// renderer/blocks.js against bytes captured on two joined LUMI Keys (.omc/redesign/research-hw.md, 2026-11-23).
const assert = require('node:assert/strict')

const hex = (s) => s.trim().split(/\s+/).map((b) => parseInt(b, 16))
const show = (a) => a.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')

// The topology reply: LKBP14… idx 61 (USB, left) port 7 <-> LKB5KX… idx 15 port 0 (right).
const TOPOLOGY = hex('F0 00 21 10 77 7D 00 00 00 00 10 10 40 20 00 66 25 21 68 18 1A 66 60 66 1A 66 6B 20 25 61 6B 1E 17 73 52 30 6D 12 16 75 73 15 0C 51 0D 14 15 0D 6D 43 5F 77 3C 00 06 3D 06 31 2E 33 2E 35 00 06 0F 06 31 2E 33 2E 34 00 07 3D 01 00 07 0F 01 00 6F F7')
const ACK15 = hex('F0 00 21 10 77 4F 00 00 00 00 20 00 00 6D F7')
const ACK61 = hex('F0 00 21 10 77 7D 00 00 00 00 20 00 00 6D F7')
const ACK15_COUNTED = hex('F0 00 21 10 77 4F 00 00 00 00 20 50 00 5D F7')
const IDENTITY = hex('F0 7E 7F 06 02 00 21 10 02 00 06 00 01 03 05 00 F7')
// config replies (type 0x18, cmd 4: item, value, min, max)
const CFG = {
  mode61: hex('F0 00 21 10 77 7D 00 00 00 00 00 43 28 04 00 00 00 00 00 00 00 00 18 00 00 00 00 7C F7'),
  global61: hex('F0 00 21 10 77 7D 00 00 00 00 00 43 44 00 00 00 60 3F 00 00 00 00 7C 7F 7F 7F 3F 65 F7'),
  scheme100: hex('F0 00 21 10 77 7D 00 00 00 00 00 43 48 01 00 00 00 00 00 00 00 00 20 00 00 00 00 2B F7'),
  scheme107: hex('F0 00 21 10 77 7D 00 00 00 00 00 43 56 05 00 00 00 00 00 00 00 00 20 00 00 00 00 15 F7'),
  topo15: hex('F0 00 21 10 77 4F 00 00 00 00 00 43 10 08 00 00 00 00 7A 7F 7F 7F 67 00 00 00 00 52 F7'),
  octave15: hex('F0 00 21 10 77 4F 00 00 00 00 00 43 08 00 00 00 00 00 7E 7F 7F 7F 1F 00 00 00 00 2E F7')
}

