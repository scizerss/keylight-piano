// Key lights for the PartyKeys family (PartyKeys 36, PartyStudio / SAM5704 relay, PopuPiano 29).
//
// The wire protocol comes from the MIT PartykeysProtocol bundle vendored in ./partykeys/ (see
// LICENSES/PartykeysProtocol-MIT.txt). This file is our own controller on top of it: it takes the
// structured target Keylight already knows (note -> hand / dim / rgb) and writes it as SysEx.
//
// Rules that never bend:
//  - Only SysEx leaves this file. A Note On to these ports lights a key, but the firmware echoes it
//    back as a key press, which would be scored. Every frame goes through checkedFrame (F0 .. F7,
//    7-bit data), so no 0x8n / 0x9n / 0xAn byte can appear in one.
//  - palette71 copies upstream's verified init and pacing byte for byte: mode, 8 ms, clear, 120 ms,
//    query, then at most 3 [note, slot] pairs per frame, 8 ms apart, deltas recomputed after each write.
//  - A send that throws stops everything and reports 'error'. No retry loop: the caller rebuilds.
//  - Notes the keyboard can't show are dropped before encoding (upstream throws instead), so a chord
//    that moved out of range never leaves the previous one lit.

import { createKeyboardRouting } from './partykeys/partykeys-routing.mjs'
import { checkedFrame, deviceKind, lightingInputIds } from './partykeys/partykeys-lights.mjs'
import { connectedPorts, lightingSysexAvailable } from './partykeys/connect-lighting.mjs'

const PACE = 8 // ms between frames: the relay's BLE hop drops anything faster
const SETTLE = 120 // ms after the mode switch and clear before the first query
const MAX_PAIRS = 3 // [note, slot] pairs per palette71 frame (a 16 byte SysEx)
const RGB_FRAME_MAX = 64 // keep rgb15 frames small for the same BLE hop
const DEFAULT_LOW = 48
const DEFAULT_HIGH = 83
const POPU_LOW = 48
const POPU_HIGH = 76
const POPU_CUSTOM_MAX = 64 // keeps the 1E upload under checkedFrame's 256 byte limit (4 + 64 colours = 210)
const DIM = 0.35 // dim (upcoming) brightness for the rgb profiles
const SLOT_ONE = 8 // the one colour upstream verified on the relay
const SLOT_RIGHT = 1
const SLOT_LEFT = 5

const RIGHT_RGB = [255, 96, 64]
const LEFT_RGB = [64, 160, 255]

const range = (count) => Array.from({ length: count }, (_, i) => i)
const pk = (channel, address, body) => [0xf0, 5, 0x30, channel, address, 0x20, 0, ...body, 0xf7]
const MODE_PALETTE = [0xf0, 0x7f, 0x30, 0x7f, 0x7f, 0x20, 0, 0x0f, 5, 0xf7] // upstream: all-device head + mode 05
const MODE_RGB = pk(0x7f, 0x7f, [0x0f, 1])
const OFF_PALETTE = pk(0x7f, 0x7f, [0x71, 0])
const OFF_RGB = pk(0x7f, 0x7f, [0x15, 1, 0, 0, 0, 0, 0, 0, 36, ...range(36)])
const OFF_POPU = [0xf0, 3, 0x20, 29, ...range(29).flatMap((i) => [i, 0]), 0xf7]

const enc = (v) => [v >> 7, v & 127] // CMD 15: each 0-255 channel as (high, low), as the protocol documents
// The key LEDs show low levels far too brightly (no gamma curve in the firmware): on the owner's PartyKeys 36, 2026-11-27,
// orange (255, 138, 61) came out violet because its small blue part swamped it, while (255, 128, 0) was orange. Screen colours
// are sRGB, so they go through a 2.6 gamma before they are sent: orange becomes (255, 52, 6) and the hand blue (6, 53, 255).
const GAMMA = 2.6
const ledLevel = (v) => Math.round(255 * Math.pow(Math.max(0, Math.min(255, v)) / 255, GAMMA))
const scale7 = (v) => Math.min(127, Math.round(v / 2))
const dimmed = (rgb) => rgb.map((v) => Math.round(v * DIM))

const defaultClock = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) }

