// ROLI BLOCKS protocol for the keyboards Keylight lights itself (LUMI Keys, Piano M, ROLI Piano):
// what is connected, how many keys, which block is where, the octave, and the keyboard's own
// colours. Pure logic plus one small controller per MIDI port (BlocksLink), so node tests can run it.
//
// Packet: F0 00 21 10 77 <idx> <7-bit packed bitstream, LSB first> <checksum> F7. idx is the block's
// topology index (0 = the block the host is cabled to); replies carry 0x40 | index and start with a
// 32-bit timestamp. Layout from ROLI's published roli_blocks_basics (ISC), checked on two joined
// LUMI Keys (see .omc/redesign/research-hw.md).
//
// Colours, the choice made here (least invasive that still gives a dark keyboard):
// - There is no non-persistent way on the stock firmware. Lighting that ends by itself when pings
//   stop needs a program uploaded in API mode (what blocksd does on a Mac): too big for this file.
//   The NRPN colour path only exists in an old LUMI program, and API-mode program events need
//   ROLI's lesson program, which 1.3.x keyboards don't run. So the dark mode is config writes,
//   which the keyboard keeps in flash.
// - Therefore: read every setting Keylight may change (READ_ITEMS) from EVERY block first, save them
//   per block serial (settings, persisted) with a dirty flag BEFORE the first write, then write
//   only: active mode slot -> one whose colour scheme is User (or that slot's scheme -> User when
//   none is), in-scale colour 34 and root colour 35 -> black. Octave 4 / transpose 5 -> 0 only when
//   they are not 0 already.
// - Restore the saved values on exit, pagehide, app hidden, when Keylight stops needing the dark
//   mode, and on the next connect after a crash (the dirty journal survives). Never blank without
//   a complete read: a keyboard that doesn't answer keeps its own colours.
// - Values that read exactly as Keylight's own blank (both colours black) are an earlier Keylight's
//   leftovers, not a choice: they are restored to ROLI_DEFAULTS instead.

import { KeyRenderer, LIGHTS_TIMEOUT_MS } from './blocks-leds.js'

/* ---------- framing ---------- */

export const ROLI_SYSEX = [0xf0, 0x00, 0x21, 0x10, 0x77]

export function checksum(body) {
  let c = body.length & 0xff
  for (const b of body) c = (c * 3 + b) & 0xff
  return c & 0x7f
}

// [value, bits] fields into 7-bit bytes, LSB first.
export function pack7(fields) {
  let bits = 0n, count = 0
  for (const [value, size] of fields) {
    bits |= (BigInt.asUintN(size, BigInt(Math.trunc(value)))) << BigInt(count)
    count += size
  }
  const out = []
  while (count > 0) { out.push(Number(bits & 0x7fn)); bits >>= 7n; count -= 7 }
  return out
}

export const frame = (index, body) => [...ROLI_SYSEX, index & 0x3f, ...body, checksum(body), 0xf7]

const DEVICE_COMMAND = { beginApi: 0, topology: 1, endApi: 2, ping: 3 }
const command = (index, cmd) => frame(index, pack7([[0x01, 7], [cmd, 9]]))
export const topologyRequest = (index = 0) => command(index, DEVICE_COMMAND.topology)
export const pingPacket = (index = 0) => command(index, DEVICE_COMMAND.ping)
export const beginApiPacket = (index = 0) => command(index, DEVICE_COMMAND.beginApi)
export const endApiPacket = (index = 0) => command(index, DEVICE_COMMAND.endApi)
export const IDENTITY_REQUEST = [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]

// Config read of one or more items in one packet (the block answers each one separately).
export const configRequest = (index, items) => frame(index, pack7([].concat(...[].concat(items).map((item) => [[0x10, 7], [1, 4], [0, 32], [item, 8]]))))
// Config write. The keyboard keeps it in flash.
export const configSet = (index, item, value) => frame(index, pack7([[0x10, 7], [0, 4], [item, 8], [value | 0, 32]]))
// Program event (3 x 32-bit) to one block.
export const programEventPacket = (index, a, b, c) => frame(index, pack7([[0x03, 7], [a >>> 0, 32], [b >>> 0, 32], [c >>> 0, 32]]))

/* ---------- parsing ---------- */

class BitReader {
  constructor(bytes) { this.bytes = bytes; this.pos = 0; this.total = bytes.length * 7 }
  left() { return this.total - this.pos }
  read(n) {
    let v = 0
    for (let i = 0; i < n; i++) {
      const at = this.pos + i, byte = this.bytes[Math.floor(at / 7)] ?? 0
      if ((byte >> (at % 7)) & 1) v += 2 ** i
    }
    this.pos += n
    return v
  }
}
const signed32 = (v) => (v >= 2 ** 31 ? v - 2 ** 32 : v)
// Body lengths from blocksd's device decoder (firmware ACK, touch, touch with velocity).
const SKIPPED_BITS = { 0x03: 39, 0x10: 42, 0x11: 42, 0x12: 42, 0x13: 66, 0x14: 66, 0x15: 66 }

export function isBlocksPacket(data) {
  return !!data && data.length >= 8 && data[0] === 0xf0 && data[1] === 0x00 && data[2] === 0x21 && data[3] === 0x10 && data[4] === 0x77 && data[data.length - 1] === 0xf7
}