async function main() {
  const B = await import('../renderer/blocks.js')

  // packets the host sends, byte for byte as measured / documented
  assert.equal(show(B.topologyRequest(0)), 'F0 00 21 10 77 00 01 01 00 5D F7')
  assert.equal(show(B.pingPacket(0)), 'F0 00 21 10 77 00 01 03 00 63 F7')
  assert.equal(show(B.configRequest(0, 4)), 'F0 00 21 10 77 00 10 01 00 00 00 00 08 00 29 F7')
  assert.equal(show(B.configRequest(0, 8)), 'F0 00 21 10 77 00 10 01 00 00 00 00 10 00 41 F7')
  assert.equal(show(B.configRequest(15, 36)), 'F0 00 21 10 77 0F 10 01 00 00 00 00 48 00 69 F7', 'another block: same checksum')
  assert.equal(show(B.configRequest(0, [20, 34, 35, 100, 107])), 'F0 00 21 10 77 00 10 01 00 00 00 00 28 40 04 00 00 00 00 10 02 12 00 00 00 00 60 08 48 00 00 00 00 00 64 20 02 00 00 00 00 2C 03 6B F7')
  assert.equal(show(B.configSet(0, 4, 0)), 'F0 00 21 10 77 00 10 40 00 00 00 00 00 00 78 F7')
  assert.equal(show(B.configSet(0, 4, -1)), 'F0 00 21 10 77 00 10 40 60 7F 7F 7F 7F 03 23 F7')
  assert.equal(show(B.configSet(0, 34, B.BLACK)), 'F0 00 21 10 77 00 10 20 04 00 00 00 7E 03 21 F7')
  assert.equal(show(B.configSet(0, 35, B.BLACK)), 'F0 00 21 10 77 00 10 30 04 00 00 00 7E 03 31 F7')
  assert.equal(show(B.configSet(0, 36, 100)), 'F0 00 21 10 77 00 10 40 04 19 00 00 00 00 2D F7')
  assert.equal(show(B.configSet(0, 20, 1).slice(0, 14)), 'F0 00 21 10 77 00 10 40 22 00 00 00 00 00', 'mode slot 1 (LUMI-lights: 10 40 22)')
  assert.equal(show(B.programEventPacket(15, 2, 72, 0xffff0000)), 'F0 00 21 10 77 0F 03 02 00 00 00 00 09 00 00 00 00 00 78 7F 1F 53 F7')
  // checksum: c = len; c = c*3 + b
  assert.equal(B.checksum([0x01, 0x01, 0x00]), 0x5d)
  assert.equal(B.checksum([0x10, 0x20, 0x04, 0, 0, 0, 0x7e, 0x03]), 0x21)

  // topology: 2 blocks, 1 link, 61 left (master), 15 right
  const p = B.parsePacket(TOPOLOGY)
  assert.ok(p.ok && p.fromDevice && p.index === 61)
  const t = p.messages[0]
  assert.equal(t.type, 'topology')
  assert.equal(t.devices.length, 2)
  assert.deepEqual(t.devices.map((d) => d.index), [61, 15])
  assert.ok(t.devices[0].serial.startsWith('LKBP14') && t.devices[1].serial.startsWith('LKB5KX'))
  assert.deepEqual([t.devices[0].battery, t.devices[1].battery], [14, 30])
  assert.deepEqual(t.links, [{ a: 61, portA: 7, b: 15, portB: 0 }])
  assert.deepEqual(p.messages.filter((m) => m.type === 'version').map((m) => [m.index, m.text]), [[61, '1.3.5'], [15, '1.3.4']])
  const asm = new B.TopologyAssembler()
  const info = B.clusterInfo(asm.feed(p))
  assert.equal(info.keys, 48)
  assert.ok(info.joined)
  assert.equal(info.master, 61)
  assert.deepEqual(info.indices, [61, 15], 'left to right')
  assert.deepEqual(info.models, ['keys24', 'keys24'])
  assert.deepEqual(info.offsets, [0, 2], 'the firmware moves the right block up 2 octaves itself')
  assert.equal(info.blocks[0].firmware, '1.3.5')
  const fromDevice = (index, fields) => {
    const body = B.pack7([[0, 32], ...fields])
    return [...B.ROLI_SYSEX, 0x40 | index, ...body, B.checksum(body), 0xf7]
  }
  const buttonWithAck = fromDevice(15, [[0x20, 7], [17, 5], [0xabc, 12], [2, 7], [5, 10]])
  assert.deepEqual(B.parsePacket(buttonWithAck, true).messages,
    [{ type: 'button', id: 0xabc, action: 'press' }, { type: 'ack', counter: 5 }])
  assert.deepEqual(B.parsePacket(fromDevice(15, [[0x21, 7], [9, 5], [4, 12]]), true).messages,
    [{ type: 'button', id: 4, action: 'release' }])
  assert.deepEqual(B.parsePacket(fromDevice(15, [[0x20, 7], [17, 5]]), true).messages, [])
  // the same row reported the other way round still orders left to right
  assert.deepEqual(B.orderBlocks([{ index: 15 }, { index: 61 }], [{ a: 15, portA: 0, b: 61, portB: 7 }]).map((d) => d.index), [61, 15])
  assert.deepEqual(B.topologyOffsets(3), [-2, 0, 2])
  assert.deepEqual(B.topologyOffsets(4), [-2, 0, 2, 4])

  // models from the serial prefix
  assert.equal(B.modelFromSerial('LKBP14XXXXXXXXXX'), 'keys24')
  assert.equal(B.modelFromSerial('RP4ABCDEF'), 'piano49')
  assert.equal(B.modelFromSerial('LPB123'), null)
  assert.equal(B.clusterInfo({ devices: [{ serial: 'RP4XYZ', index: 3 }], links: [] }).keys, 49)
  assert.equal(B.clusterInfo({ devices: [{ serial: 'LKBXYZ', index: 3 }], links: [] }).joined, false)

  const telemetry = []
  const batteryLink = new B.BlocksLink({ send() {}, onChange: (info, why) => telemetry.push([why, info.blocks[0].battery, info.blocks[0].charging]),
    onButton: (button, serial) => telemetry.push([button.action, button.id, serial]) })
  batteryLink.feed(buttonWithAck)
  assert.deepEqual(telemetry, [], 'buttons before topology have no known source')
  batteryLink.feed(TOPOLOGY)
  batteryLink.feed(buttonWithAck)
  const batteryTopology = (battery, charging) => {
    const device = (d, level, powered) => [...d.serial].map((c) => [c.charCodeAt(0), 7]).concat([[d.index, 7], [level, 5], [powered, 1]])
    return fromDevice(61, [[1, 7], [t.version, 8], [2, 7], [1, 8],
      ...device(t.devices[0], battery, charging), ...device(t.devices[1], 30, t.devices[1].charging), [61, 7], [7, 5], [15, 7], [0, 5]])
  }
  batteryLink.feed(batteryTopology(15, true))
  batteryLink.feed(batteryTopology(15, true))
  assert.deepEqual(telemetry.filter(([why]) => why === 'press' || why === 'battery'),
    [['press', 0xabc, t.devices[1].serial], ['battery', 15, true]])
  batteryLink.stop()

  // ping acks: from-device, type 2
  for (const [bytes, idx] of [[ACK15, 15], [ACK61, 61], [ACK15_COUNTED, 15]]) {
    const a = B.parsePacket(bytes)
    assert.ok(a.ok && a.index === idx && a.messages[0].type === 'ack', show(bytes))
  }
  assert.equal(B.parsePacket(ACK15_COUNTED).messages[0].counter, 5)
  assert.deepEqual(B.parseIdentity(IDENTITY), { roli: true, family: 2, model: 6, version: '1.3.5' })
  assert.equal(B.parsePacket([0x90, 60, 100]), null)

  // config replies
  const cfg = (b) => B.parsePacket(b).messages[0]
  assert.deepEqual([cfg(CFG.mode61).item, cfg(CFG.mode61).value, cfg(CFG.mode61).min, cfg(CFG.mode61).max], [20, 1, 0, 3])
  assert.equal(cfg(CFG.global61).value, B.BLACK)
  assert.deepEqual([cfg(CFG.topo15).item, cfg(CFG.topo15).value, cfg(CFG.topo15).min], [8, 2, -12])
  assert.deepEqual([cfg(CFG.octave15).item, cfg(CFG.octave15).value, cfg(CFG.octave15).min, cfg(CFG.octave15).max], [4, 0, -4, 3])
  assert.equal(cfg(CFG.scheme107).value, B.SCHEME.user)
  // a reply the host never sent, with a bad checksum, is not read
  const bad = [...CFG.mode61]; bad[bad.length - 2] ^= 1
  assert.equal(B.parsePacket(bad).messages.length, 0)

  // colour decisions
  const owner = { 4: 0, 5: 0, 20: 1, 22: 0, 27: 4, 34: B.BLACK, 35: B.BLACK, 36: 100, 100: 0, 107: 1, 114: 2, 115: 0, 121: 3 }
  assert.ok(B.looksBlanked(owner))
  let k = B.keepValues(owner, null)
  assert.equal(k.from, 'defaults', 'black on black is an old Keylight blank: ROLI defaults instead')
  assert.equal(k.values[34], B.ROLI_DEFAULTS[34]); assert.equal(k.values[35], B.ROLI_DEFAULTS[35]); assert.equal(k.values[20], 1)
  const mine = { ...owner, 34: 0xff00ff00 | 0, 35: 0xffff0000 | 0 }
  assert.equal(B.keepValues(mine, null).from, 'read')
  const blankJournal = { dirty: true, values: mine, written: { 34: B.BLACK, 35: B.BLACK } }
  assert.equal(B.keepValues(owner, blankJournal).values[34], mine[34], 'a dirty journal wins over the blank now on the keyboard')
  assert.equal(B.keepValues(owner, { ...blankJournal, dirty: false }).from, 'defaults', 'a clean journal is history only')
  const changed = { ...mine, 34: 0xff123456 | 0 }
  assert.equal(B.keepValues(changed, blankJournal).values[34], changed[34], 'colours changed since (Dashboard): the old journal doesn\'t overwrite them')
  assert.ok(B.journalLive({ ...owner, 4: 3 }, { ...blankJournal, written: { ...blankJournal.written, 4: 0 } }), 'the octave moved by you doesn\'t make the journal stale')
  assert.equal(B.keepValues(owner, null, mine).values[35], mine[35], 'a snapped-on block takes the row\'s saved colours')
  // a power cycle after a crash resets the active mode: the journal still holds your colours
  const modeJournal = { dirty: true, values: { ...mine, 20: 0 }, written: { 20: 1, 34: B.BLACK, 35: B.BLACK } }
  assert.equal(B.keepValues({ ...owner, 20: 0 }, modeJournal).from, 'journal')
  // a restore cut short (34 landed, 35 didn't): still live, so 35 isn't taken as your black
  const half = B.keepValues({ ...owner, 34: mine[34] }, blankJournal)
  assert.equal(half.from, 'journal'); assert.equal(half.values[35], mine[35])
  // a mode outside 0..3 with no User slot doesn't break the writes
  assert.deepEqual(B.darkWrites({ ...mine, 20: 7, 107: 0 })[0], [100, 1])
  // dark: the active slot is already User here, so only the two colours
  assert.deepEqual(B.darkWrites(mine), [[34, B.BLACK], [35, B.BLACK]])
  // active slot Pro: switch to the slot that is User
  assert.deepEqual(B.darkWrites({ ...mine, 20: 0 })[0], [20, 1])
  // no User slot anywhere: that slot's scheme becomes User
  assert.deepEqual(B.darkWrites({ ...mine, 20: 2, 107: 0 })[0], [114, 1])
  // restore: what was written, back to the saved value; the octave only if it is still Keylight's
  assert.deepEqual(B.restoreWrites(mine, { 34: B.BLACK, 35: B.BLACK, 4: 0 }, { 4: 0 }), [[4, 0], [34, mine[34]], [35, mine[35]]])
  assert.deepEqual(B.restoreWrites({ ...mine, 4: 2 }, { 4: 0, 34: B.BLACK }, { 4: 1 }), [[34, mine[34]]], 'you pressed the octave buttons: your octave stays')

  /* ----- the controller, on a fake clock ----- */
  function clock() {
    let now = 0, id = 0
    const due = new Map()
    const add = (fn, ms, every) => { due.set(++id, { at: now + ms, fn, every }); return id }
    return {
      timers: { setTimeout: (fn, ms) => add(fn, ms, 0), clearTimeout: (i) => due.delete(i), setInterval: (fn, ms) => add(fn, ms, ms), clearInterval: (i) => due.delete(i) },
      run(ms) {
        const end = now + ms
        for (;;) {
          let next = null
          for (const [i, d] of due) if (d.at <= end && (!next || d.at < due.get(next).at)) next = i
          if (!next) break
          const d = due.get(next); now = d.at
          if (d.every) d.at += d.every; else due.delete(next)
          d.fn()
        }
        now = end
      }
    }
  }
  const reply = (idx, item, value, min = 0, max = 0) => {
    const body = B.pack7([[0, 32], [0x18, 7], [4, 4], [item, 8], [value, 32], [min, 32], [max, 32]])
    return [0xf0, 0, 0x21, 0x10, 0x77, 0x40 | idx, ...body, B.checksum(body), 0xf7]
  }
  function rig(journal = {}) {
    const c = clock(), sent = [], changes = []
    const store = { get: (s) => journal[s] || null, set: (s, e) => { journal[s] = e && JSON.parse(JSON.stringify(e)) } }
    const link = new B.BlocksLink({ send: (b) => sent.push(b), store, timers: c.timers, onChange: (i, why) => changes.push(why) })
    return { c, sent, changes, link, journal }
  }
  // host->device config sets (type 0x10, cmd 0, item 8 bits, value 32 bits) as [index, item, value]
  const hostSets = (sent) => sent.filter((b) => b[4] === 0x77).map((b) => {
    let bits = 0n
    b.slice(6, b.length - 2).forEach((x, i) => { bits |= BigInt(x) << BigInt(7 * i) })
    if ((bits & 0x7fn) !== 0x10n || ((bits >> 7n) & 0xfn) !== 0n) return null
    return [b[5], Number((bits >> 11n) & 0xffn), Number(BigInt.asIntN(32, (bits >> 19n) & 0xffffffffn))]
  }).filter(Boolean)

  // connect: identity + topology request, then the reply
  let r = rig()
  r.link.start()
  assert.equal(show(r.sent[0]), show(B.IDENTITY_REQUEST))
  assert.equal(show(r.sent[1]), 'F0 00 21 10 77 00 01 01 00 5D F7')
  r.link.feed(TOPOLOGY)
  assert.deepEqual(r.changes, ['connect'])
  assert.equal(r.link.info.keys, 48)
  r.c.run(2000)
  assert.ok(!r.changes.includes('no-reply'))
  // octave read answers
  r.link.feed(reply(61, 4, 0, -4, 3)); r.link.feed(reply(61, 5, 0, -11, 11))
  assert.equal(r.link.lowestNote(), 48)
  // snap off: the next poll's topology has one block
  const one = B.clusterInfo({ devices: [{ serial: 'LKBP14AAAAAAAAAA', index: 61 }], links: [] })
  assert.equal(one.keys, 24)
  // an ack from an unknown index asks for the topology soon
  r.sent.length = 0
  r.link.feed(hex('F0 00 21 10 77 45 00 00 00 00 20 00 00 6D F7'.replace('6D', show([B.checksum([0, 0, 0, 0, 0x20, 0, 0])]))))
  r.c.run(300)
  assert.ok(r.sent.some((b) => show(b) === 'F0 00 21 10 77 00 01 01 00 5D F7'), 'a new block answered: topology again')

  // the owner's case: both blocks black, nothing saved yet
  r = rig()
  r.link.start(); r.link.feed(TOPOLOGY); r.sent.length = 0
  r.link.setDark(true)
  r.c.run(100)
  assert.equal(hostSets(r.sent).length, 0, 'nothing written before the read')
  for (const idx of [61, 15]) for (const [item, v] of Object.entries(owner)) if (B.READ_ITEMS.includes(Number(item))) r.link.feed(reply(idx, Number(item), v))
  const serials = r.link.info.blocks.map((b) => b.serial)
  for (const s of serials) assert.ok(r.journal[s] && r.journal[s].dirty, 'saved and dirty before the writes')
  assert.equal(r.journal[serials[0]].values[34], B.ROLI_DEFAULTS[34], 'black saved values become ROLI defaults')
  assert.equal(r.journal[serials[1]].values[34], B.ROLI_DEFAULTS[34])
  r.c.run(500)
  const dark = hostSets(r.sent)
  assert.deepEqual(dark.filter(([, item]) => item === 34).map(([i]) => i).sort(), [15, 61], 'both blocks go dark')
  assert.ok(!dark.some(([, item]) => item === 4), 'octave already 0: not written')
  // octave buttons pressed later: followed, not fought
  r.link.feed(reply(61, 4, 1, -4, 3))
  assert.equal(r.changes.at(-1), 'octave')
  r.link.feed(reply(61, 4, 2, -4, 3))
  assert.equal(r.changes.at(-1), 'octave')
  assert.equal(r.link.octave, 2)
  // exit: both blocks back, ROLI defaults (the saved black was Keylight's)
  r.sent.length = 0
  r.link.setDark(false)
  r.c.run(500)
  const back = hostSets(r.sent)
  assert.deepEqual(back.filter(([, item]) => item === 34).map(([i, , v]) => [i, v]).sort(), [[15, B.ROLI_DEFAULTS[34]], [61, B.ROLI_DEFAULTS[34]]])
  assert.ok(!back.some(([, item]) => item === 4), 'octave not restored: Keylight never changed it')
  for (const s of serials) assert.equal(r.journal[s].dirty, true, 'dirty until a read shows the restore landed')
  // the keyboard ignored one write (another program on it): that block stays dirty
  for (const it of [34, 35]) r.link.feed(reply(61, it, B.ROLI_DEFAULTS[it]))
  r.link.feed(reply(15, 34, B.ROLI_DEFAULTS[34])); r.link.feed(reply(15, 35, B.BLACK))
  assert.equal(r.journal[serials[0]].dirty, false, 'read back: clean')
  assert.equal(r.journal[serials[1]].dirty, true, 'a write that didn\'t land stays dirty, for next time')

  // your own colours: saved, restored exactly; octave 2 -> 0 while Keylight runs, back to 2 after
  r = rig()
  r.link.start(); r.link.feed(TOPOLOGY)
  r.link.setDark(true)
  const yours = { ...mine, 4: 2 }
  for (const idx of [61, 15]) for (const item of B.READ_ITEMS) r.link.feed(reply(idx, item, yours[item] ?? 0))
  r.c.run(500)
  assert.ok(hostSets(r.sent).some(([i, item, v]) => i === 61 && item === 4 && v === 0), 'octave to 0 on the cabled block')
  r.sent.length = 0
  r.link.release(true)
  const mineBack = hostSets(r.sent)
  assert.ok(mineBack.some(([i, item, v]) => i === 61 && item === 34 && v === mine[34]) && mineBack.some(([i, item, v]) => i === 15 && item === 35 && v === mine[35]))
  assert.ok(mineBack.some(([i, item, v]) => i === 61 && item === 4 && v === 2), 'your octave back')

  // a crash: the journal is still dirty, the keyboard still black. Next launch keeps the journal's values.
  const crashed = {}
  crashed[serials[0]] = { values: mine, written: { 34: B.BLACK, 35: B.BLACK }, dirty: true }
  r = rig(crashed)
  r.link.start(); r.link.feed(TOPOLOGY)
  r.link.repairLeftovers()
  r.c.run(100)
  assert.equal(hostSets(r.sent).length, 0, 'read first')
  for (const item of B.READ_ITEMS) r.link.feed(reply(61, item, owner[item] ?? 0))
  r.c.run(500)
  assert.ok(hostSets(r.sent).some(([i, item, v]) => i === 61 && item === 34 && v === mine[34]), 'not dark this time: put back at once')
  for (const it of [34, 35]) r.link.feed(reply(61, it, mine[it]))
  assert.equal(crashed[serials[0]].dirty, false)
  // a leftover journal while the keyboard already shows other colours: dropped, nothing written
  crashed[serials[0]] = { values: mine, written: { 34: B.BLACK, 35: B.BLACK }, dirty: true }
  r = rig(crashed)
  r.link.start(); r.link.feed(TOPOLOGY); r.link.repairLeftovers()
  for (const item of B.READ_ITEMS) r.link.feed(reply(61, item, changed[item] ?? 0))
  r.c.run(500)
  assert.equal(hostSets(r.sent).length, 0)
  assert.equal(crashed[serials[0]].dirty, false)
  crashed[serials[0]] = { values: mine, written: { 34: B.BLACK, 35: B.BLACK }, dirty: true }
  r = rig(crashed)
  r.link.start(); r.link.feed(TOPOLOGY); r.link.setDark(true)
  for (const idx of [61, 15]) for (const item of B.READ_ITEMS) r.link.feed(reply(idx, item, owner[item] ?? 0))
  assert.equal(crashed[serials[0]].values[34], mine[34], 'dark again: the journal still holds your colours')
  assert.equal(crashed[serials[1]].values[34], mine[34], 'the other block borrows the row\'s colours, not ROLI defaults')

  // A replacement index can be shared by a departing block and a moving one.
  r = rig()
  r.link.start(); r.link.feed(TOPOLOGY)
  const [leftBlock, rightBlock] = r.link.info.blocks
  r.link.putBack(leftBlock, { 34: 111 }, { 34: B.BLACK })
  r.link.putBack(rightBlock, { 34: 222 }, { 34: B.BLACK })
  r.link.onTopology({ devices: [{ ...rightBlock, index: leftBlock.index }], links: [] })
  r.link.feed(reply(leftBlock.index, 34, 222))
  assert.equal(r.link.confirming.size, 0, 'obsolete confirmation is discarded on reassignment')
  assert.equal(r.journal[rightBlock.serial].dirty, true, 'stale reply cannot clean the surviving journal')
  assert.equal(r.link.config.get(leftBlock.index), undefined, 'read sent for the old owner cannot seed the new one')
  r.c.run(500)
  assert.deepEqual(hostSets(r.sent), [[leftBlock.index, 34, 222]], 'writes follow the surviving serial and drop the departing serial')
  r.c.run(B.REPLY_MS)
  for (const item of B.READ_ITEMS) r.link.feed(reply(leftBlock.index, item, item === 34 ? 222 : mine[item] ?? 0))
  assert.equal(r.journal[rightBlock.serial].dirty, false, 'a fresh read reconciles the moved block')

  // a keyboard that never answers the read is never written to
  r = rig()
  r.link.start(); r.link.feed(TOPOLOGY); r.link.setDark(true)
  r.c.run(5000)
  assert.equal(hostSets(r.sent).length, 0)
  assert.ok(r.changes.includes('read-failed'))
  assert.ok(r.sent.some((b) => show(b) === show(B.beginApiPacket(61))), 'tried API mode for the read')
  // no topology at all: the app falls back to the port name
  r = rig()
  r.link.start(); r.c.run(1600)
  assert.ok(r.changes.includes('no-reply'))

  // API mode keep-alive: 400 ms to the cabled block, 1666 ms to the others, stops when asked
  r = rig()
  r.link.start(); r.link.feed(TOPOLOGY); r.sent.length = 0
  r.link.feed(reply(61, 4, 0)); r.link.feed(reply(15, 4, 0))
  r.link.setApi(true)
  r.c.run(2000)
  const pings = r.sent.filter((b) => b[6] === 0x01 && b[7] === 0x03)
  assert.equal(pings.filter((b) => b[5] === 61).length, 5)
  assert.equal(pings.filter((b) => b[5] === 15).length, 1)
  r.link.setApi(false)
  r.sent.length = 0; r.c.run(2000)
  assert.equal(r.sent.filter((b) => b[6] === 0x01 && b[7] === 0x03).length, 0)
  // a read in API mode cut short by leaving: the pings stop too
  r.link.setDark(true); r.c.run(1600)
  assert.ok(r.link.api, 'the read retried in API mode')
  r.link.setDark(false)
  r.sent.length = 0; r.c.run(2000)
  assert.equal(r.sent.filter((b) => b[6] === 0x01 && b[7] === 0x03).length, 0)
  r.link.stop()

  console.log('blocks: ok')
}
main().catch((e) => { console.error(e); process.exit(1) })