// 'palette71' (relay, and the default for a PartyKeys), 'rgb15-capable' (a direct PartyKeys: palette71
// by default, per-key RGB when asked), 'popu' (PopuPiano) or null.
export function partyProfileFor(port) {
  if (!port) return null
  const raw = `${port.name ?? ''} ${port.manufacturer ?? ''}`
  const kind = deviceKind(port)
  if (kind === 'popupiano' || /popu\s*piano/i.test(raw)) return 'popu'
  if (kind === 'partykeys') return 'rgb15-capable'
  if (kind === 'partystudio') return 'palette71'
  return null
}

const MODES = ['one', 'hands', 'rgb']

// What a controller would be, without starting anything. The caller compares `signature` with the live
// controller's before rebuilding, so port opens and first sends (which fire onstatechange) never abort
// a 120 ms init.
export function planParty({ output, inputs, outputs, sysexGranted, access, mode, colors } = {}) {
  const family = partyProfileFor(output)
  const wanted = MODES.includes(mode) ? mode : 'one'
  const sysex = access ? lightingSysexAvailable(access, sysexGranted === true) : sysexGranted === true
  let profile = null
  let effective = wanted
  if (family === 'popu') profile = 'popu'
  else if (family === 'rgb15-capable' && wanted === 'rgb') profile = 'rgb15'
  else if (family) { profile = 'palette71'; if (wanted === 'rgb') effective = 'one' } // rgb is for a direct PartyKeys only
  const outs = connectedPorts(outputs)
  const index = outs.indexOf(output)
  const outputId = output ? (output.id ?? (index >= 0 ? `output-${index}` : 'output')) : null
  const inputIds = profile && profile !== 'popu' ? lightingInputIds(output, connectedPorts(inputs), outs) : []
  let reason = null
  let message = ''
  if (!profile) { reason = 'unsupported'; message = 'Key lights unavailable: not a supported keyboard' }
  else if (typeof output?.send !== 'function' || output.state === 'disconnected') { reason = 'no-output'; message = 'Key lights unavailable: no MIDI output' }
  else if (!sysex) { reason = 'no-sysex'; message = 'The keyboard plays, but key lights need MIDI SysEx access.' }
  else if (profile !== 'popu' && !inputIds.length) { reason = 'unpaired'; message = 'Key lights unavailable: input not paired' }
  const sig = { outputId, inputIds, profile, mode: effective, sysexGranted: sysex }
  // hand colours change what 1E uploads, so they count for PopuPiano; the other profiles use fixed palettes
  if (profile === 'popu') sig.colors = [cleanRgb(colors?.right) ?? RIGHT_RGB, cleanRgb(colors?.left) ?? LEFT_RGB]
  const signature = JSON.stringify(sig)
  return { profile, family, mode: effective, outputId, inputIds, sysex, available: !reason, reason, message, signature }
}

function cleanRgb(value) {
  if (!Array.isArray(value) || value.length !== 3) return null
  const out = []
  for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(value[i])) return null // also catches holes in a sparse array
    out.push(Math.max(0, Math.min(255, Math.round(value[i]))))
  }
  return out
}

// A Map note -> {hand, dim, rgb, held}, or any iterable of notes, as a sorted [note, spec] list. Anything that
// isn't an integer note is dropped; nothing here throws.
function normalise(target) {
  const out = new Map()
  const add = (note, spec) => {
    if (!Number.isInteger(note)) return
    const s = spec && typeof spec === 'object' ? spec : {}
    out.set(note, { hand: s.hand === 'left' || s.hand === 'right' ? s.hand : null, dim: s.dim === true, rgb: cleanRgb(s.rgb), held: s.held === true })
  }
  if (target instanceof Map) for (const [note, spec] of target) add(note, spec)
  else if (target && typeof target[Symbol.iterator] === 'function') for (const note of target) add(note, null)
  return [...out].sort((a, b) => a[0] - b[0])
}