// One device->host packet: { index, ok, messages: [{ type: 'topology' | 'ack' | 'config' | ... }] }, or null.
export function parsePacket(data, includeButtons = false) {
  if (!isBlocksPacket(data)) return null
  const raw = data[5], body = Array.from(data.slice(6, data.length - 2))
  const fromDevice = !!(raw & 0x40)
  const out = { index: raw & 0x3f, fromDevice, ok: checksum(body) === data[data.length - 2], messages: [] }
  if (!fromDevice || !out.ok) return out
  const r = new BitReader(body)
  if (r.left() < 32) return out
  r.read(32)    // timestamp
  while (r.left() >= 7) {
    const type = r.read(7)
    if (type === 0) break
    if (type === 0x01 || type === 0x04) {
      if (r.left() < 23) break
      const m = { type: type === 1 ? 'topology' : 'topologyExtend', version: r.read(8), devices: [], links: [] }
      const nd = r.read(7), nc = r.read(8)
      m.numDevices = nd; m.numLinks = nc
      if (r.left() < nd * 125 + nc * 24) break
      for (let i = 0; i < nd; i++) {
        let serial = ''
        for (let k = 0; k < 16; k++) { const ch = r.read(7); if (ch) serial += String.fromCharCode(ch) }
        m.devices.push({ serial: serial.trim(), index: r.read(7), battery: r.read(5), charging: !!r.read(1) })
      }
      for (let i = 0; i < nc; i++) m.links.push({ a: r.read(7), portA: r.read(5), b: r.read(7), portB: r.read(5) })
      out.messages.push(m)
    } else if (type === 0x05) {
      if (r.left() < 8) break
      out.messages.push({ type: 'topologyEnd', version: r.read(8) })
    } else if (type === 0x02) {
      if (r.left() < 10) break
      out.messages.push({ type: 'ack', counter: r.read(10) })
    } else if (type === 0x06 || type === 0x07) {
      if (r.left() < 14) break
      const index = r.read(7), n = r.read(7)
      if (r.left() < n * 7) break
      let text = ''
      for (let k = 0; k < n; k++) { const ch = r.read(7); if (ch) text += String.fromCharCode(ch) }
      out.messages.push({ type: type === 6 ? 'version' : 'name', index, text })
    } else if (type === 0x18) {
      if (r.left() < 4) break
      const cmd = r.read(4)
      if (cmd === 7 || cmd === 9) continue // Factory sync end/reset have no body.
      const bits = cmd === 4 || cmd === 5 ? 104 : cmd === 0 ? 40 : 0
      if (!bits || r.left() < bits) break
      const item = r.read(8)
      if (cmd === 4 || cmd === 5) out.messages.push({ type: 'config', cmd, item, value: signed32(r.read(32)), min: signed32(r.read(32)), max: signed32(r.read(32)) })
      else out.messages.push({ type: 'config', cmd, item, value: signed32(r.read(32)) })
    } else if (type === 0x20 || type === 0x21) {
      if (r.left() < 17) break
      r.read(5)    // timestamp offset
      const id = r.read(12)
      if (includeButtons) out.messages.push({ type: 'button', id, action: type === 0x20 ? 'press' : 'release' })
    } else if (type === 0x28) {
      if (r.left() < 96) break
      out.messages.push({ type: 'programEvent', values: [r.read(32), r.read(32), r.read(32)] })
    } else {
      // A log (0x30) consumes the rest of the packet. Unknown bodies have no length prefix.
      const bits = SKIPPED_BITS[type]
      if (!bits || r.left() < bits) break
      r.pos += bits
    }
  }
  return out
}

// Universal identity reply: F0 7E <id> 06 02 <maker 3> <family 2> <model 2> <version 4> F7
export function parseIdentity(data) {
  if (!data || data.length < 15 || data[0] !== 0xf0 || data[1] !== 0x7e || data[3] !== 0x06 || data[4] !== 0x02) return null
  const roli = data[5] === 0x00 && data[6] === 0x21 && data[7] === 0x10
  return { roli, family: data[8] | (data[9] << 7), model: data[10] | (data[11] << 7), version: [data[12], data[13], data[14]].join('.') }
}

/* ---------- models and topology ---------- */

// LKB: LUMI Keys and Piano M (24 keys); RP4: ROLI Piano (49 keys, no DNA ports).
export function modelFromSerial(serial) {
  const s = String(serial || '').toUpperCase()
  return s.startsWith('LKB') ? 'keys24' : s.startsWith('RP4') ? 'piano49' : null
}
export const MODEL_KEYS = { keys24: 24, piano49: 49 }

// LKB ports: 0,1 west (left) edge, 2-5 north, 6,7 east (right). A east -> B west: A is left of B.
const isEast = (p) => p === 6 || p === 7
const isWest = (p) => p === 0 || p === 1
export function orderBlocks(devices, links = []) {
  const byIndex = new Map(devices.map((d) => [d.index, d]))
  const rightOf = new Map(), hasLeft = new Set()
  for (const l of links) {
    if (!byIndex.has(l.a) || !byIndex.has(l.b)) continue
    if (isEast(l.portA) && isWest(l.portB)) { rightOf.set(l.a, l.b); hasLeft.add(l.b) } else if (isEast(l.portB) && isWest(l.portA)) { rightOf.set(l.b, l.a); hasLeft.add(l.a) }
  }
  const out = [], seen = new Set()
  for (const d of devices) {
    if (hasLeft.has(d.index) || seen.has(d.index)) continue
    for (let at = d.index; at != null && !seen.has(at); at = rightOf.get(at)) { seen.add(at); out.push(byIndex.get(at)) }
  }
  for (const d of devices) if (!seen.has(d.index)) out.push(d)   // a ring or a missing link: keep them all
  return out
}

// The firmware's own per-block octave offset (config item 8) for a row of `width` blocks.
export function topologyOffsets(width) {
  const start = Math.floor((width - 1) / 2)
  return Array.from({ length: width }, (_, x) => (x - start) * 2)
}

