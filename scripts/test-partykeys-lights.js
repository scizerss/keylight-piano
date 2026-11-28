// PartyKeys key lights (renderer/party-lights.js): byte parity with the vendored upstream controller,
// no channel messages ever, range and routing, the three wire profiles, and the dispose / error rules.
// Run beside the upstream tests: node --test scripts/partykeys-upstream/
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.join(__dirname, '..')
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href)

const MODE_PALETTE = [0xf0, 0x7f, 0x30, 0x7f, 0x7f, 0x20, 0, 0x0f, 5, 0xf7]
const OFF_PALETTE = [0xf0, 5, 0x30, 0x7f, 0x7f, 0x20, 0, 0x71, 0, 0xf7]
const QUERY = [0xf0, 5, 0x30, 0x7f, 0x7f, 0x20, 0, 1, 0xf7]
const report = (channel, address, command = 2, value = 1) => [240, 5, 48, 32, 0, channel, address, command, value, 247]

;(async () => {
  const party = await load('renderer/party-lights.js')
  const upstream = await load('renderer/partykeys/partykeys-lights.mjs')
  const { fakeClock } = await load('scripts/partykeys-upstream/midi-light-helpers.mjs')
  const { partyProfileFor, planParty, createPartyLights } = party

  // a port pair the way the hosts expose them; `sent` records [time, frame]
  function rig(name = 'SAM5704', extra = {}) {
    const time = fakeClock()
    const sent = []
    const statuses = []
    const ranges = []
    const input = { id: 'in', name, state: 'connected' }
    const output = { id: 'out', name, state: 'connected', send(frame) { sent.push([time.now(), [...frame]]) }, ...extra.output }
    const base = {
      output, inputs: [input], outputs: [output], sysexGranted: true, clock: time.clock,
      onStatus: (s, d) => statuses.push([s, d]), onRange: (r) => ranges.push(r),
    }
    return { time, sent, statuses, ranges, input, output, base, make: (over = {}) => createPartyLights({ ...base, ...over }) }
  }
  const frames = (r) => r.sent.map((s) => s[1])
  const note = (hand = null, dim = false, rgb = null) => ({ hand, dim, rgb })
  const target = (notes, spec = note()) => new Map(notes.map((n) => [n, spec]))
  const lit = (list) => {
    // what the keys show after replaying palette71 frames (71 frames only)
    const on = new Map()
    for (const f of list) {
      if (f[7] !== 0x71) continue
      if (!f[8]) on.clear()
      for (let i = 9; i < f.length - 1; i += 2) f[i + 1] ? on.set(f[i], f[i + 1]) : on.delete(f[i])
    }
    return on
  }

  // ---- profile detection --------------------------------------------------------------------------
  assert.equal(partyProfileFor({ name: 'PartyKeys 36' }), 'rgb15-capable')
  assert.equal(partyProfileFor({ name: 'Party Keys BLE' }), 'rgb15-capable')
  assert.equal(partyProfileFor({ name: 'PartyStudio One' }), 'palette71')
  assert.equal(partyProfileFor({ name: 'SAM5704 USB MIDI', manufacturer: 'PartyKeys' }), 'palette71', 'the relay is never a direct keyboard')
  assert.equal(partyProfileFor({ name: 'PopuPiano MIDI' }), 'popu')
  assert.equal(partyProfileFor({ name: 'Popu Piano' }), 'popu')
  assert.equal(partyProfileFor({ name: 'LUMI Keys BLOCK' }), null)
  assert.equal(partyProfileFor({ name: 'Bluetooth Speaker' }), null)
  assert.equal(partyProfileFor(null), null)

  // ---- (a) golden parity with upstream palette71 --------------------------------------------------
  // The same script, the same fake clock, through our controller and upstream's. Bytes AND times must match.
  async function parity(label, script) {
    const mine = rig()
    const theirs = { time: fakeClock(), sent: [] }
    const upOut = { send: (f) => theirs.sent.push([theirs.time.now(), [...f]]) }
    const up = upstream.createLightController(upOut, 'palette71', () => {}, theirs.time.clock)
    const ours = mine.make({ mode: 'one' })
    const drive = {
      set: (notes) => { ours.set(target(notes)); up.set(notes) },
      off: () => { ours.off(); up.off() },
      tick: (ms) => { mine.time.tick(ms); theirs.time.tick(ms) },
      receive: (bytes) => { ours.receive(bytes, 'in'); up.receive(bytes, 'in') },
      dispose: () => { ours.dispose(); up.dispose() },
    }
    script(drive)
    assert.ok(theirs.sent.length > 4, `${label}: the script sent something`)
    assert.deepEqual(mine.sent, theirs.sent, `${label}: bytes and timings equal upstream`)
    assert.equal(mine.time.pending(), 0, `${label}: nothing left pending`)
    assert.equal(theirs.time.pending(), 0)
  }

  await parity('default route', (d) => {
    d.set([60, 64, 67, 72]) // before the init finished: held until ready
    d.tick(136) // 8 ms + 120 ms settle, then first frame
    d.tick(7)
    d.set([62, 65, 69, 72, 76]) // rapid change while the old chord is still being paced
    d.tick(3)
    d.set([55, 59, 62]) // and again
    d.tick(100)
    d.set([60, 64, 67, 72]) // back, fully settled
    d.tick(60)
    d.off()
    d.tick(40)
    d.set([48, 50, 52, 53, 55, 57, 59, 60]) // eight notes: three frames
    d.tick(5)
    d.tick(200)
    d.set([48, 50, 52, 53, 55, 57, 59, 60]) // identical: nothing resent
    d.tick(50)
    d.set([83])
    d.tick(30)
    d.off()
    d.tick(30)
    d.set([60, 64, 67, 72])
    d.tick(1)
    d.dispose()
    d.tick(1000)
  })

  await parity('discovered route', (d) => {
    // notes stay inside both the default range (48-83) and the discovered one, so upstream's throw
    // on out-of-range notes never comes into play; the filter's behaviour is covered in (c) and (d)
    d.tick(130)
    d.set([60, 64, 67])
    d.tick(60)
    d.receive(report(2, 0x3f)) // a unit answers on channel 2: frames move off the broadcast address
    d.tick(100)
    d.set([72, 76, 79, 83])
    d.tick(60)
    d.receive(report(2, 0x3f, 0x18, 1)) // octave +1: the unit now covers 60..95
    d.tick(100)
    d.set([60, 64, 67, 72])
    d.tick(60)
    d.receive(report(3, 0x40)) // a second unit above
    d.tick(100)
    d.off()
    d.tick(40)
    d.set([62, 65])
    d.tick(40)
    d.dispose()
    d.tick(500)
  })

  // ---- (b) never a channel message, whatever mode / profile / input ------------------------------
  {
    let seed = 12345
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
    const combos = [
      ['PartyKeys 36', 'one'], ['PartyKeys 36', 'hands'], ['PartyKeys 36', 'rgb'],
      ['SAM5704', 'one'], ['SAM5704', 'hands'], ['SAM5704', 'rgb'],
      ['PopuPiano', 'one'], ['PopuPiano', 'hands'], ['PopuPiano', 'rgb'],
    ]
    for (const [name, mode] of combos) {
      const r = rig(name)
      const c = r.make({ mode })
      for (let i = 0; i < 60; i++) {
        const t = new Map()
        for (let n = rnd(6); n >= 0; n--) {
          const rgb = rnd(2) ? [rnd(256), rnd(256), rnd(256)] : null
          t.set(30 + rnd(80), note([null, 'right', 'left'][rnd(3)], rnd(4) === 0, rgb))
        }
        if (i % 17 === 5) c.off()
        else c.set(t)
        if (i % 11 === 3) c.receive(report(1 + rnd(3), 0x3f + rnd(3), [2, 0x18, 4][rnd(3)], rnd(3)), 'in')
        r.time.tick(10 + rnd(60))
      }
      c.dispose()
      r.time.tick(5000)
      assert.ok(r.sent.length > 5, `${name}/${mode}: sent frames`)
      for (const [, f] of r.sent) {
        assert.equal(f[0], 0xf0, `${name}/${mode}: starts with F0`)
        assert.equal(f.at(-1), 0xf7, `${name}/${mode}: ends with F7`)
        assert.ok(f.slice(1, -1).every((b) => Number.isInteger(b) && b >= 0 && b < 0x80), `${name}/${mode}: 7-bit data only`)
        assert.ok(f.every((b) => b < 0x80 || b === 0xf0 || b === 0xf7), `${name}/${mode}: no 0x8n/0x9n/0xAn status byte`)
      }
    }
  }

  // ---- (c) out-of-range notes: dropped, no error, nothing stays lit -------------------------------
  {
    const r = rig()
    const c = r.make()
    c.set(target([60, 64, 67]))
    r.time.tick(300)
    assert.deepEqual([...lit(frames(r)).keys()], [60, 64, 67])
    c.set(target([84, 90, 20, 127, 47, 60.5]))
    r.time.tick(100)
    assert.deepEqual([...lit(frames(r)).keys()], [], 'the old chord is cleared, not left lit')
    assert.ok(!r.statuses.some((s) => s[0] === 'error'), 'no error')
    c.set(target([47, 60, 84, 83, 48]))
    r.time.tick(100)
    assert.deepEqual([...lit(frames(r)).keys()], [48, 60, 83], 'only the in-range notes light')
    c.set([60, '61', null, NaN, Infinity, 62]) // junk in a plain note list
    r.time.tick(100)
    assert.deepEqual([...lit(frames(r)).keys()], [60, 62])
    c.dispose()

    // an empty target sends 71 00 once at most, however often it is set
    const e = rig()
    const ec = e.make()
    e.time.tick(300)
    const before = e.sent.length
    for (let i = 0; i < 30; i++) { ec.set(new Map()); ec.off(); e.time.tick(16) }
    assert.equal(e.sent.length, before, 'an empty target on a dark keyboard sends nothing')
    ec.set(target([60]))
    e.time.tick(50)
    const after = e.sent.length
    for (let i = 0; i < 30; i++) { ec.set(new Map()); e.time.tick(16) }
    const clears = frames(e).slice(after).filter((f) => JSON.stringify(f) === JSON.stringify(OFF_PALETTE))
    assert.equal(clears.length, 1, 'one 71 00, not one per 60 Hz update')
    ec.dispose()
  }

  // ---- one colour vs hands -------------------------------------------------------------------------
  {
    const r = rig()
    const c = r.make({ mode: 'one' })
    c.set(new Map([[60, note('right')], [64, note('left')], [67, note('right', true)], [72, note(null)]]))
    r.time.tick(300)
    assert.deepEqual(frames(r).find((f) => f[7] === 0x71 && f[8]), [0xf0, 5, 0x30, 0x7f, 0x7f, 0x20, 0, 0x71, 3, 60, 8, 64, 8, 72, 8, 0xf7], "'one': slot 8, dim dropped")
    c.dispose()

    const h = rig()
    const hc = h.make({ mode: 'hands' })
    hc.set(new Map([[60, note('right')], [64, note('left')], [67, note('right', true)], [72, note(null)]]))
    h.time.tick(300)
    const frame = frames(h).find((f) => f[7] === 0x71 && f[8])
    assert.deepEqual(frame, [0xf0, 5, 0x30, 0x7f, 0x7f, 0x20, 0, 0x71, 3, 60, 1, 64, 5, 72, 8, 0xf7], "'hands': right 1, left 5, no hand 8, dim dropped")
    assert.deepEqual([...lit(frames(h))], [[60, 1], [64, 5], [72, 8]])
    // a key changes colour by being rewritten
    hc.set(new Map([[60, note('left')], [64, note('left')], [72, note(null)]]))
    h.time.tick(100)
    assert.deepEqual([...lit(frames(h))], [[60, 5], [64, 5], [72, 8]])
    hc.dispose()
  }

  // ---- (d) routing: range, channel/address, octave, onRange ---------------------------------------
  {
    const r = rig()
    const c = r.make()
    r.time.tick(130) // init done, query out
    assert.deepEqual(frames(r).slice(0, 3), [MODE_PALETTE, OFF_PALETTE, QUERY])
    assert.deepEqual(c.status().range, { low: 48, high: 83, units: 0, octave: 0 }, 'default 36 keys from C3')
    c.set(target([60, 64, 67]))
    r.time.tick(100)
    assert.deepEqual(frames(r).at(-1), [0xf0, 5, 0x30, 0x7f, 0x7f, 0x20, 0, 0x71, 3, 60, 8, 64, 8, 67, 8, 0xf7], 'unrouted: the broadcast address')
    assert.equal(r.ranges.length, 0)

    c.receive(report(2, 0x40), 'other') // another input: ignored
    r.time.tick(100)
    assert.equal(r.ranges.length, 0, 'a report from an unpaired input changes nothing')

    const mark = r.sent.length
    c.receive(report(2, 0x40), 'in') // the unit at address 0x40 sits one unit up: 84..119
    assert.deepEqual(r.ranges, [{ low: 84, high: 119, units: 1, octave: 0 }], 'range widened, onRange fired once')
    r.time.tick(200)
    const after = frames(r).slice(mark)
    assert.deepEqual(after[0], OFF_PALETTE, 'route change clears first')
    assert.deepEqual([...lit(after)], [], 'the old chord (now below the unit) is not restored')
    c.set(target([84, 88, 91, 95, 119, 120, 83]))
    r.time.tick(200)
    const routed = frames(r).slice(mark + after.length).filter((f) => f[7] === 0x71)
    assert.ok(routed.length >= 2 && routed.every((f) => f[3] === 2 && f[4] === 0x40), 'frames carry channel 2 / address 0x40')
    assert.deepEqual([...lit(frames(r))].map((x) => x[0]), [84, 88, 91, 95, 119], '83 and 120 fall outside the unit')

    const mark2 = r.sent.length
    c.receive(report(2, 0x40, 0x18, 0x7f), 'in') // octave -1
    assert.deepEqual(r.ranges.at(-1), { low: 72, high: 107, units: 1, octave: -1 }, 'octave report shifts the range')
    r.time.tick(300)
    assert.deepEqual([...lit(frames(r))].map((x) => x[0]), [83, 84, 88, 91, 95], 'restored on the new range 72..107: 83 comes in (it is still wanted), 119 drops out')
    assert.ok(frames(r).slice(mark2).filter((f) => f[7] === 0x71 && f[8]).every((f) => f[3] === 2 && f[4] === 0x40), 'every frame after the octave change carries the unit')

    // two units: 36 x N keys, the lower one on its own address
    c.receive(report(3, 0x3f), 'in')
    assert.equal(r.ranges.at(-1).units, 2)
    c.dispose()
  }

  // ---- (e0) rgb15 LED gamma on the real hand colours (hardware-checked 2026-11-27) ------------------
  {
    const r = rig('PartyKeys 36')
    const c = r.make({ mode: 'rgb' })
    r.time.tick(300)
    c.set(new Map([[60, note('right', false, [255, 138, 61])], [64, note('left', false, [61, 139, 255])]]))
    r.time.tick(100)
    const hands = frames(r).at(-1)
    const has = (seq) => hands.some((_, i) => seq.every((b, k) => hands[i + k] === b))
    assert.equal(hands[7], 0x15)
    assert.ok(has([1, 127, 0, 52, 0, 6, 1, 12]), 'orange (255, 138, 61) reaches the keyboard as (255, 52, 6), on key 12 (MIDI 60)')
    assert.ok(has([0, 6, 0, 53, 1, 127, 1, 16]), 'blue (61, 139, 255) reaches the keyboard as (6, 53, 255), on key 16 (MIDI 64)')
  }
  // ---- (e) rgb15: direct PartyKeys only ------------------------------------------------------------
  {
    const enc = (v) => { const g = Math.round(255 * Math.pow(v / 255, 2.6)); return [g >> 7, g & 127] }   // LED gamma 2.6 (see party-lights.js ledLevel)
    const r = rig('PartyKeys 36')
    const c = r.make({ mode: 'rgb' })
    assert.equal(c.profile, 'rgb15')
    // the protocol page's quickstart: keys 17, 18, 19 red / green / blue (MIDI 65, 66, 67 from C3 = 48)
    c.set(new Map([[65, note('right', false, [255, 0, 0])], [66, note(null, false, [0, 255, 0])], [67, note('left', false, [0, 0, 255])]]))
    r.time.tick(300)
    assert.deepEqual(frames(r)[0], [0xf0, 5, 0x30, 0x7f, 0x7f, 0x20, 0, 0x0f, 1, 0xf7], 'mode 0F 01')
    assert.deepEqual(frames(r)[2], QUERY)
    const expected = [
      0xf0, 0x05, 0x30, 0x7f, 0x7f, 0x20, 0x00, 0x15, 0x03,
      ...enc(255), ...enc(0), ...enc(0), 1, 17,
      ...enc(0), ...enc(255), ...enc(0), 1, 18,
      ...enc(0), ...enc(0), ...enc(255), 1, 19,
      0xf7,
    ]
    assert.deepEqual(frames(r)[3], expected, 'matches the protocol page example byte for byte')
    // dim = 35% brightness, same colour group for equal colours, offs go first as a black group
    c.set(new Map([[65, note('right', true, [200, 100, 0])], [66, note(null, false, [0, 255, 0])]]))
    r.time.tick(100)
    const next = frames(r)[4]
    assert.deepEqual(next, [0xf0, 5, 0x30, 0x7f, 0x7f, 0x20, 0, 0x15, 2, 0, 0, 0, 0, 0, 0, 1, 19, ...enc(Math.round(200 * Math.pow(0.35, 1 / 2.6))), ...enc(Math.round(100 * Math.pow(0.35, 1 / 2.6))), ...enc(0), 1, 17, 0xf7], 'delta: 67 off, 65 dimmed to 35% of the LED level')
    const dimTarget = note('right', true, [200, 100, 0])
    const dimFrame = [0xf0, 5, 0x30, 0x7f, 0x7f, 0x20, 0, 0x15, 1, ...next.slice(17, -1), 0xf7]
    for (const held of [true, false]) {
      const before = frames(r).length
      c.set(new Map([[65, { ...dimTarget, held }], [66, note(null, false, [0, 255, 0])]]))
      r.time.tick(100)
      assert.equal(frames(r).length, before + 1)
      assert.deepEqual(frames(r).at(-1), dimFrame, 'key-down and key-up resend the exact dim colour')
    }
    // a wide chord is split to frames of at most 64 bytes, 8 ms apart
    const many = new Map()
    for (let n = 48; n < 84; n++) many.set(n, note(null, false, [n * 5 % 256, 255 - n, n]))
    const mark = r.sent.length
    c.set(many)
    r.time.tick(2000)
    const wide = r.sent.slice(mark)
    assert.ok(wide.length > 3, 'split into several frames')
    assert.ok(wide.every(([, f]) => f.length <= 64), 'every frame at most 64 bytes')
    assert.ok(wide.slice(1).every(([t], i) => t - wide[i][0] >= 8), 'paced 8 ms')
    const keys = new Set()
    for (const [, f] of wide) for (let i = 9; i < f.length - 1;) { const k = f[i + 6]; for (let j = 0; j < k; j++) keys.add(f[i + 7 + j]); i += 7 + k }
    assert.equal(keys.size, 36, 'all 36 keys covered')
    c.off()
    r.time.tick(50)
    assert.deepEqual(r.sent.at(-1)[1], [0xf0, 5, 0x30, 0x7f, 0x7f, 0x20, 0, 0x15, 1, 0, 0, 0, 0, 0, 0, 36, ...Array.from({ length: 36 }, (_, i) => i), 0xf7], 'off = every key black')
    // with a discovered unit the index follows the unit, not C3
    c.set(new Map([[84, note(null, false, [255, 255, 255])]]))
    r.time.tick(100)
    c.receive(report(2, 0x40), 'in')
    r.time.tick(300)
    const routed = r.sent.at(-1)[1]
    assert.deepEqual(routed.slice(0, 9), [0xf0, 5, 0x30, 2, 0x40, 0x20, 0, 0x15, 1], 'unit channel and address')
    assert.equal(routed[16], 0, 'note 84 is key 0 of the unit at 0x40')
    c.dispose()

    // never on the relay, whatever was asked
    for (const name of ['SAM5704', 'PartyStudio One']) {
      const s = rig(name)
      const sc = s.make({ mode: 'rgb' })
      assert.equal(sc.profile, 'palette71', `${name}: rgb falls back to palette71`)
      assert.equal(sc.mode, 'one')
      sc.set(new Map([[60, note(null, false, [255, 0, 0])]]))
      s.time.tick(300)
      assert.deepEqual(frames(s)[0], MODE_PALETTE)
      assert.ok(frames(s).every((f) => f[7] !== 0x15 && !(f[7] === 0x0f && f[8] === 1)), `${name}: no CMD 15, no RGB mode 0F 01`)
      sc.dispose()
    }
  }

  // ---- popu ----------------------------------------------------------------------------------------
  {
    const scale = (v) => Math.min(127, Math.round(v / 2))
    const r = rig('PopuPiano', {})
    const c = r.make({ mode: 'hands', colors: { right: [254, 0, 0], left: [0, 254, 0] } })
    assert.equal(c.profile, 'popu')
    assert.equal(c.inputIds.length, 0, 'no pairing needed')
    // palette: right, left, right-dim, left-dim; red = 7F 00 00, green = 00 7F 00 like popupiano-led.md
    const palette = frames(r)[0]
    assert.deepEqual(palette.slice(0, 11), [0xf0, 3, 0x1e, 4, 1, 0x7f, 0, 0, 0, 0x7f, 0], 'slot 1 red, slot 2 green')
    assert.deepEqual(palette.slice(11, 17), [scale(89), 0, 0, 0, scale(89), 0], 'dim slots at 35%')
    assert.equal(palette.length, 6 + 12)
    // doc example: keys 0, 7, 14 lit with slot 1, the rest 0, all 29 pairs
    c.set(new Map([[48, note('right')], [55, note('right')], [62, note('right')]]))
    r.time.tick(100)
    const expected = [0xf0, 3, 0x20, 29]
    for (let i = 0; i < 29; i++) expected.push(i, [0, 7, 14].includes(i) ? 1 : 0)
    expected.push(0xf7)
    assert.deepEqual(frames(r).at(-1), expected, 'CMD 20: all 29 [lamp, slot] pairs')
    assert.equal(expected.length, 63)
    assert.equal(frames(r).filter((f) => f[2] === 0x1e).length, 1, 'palette uploaded once')
    // dedupe: the same target again sends nothing; a new one is one full frame
    const count = r.sent.length
    c.set(new Map([[48, note('right')], [55, note('right')], [62, note('right')]]))
    r.time.tick(100)
    assert.equal(r.sent.length, count)
    c.set(new Map([[49, note('left')], [76, note('left', true)], [77, note('left')], [47, note('left')]]))
    r.time.tick(100)
    const f = frames(r).at(-1)
    assert.equal(f.length, 63)
    assert.deepEqual([f[4 + 2 * 1 + 1], f[4 + 2 * 28 + 1], f[4 + 2 * 0 + 1]], [2, 4, 0], 'lamp 1 left, lamp 28 left-dim, 48 off; 47 and 77 dropped')
    // paced 8 ms apart
    assert.ok(r.sent.slice(1).every(([t], i) => t - r.sent[i][0] >= 8), 'every popu frame at least 8 ms after the last')
    c.off()
    r.time.tick(50)
    assert.deepEqual(r.sent.at(-1)[1], [0xf0, 3, 0x20, 29, ...Array.from({ length: 29 }, (_, i) => [i, 0]).flat(), 0xf7], 'off = 29 zero pairs')
    c.dispose()

    // rgb mode: a new colour re-uploads the palette once, then the frame refers to its slot
    const q = rig('PopuPiano')
    const qc = q.make({ mode: 'rgb' })
    qc.set(new Map([[50, note(null, false, [255, 128, 0])], [51, note(null, false, [255, 128, 0])], [52, note(null, true, [255, 128, 0])]]))
    q.time.tick(100)
    const ups = frames(q).filter((x) => x[2] === 0x1e)
    assert.equal(ups.length, 2, 'init palette, then one upload for the new colours')
    assert.equal(ups[1][3], 6, '4 hand slots + 2 colours')
    assert.deepEqual(ups[1].slice(-7, -1), [127, 64, 0, scale(89), scale(45), 0], 'slot 5 = colour, slot 6 = its 35% dim')
    const fr = frames(q).at(-1)
    assert.deepEqual([fr[4 + 2 * 2 + 1], fr[4 + 2 * 3 + 1], fr[4 + 2 * 4 + 1]], [5, 5, 6])
    const n = q.sent.length
    qc.set(new Map([[50, note(null, false, [255, 128, 0])]])) // no new colour: no upload
    q.time.tick(100)
    assert.equal(frames(q).slice(n).filter((x) => x[2] === 0x1e).length, 0)
    // lamps 0..28 only
    qc.set(new Map([[47, note()], [77, note()], [48, note()], [76, note()]]))
    q.time.tick(100)
    const g = frames(q).at(-1)
    assert.deepEqual([g[5], g[4 + 2 * 28 + 1]], [1, 1])
    qc.dispose()

    // 29 lit keys: the colour table never outgrows the 1E frame limit
    const w = rig('PopuPiano')
    const wc = w.make({ mode: 'rgb' })
    for (let round = 0; round < 6; round++) {
      const t = new Map()
      for (let k = 0; k < 29; k++) t.set(48 + k, note(null, false, [round * 40 + k, k * 8, 255 - k]))
      wc.set(t)
      w.time.tick(500)
    }
    assert.ok(frames(w).every((x) => x.length <= 256), 'every frame passes checkedFrame')
    assert.ok(!w.statuses.some((s) => s[0] === 'error'))
    wc.dispose()
  }

  // ---- availability: SysEx, pairing, signature -----------------------------------------------------
  {
    const a = rig()
    const noSysex = a.make({ sysexGranted: false })
    assert.equal(noSysex.available, false)
    assert.equal(noSysex.status().state, 'unavailable')
    assert.match(noSysex.status().detail, /need MIDI SysEx access/)
    noSysex.set(target([60]))
    noSysex.off()
    a.time.tick(1000)
    assert.equal(a.sent.length, 0, 'no SysEx: nothing is ever written')
    noSysex.dispose()

    const denied = a.make({ access: { sysexEnabled: false }, sysexGranted: true })
    assert.equal(denied.available, false, 'an access object that denies SysEx wins')
    const injected = a.make({ access: {}, sysexGranted: true })
    assert.equal(injected.available, true, 'a bridge without the flag counts as granted after a successful request')
    injected.dispose()
    const quiet = a.sent.length // the injected controller's own init frames

    const unpaired = a.make({ inputs: [{ id: 'x', name: 'USB MIDI' }] })
    assert.equal(unpaired.available, false)
    assert.match(unpaired.status().detail, /input not paired/)
    const ambiguous = a.make({ inputs: [{ id: 'a', name: 'SAM5704' }, { id: 'b', name: 'SAM5704' }] })
    assert.equal(ambiguous.available, false, 'two same-named inputs are ambiguous: never guess')
    const stranger = createPartyLights({ ...a.base, output: { id: 'z', name: 'LUMI Keys', send() { throw new Error('must not send') } } })
    assert.equal(stranger.available, false)
    stranger.set(target([60]))
    assert.equal(a.sent.length, quiet, 'unavailable controllers never write')

    const s1 = planParty(a.base).signature
    assert.equal(planParty({ ...a.base }).signature, s1, 'stable')
    assert.notEqual(planParty({ ...a.base, mode: 'hands' }).signature, s1)
    assert.notEqual(planParty({ ...a.base, sysexGranted: false }).signature, s1)
    assert.notEqual(planParty({ ...a.base, inputs: [{ id: 'other', name: 'SAM5704' }] }).signature, s1)
    assert.equal(planParty({ ...a.base, mode: 'rgb' }).signature, s1, "rgb on a relay is just 'one'")
    assert.deepEqual(JSON.parse(s1), { outputId: 'out', inputIds: ['in'], profile: 'palette71', mode: 'one', sysexGranted: true })
    const live = a.make()
    assert.equal(live.signature, s1)
    live.dispose()
    assert.deepEqual(planParty({ output: { name: 'PartyKeys 36' }, inputs: [{ name: 'PartyKeys 36' }], outputs: [{ name: 'PartyKeys 36' }], sysexGranted: true }).inputIds, ['input-0'], 'ports without ids use the connectedPorts index')
  }

  // ---- (f) dispose: pending frames cancelled, nothing sent afterwards ------------------------------
  {
    const r = rig()
    const c = r.make()
    c.set(target([48, 50, 52, 53, 55, 57, 59, 60])) // 3 frames
    r.time.tick(130 + 8) // init done, first frame out, next one pending
    const sentBefore = r.sent.length
    assert.ok(r.time.pending() > 0)
    c.dispose()
    assert.deepEqual(r.sent.at(-1)[1], OFF_PALETTE, 'dispose clears')
    assert.equal(r.sent.length, sentBefore + 1)
    assert.equal(r.time.pending(), 0, 'all timers cancelled')
    const total = r.sent.length
    c.set(target([60]))
    c.off()
    c.receive(report(2, 0x40), 'in')
    c.receive(report(2, 0x40, 0x18, 1), 'in')
    c.dispose()
    r.time.tick(10000)
    assert.equal(r.sent.length, total, 'nothing after dispose')
    assert.equal(r.time.pending(), 0)

    // dispose during the init: the late open() must not light anything
    let open
    const late = rig('SAM5704', { output: { open: () => new Promise((res) => { open = res }) } })
    const lc = late.make()
    lc.set(target([60, 64]))
    lc.dispose()
    open()
    await Promise.resolve(); await Promise.resolve()
    late.time.tick(5000)
    assert.equal(late.sent.length, 0)
    assert.equal(late.time.pending(), 0)

    // open() that rejects: reported, nothing written
    const bad = rig('SAM5704', { output: { open: () => Promise.reject(new Error('permission revoked')) } })
    const bc = bad.make()
    bc.set(target([60]))
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    bad.time.tick(5000)
    assert.equal(bad.statuses.at(-1)[0], 'error')
    assert.equal(bad.sent.length, 0)
    bc.dispose()
  }

  // ---- (g) a throwing send: error status, then silence ---------------------------------------------
  {
    for (const [name, mode] of [['SAM5704', 'one'], ['PartyKeys 36', 'rgb'], ['PopuPiano', 'one']]) {
      let fail = false
      const r = rig(name)
      r.output.send = (f) => { if (fail) throw new Error('relay unavailable'); r.sent.push([r.time.now(), [...f]]) }
      const c = r.make({ mode })
      const chord = (notes) => new Map(notes.map((n) => [n, note('right', false, [n * 2, 255 - n, 10])]))
      c.set(chord([48, 50, 52, 53, 55, 57, 59, 60]))
      r.time.tick(400)
      const ok = r.sent.length
      const sentOk = r.statuses.filter((s) => s[0] === 'sent').length
      assert.ok(ok >= 3 && sentOk > 0)
      fail = true
      c.set(chord([62, 65, 69])) // the next write throws
      r.time.tick(20)
      const errors = r.statuses.filter((s) => s[0] === 'error')
      assert.equal(errors.length, 1, `${name}: one error status`)
      assert.match(errors[0][1], /relay unavailable/)
      assert.equal(c.status().state, 'error')
      assert.equal(r.time.pending(), 0, `${name}: the error cancels every timer at once, routing's too`)
      assert.equal(r.statuses.filter((s) => s[0] === 'sent').length, sentOk, `${name}: the failed target is never reported as sent`)
      fail = false // the port recovers: still nothing, the caller must rebuild
      c.set(chord([62, 65]))
      c.off()
      r.time.tick(10000)
      assert.equal(r.sent.length, ok, `${name}: nothing sent after the error`)
      assert.equal(r.time.pending(), 0, `${name}: no retry timer`)
      c.dispose()
      assert.equal(r.sent.length, ok, `${name}: dispose after an error stays silent`)
    }

    // the host's own error event (Android reports a failed send asynchronously)
    const r = rig()
    const c = r.make()
    c.set(target([60]))
    r.time.tick(300)
    const n = r.sent.length
    c.reportError(new Error('midi port error'))
    c.reportError(new Error('again'))
    c.set(target([62]))
    r.time.tick(1000)
    assert.equal(r.statuses.filter((s) => s[0] === 'error').length, 1)
    assert.equal(r.sent.length, n)

    // an async send that rejects is a failure as well
    const a = rig()
    a.output.send = () => Promise.reject(new Error('rpc failed'))
    const ac = a.make()
    await Promise.resolve(); await Promise.resolve()
    assert.equal(a.statuses.at(-1)[0], 'error')
    ac.dispose()
  }


  // ---- regressions from the independent review -----------------------------------------------------
  {
    // a half-written target must not hide behind the old 'sent' signature
    const a = rig()
    const ac = a.make()
    a.time.tick(300)
    ac.set(target([60, 64, 67, 72])) // frame 1 (60 64 67) goes out now
    ac.set(new Map()) // changed our mind inside the 8 ms
    a.time.tick(100)
    assert.equal(ac.status().lit, 0, 'dark keyboard + partial write + empty target: nothing stays lit')
    assert.deepEqual([...lit(frames(a))], [])
    ac.set(target([60, 64, 67]))
    a.time.tick(100)
    ac.set(target([62, 65, 69, 72])) // frame 1 turns 60 64 67 off
    ac.set(target([60, 64, 67])) // back to the settled chord inside the 8 ms
    a.time.tick(100)
    assert.deepEqual([...lit(frames(a))].map((x) => x[0]), [60, 64, 67], 'back to the settled chord: lit again, not stuck dark')
    ac.dispose()

    // onStatus('sent') may call set() / dispose(): pacing holds and no timer outlives dispose
    const b = rig()
    let bc
    const seen = []
    bc = b.make({ onStatus: (st) => { if (st === 'sent' && seen.push(st) === 1) bc.set(target([62, 65, 69])) } })
    bc.set(target([60, 64, 67]))
    b.time.tick(500)
    const times = b.sent.map((x) => x[0])
    assert.ok(times.slice(1).every((t, i) => t - times[i] >= 8), 'frames at least 8 ms apart')
    assert.deepEqual([...lit(frames(b))].map((x) => x[0]), [62, 65, 69])
    bc.dispose()
    assert.equal(b.time.pending(), 0)
    const d = rig()
    let dc
    dc = d.make({ onStatus: (st) => { if (st === 'sent') dc.dispose() } })
    dc.set(target([60]))
    d.time.tick(300)
    assert.equal(d.time.pending(), 0, 'dispose from inside onStatus leaves no timer')

    // reportError before a slow open() resolves: the late open must not light or flip the state back
    let open
    const e = rig('SAM5704', { output: { open: () => new Promise((res) => { open = res }) } })
    const ec = e.make()
    ec.reportError(new Error('midi port error'))
    open()
    await Promise.resolve(); await Promise.resolve()
    e.time.tick(1000)
    assert.equal(e.sent.length, 0)
    assert.equal(ec.status().state, 'error')
    assert.equal(e.time.pending(), 0)
    ec.dispose()

    // a failed controller reports no more ranges (routing timers are gone)
    const f = rig()
    f.output.send = () => { throw new Error('gone') }
    const fc = f.make()
    f.time.tick(500)
    assert.equal(f.time.pending(), 0)
    fc.receive(report(2, 0x40), 'in')
    f.time.tick(10000)
    assert.equal(f.ranges.length, 0)

    // popu: black is unlit, a left note in rgb mode without a colour takes the left slot, the table reset rewrites keys
    const p = rig('PopuPiano')
    const pc = p.make({ mode: 'rgb' })
    pc.set(new Map([[48, note('right', false, [0, 0, 0])], [49, note('left')], [50, note('right', true, [1, 1, 1])], [51, note('right')]]))
    p.time.tick(100)
    const pf = frames(p).at(-1)
    assert.deepEqual([pf[5], pf[7], pf[9], pf[11]], [0, 2, 0, 1], 'black and sub-1 dim stay dark; left 2, right 1')
    for (let round = 0; round < 3; round++) {
      const colours = new Map()
      for (let k = 0; k < 29; k++) colours.set(48 + k, note(null, false, [20 + round * 70 + k, 200 - k, 9]))
      pc.set(colours)
      p.time.tick(500)
    }
    // the table now holds 3 x 29 > 64 colours: it was reset. Note 48 must still carry its new colour's slot
    const last = frames(p).filter((x) => x[2] === 0x20).at(-1)
    const lastUp = frames(p).filter((x) => x[2] === 0x1e).at(-1)
    assert.ok(lastUp[3] >= 4 + 29, 'palette re-uploaded after the reset')
    assert.ok(last.slice(4).filter((_, i) => i % 2 === 1).every((slot) => slot >= 5), 'all 29 lamps carry a custom slot')
    // the exact collision: note 48 lit with slot 5, then the table resets and slot 5 means a new colour
    const q = rig('PopuPiano')
    const qc = q.make({ mode: 'rgb' })
    const mk = (base, count) => new Map(Array.from({ length: count }, (_, k) => [48 + k, note(null, false, [base + k, 10, 10])]))
    qc.set(mk(10, 29)); q.time.tick(300) // slots 5..33, note 48 = slot 5
    qc.set(mk(60, 29)); q.time.tick(300) // 58 colours in the table
    qc.set(mk(120, 6)); q.time.tick(300) // 64: the table is full
    qc.set(new Map([[48, note(null, false, [10, 10, 10])]])); q.time.tick(300) // note 48 back on slot 5: written {48: 5}
    const uploads = frames(q).filter((x) => x[2] === 0x1e).length
    const lamps = frames(q).filter((x) => x[2] === 0x20).length
    qc.set(new Map([[48, note(null, false, [200, 200, 1])]])) // one new colour: the table resets, slot 5 is a new colour
    q.time.tick(300)
    assert.equal(frames(q).filter((x) => x[2] === 0x1e).length, uploads + 1, 'the palette is uploaded again')
    assert.equal(frames(q).filter((x) => x[2] === 0x20).length, lamps + 1, 'and the lamp frame follows, even though note 48 is still on slot 5')
    const lastQ = frames(q).filter((x) => x[2] === 0x20).at(-1)
    assert.equal(lastQ[5], 5)
    assert.deepEqual(frames(q).filter((x) => x[2] === 0x1e).at(-1).slice(-4, -1), [100, 100, 1], 'slot 5 is the new colour')


    // popu: a palette reset under lit lamps, then an empty target inside the 8 ms: the lamps must still go dark
    const z = rig('PopuPiano')
    const zc = z.make({ mode: 'rgb' })
    const zk = (base, count) => new Map(Array.from({ length: count }, (_, k) => [48 + k, note(null, false, [base + k, 10, 10])]))
    zc.set(zk(10, 29)); z.time.tick(300)
    zc.set(zk(60, 29)); z.time.tick(300)
    zc.set(zk(120, 6)); z.time.tick(300)
    zc.set(new Map([[48, note(null, false, [10, 10, 10])]])); z.time.tick(300)
    zc.set(new Map([[48, note(null, false, [200, 200, 1])]])) // resets: 1E goes out, the 8 ms timer starts
    zc.set(new Map())
    z.time.tick(300)
    assert.deepEqual(frames(z).at(-1), [0xf0, 3, 0x20, 29, ...Array.from({ length: 29 }, (_, i) => [i, 0]).flat(), 0xf7], 'the last frame darkens every lamp')

    // an unavailable controller is inert: no routing timers, no onRange from reports
    const u = rig()
    const uc = u.make({ sysexGranted: false })
    uc.receive(report(2, 0x40), 'in')
    uc.receive(report(2, 0x40, 4), 'in')
    assert.equal(u.time.pending(), 0)
    u.time.tick(10000)
    assert.equal(u.ranges.length, 0)
    assert.equal(u.sent.length, 0)
    // a sparse or odd colour is ignored, not passed through
    const sparse = new Array(3)
    const sp = rig('PopuPiano').make({ colors: { right: sparse } })
    assert.equal(sp.available, true)
    sp.dispose()

    // overlapping units: the second unit's key index follows its real low (84), not the first note the scan sees
    const o = rig('PartyKeys 36')
    const oc = o.make({ mode: 'rgb' })
    o.time.tick(300)
    oc.receive(report(2, 0x3f), 'in'); oc.receive(report(2, 0x3f, 0x18, 1), 'in') // 60..95
    oc.receive(report(3, 0x40), 'in') // 84..119, overlapping 84..95
    o.time.tick(100)
    oc.set(new Map([[100, note(null, false, [255, 0, 0])]]))
    o.time.tick(200)
    const of = o.sent.at(-1)[1]
    assert.deepEqual(of.slice(3, 5), [3, 0x40])
    assert.equal(of[16], 100 - 84, 'MIDI 100 is key 16 of the unit whose window starts at 84')

    // a disconnected port is never used; PopuPiano hand colours are part of the signature
    const dis = planParty({ output: { id: 'o', name: 'PopuPiano', state: 'disconnected', send() {} }, sysexGranted: true })
    assert.equal(dis.available, false)
    const base = { output: { id: 'o', name: 'PopuPiano', send() {} }, sysexGranted: true }
    assert.notEqual(planParty({ ...base, colors: { right: [1, 2, 3] } }).signature, planParty(base).signature)
    assert.equal(planParty({ ...base }).signature, planParty({ ...base, colors: {} }).signature)
  }

  console.log('PartyKeys lights: parity with upstream, no channel messages, range and routing, rgb15, popu, dispose and error rules passed')
})().catch((error) => { console.error(error); process.exitCode = 1 })