export function createPartyLights(opts = {}) {
  const { output, onStatus = () => {}, onRange = () => {}, clock = defaultClock } = opts
  const plan = planParty(opts)
  const { profile, mode, inputIds, available } = plan
  const paired = new Set(inputIds)
  const popuColors = {
    right: cleanRgb(opts.colors?.right) ?? RIGHT_RGB,
    left: cleanRgb(opts.colors?.left) ?? LEFT_RGB,
  }

  let alive = true
  let opened = false
  let ready = false
  let failed = false
  let timer
  let sent = '' // signature of the last target fully written
  let needsClear = false
  let paletteDirty = false
  let popuStale = false // the palette was rebuilt under lit lamps
  let state = available ? 'starting' : 'unavailable'
  let detail = available ? '' : plan.message
  let frames = 0
  let rawTarget = [] // sorted [note, spec], re-filtered whenever the range changes
  let desired = new Map() // note -> { key, slot?, rgb? } after range filtering
  let desiredSig = ''
  const written = new Map() // note -> key actually written (a key changes colour by being rewritten)
  const controls = []
  const popuSlots = new Map() // 'r,g,b' -> slot 5.. (stable until the table fills)

  // ---- range -------------------------------------------------------------------------------------
  let info = { low: DEFAULT_LOW, high: DEFAULT_HIGH, units: 0, octave: 0 }
  if (profile === 'popu') info = { low: POPU_LOW, high: POPU_HIGH, units: 1, octave: 0 }
  let routedNotes = null // Set of notes some discovered unit covers; null before discovery
  const unitLows = new Map() // 'channel:address' -> lowest MIDI note of that unit

  function rescan() {
    if (!routing) return
    const units = new Map()
    const routed = new Set()
    for (let n = 0; n <= 127; n++) {
      const r = routing.route(n)
      if (r.address === 0x7f) continue
      routed.add(n)
      const key = `${r.channel}:${r.address}`
      const u = units.get(key) ?? { channel: r.channel, address: r.address, min: n, max: n }
      u.max = n
      units.set(key, u)
    }
    unitLows.clear()
    let next
    if (!units.size) {
      routedNotes = null
      next = { low: DEFAULT_LOW, high: DEFAULT_HIGH, units: 0, octave: 0 }
    } else {
      routedNotes = routed
      let primary
      for (const [key, u] of units) {
        // A unit's window is 36 keys wide. A short scan means a neighbour or note 0 cut its bottom off
        // (real low = max - 35); a neighbour or note 127 cutting the top off leaves the low where it is.
        const other = (n) => { const r = routing.route(n); return r.address !== 0x7f && `${r.channel}:${r.address}` !== key }
        const bottomCut = u.min === 0 || other(u.min - 1)
        const topCut = u.max === 127 || other(u.max + 1)
        const low = u.max - u.min < 35 && bottomCut && !topCut ? u.max - 35 : u.min
        unitLows.set(key, low)
        if (!primary || u.address < primary.address || (u.address === primary.address && u.channel < primary.channel)) primary = { ...u, low }
      }
      next = {
        low: Math.min(...routed),
        high: Math.max(...routed),
        units: units.size,
        octave: Math.round((primary.low - 48 - (primary.address - 0x3f) * 36) / 12),
      }
    }
    const changed = next.low !== info.low || next.high !== info.high || next.units !== info.units || next.octave !== info.octave
    info = next
    if (changed && alive && !failed) {
      try { onRange({ ...info }) } catch { /* a listener bug must not stop the lights */ }
    }
  }

  const allowed = (note) => {
    if (profile === 'popu') return note >= POPU_LOW && note <= POPU_HIGH
    if (routedNotes) return routedNotes.has(note)
    return note >= DEFAULT_LOW && note <= DEFAULT_HIGH
  }
  const unitFor = (note) => {
    const r = routing ? routing.route(note) : { channel: 0x7f, address: 0x7f }
    return { channel: r.channel, address: r.address, low: unitLows.get(`${r.channel}:${r.address}`) ?? DEFAULT_LOW }
  }

  // ---- target -> per profile values --------------------------------------------------------------
  function paletteSlot(spec) {
    if (spec.dim) return 0 // upcoming notes aren't lit on the relay: only the verified now-colour is
    if (mode === 'hands') return spec.hand === 'right' ? SLOT_RIGHT : spec.hand === 'left' ? SLOT_LEFT : SLOT_ONE
    return SLOT_ONE
  }

  function rgbFor(spec) {
    const base = spec.rgb ?? (spec.hand === 'left' ? LEFT_RGB : RIGHT_RGB)
    // dimmed in screen space by DIM^(1/GAMMA), so after the LED gamma an upcoming key is DIM as bright, not DIM^2.6 (nearly off)
    const rgb = spec.dim ? base.map((v) => Math.round(v * Math.pow(DIM, 1 / GAMMA))) : base
    return rgb[0] + rgb[1] + rgb[2] ? rgb : null
  }

  function popuHandSlot(spec) {
    const left = mode !== 'one' && spec.hand === 'left'
    return (spec.dim ? 3 : 1) + (left ? 1 : 0)
  }

  function popuPaletteColors() {
    const colors = [popuColors.right, popuColors.left, dimmed(popuColors.right), dimmed(popuColors.left)]
    for (const key of popuSlots.keys()) colors.push(key.split(',').map(Number))
    return colors
  }

  function build() {
    const next = new Map()
    if (profile === 'palette71') {
      for (const [note, spec] of rawTarget) {
        if (!allowed(note)) continue
        const slot = paletteSlot(spec)
        if (slot) next.set(note, { key: slot, slot })
      }
    } else if (profile === 'rgb15') {
      for (const [note, spec] of rawTarget) {
        if (!allowed(note)) continue
        const rgb = rgbFor(spec)
        if (rgb) next.set(note, { key: rgb.join(',') + (spec.held ? ':held' : ''), rgb })
      }
    } else if (profile === 'popu') {
      const wanted = []
      for (const [note, spec] of rawTarget) {
        if (!allowed(note)) continue
        const rgb = mode === 'rgb' && spec.rgb ? (spec.dim ? dimmed(spec.rgb) : spec.rgb) : null
        if (rgb && !(rgb[0] + rgb[1] + rgb[2])) continue // a black colour is an unlit key, not the hand colour
        wanted.push([note, spec, rgb ? rgb.join(',') : null])
      }
      const fresh = [...new Set(wanted.map((w) => w[2]).filter((k) => k && !popuSlots.has(k)))]
      if (popuSlots.size + fresh.length > POPU_CUSTOM_MAX) {
        // table full: start over with only what is lit now (at most 29 colours), and upload it again
        popuSlots.clear()
        for (const k of new Set(wanted.map((w) => w[2]).filter(Boolean))) popuSlots.set(k, 5 + popuSlots.size)
        paletteDirty = true
        // slot numbers now mean other colours: the lit lamps are stale, so the next frame must be sent
        // whatever it holds (even all zeros). `written` keeps saying what is physically lit.
        popuStale = true
        sent = 'unset'
      } else {
        for (const k of fresh) { popuSlots.set(k, 5 + popuSlots.size); paletteDirty = true }
      }
      for (const [note, spec, rgbKey] of wanted) {
        const slot = rgbKey ? popuSlots.get(rgbKey) : popuHandSlot(spec)
        next.set(note, { key: slot, slot })
      }
    }
    desired = next
    desiredSig = [...next].map(([n, v]) => `${n}:${v.key}`).join(',')
  }

  // ---- sending -----------------------------------------------------------------------------------
  const later = (fn, ms) => {
    timer = clock.set(() => { timer = undefined; if (alive && !failed) fn() }, ms)
  }

  function fail(error) {
    if (failed) return
    failed = true
    state = 'error'
    detail = error instanceof Error ? error.message : String(error)
    if (timer !== undefined) { clock.clear(timer); timer = undefined }
    controls.length = 0
    routing?.dispose() // its query / requery timers must not outlive a failed controller
    try { onStatus('error', detail) } catch { /* ignore */ }
  }

  // The host's own send may fail later (Android and iOS send over an async RPC). It reports to the controller that made the send, via the
  // third argument (ignored by Web MIDI), so another controller's late failure, or any unrelated host error, never fails this one.
  const sendFailed = (e) => { if (alive) fail(e) }
  function send(frame) {
    try {
      const result = output.send(checkedFrame(frame), undefined, sendFailed)
      frames++
      // Android's send is an async RPC: a rejection is a failure too, not an unhandled one
      if (result && typeof result.then === 'function') result.then(undefined, (e) => { if (alive) fail(e) })
      return true
    } catch (error) {
      fail(error)
      return false
    }
  }

  const routing = available && (profile === 'palette71' || profile === 'rgb15') ? createKeyboardRouting((frame) => {
    if (!alive || failed) return false
    controls.push(frame)
    flush()
    return true
  }, () => {
    // Routes or octave changed: whatever is lit sits on the old addresses. Clear, then restore the CURRENT target.
    needsClear = true
    sent = 'unset'
    rescan()
    build()
    flush()
  }, clock) : null

  const offFrame = () => (profile === 'popu' ? OFF_POPU : profile === 'rgb15' ? OFF_RGB : OFF_PALETTE)

  function nextPalette() {
    if (!desired.size) return written.size ? { bytes: OFF_PALETTE, clear: true } : null
    const off = [...written.keys()].filter((n) => !desired.has(n)).sort((a, b) => a - b).map((n) => [n, 0])
    const on = [...desired].filter(([n, v]) => written.get(n) !== v.slot).map(([n, v]) => [n, v.slot])
    const pairs = [...off, ...on]
    if (!pairs.length) return null
    const groups = new Map()
    for (const pair of pairs) {
      const u = unitFor(pair[0])
      const key = `${u.channel}:${u.address}`
      const g = groups.get(key) ?? { channel: u.channel, address: u.address, pairs: [] }
      g.pairs.push(pair)
      groups.set(key, g)
    }
    const first = [...groups.values()].sort((a, b) => a.address - b.address || a.channel - b.channel)[0]
    const chunk = first.pairs.slice(0, MAX_PAIRS)
    return { bytes: pk(first.channel, first.address, [0x71, chunk.length, ...chunk.flat()]), pairs: chunk }
  }

  function nextRgb() {
    if (!desired.size) return written.size ? { bytes: OFF_RGB, clear: true } : null
    const off = [...written.keys()].filter((n) => !desired.has(n)).sort((a, b) => a - b).map((n) => [n, null])
    const on = [...desired].filter(([n, v]) => written.get(n) !== v.key).map(([n, v]) => [n, v])
    const all = [...off, ...on]
    if (!all.length) return null
    const units = new Map()
    for (const pair of all) {
      const u = unitFor(pair[0])
      const key = `${u.channel}:${u.address}`
      const entry = units.get(key) ?? { ...u, groups: new Map() }
      const rgb = pair[1]?.rgb || [0, 0, 0]
      const colour = rgb.join(',')
      const group = entry.groups.get(colour) ?? { rgb, keys: [], pairs: [] }
      group.keys.push(pair[0] - u.low)
      group.pairs.push(pair)
      entry.groups.set(colour, group)
      units.set(key, entry)
    }
    const unit = [...units.values()].sort((a, b) => a.address - b.address || a.channel - b.channel)[0]
    // one frame: as many colour groups as fit in RGB_FRAME_MAX bytes (header 8 + count 1 + F7 1 + 7 per group + keys)
    const chosen = []
    let size = 10
    for (const group of unit.groups.values()) {
      const cost = 7 + group.keys.length
      if (chosen.length && size + cost > RGB_FRAME_MAX) break
      chosen.push(group)
      size += cost
    }
    const body = [0x15, chosen.length]
    const pairs = []
    for (const g of chosen) {
      body.push(...enc(ledLevel(g.rgb[0])), ...enc(ledLevel(g.rgb[1])), ...enc(ledLevel(g.rgb[2])), g.keys.length, ...g.keys)
      pairs.push(...g.pairs)
    }
    return { bytes: pk(unit.channel, unit.address, body), pairs }
  }

  function nextPopu() {
    const same = written.size === desired.size && [...desired].every(([n, v]) => written.get(n) === v.key)
    if (same && !popuStale) return null
    const slots = new Array(29).fill(0)
    for (const [n, v] of desired) slots[n - POPU_LOW] = v.slot
    return { bytes: [0xf0, 3, 0x20, 29, ...slots.flatMap((s, i) => [i, s]), 0xf7], replace: true }
  }

  const paletteFrame = () => {
    const colors = popuPaletteColors()
    return [0xf0, 3, 0x1e, colors.length, 1, ...colors.flatMap((c) => c.map(scale7)), 0xf7]
  }

  function apply(next) {
    if (next.clear) { popuStale = false; written.clear() }
    else if (next.replace) { popuStale = false; written.clear(); for (const [n, v] of desired) written.set(n, v.key) }
    else for (const [n, v] of next.pairs) {
      if (v === 0 || v === null) written.delete(n)
      else written.set(n, profile === 'rgb15' ? v.key : v)
    }
  }

  function flush() {
    if (!alive || !ready || failed || timer !== undefined) return
    try {
      if (controls.length) {
        if (send(controls.shift())) later(flush, PACE)
        return
      }
      if (needsClear) {
        if (send(offFrame())) { written.clear(); sent = ''; needsClear = false; later(flush, PACE) }
        return
      }
      if (profile === 'popu' && paletteDirty) {
        if (send(paletteFrame())) { paletteDirty = false; later(flush, PACE) }
        return
      }
      if (desiredSig === sent) return
      const next = profile === 'rgb15' ? nextRgb() : profile === 'popu' ? nextPopu() : nextPalette()
      if (next && !send(next.bytes)) return
      if (next) apply(next)
      // Recompute the next chunk from what was ACTUALLY written, never from a stale queue: a rapid chord
      // change or a pause safely supersedes a half-sent target.
      // schedule first: a listener that calls set() or dispose() must find the pacing timer already in place
      if (next) later(flush, PACE)
      if (written.size === desired.size && [...desired].every(([n, v]) => written.get(n) === v.key)) {
        sent = desiredSig
        state = 'sent'
        try { onStatus('sent') } catch { /* ignore */ }
      } else if (next) {
        sent = 'unset' // half written: the old signature no longer describes the keys, so a target equal to it must still be sent
      }
    } catch (error) {
      fail(error)
    }
  }

  function initialize() {
    if (!alive || failed) return
    opened = true
    const settle = () => { ready = true; state = 'ready'; try { onStatus('ready') } catch { /* ignore */ } routing?.query(); flush() }
    if (profile === 'popu') {
      if (!send(paletteFrame())) return
      paletteDirty = false
      later(() => {
        if (!send(OFF_POPU)) return
        later(settle, PACE)
      }, PACE)
      return
    }
    if (!send(profile === 'rgb15' ? MODE_RGB : MODE_PALETTE)) return
    later(() => {
      if (!send(offFrame())) return
      // mode settle before discovery and lighting; not a measured physical latency
      later(settle, SETTLE)
    }, PACE)
  }

  if (available) {
    try {
      if (typeof output.open === 'function') {
        // a rebuild on the same port (a colour change) disposed the old controller a moment ago, and open() is already open: the mode
        // frame waits one pace behind that clear, or the relay's BLE hop can drop it and leave the keyboard in the old mode
        void Promise.resolve(output.open()).then(() => { if (alive && !failed) later(initialize, PACE) }).catch((error) => { if (alive) fail(error) })
      } else initialize()
    } catch (error) {
      fail(error)
    }
  }

  return {
    profile,
    mode,
    available,
    inputIds: [...inputIds],
    signature: plan.signature,
    set(target) {
      if (!alive || failed || !available) return
      rawTarget = normalise(target)
      build()
      flush()
    },
    off() {
      if (!alive || failed || !available) return
      rawTarget = []
      build()
      // a clear is only worth sending when something may be lit: an empty target never spams 71 00
      if (written.size || sent !== '') needsClear = true
      flush()
    },
    receive(bytes, inputId) {
      if (!alive || failed || !available || !routing || !paired.has(inputId)) return
      routing.receive(bytes, inputId)
    },
    // The host's own MIDI error event (Android reports send failures asynchronously) lands here.
    reportError(error) {
      if (alive && available) fail(error)
    },
    status() {
      return {
        state, detail, profile, mode, available, outputId: plan.outputId, inputIds: [...inputIds],
        reason: plan.reason, frames, lit: written.size, range: { ...info },
      }
    },
    dispose() {
      if (!alive) return
      if (timer !== undefined) { clock.clear(timer); timer = undefined }
      routing?.dispose()
      controls.length = 0
      // best effort: leave no key lit. Skipped after a failed send (the port is most likely gone).
      const clear = opened && !failed
      alive = false
      state = 'disposed'
      if (clear) {
        try {
          const r = output.send(checkedFrame(offFrame()), undefined, sendFailed)
          if (r && typeof r.then === 'function') r.then(undefined, () => {})
        } catch { /* best effort: a dying port must not raise an error status after dispose */ }
      }
    },
  }
}