// What the app needs from a finished topology. master: the block the port is cabled to.
export function clusterInfo(topology) {
  if (!topology || !topology.devices || !topology.devices.length) return null
  const ordered = orderBlocks(topology.devices, topology.links)
  const blocks = ordered.map((d) => ({ ...d, model: modelFromSerial(d.serial), firmware: topology.versions?.[d.index] || '' }))
  const known = blocks.filter((b) => b.model)
  const keys = known.reduce((n, b) => n + MODEL_KEYS[b.model], 0)
  const offsets = topologyOffsets(blocks.length)
  return {
    blocks,
    indices: blocks.map((b) => b.index),
    master: topology.master ?? topology.devices[0].index,
    keys,
    joined: blocks.length >= 2,
    models: blocks.map((b) => b.model).filter(Boolean),
    offsets,
    minOffset: Math.min(...offsets)
  }
}

// Collects topology messages: one packet when it is small, else 0x04 extends until 0x05 end.
export class TopologyAssembler {
  constructor() { this.pending = null; this.last = null }
  // returns a finished topology or null
  feed(packet) {
    let done = null
    for (const m of packet.messages) {
      if (m.type === 'topology') {
        this.pending = { devices: [...m.devices], links: [...m.links], versions: {}, master: packet.index }
        if (m.numDevices < 6 && m.numLinks < 24) done = this.pending
      } else if (m.type === 'topologyExtend' && this.pending) {
        this.pending.devices.push(...m.devices); this.pending.links.push(...m.links)
        if (m.numDevices < 6 && m.numLinks < 24) done = this.pending
      } else if (m.type === 'topologyEnd' && this.pending) {
        done = this.pending
      } else if (m.type === 'version' && this.pending) {
        if (this.pending.versions[m.index] !== m.text) {
          this.pending.versions[m.index] = m.text
          if (this.pending === this.last) done = this.pending
        }
      }
    }
    if (done && done !== this.last) {
      for (const block of done.devices) {
        const previous = this.last?.devices.find((b) => b.serial === block.serial && b.index === block.index)
        if (previous && done.versions[block.index] == null) {
          done.versions[block.index] = this.last.versions[block.index]
        }
      }
      this.last = done
    }
    return done
  }
}

/* ---------- the keyboard's own settings: save, darken, restore ---------- */

export const ITEM = { octave: 4, transpose: 5, octaveTopology: 8, mode: 20, scale: 22, key: 27, globalColour: 34, rootColour: 35, brightness: 36 }
export const SCHEME_ITEMS = [100, 107, 114, 121]       // colour scheme of mode slot 0..3
export const SCHEME = { pro: 0, user: 1, piano: 2, stage: 3, rainbow: 4 }
export const READ_ITEMS = [4, 5, 20, 22, 27, 34, 35, 36, ...SCHEME_ITEMS]
export const BLACK = 0xff000000 | 0      // -16777216, as the keyboard reports it
// ROLI's factory scheme for Mode 1 is Pro, which ignores 34/35; these show when a User-scheme mode is
// picked. Not published by ROLI: white in-scale keys (what Pro shows) and a blue root. [INFER]
export const ROLI_DEFAULTS = Object.freeze({ 34: 0xffffffff | 0, 35: 0xff0080ff | 0 })

// What Keylight's own blank wrote (old versions too): both colours black.
export const looksBlanked = (v) => !!v && v[34] === BLACK && v[35] === BLACK

// A dirty journal still applies while the keyboard still shows some of what Keylight wrote, and
// the rest is either that or already your value (a restore cut short). The octave is yours to move
// and the active mode (20) resets on a power cycle, so neither counts. Anything else means it was
// put back, or you changed it since (Dashboard): then the journal is old news.
const VOLATILE = new Set(['4', '5', '20'])
export function journalLive(read, journal) {
  if (!journal || !journal.dirty || !journal.values) return false
  const items = Object.keys(journal.written || {}).filter((k) => !VOLATILE.has(k))
  return items.some((k) => read[k] === journal.written[k]) &&
    items.every((k) => read[k] === journal.written[k] || read[k] === journal.values[k])
}

// The values to restore later. A live journal (a session that didn't end, or a crash) wins:
// the keyboard now holds Keylight's values. Else what was read, with black-on-black repaired.
// `fallback`: the cluster's saved values, for a block that took the master's (blank) colours
// when it was snapped on.
export function keepValues(read, journal, fallback = null) {
  if (journalLive(read, journal)) return { values: { ...journal.values }, from: 'journal' }
  if (looksBlanked(read) && fallback && !looksBlanked(fallback)) return { values: { ...read, 34: fallback[34], 35: fallback[35] }, from: 'cluster' }
  if (looksBlanked(read)) return { values: { ...read, ...ROLI_DEFAULTS }, from: 'defaults' }
  return { values: { ...read }, from: 'read' }
}

// The writes that make one block dark, from its saved values. [[item, value]]
export function darkWrites(saved) {
  const writes = []
  const slot = Number.isInteger(saved[20]) && saved[20] >= 0 && saved[20] < SCHEME_ITEMS.length ? saved[20] : 0
  const schemeOf = (s) => saved[SCHEME_ITEMS[s]]
  if (schemeOf(slot) !== SCHEME.user) {
    const user = [0, 1, 2, 3].find((s) => schemeOf(s) === SCHEME.user)
    if (user != null) writes.push([20, user])
    else writes.push([SCHEME_ITEMS[slot], SCHEME.user])
  }
  writes.push([34, BLACK], [35, BLACK])
  return writes
}

// The writes that put one block back: every item Keylight wrote, to its saved value. The octave and
// transpose only if they still are what Keylight set (pressing the octave buttons since is your choice).
export function restoreWrites(saved, written, current = {}) {
  const writes = []
  for (const key of Object.keys(written || {})) {
    const item = Number(key)
    if (!(key in saved)) continue
    if ((item === 4 || item === 5) && current[key] != null && current[key] !== written[key]) continue
    writes.push([item, saved[key]])
  }
  return writes
}

/* ---------- controller: one per keyboard port ---------- */

export const POLL_MS = 3000
export const REPLY_MS = 1500
export const PING_MASTER_MS = 400
export const PING_OTHER_MS = 1666
const SEND_GAP_MS = 25        // Bluetooth MIDI: don't burst

// opts: { send(bytes), store: { get(serial), set(serial, entry|null) }, log, onChange(info, why),
//         onLightsState(state, blocks), timers, now() }
export class BlocksLink {
  constructor(opts) {
    this.send = opts.send
    this.store = opts.store || { get: () => null, set: () => {} }
    this.log = opts.log || (() => {})
    this.onChange = opts.onChange || (() => {})
    this.onButton = opts.onButton
    this.onLightsState = opts.onLightsState || (() => {})
    this.t = opts.timers || globalThis
    this.now = opts.now
    this.assembler = new TopologyAssembler()
    this.info = null            // clusterInfo of the last topology
    this.identity = null
    this.config = new Map()     // index -> { item: value }
    this.ranges = new Map()     // index -> { item: [min, max] }
    this.octave = null          // the master's octave (item 4)
    this.transpose = null
    this.ackIndices = new Set()
    this.wantDark = false
    this.dark = new Map()       // serial -> { index, saved, written }
    this.confirming = new Map() // serial -> { index, expect: { item: value }, saved }: restores not yet read back
    this.api = false
    this.apiWhy = new Set()
    this.apiBlocks = new Map()    // index -> serial of the active API session
    this.responders = new Set()   // serials that answered config reads on this port
    this.ownership = null         // explicit serials, or null to use config replies
    this.ownershipStale = false   // fed by another input: config replies wait for that input's own topology
    this.renderers = new Map()
    this.lightsTimer = null
    this.lightsExpired = false
    this.lightsArmedFor = null    // the owned blocks the lights timeout counts for
    this.lastLightsState = JSON.stringify(['idle', []])
    this.holding = {}           // item -> true while Keylight's octave/transpose 0 is on its way
    this.queue = []
    this.sending = null
    this.configDrain = null       // old config replies have indices but no request IDs
    this.started = false
    this.noReply = false        // no topology answer after REPLY_MS
    this.readFailed = false
  }

  start() {
    if (this.started) return
    this.started = true
    this.out(IDENTITY_REQUEST)
    this.requestTopology()
    this.replyTimer = this.t.setTimeout(() => {
      if (this.info) return
      this.noReply = true
      this.log('BLOCKS no topology reply')
      this.onChange(this.info, 'no-reply')
    }, REPLY_MS)
    this.pollTimer = this.t.setInterval(() => this.poll(), POLL_MS)
  }

  // Stops talking. Doesn't restore: call release() first while the port still works.
  stop() {
    this.started = false
    this.apiWhy.clear()
    this.apiBlocks.clear()
    if (this.lightsTimer != null) this.t.clearTimeout(this.lightsTimer)
    this.lightsTimer = null
    const renderers = [...this.renderers.values()]
    this.renderers.clear()
    for (const renderer of renderers) renderer.reset()
    for (const id of [this.replyTimer, this.readTimer, this.topoSoon, this.sending, this.holdTimer, this.configDrain]) if (id != null) this.t.clearTimeout(id)
    for (const id of [this.pollTimer, this.pingMaster, this.pingOthers]) if (id != null) this.t.clearInterval(id)
    this.pingMaster = this.pingOthers = this.sending = this.topoSoon = this.readTimer = this.holdTimer = null
    this.reading = null
    this.configDrain = null
    this.holding = {}
    this.api = false
    this.queue = []
    this.emitLightsState()
  }

  out(bytes) { try { this.send(bytes) } catch (_e) {} }
  // Writes and reads go out spaced, so a Bluetooth link isn't flooded.
  queuedRead(index, items) {
    if (this.configDrain != null) return
    this.enqueue({ bytes: configRequest(index, items) })
  }
  queuedWrite(serial, item, value) {
    if (serial) this.enqueue({ serial, item, value })
  }
  enqueue(message) {
    this.queue.push(message)
    if (!this.sending) this.pump()
  }
  sendQueued(message) {
    if (message.bytes) { this.out(message.bytes); return }
    const index = this.info?.blocks.find((b) => b.serial === message.serial)?.index
    if (index != null) this.out(configSet(index, message.item, message.value))
  }
  pump() {
    const next = this.queue.shift()
    if (!next) { this.sending = null; return }
    this.sendQueued(next)
    this.sending = this.t.setTimeout(() => this.pump(), SEND_GAP_MS)
  }
  flush() {     // pagehide: everything now
    if (this.sending) this.t.clearTimeout(this.sending)
    this.sending = null
    while (this.queue.length) this.sendQueued(this.queue.shift())
  }

  requestTopology() { this.out(topologyRequest(0)) }
  poll() {
    this.requestTopology()
    // the octave (buttons) and the mode (a keyboard switched off and on starts in another mode)
    this.queuedRead(0, this.wantDark ? [4, 5, 20] : [4, 5])
  }

  // Every SysEx from the port. True if it was one of ours.
  feed(data) {
    const id = parseIdentity(data)
    if (id) { this.identity = id; return true }
    const p = parsePacket(data, !!this.onButton)
    if (!p) return false
    if (!p.fromDevice || !p.ok) return true
    const topo = this.assembler.feed(p)
    if (topo) this.onTopology(topo)
    for (const m of p.messages) {
      if (m.type === 'ack') this.onAck(p.index, m.counter)
      else if (m.type === 'programEvent') this.rendererAt(p.index)?.onProgramEvent(m.values)
      else if (m.type === 'button') {
        const block = this.info?.blocks.find((b) => b.index === p.index)
        if (block) this.onButton(m, block.serial)
      }
      else if (m.type === 'config' && (m.cmd === 4 || m.cmd === 5 || m.cmd === 0)) this.onConfig(p.index, m)
    }
    return true
  }

  onAck(index, counter) {
    this.rendererAt(index)?.onAck(counter)
    if (this.ackIndices.has(index)) return
    this.ackIndices.add(index)
    // a block we don't know answered: the row changed
    if (this.info && !this.info.indices.includes(index) && !this.topoSoon) {
      this.topoSoon = this.t.setTimeout(() => { this.topoSoon = null; this.requestTopology() }, 200)
    }
  }

  onTopology(topo) {
    const info = clusterInfo(topo)
    if (!info) return
    const prev = this.info
    this.info = info
    this.noReply = false
    const wasStale = this.ownershipStale
    this.ownershipStale = false
    this.ackIndices = new Set(info.indices)
    const sig = (i) => (i ? [i.master, ...i.blocks.map((b) => b.serial + '@' + b.index)].join(',') : '')
    if (sig(prev) === sig(info)) {
      if (info.blocks.some((b, i) => b.firmware !== prev.blocks[i].firmware)) {
        this.onChange(info, 'firmware')
        this.syncLights()
      }
      if (info.blocks.some((b, i) => b.battery !== prev.blocks[i].battery || b.charging !== prev.blocks[i].charging)) {
        this.onChange(info, 'battery')
      }
      if (wasStale) this.probeLightOwnership()
      return
    }
    this.log('BLOCKS topology ' + info.blocks.map((b) => (b.serial.slice(0, 6) || '?') + '… idx ' + b.index + (b.model ? ' ' + b.model : '')).join(' | ') + ' keys=' + info.keys)
    // blocks that left: their journal stays dirty until they are seen again; the rest may have a new index
    const indexOf = (serial) => info.blocks.find((b) => b.serial === serial)?.index
    for (const b of prev?.blocks || []) {
      if (indexOf(b.serial) !== b.index) {
        this.config.delete(b.index)
        this.ranges.delete(b.index)
        this.responders.delete(b.serial)
      }
    }
    for (const [serial, d] of this.dark) {
      const at = indexOf(serial)
      if (at == null) this.dark.delete(serial)
      else d.index = at
    }
    const repairWasReading = this.reading?.why === 'repair'
    this.cancelRead()
    const changedMapping = prev && (prev.master !== info.master || prev.blocks.length !== info.blocks.length ||
      prev.blocks.some((b) => indexOf(b.serial) !== b.index))
    if (changedMapping) {
      this.queue = this.queue.filter((message) => !message.bytes)
      this.confirming.clear()      // a partial readback was for the old row; keep the journal dirty
      if (this.configDrain != null) this.t.clearTimeout(this.configDrain)
      this.configDrain = this.t.setTimeout(() => {
        this.configDrain = null
        if (this.started) this.readTopologyConfig(true)
      }, REPLY_MS)
    }
    this.onChange(info, prev ? 'topology' : 'connect')
    this.syncLights()
    if (this.configDrain == null) this.readTopologyConfig(repairWasReading)
  }

  readTopologyConfig(repair) {
    this.queuedRead(0, [4, 5])
    this.probeLightOwnership()
    if (!this.started || this.reading) return       // onChange may already have started a read or stopped the link
    if (this.wantDark) this.darken()
    else if (repair) this.repairLeftovers()
  }

  onConfig(index, m) {
    // the index is the old input's: which block answered isn't known until this input's topology
    if (this.ownershipStale || this.configDrain != null) return
    const c = this.config.get(index) || {}
    c[m.item] = m.value
    this.config.set(index, c)
    if (m.min != null) { const r = this.ranges.get(index) || {}; r[m.item] = [m.min, m.max]; this.ranges.set(index, r) }
    const block = this.info?.blocks.find((b) => b.index === index)
    if ((m.cmd === 4 || m.cmd === 5) && block?.serial && !this.responders.has(block.serial)) {
      this.responders.add(block.serial)
      if (this.ownership == null) this.syncLights()
    }
    const master = this.info ? this.info.master : index
    if (index === master && (m.item === 4 || m.item === 5)) {
      const key = m.item === 4 ? 'octave' : 'transpose'
      // a reply sent before Keylight's 0 landed isn't you pressing a button
      if (this.holding[m.item]) { if (m.value === 0) delete this.holding[m.item] } else if (this[key] !== m.value) {
        const had = this[key] != null
        this[key] = m.value
        this.onChange(this.info, had ? 'octave' : 'config')
      }
    }
    // the keyboard came back in another mode (it doesn't keep the active mode over a power cycle)
    if (m.item === 20 && this.wantDark) {
      const d = [...this.dark.values()].find((x) => x.index === index)
      if (d && d.written[20] != null && m.value !== d.written[20]) this.queuedWrite(block?.serial, 20, d.written[20])
    }
    if (this.confirming.size) this.checkConfirm(index, m)
    if (this.reading) this.checkRead()
  }

  // The lowest note the row plays, as the firmware works it out.
  lowestNote() {
    if (!this.info || this.octave == null) return null
    return 48 + 12 * (this.octave + this.info.minOffset) + (this.transpose || 0)
  }

  /* ----- dark mode ----- */

  setDark(want) {
    if (want === this.wantDark) return
    this.wantDark = want
    if (want) this.darken()
    else this.release()
  }

  darken() {
    if (!this.info || !this.wantDark) return
    this.read(this.info.blocks.filter((b) => b.model && !this.dark.has(b.serial)), 'dark')
  }

  // Reads READ_ITEMS from these blocks, then checkRead() decides. why: 'dark' | 'repair'
  read(todo, why) {
    this.cancelRead()
    if (!todo.length || this.configDrain != null) return
    this.reading = { blocks: todo, why, tried: 0 }
    // fresh answers only: an older read may hold the values Keylight itself wrote
    for (const b of todo) this.config.set(b.index, {})
    for (const b of todo) this.queuedRead(b.index, READ_ITEMS)
    if (this.readTimer) this.t.clearTimeout(this.readTimer)
    this.readTimer = this.t.setTimeout(() => this.readTimedOut(), REPLY_MS)
  }

  cancelRead() {
    this.reading = null
    if (this.readTimer) { this.t.clearTimeout(this.readTimer); this.readTimer = null }
    this.setApi(false, 'read')
  }

  readTimedOut() {
    this.readTimer = null
    if (!this.reading) return
    // some keyboards may only answer in API mode: try once more that way
    if (this.reading.tried < 1) {
      this.reading.tried++
      this.log('BLOCKS no config reply, trying API mode')
      this.setApi(true, 'read')
      for (const b of this.reading.blocks) this.queuedRead(b.index, READ_ITEMS)
      this.readTimer = this.t.setTimeout(() => this.readTimedOut(), REPLY_MS)
      return
    }
    // a block that answered is handled; one that didn't is left alone (joined blocks on two Bluetooth links: each block answers
    // only on its own link, so a link that reaches the whole row can't read all of it)
    const answered = this.reading.blocks.filter((b) => READ_ITEMS.every((item) => item in (this.config.get(b.index) || {})))
    if (answered.length) {
      this.log('BLOCKS ' + (this.reading.blocks.length - answered.length) + ' block(s) did not answer: going on with the ' + answered.length + ' that did')
      this.reading.blocks = answered
      this.checkRead()
      return
    }
    this.reading = null
    this.readFailed = true
    this.setApi(false, 'read')
    this.log('BLOCKS could not read the keyboard\'s own colours: leaving them as they are')
    this.onChange(this.info, 'read-failed')
  }

  checkRead() {
    const r = this.reading
    if (!r) return
    const complete = (b) => READ_ITEMS.every((item) => item in (this.config.get(b.index) || {}))
    if (!r.blocks.every(complete)) return
    this.reading = null
    if (this.readTimer) { this.t.clearTimeout(this.readTimer); this.readTimer = null }
    this.setApi(false, 'read')
    const readOf = (b) => { const v = {}; for (const item of READ_ITEMS) v[item] = this.config.get(b.index)[item]; return v }
    if (r.why === 'repair') {
      for (const b of r.blocks) {
        const j = this.store.get(b.serial), read = readOf(b)
        if (!journalLive(read, j)) { if (j && j.dirty) this.store.set(b.serial, { ...j, written: {}, dirty: false, at: Date.now() }); continue }
        this.putBack(b, j.values, j.written, read)
        this.log('BLOCKS putting back the settings a past session left on ' + b.serial.slice(0, 6) + '…')
      }
      return
    }
    if (!this.wantDark) return
    // the master first, so a block that took its colours when it was snapped on can borrow them
    const order = [...r.blocks].sort((a, b) => (a.index === this.info.master ? -1 : b.index === this.info.master ? 1 : 0))
    let clusterKeep = [...this.dark.values()].find((d) => d.index === this.info.master)?.saved || null
    for (const b of order) {
      const read = readOf(b)
      const journal = this.store.get(b.serial)
      const keep = keepValues(read, journal, clusterKeep)
      if (b.index === this.info.master) clusterKeep = keep.values
      this.confirming.delete(b.serial)
      const writes = darkWrites(read)
      const written = { ...(keep.from === 'journal' ? journal.written : {}) }
      for (const [item, value] of writes) written[item] = value
      // saved before anything is written
      this.store.set(b.serial, { values: keep.values, written, dirty: true, at: Date.now() })
      this.dark.set(b.serial, { index: b.index, saved: keep.values, written })
      this.log('BLOCKS saved own settings of ' + b.serial.slice(0, 6) + '… (' + keep.from + '), lights dark')
      for (const [item, value] of writes) this.queuedWrite(b.serial, item, value)
    }
    this.holdOctave()
  }

  // Octave and transpose to 0 while Keylight runs, once per block row, on the master (the
  // firmware passes it to the row). Not again after you press the octave buttons.
  holdOctave() {
    const master = this.info.blocks.find((b) => b.index === this.info.master)
    const d = this.dark.get(master?.serial)
    if (!d) return
    const now = []
    for (const item of [4, 5]) {
      if (d.written[item] != null || d.held?.[item]) continue
      d.held = { ...d.held, [item]: true }
      if (d.saved[item] !== 0) { d.written[item] = 0; now.push(item) }
    }
    if (!now.length) return
    // saved before it is written
    for (const [serial, x] of this.dark) if (x.index === d.index) this.store.set(serial, { values: x.saved, written: x.written, dirty: true, at: Date.now() })
    for (const item of now) {
      this.holding[item] = true
      this.queuedWrite(master.serial, item, 0)
      this[item === 4 ? 'octave' : 'transpose'] = 0     // what it is now; the next poll confirms
    }
    if (this.holdTimer) this.t.clearTimeout(this.holdTimer)
    this.holdTimer = this.t.setTimeout(() => { this.holdTimer = null; this.holding = {} }, 1000)
    this.onChange(this.info, 'octave')
  }

  // Back to the keyboard's own settings, on every block Keylight darkened.
  release(immediate = false) {
    this.cancelRead()
    if (this.holdTimer) { this.t.clearTimeout(this.holdTimer); this.holdTimer = null }
    this.holding = {}
    const current = this.config.get(this.info?.master) || {}
    // the other blocks first, the master last (it passes its settings on to the row)
    const list = [...this.dark.entries()].sort(([, a], [, b]) => (a.index === this.info?.master ? 1 : b.index === this.info?.master ? -1 : 0))
    for (const [serial, d] of list) {
      this.putBack({ serial, index: d.index }, d.saved, d.written, d.index === this.info?.master ? { 4: this.octave ?? current[4], 5: this.transpose ?? current[5] } : {})
      this.log('BLOCKS own settings back on ' + serial.slice(0, 6) + '…')
    }
    this.dark.clear()
    if (immediate) this.flush()
  }

  // Writes the saved values back. The journal stays dirty until a read shows they landed: a
  // Bluetooth drop, the page closing, or another program on the keyboard (blocksd's ignores colour
  // writes) must not lose them.
  putBack({ serial, index }, saved, written, current = {}) {
    const writes = restoreWrites(saved, written, current)
    for (const [item, value] of writes) this.queuedWrite(serial, item, value)
    this.store.set(serial, { values: saved, written, dirty: true, at: Date.now() })
    const expect = {}
    for (const [item, value] of writes) expect[item] = value
    if (!writes.length) { this.store.set(serial, { values: saved, written: {}, dirty: false, at: Date.now() }); return }
    this.confirming.set(serial, { index, expect, saved })
    this.queuedRead(index, writes.map(([item]) => item))
  }
  checkConfirm(index, m) {
    for (const [serial, c] of this.confirming) {
      if (c.index !== index || !(m.item in c.expect)) continue
      if (m.value !== c.expect[m.item]) continue        // not yet: stays dirty, put back again next time
      delete c.expect[m.item]
      if (Object.keys(c.expect).length) continue
      this.confirming.delete(serial)
      this.store.set(serial, { values: c.saved, written: {}, dirty: false, at: Date.now() })
      this.log('BLOCKS checked: own settings are back on ' + serial.slice(0, 6) + '…')
    }
  }

  // A past session (a crash, the page closed before the check) left a journal for a block that is
  // here, and Keylight won't darken it now: read it, and put it back if it still shows Keylight's values.
  repairLeftovers() {
    if (!this.info || this.wantDark) return
    this.read(this.info.blocks.filter((b) => this.store.get(b.serial)?.dirty), 'repair')
  }

  /* ----- Local key lights ----- */

  // The app can assign serials across links. Null restores per-port config discovery.
  setOwnedSerials(serials = null) {
    const next = serials == null ? null : new Set(serials)
    if (next == null ? this.ownership == null :
      next.size === this.ownership?.size && [...next].every((serial) => this.ownership.has(serial))) return
    this.ownership = next
    this.syncLights()
    this.probeLightOwnership()
  }

  ownedBlocks() {
    const serials = this.ownership ?? this.responders
    return (this.info?.blocks || []).filter((block) => serials.has(block.serial))
  }

  ownedSerials() { return this.ownedBlocks().map((block) => block.serial) }

  probeLightOwnership() {
    if (!this.apiWhy.has('leds') || this.ownership != null || this.ownershipStale) return
    for (const b of this.info?.blocks || []) {
      if (!this.responders.has(b.serial)) this.queuedRead(b.index, [4, 5])
    }
  }

  startLights() {
    if (this.apiWhy.has('leds')) return
    this.apiWhy.add('leds')
    this.lightsArmedFor = null      // syncLights arms the timeout
    this.syncLights()
    this.probeLightOwnership()
  }

  // The firmware has LIGHTS_TIMEOUT_MS to show up, counted again whenever the owned blocks change
  // (a block snapped on later reports its version late too).
  armLightsTimer() {
    if (this.lightsTimer != null) this.t.clearTimeout(this.lightsTimer)
    this.lightsExpired = false
    this.lightsTimer = this.t.setTimeout(() => {
      this.lightsTimer = null
      this.lightsExpired = true
      this.emitLightsState()
    }, LIGHTS_TIMEOUT_MS)
  }

  // Ownership found through another port's replies (swapped routing before a fold): find it again,
  // once this input's own topology says which block an index is (it probes again then).
  resetOwnership() {
    this.ownershipStale = true
    this.assembler = new TopologyAssembler()
    this.config.clear()
    this.ranges.clear()
    if (this.started) this.requestTopology()
    this.responders.clear()
    // re-probing: the firmware gets its full time again (a timer armed before the swap/fold would cut it short)
    this.lightsArmedFor = null
    this.syncLights()
  }

  stopLights() {
    if (!this.apiWhy.delete('leds')) return
    if (this.lightsTimer != null) this.t.clearTimeout(this.lightsTimer)
    this.lightsTimer = null
    this.lightsArmedFor = null
    this.syncLights()
  }

  setKeyFrame(serial, colors24, brightness = 1) {
    return this.renderers.get(serial)?.setFrame(colors24, brightness) ?? false
  }

  lightsDetails() {
    if (!this.apiWhy.has('leds')) return []
    return this.ownedBlocks().map(({ serial, index, firmware }) => {
      const renderer = this.renderers.get(serial)
      const state = renderer?.state ?? (this.lightsExpired ? 'failed' : 'probing')
      const reason = renderer ? renderer.reason : (this.lightsExpired ? 'no-firmware' : null)
      return { serial, index, firmware, state, reason }
    })
  }

  lightsState() {
    if (!this.apiWhy.has('leds')) return 'idle'
    const blocks = this.lightsDetails()
    if (!blocks.length) return this.lightsExpired ? 'failed' : 'probing'
    if (blocks.some((b) => b.state === 'failed')) return 'failed'
    return blocks.every((b) => b.state === 'ready') ? 'ready' : 'probing'
  }

  emitLightsState() {
    const state = this.lightsState(), blocks = this.lightsDetails()
    if (state === 'ready' && this.lightsTimer != null) { this.t.clearTimeout(this.lightsTimer); this.lightsTimer = null }
    const signature = JSON.stringify([state, blocks])
    if (this.lastLightsState === signature) return
    this.lastLightsState = signature
    this.onLightsState(state, blocks)
  }

  rendererAt(index) {
    const serial = this.apiBlocks.get(index)
    const renderer = this.renderers.get(serial)
    return renderer?.index === index ? renderer : null
  }

  syncLights() {
    const owned = this.ownedBlocks()
    const wanted = this.apiWhy.has('leds') ? owned : []
    if (this.apiWhy.has('leds')) {
      const armFor = owned.map((b) => b.serial + '@' + b.index).join(',')
      if (armFor !== this.lightsArmedFor) { this.lightsArmedFor = armFor; this.armLightsTimer() }
    }
    const reset = new Set()
    for (const [serial, renderer] of this.renderers) {
      if (wanted.some((b) => b.serial === serial && b.index === renderer.index && b.firmware === renderer.firmware)) continue
      this.renderers.delete(serial)
      if (renderer.state !== 'failed' && owned.some((b) => b.serial === serial && b.index === renderer.index)) reset.add(renderer.index)
      renderer.reset()
    }
    for (const block of wanted) {
      if (this.renderers.has(block.serial) || (!block.firmware && block.model === 'keys24')) continue
      const renderer = new KeyRenderer({
        ...block, send: (bytes) => this.out(bytes), timers: this.t, now: this.now,
        onState: (state) => {
          if (this.renderers.get(block.serial) !== renderer) return
          if (state === 'failed') this.syncApi(new Set([block.index]))
          this.emitLightsState()
        }
      })
      renderer.start()
      this.renderers.set(block.serial, renderer)
      if (renderer.state === 'probing') reset.add(block.index)
    }
    this.syncApi(reset)
    this.emitLightsState()
  }

  /* ----- API mode keep-alive ----- */

  // The legacy read and lights callers retain independent API holds.
  setApi(on, why = 'lights') {
    if (on) this.apiWhy.add(why)
    else this.apiWhy.delete(why)
    this.syncApi()
  }

  syncApi(reset = new Set()) {
    const legacy = [...this.apiWhy].some((why) => why !== 'leds')
    const owned = new Map(this.ownedBlocks().map((b) => [b.index, b.serial]))
    const addressable = new Map(this.indices().map((i) => [i, this.info?.blocks.find((b) => b.index === i)?.serial ?? null]))
    const next = legacy ? new Map(addressable) : new Map()
    for (const renderer of this.renderers.values()) {
      if (owned.get(renderer.index) === renderer.serial && (renderer.state === 'probing' || renderer.state === 'ready')) {
        next.set(renderer.index, renderer.serial)
      }
    }

    const previous = this.apiBlocks
    this.apiBlocks = next
    this.api = next.size > 0
    for (const [index, serial] of previous) {
      // also a block that left the owned set but is still at that index (resetOwnership, setOwnedSerials): not frozen until its ping timeout
      const here = serial != null && !!this.info?.blocks.some((b) => b.index === index && b.serial === serial)
      if (!reset.has(index) && !next.has(index) && (here || owned.get(index) === serial || addressable.get(index) === serial)) {
        this.out(endApiPacket(index))
      }
    }
    for (const index of reset) this.out(endApiPacket(index))
    for (const [index, serial] of next) {
      if (reset.has(index) || previous.get(index) !== serial) this.out(beginApiPacket(index))
    }
    const master = this.info?.master ?? 0
    if (this.pingIndex !== master || !this.api || this.pingMaster == null) this.restartPings()
  }

  restartPings() {
    for (const id of [this.pingMaster, this.pingOthers]) if (id != null) this.t.clearInterval(id)
    this.pingMaster = this.pingOthers = null
    this.pingIndex = this.info?.master ?? 0
    if (!this.api) return
    const master = this.pingIndex
    this.pingMaster = this.t.setInterval(() => {
      if (this.apiBlocks.has(master)) this.out(pingPacket(master))
    }, PING_MASTER_MS)
    this.pingOthers = this.t.setInterval(() => {
      for (const i of this.apiBlocks.keys()) if (i !== master) this.out(pingPacket(i))
    }, PING_OTHER_MS)
  }

  // Before config discovery the legacy API can talk to the physical master.
  indices() {
    const owned = this.ownedBlocks().map((block) => block.index)
    return owned.length || this.ownership != null ? owned : [this.info?.master ?? 0]
  }
}

/* ----- the whole row's in-page lights ----- */

// Each block of the row (left to right) on the link that has its program ready.
export function routeRowLights(blocks, links) {
  const routed = blocks.map(({ serial }) => ({
    serial, link: links.find((l) => l.lightsDetails().some((b) => b.serial === serial && b.state === 'ready')) || null
  }))
  return { routed, ready: routed.length > 0 && routed.every((b) => b.link), waiting: routed.filter((b) => !b.link).map((b) => b.serial) }
}

// Two links reach a same block but not the same row: one of them still holds the topology from before a split
// or a snap-on (the other's poll came first). Neither row is the real one yet.
export function rowsDisagree(infos) {
  const rows = infos.filter(Boolean).map((i) => i.blocks.map((b) => b.serial).filter(Boolean))
  return rows.some((p, k) => rows.slice(k + 1).some((q) =>
    p.some((s) => q.includes(s)) && (p.length !== q.length || p.some((s) => !q.includes(s)))))
}

// A joined block no link owns (two snapped blocks, only one's Bluetooth port connected) never gets
// ready, and the ready one's program keeps its keys black: the app waits this long for the row, then gives up.
export const ROW_LIGHTS_TIMEOUT_MS = 8000
export class RowLightsWait {
  constructor({ timers = globalThis, ms = ROW_LIGHTS_TIMEOUT_MS, onExpire = () => {} } = {}) {
    this.t = timers
    this.ms = ms
    this.onExpire = onExpire
    this.key = ''           // the row waited for, '' for none
    this.timer = null
    this.expired = false
  }
  // Another row (or none) starts the count again.
  wait(key = '') {
    if (key === this.key) return
    this.key = key
    if (this.timer != null) this.t.clearTimeout(this.timer)
    this.timer = null
    if (!key) return
    this.timer = this.t.setTimeout(() => { this.timer = null; this.expired = true; this.onExpire() }, this.ms)
  }
  reset() { this.wait(''); this.expired = false }
}
