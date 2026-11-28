// PartyKeys key lights wired into the app (phase 2): runs the PRODUCTION code from renderer/app.js in a vm, with only the DOM, the
// MIDI ports and the clock faked. The controller itself (renderer/party-lights.js, byte parity with upstream) is tested in
// scripts/test-partykeys-lights.js; this file tests the wiring: port picking, the "no Note On, ever" rule on every old light path,
// pause and resume, hot-plug, SysEx denied, PopuPiano, and that the keyboard's SysEx reports are never scored.
//   node scripts/test-partykeys-app.js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')

const root = path.join(__dirname, '..')
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href)
const src = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8')
const cut = (from, to) => {
  const i = src.indexOf(from)
  assert.ok(i >= 0, 'app.js has: ' + from)
  const j = src.indexOf(to, i + from.length)
  assert.ok(j > i, 'app.js has, after it: ' + to)
  return src.slice(i, j)
}

;(async () => {
  const party = await load('renderer/party-lights.js')
  const lights = await load('renderer/lights.js')
  const { noteColor } = await load('renderer/views.js')
  const { fakeClock, paletteState } = await load('scripts/partykeys-upstream/midi-light-helpers.mjs')

  // ---------------------------------------------------------------------------------------------------------
  // the production slices, in the order the file has them
  const slices = [
    cut('const KB_PORT = /lumi', '// A keyboard that plays but gets no light notes'),                       // pickPorts and its port rules
    cut('// <party-lights>', '// </party-lights>'),                                                          // the controller wiring
    cut('const litRoutes = new Map()', '/* ============================== Key lights on a PartyKeys-family keyboard'),   // noteRoute, updateNoteLights
    cut('const identifyTimers = new Map()', '/* ============================== backing track sync'),          // identify, exact, clear, sweep, light test
    cut('function lightFallbackMessage()', '// The iPhone/iPad app is a paid'),                                 // the messages and showLightState
    cut('function handleMidiMessage(', 'function handleNoteOn('),                                             // the input handler
    src.match(/^const keysFromName = .*$/m)[0]
  ]

  const els = new Map()
  const el = (id) => {
    if (!els.has(id)) {
      const classes = new Set()
      els.set(id, { id, textContent: '', value: '', disabled: false, title: '', hidden: false,
        classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
        querySelector: () => ({ hidden: false, disabled: false }) })
    }
    return els.get(id)
  }
  const statuses = []
  const clock = fakeClock()
  const ctx = vm.createContext({
    console: { log() {} }, performance: { now: () => clock.now() }, document: { hidden: false },
    setTimeout: (fn, ms) => clock.clock.set(fn, ms), clearTimeout: (id) => clock.clock.clear(id),
    partyProfileFor: party.partyProfileFor, planParty: party.planParty,
    noteColor: (note, view) => noteColor(note, view, true),
    createPartyLights: (opts) => party.createPartyLights({ ...opts, clock: clock.clock }),   // production code, a fake clock
    clearLights: lights.clearLights, noteBursts: lights.noteBursts, velocityForColour: lights.velocityForColour,
    Array, Map, Set, Number, Math, JSON, Uint8Array, Error
  })
  const run = (code) => vm.runInContext(code, ctx, { filename: 'renderer/app.js (production slice)' })
  ctx.$ = el
  ctx.status = (m) => statuses.push(m)
  ctx.setText = (e, t) => { if (e) e.textContent = t }
  const diag = []
  ctx.recordDiagnosticFailure = (...a) => diag.push(a)
  ctx.noteOnCalls = []
  ctx.noteOffCalls = []
  ctx.handleNoteOn = (...a) => ctx.noteOnCalls.push(a)
  ctx.handleNoteOff = (...a) => ctx.noteOffCalls.push(a)
  ctx.hexToRgb = (h) => [1, 2, 3].map((i) => parseInt(h.slice(i * 2 - 1, i * 2 + 1), 16))
  ctx.noteName = (n) => 'n' + n
  ctx.noteRgb = (n) => (n.hand === 'left' ? [64, 160, 255] : [255, 96, 64])
  run(`
    const COLORS = { hand: { left: '#40a0ff', right: '#ff6040' } }
    const settings = { partyColor: 'one', kbLightsSwap: false, exactColors: false, keyboardMode: 'Pro', kbPort: '' }
    let midi = null, midiInput = null, midiInput2 = null, midiOutput = null, midiOutput2 = null, midiRowInput = null
    let midiSysexGranted = true, daemon = null, midiOutputFailure = null, midiOpening = null
    let player = null, song = null, screen = 'home', freeplay = false, handGuideRun = null, held = new Set(), litNotes = new Map()
    let kbOctave = 0, kbSetAt = 0, rawLogged = 0, quizHints = [], jamLit = []
    const pair = { side: [0, 1], low: [48, 48] }
    const pageLights = { gaveUp: false }
    const blockLinks = new Map()
    const IS_WIN = false, IS_IOS = false
    const performanceControls = null
    const framesDrive = () => false, daemonOwnsKeyboard = () => false, noteLightsOnly = () => true, daemonSettling = () => false
    const linksFor = () => [], blockIndices = () => [0], lightStyle = () => 'Pro', userRgb = () => [167, 139, 250]
    const kbBase = () => 48 + 12 * kbOctave, kbKeys = () => 36, kbWindowZero = () => 48, kbLabel = () => ''
    const portLabel = (p) => ((p.manufacturer || '') + ' ' + (p.name || '')).trim()
    const canChooseLights = () => false, supportDeviceAction = () => undefined, keyboardSettingsAction = () => undefined, noKeyboardNextStep = () => ''
    const daemonIssue = () => '', kbAsk = false
    const cancelCeremony = () => {}, lightSink = { resend() {} }, rememberKeysAt = () => {}, recheckHands = () => {}, syncOctaveUI = () => {}
    const applyKeyCount = () => {}, updateKbChip = () => {}, renderSetup = () => {}, emitKeyboard = () => {}
    const handGuideOverlay = () => null, guideRgb = () => [255, 96, 64]
    const quizHintPitches = () => quizHints, quizHintRgb = () => [167, 139, 250], jamLitPitches = () => jamLit
    const setKeyOn = () => {}, setKeyOff = () => {}, turnOffAllKeys = () => {}, setLightingMode = () => {}, endApiMode = () => {}, setAllKeysToColor = () => {}
    const LIGHTING_MODE = {}, pressRgb = () => [255, 255, 255], dimRgb = (c) => c
    const routeToJam = () => false, jamUi = null, mpeStates = [], mpeFor = () => ({ feed() {}, bendRangeFor: () => null })
    const logRaw = () => {}, logExpr = () => {}, setSustain = () => {}, stopAll = () => {}, setBend = () => {}, setPressure = () => {}, setSlide = () => {}, setPolyPressure = () => {}
    const setup = { open: false }
    const blocksFeed = () => false
    const keysAuto = () => 24
  `)
  for (const s of slices) run(s)

  // ---------------------------------------------------------------------------------------------------------
  // fake ports the way the hosts expose them; every byte written is recorded in `sent`
  const mkPair = (name, id, { maker = '', input = true } = {}) => {
    const sent = []
    const inp = { id: id + '-in', name, manufacturer: maker, state: 'connected', connection: 'open', type: 'input', onmidimessage: null }
    const out = { id: id + '-out', name, manufacturer: maker, state: 'connected', connection: 'open', type: 'output', send(data) { sent.push([...data]) } }
    return { input: input ? inp : null, output: out, sent }
  }
  const access = (...pairs) => ({
    sysexEnabled: true,
    inputs: new Map(pairs.filter((p) => p.input).map((p) => [p.input.id, p.input])),
    outputs: new Map(pairs.map((p) => [p.output.id, p.output])),
  })
  const bind = (pairs, { input = pairs[0]?.input ?? null, output = pairs[0]?.output ?? null, midiAccess = access(...pairs) } = {}) => {
    ctx.__access = midiAccess; ctx.__in = input; ctx.__out = output
    run('midi = __access; midiInput = __in; midiOutput = __out; midiInput2 = null; midiOutput2 = null')
    run('syncPartyLights()')
  }
  const unbind = () => { run('midi = null; midiInput = null; midiOutput = null; syncPartyLights()') }
  // The only things that may ever reach a party port are SysEx frames, and never ROLI's.
  const noChannelBytes = (frames, label) => {
    for (const f of frames) {
      assert.equal(f[0], 0xf0, label + ': every message is SysEx, got ' + f.slice(0, 4).map((b) => b.toString(16)).join(' '))
      assert.ok(!(f[1] === 0 && f[2] === 0x21 && f[3] === 0x10), label + ': no ROLI SysEx')
      assert.ok(f.slice(1, -1).every((b) => b < 0x80), label + ': 7-bit data only, so no 0x8n, 0x9n or 0xAn byte can hide inside')
    }
  }
  const frameLit = (frames) => paletteState(frames)
  const target = (notes, hand = 'right') => notes.map((n) => ({ pitch: n, hand }))
  const snapOf = (active, upcoming = []) => ({ activeNotes: target(active), upcomingNotes: target(upcoming), waiting: false, waitNotes: [], needPitches: new Set() })
  const play = (active, upcoming) => { ctx.__snap = snapOf(active, upcoming); run('updatePartyLights(__snap)') }
  const set = (code) => run(code)
  const ready = () => clock.tick(300)

  // ---- 1. port picking: a party port is the keyboard at rank 2; it never makes a two-keyboard row ----------------
  {
    const port = (name, id, maker = '') => ({ id, name, manufacturer: maker, state: 'connected' })
    const pick = (ins, outs, choice = '') => { ctx.__a = ins; ctx.__b = outs; ctx.__c = choice; return run('pickPorts(__a, __b, __c)') }
    const k1 = [port('PartyKeys', 'k1-in')], k1o = [port('PartyKeys', 'k1-out')]
    let r = pick(k1, k1o)
    assert.equal(r.input.id, 'k1-in'); assert.equal(r.output.id, 'k1-out'); assert.ok(!r.input2 && !r.output2, 'one PartyKeys is one keyboard')
    for (const name of ['PartyKeys 36', 'Party Keys', 'PARTYKEYS-BLE', 'PartyStudio', 'SAM5704 USB MIDI']) {
      r = pick([port(name, 'a-in')], [port(name, 'a-out')])
      assert.ok(r.input && r.output && !r.input2, name + ' is the keyboard, with its own output')
    }
    r = pick([port('PartyKeys', 'p1-in'), port('PartyKeys', 'p2-in')], [port('PartyKeys', 'p1-out'), port('PartyKeys', 'p2-out')])
    assert.ok(!r.input2 && !r.output2, 'two PartyKeys never become a 24 + 24 row')
    r = pick([port('PartyKeys', 'p-in'), port('LUMI Keys BLOCK', 'l-in', 'ROLI Ltd.')], [port('PartyKeys', 'p-out'), port('LUMI Keys BLOCK', 'l-out', 'ROLI Ltd.')])
    assert.ok(!r.input2 && !r.output2, 'a PartyKeys beside a LUMI is not a two-keyboard row')
    assert.equal(r.input.id, 'l-in', 'the 24-key ROLI name still outranks it when both are plugged in')
    for (const choice of ['__two__']) {
      r = pick([port('PartyKeys', 'p1-in'), port('PartyKeys', 'p2-in')], [port('PartyKeys', 'p1-out'), port('PartyKeys', 'p2-out')], choice)
      assert.ok(!r.input2 && !r.output2 && !r.input, 'Two keyboards as one skips party ports')
      r = pick([port('PartyKeys', 'p-in'), port('LUMI Keys BLOCK', 'l-in', 'ROLI Ltd.')], [port('PartyKeys', 'p-out'), port('LUMI Keys BLOCK', 'l-out', 'ROLI Ltd.')], choice)
      assert.ok(!r.input2 && r.input.id === 'l-in', 'a LUMI and a PartyKeys under Two keyboards as one: just the LUMI')
    }
    // the PartyKeys card picked: it wins over a LUMI that Bluetooth reconnected by itself, and over two LUMIs that would pair
    { ctx.__a = [port('PartyKeys', 'p-in'), port('LUMI Keys BLOCK', 'l-in', 'ROLI Ltd.')]; ctx.__b = [port('PartyKeys', 'p-out'), port('LUMI Keys BLOCK', 'l-out', 'ROLI Ltd.')]
      const w = run("pickPorts(new Map(__a.map((p) => [p.id, p])).values(), new Map(__b.map((p) => [p.id, p])).values(), '', 'partykeys')")   // one-shot iterators, as bindMidiPorts passes them
      assert.ok(w.input.id === 'p-in' && w.output.id === 'p-out' && !w.input2, 'PartyKeys picked: the PartyKeys is the keyboard, not the LUMI')
      ctx.__a = [port('LUMI Keys BLOCK', 'l1-in', 'ROLI Ltd.'), port('LUMI Keys BLOCK', 'l2-in', 'ROLI Ltd.'), port('PartyKeys', 'p-in')]
      ctx.__b = [port('LUMI Keys BLOCK', 'l1-out', 'ROLI Ltd.'), port('LUMI Keys BLOCK', 'l2-out', 'ROLI Ltd.'), port('PartyKeys', 'p-out')]
      const w2 = run("pickPorts(__a, __b, '', 'partykeys')")
      assert.ok(w2.input.id === 'p-in' && !w2.input2, 'PartyKeys picked: two LUMIs do not pair over it')
      const w3 = run("pickPorts(__a, __b, '', 'roli')")
      assert.ok(w3.input.id === 'l1-in' && w3.input2 && w3.input2.id === 'l2-in', 'ROLI picked: the two LUMIs pair as before')
      ctx.__a.pop()
      const outputOnly = run("pickPorts(__a, __b, '', 'partykeys')")
      assert.deepEqual([outputOnly.input.id, outputOnly.input2.id], ['l1-in', 'l2-in'])
      assert.deepEqual([outputOnly.output.id, outputOnly.output2.id], ['l1-out', 'l2-out'])
    }
    r = pick([port('PartyKeys', 'p-in')], [port('PartyKeys', 'p-out')], 'PartyKeys')
    assert.equal(r.output.id, 'p-out', 'choosing it by name lights it too')
    r = pick([], [port('PartyKeys', 'p-out')])
    assert.equal(r.output.id, 'p-out', 'the output can appear before the input')
    assert.ok(!r.input)
    assert.ok(!pick([port('Casio', 'c-in'), port('PartyKeys', 'p-in')], []).ask, 'a party port is a named keyboard: Automatic does not ask')
  }

  {
    const saved = run('({ screen, player, song, partyLights, color: settings.partyColor, view: settings.view })')
    set("screen = 'play'; player = { active: true }; song = {}; partyLights = { status: () => ({ profile: 'rgb15' }) }; settings.partyColor = 'rgb'; held.add(61)")
    const note = { pitch: 61, hand: 'left' }
    ctx.__snap = { ...snapOf([]), upcomingNotes: [note] }
    for (const view of ['CASCADE', 'RAINBOW', 'COLORNOTE']) {
      ctx.__view = view
      const target = run('settings.view = __view; partyTarget(__snap).get(61)')
      assert.equal(target.dim, true, 'holding an upcoming note keeps it dim')
      assert.equal(target.held, true, 'held state requests a redraw')
      assert.deepEqual(Array.from(target.rgb), noteColor(note, view, true).slice(1).match(/../g).map((s) => parseInt(s, 16)))
    }
    assert.equal(noteColor(note, 'CASCADE', true), '#86b6ff')
    ctx.__saved = saved
    set('screen = __saved.screen; player = __saved.player; song = __saved.song; partyLights = __saved.partyLights; settings.partyColor = __saved.color; settings.view = __saved.view; held.delete(61)')
  }

  // ---- 7a. key counts from the name ------------------------------------------------------------------------------
  assert.equal(run("keysFromName('PartyKeys 36')"), 36)
  assert.equal(run("keysFromName('PartyStudio')"), 36)
  assert.equal(run("keysFromName('SAM5704')"), 36)
  assert.equal(run("keysFromName('PopuPiano')"), 29, 'PopuPiano has 29 keys')
  assert.equal(run("keysFromName('LUMI Keys BLOCK')"), 24)
  assert.equal(run("keysFromName('ROLI Piano')"), 49)
  assert.equal(run("keysFromName('USBMidi2-ACX')"), 24)

  // ---- 2 + 3. a direct PartyKeys through every flow: nothing but SysEx ever leaves --------------------------------------
  const A = mkPair('PartyKeys', 'a')
  bind([A])
  assert.ok(run('partyBound()') && run('isPartyOut(midiOutput)') && !run('hasNoteLightPort()'), 'a party output is not a Note On light port')
  ready()
  assert.equal(run('partyStatus.state'), 'ready')
  assert.equal(run('partyUsable()'), true)
  assert.equal(run('lightFallbackMessage()'), '', 'nothing to complain about while it works')
  assert.equal(run('partyStateText()'), 'On: keys to play (beta)', 'brand-neutral status')
  assert.ok(A.sent.length >= 2 && A.sent[0].join() === [0xf0, 0x7f, 0x30, 0x7f, 0x7f, 0x20, 0, 0x0f, 5, 0xf7].join(), 'init: mode 05 first')
  const idle = A.sent.length

  // the old light paths, each pointed at the party port: all of them must be silent
  ctx.__lit = new Map([[60, 127], [64, 20], [67, 127 | 128]])
  run('updateNoteLights(__lit)')
  assert.equal(run('noteRoute(60)'), null, 'no Note On route to a party port')
  set('settings.kbLightsSwap = true'); assert.equal(run('noteRoute(60)'), null, 'swapped: still none'); set('settings.kbLightsSwap = false')
  assert.equal(run('identifyKeyboard(0)'), false, 'identify never flashes a party port')
  assert.equal(run('midiLightSweep(midiOutput)'), 0, 'the sweep never runs on a party port')
  assert.equal(run('midiLightSweep()'), 0)
  assert.equal(run('exactWanted()'), false)
  set('settings.exactColors = true'); assert.equal(run('exactWanted()'), false, 'exact colours are off for a party output'); set('settings.exactColors = false')
  run('clearNoteLights()')
  run('cancelLightTest()')
  assert.equal(run('hasNoteLightPort()'), false)
  const afterOld = A.sent.slice(idle)
  noChannelBytes(afterOld.filter((f) => f[0] !== 0xf0), 'old light paths')
  assert.equal(afterOld.filter((f) => f[0] !== 0xf0).length, 0, 'the old paths wrote nothing channel-like')

  // 3. play, pause, resume
  ctx.__player = { active: true, armed: false, firstWaitNotes: () => [] }
  set('player = __player; song = {}; screen = "play"; freeplay = false')
  A.sent.length = 0
  play([60, 64], [67])
  clock.tick(100)
  assert.deepEqual(frameLit(A.sent), [60, 64], 'play: the notes to play are lit (the upcoming one is not, on the palette71 default)')
  assert.ok(A.sent.every((f) => f[7] === 0x71), 'palette71 frames')
  const slot = A.sent.find((f) => f[7] === 0x71 && f[8] > 0)[10]
  assert.equal(slot, 8, 'the verified one colour: palette slot 8')
  A.sent.length = 0
  set('player.active = false')
  for (let i = 0; i < 90; i++) play([60, 64], [67])         // 1.5 s of 60 Hz frames while paused
  clock.tick(200)
  assert.deepEqual(A.sent.map((f) => f.join(',')), [[0xf0, 5, 0x30, 0x7f, 0x7f, 0x20, 0, 0x71, 0, 0xf7].join(',')], 'pause: a single 71 00, however long it stays paused')
  A.sent.length = 0
  set('player.active = true')
  play([62], [])                                              // the song moved on while paused: the CURRENT target comes back
  clock.tick(100)
  assert.deepEqual(frameLit(A.sent), [62], 'resume: the current target is restored')
  A.sent.length = 0
  ctx.__first = target([65])
  set('player.active = false; player.armed = true; player.firstWaitNotes = () => __first')
  play([], [67])
  clock.tick(100)
  assert.deepEqual(frameLit(A.sent), [65], 'armed Wait mode lights the first group (B6), not the next-note dim one')
  set('player.armed = false; player.active = true')
  // idle, held keys, hand guide
  A.sent.length = 0
  set('screen = "home"; player = null; song = null')
  ctx.__held = new Set([60, 62])
  set('held = __held')
  run('updatePartyLights(null)')
  clock.tick(100)
  assert.deepEqual(A.sent.map((f) => f.join(',')), [[0xf0, 5, 0x30, 0x7f, 0x7f, 0x20, 0, 0x71, 0, 0xf7].join(',')], 'leaving the song: one clear')
  set('quizHints = [72]'); run('updatePartyLights(null)'); clock.tick(100)
  assert.deepEqual(frameLit(A.sent), [72], 'a note-game hint is lit (it is a key to press)')
  set('quizHints = []')
  A.sent.length = 0
  for (const down of [[], [60], [60, 64, 67]]) { ctx.__held = new Set(down); set('held = __held'); run('updatePartyLights(null)'); clock.tick(40) }
  assert.deepEqual(frameLit(A.sent), [], 'held keys never go to the lights')
  noChannelBytes(A.sent, 'held keys')

  // Test lights: through the controller, one key at a time, the button disabled while it runs, and the song's lights come back
  set('screen = "play"; player = __player; song = {}')
  play([], [])
  clock.tick(100)
  A.sent.length = 0
  run('runPartyLightTest()')
  assert.equal(el('testLights').disabled, true)
  assert.equal(run('lightTestActive'), true)
  play([55], [])                                              // the frame loop keeps running: it must not wipe the test, or light its own note
  clock.tick(2200)
  assert.equal(run('lightTestActive'), false)
  assert.equal(el('testLights').disabled, false)
  const everLit = new Set()
  for (const f of A.sent) if (f[7] === 0x71) for (let i = 9; i < f.length - 1; i += 2) if (f[i + 1]) everLit.add(f[i])
  assert.deepEqual([...everLit].sort((a, b) => a - b), [60, 64, 67, 72], 'the test lit C, E, G and C one after the other (the song\'s note 55 stayed out of it)')
  assert.deepEqual(frameLit(A.sent), [], 'and ended dark')
  noChannelBytes(A.sent, 'Test lights')
  A.sent.length = 0
  play([60], [])
  clock.tick(100)
  assert.deepEqual(frameLit(A.sent), [60], 'after Test lights the current target is back')
  // cancelling a running test (playback starts) restores
  run('runPartyLightTest()'); clock.tick(300); set('player.active = true'); run('cancelLightTest()')
  assert.equal(run('lightTestActive'), false); assert.equal(el('testLights').disabled, false)
  clock.tick(500)

  // reviewer findings: a hidden page, a failing send and a rebuild in the middle of Test lights
  {
    const T = mkPair('PartyKeys', 't')
    bind([T])
    clock.tick(300)
    set('screen = "home"; player = null; song = null')
    run('updatePartyLights(null)')
    run('runPartyLightTest()'); clock.tick(600)
    T.sent.length = 0
    run('clearNoteLights()')                                  // the page went to the background mid-test
    assert.equal(run('lightTestActive'), false, 'hiding cancels a running Test lights')
    clock.tick(3000)
    assert.deepEqual(frameLit(T.sent), [], 'and its timers light nothing afterwards')
    assert.equal(el('testLights').disabled, false)
    // a send that fails mid-test: no false "done", and the button stays off because the lights are off
    statuses.length = 0
    run('runPartyLightTest()'); clock.tick(300)
    T.output.send = () => { throw new Error('port closed') }
    clock.tick(500)
    assert.equal(run('partyStatus.state'), 'error')
    assert.equal(run('lightTestActive'), false, 'an error ends the test')
    clock.tick(3000)
    assert.ok(!statuses.some((m) => /Light test done/.test(m)), 'no false "Light test done"')
    assert.equal(el('testLights').disabled, true, 'Test lights stays greyed out while the lights are in error')
    assert.match(run('lightFallbackMessage()'), /^Key lights stopped: port closed/)
    unbind()
    // dispose in the middle of a test: one clear frame, not two
    const U = mkPair('PartyKeys', 'u')
    bind([U])
    clock.tick(300)
    run('runPartyLightTest()'); clock.tick(300)
    U.sent.length = 0
    unbind()
    assert.equal(U.sent.filter((f) => f[7] === 0x71 && f[8] === 0).length, 1, 'a rebuild mid-test sends one clear')
    assert.equal(el('testLights').disabled, false)
  }

  // output change, port change and swap: each rebuild clears and starts clean, and nothing channel-like is ever written
  const B = mkPair('PartyKeys', 'b')
  bind([A, B], { input: B.input, output: B.output })
  assert.equal(run('partyLights'), null, 'two PartyKeys plugged in at once: it is ambiguous which input is whose, so no guess')
  assert.equal(run('lightFallbackMessage()'), 'Key lights unavailable: input not paired')
  assert.equal(B.sent.length, 0, 'and nothing is written to either')
  const clears = A.sent.length
  bind([B], { input: B.input, output: B.output })      // the first one was unplugged: the second takes the lights
  clock.tick(300)
  assert.ok(A.sent.length >= clears, 'the old output was cleared when it went')
  noChannelBytes(A.sent, 'old output on change')
  noChannelBytes(B.sent, 'new output')
  assert.equal(B.sent[0].join(), [0xf0, 0x7f, 0x30, 0x7f, 0x7f, 0x20, 0, 0x0f, 5, 0xf7].join(), 'the new output gets the mode frame')
  set('settings.kbLightsSwap = true'); run('clearNoteLights()'); assert.equal(run('noteRoute(55)'), null); set('settings.kbLightsSwap = false')
  noChannelBytes(B.sent, 'after swap')
  unbind()
  assert.equal(run('partyLights'), null, 'unplugged: no controller')
  noChannelBytes(A.sent, 'everything A ever got')
  noChannelBytes(B.sent, 'everything B ever got')

  // ---- 4. the keyboard's own SysEx (its reports, or an echo of our frames) is never scored; its notes still are ----------------
  const E = mkPair('PartyStudio', 'e')
  bind([E])
  ready()
  const info = () => run('partyLights.status().range')
  assert.equal(info().units, 0, 'no unit found yet')
  const report = [240, 5, 48, 32, 0, 2, 0x3f, 2, 1, 247]
  ctx.__sx = new Uint8Array(report)
  run(`handleMidiMessage(__sx, 0, false, '${E.input.id}')`)
  assert.equal(ctx.noteOnCalls.length, 0, 'SysEx is never a note')
  assert.equal(info().units, 1, 'the paired input\'s report reached the controller')
  ctx.__echo = new Uint8Array([0xf0, 5, 0x30, 0x7f, 0x7f, 0x20, 0, 0x71, 1, 60, 8, 0xf7])     // an echo of one of our own frames
  run(`handleMidiMessage(__echo, 0, false, '${E.input.id}')`)
  assert.equal(ctx.noteOnCalls.length, 0, 'an echoed frame is not a note either')
  ctx.__other = new Uint8Array([240, 5, 48, 32, 0, 3, 0x40, 2, 1, 247])
  run("handleMidiMessage(__other, 0, false, 'someone-elses-input')")
  assert.equal(info().units, 1, 'a report from an input that is not the paired one is dropped')
  ctx.__note = new Uint8Array([0x90, 60, 100])
  run(`handleMidiMessage(__note, 0, false, '${E.input.id}')`)
  assert.deepEqual(ctx.noteOnCalls, [[60, 100, 0]], 'a key press still scores')
  ctx.__off = new Uint8Array([0x80, 60, 0])
  run(`handleMidiMessage(__off, 0, false, '${E.input.id}')`)
  assert.equal(ctx.noteOffCalls.length, 1)
  assert.equal(run('partyKeysLive()'), 36, 'one unit found: 36 keys')
  ctx.__sx2 = new Uint8Array([240, 5, 48, 32, 0, 3, 0x40, 2, 1, 247])
  run(`handleMidiMessage(__sx2, 0, false, '${E.input.id}')`)
  assert.equal(run('partyKeysLive()'), 72, 'a second unit spliced on: 36 x 2 keys')
  noChannelBytes(E.sent, 'the relay')
  unbind()

  // ---- 5. hot-plug: the output appears before the input, then the input arrives --------------------------------------------------
  {
    const H = mkPair('PartyKeys', 'h')
    bind([H], { input: null, output: H.output, midiAccess: access({ output: H.output, input: null }) })
    assert.equal(run('partyLights'), null, 'output only: no controller yet')
    assert.equal(run('partyStatus.state'), 'unavailable')
    assert.equal(run('lightFallbackMessage()'), 'Key lights unavailable: input not paired', 'the reason is shown')
    assert.equal(H.sent.length, 0, 'nothing is written before the keyboard is paired')
    bind([H], { input: H.input, output: H.output, midiAccess: access(H) })
    const made = run('partyLights')
    assert.ok(made, 'the input arrived: the lights attached')
    clock.tick(20)
    const afterInit = H.sent.length
    // a port opening and its first send both fire onstatechange: bindMidiPorts runs again and again with the same ports
    for (let i = 0; i < 6; i++) { run('syncPartyLights()'); clock.tick(5) }
    assert.equal(run('partyLights'), made, 'the same controller: a port-open statechange rebuilds nothing')
    clock.tick(300)
    assert.equal(run('partyStatus.state'), 'ready', 'the 120 ms init was not aborted')
    assert.equal(H.sent.filter((f) => f[7] === 0x0f).length, 1, 'the mode frame was sent exactly once')
    assert.ok(H.sent.length >= afterInit)
    // a colour change is a real change: one clean rebuild, and never 0F 05 mixed with 0F 01 without a clear in between
    set("settings.partyColor = 'hands'"); run('syncPartyLights()')
    assert.notEqual(run('partyLights'), made, 'changing the colour mode rebuilds')
    unbind()
  }

  // ---- 6. SysEx denied: it plays, there are no lights, and Test lights is off --------------------------------------------------
  {
    const D = mkPair('PartyKeys', 'd')
    const denied = access(D); denied.sysexEnabled = false
    set('midiSysexGranted = false')
    bind([D], { midiAccess: denied })
    el('testLights').disabled = false
    run('syncPartySettings()')
    assert.equal(run('partyLights'), null)
    assert.equal(run('lightFallbackMessage()'), 'The keyboard plays, but key lights need MIDI SysEx access.', 'the plays-but-no-lights message')
    assert.equal(run('partyStateText()'), 'The keyboard plays, but key lights need MIDI SysEx access.')
    assert.equal(el('testLights').disabled, true, 'Test lights is disabled')
    assert.equal(run('(hasNoteLightPort() || framesDrive() || partyUsable()) && !$("testLights").disabled'), false, 'the support wizard cannot start a test either')
    statuses.length = 0
    run('runPartyLightTest()')
    assert.match(statuses.at(-1), /SysEx/, 'asking for a test says why not')
    clock.tick(500)
    assert.equal(D.sent.length, 0, 'nothing at all is written without SysEx')
    // access granted later (a retry): the button comes back
    set('midiSysexGranted = true'); denied.sysexEnabled = true
    run('syncPartyLights(true)')
    assert.ok(run('partyLights'))
    clock.tick(300)
    assert.equal(el('testLights').disabled, false, 'Test lights is back once the lights are ready')
    unbind()
  }

  // ---- second review ------------------------------------------------------------------------------------------------------
  {
    // (1) a native send error only fails the controller that owns it; an unrelated error, or another port's, never does
    const onerror = run('(' + src.match(/midi\.onerror = (\(error\) => recordDiagnosticFailure\(.*\))\s*$/m)[1] + ')')
    set("settings.partyColor = 'one'")
    const G = mkPair('PartyKeys', 'g')
    let handlers = []
    G.output.send = (frame, _ts, onFail) => { G.sent.push([...frame]); handlers.push(onFail) }
    bind([G]); clock.tick(300)
    assert.equal(run('partyStatus.state'), 'ready')
    assert.ok(handlers.length && handlers.every((h) => typeof h === 'function'), 'every frame carries the sender\'s own failure handler')
    onerror(new Error('input overflow'), null)
    onerror(new Error('another port'), { op: 'send', port: 'someone-else-out' })
    onerror(new Error('a clear'), { op: 'clear', port: G.output.id })
    assert.equal(run('partyStatus.state'), 'ready', 'unrelated native errors leave a live controller alone')
    // a stale controller's late failure (the old one's clear, rejected after a rebuild) must not fail the new one
    const stale = handlers.at(-1)
    handlers = []
    set("settings.partyColor = 'hands'"); run('syncPartyLights()')
    clock.tick(300)
    assert.equal(run('partyStatus.state'), 'ready')
    stale(new Error('queue full'))
    assert.equal(run('partyStatus.state'), 'ready', 'a disposed controller\'s late failure is ignored')
    handlers.at(-1)(new Error('queue full'))
    assert.equal(run('partyStatus.state'), 'error', 'but the live one hears its own')
    assert.ok(diag.some((d) => d[1] === 'Key lights'), 'the controller\'s own failure is in the diagnostics')
    set("settings.partyColor = 'one'")
    unbind()
    // a host-wide error that names the live party output (someone else's send, e.g. the support wizard's identity request) does not fail it
    bind([G]); clock.tick(300)
    onerror(new Error('port closed'), { op: 'send', port: G.output.id })
    assert.equal(run('partyStatus.state'), 'ready')
    unbind()
  }
  {
    // (2) a colour change on the same port: the mode frame waits one pace behind the old controller's clear
    const R = mkPair('PartyKeys', 'r')
    const times = []
    R.output.open = async () => R.output
    R.output.send = (frame) => { times.push([clock.now(), [...frame]]); R.sent.push([...frame]) }
    bind([R])
    await new Promise((r) => setImmediate(r)); clock.tick(300)
    assert.equal(run('partyStatus.state'), 'ready')
    times.length = 0
    set("settings.partyColor = 'hands'"); run('syncPartyLights()')
    await new Promise((r) => setImmediate(r)); clock.tick(300)
    const off = times.find(([, f]) => f[7] === 0x71 && f[8] === 0), mode = times.find(([, f]) => f[7] === 0x0f)
    assert.ok(off && mode, 'a clear and a mode frame')
    assert.ok(mode[0] - off[0] >= 8, 'the mode frame is at least one pace (8 ms) after the old clear: ' + (mode[0] - off[0]) + ' ms')
    assert.equal(run('partyStatus.state'), 'ready')
    set("settings.partyColor = 'one'")
    unbind()
  }
  {
    // (3) not "on" until the port is open and initialised
    const S = mkPair('PartyKeys', 's')
    let opened
    S.output.open = () => new Promise((res) => { opened = res })
    bind([S])
    assert.equal(run('partyStatus.state'), 'starting')
    assert.equal(run('partyStateText()'), 'Starting key lights…', 'starting, while open() has not answered')
    assert.equal(run('partyUsable()'), false)
    assert.equal(el('testLights').disabled, true, 'Test lights waits')
    opened(S.output); await new Promise((r) => setImmediate(r)); clock.tick(300)
    assert.equal(run('partyStateText()'), 'On: keys to play (beta)')
    assert.equal(el('testLights').disabled, false)
    unbind()
    // no controller (output only, nothing paired): unavailable, never on
    const Q = mkPair('PartyKeys', 'q')
    bind([Q], { input: null, output: Q.output, midiAccess: access({ output: Q.output, input: null }) })
    assert.equal(run('lightFallbackMessage()'), 'Key lights unavailable: input not paired')
    unbind()
    assert.match(src, /partyBound\(\)\) return partyUsable\(\) \? 'party' : partyLights && partyStatus\.state === 'starting' \? 'checking'/, 'setup shows checking while starting')
  }
  {
    // (4b) a lone keyboard whose two directions are named differently is still one device
    const port = (name, id) => ({ id, name, manufacturer: '', state: 'connected' })
    const pick = (ins, outs) => { ctx.__a = ins; ctx.__b = outs; return run("pickPorts(__a, __b, '')") }
    for (const [i, o] of [['PartyKeys In', 'PartyKeys Out'], ['SAM5704', 'SAM5704 APP'], ['PartyKeys MIDI In', 'PartyKeys MIDI Out'], ['PartyStudio', 'PartyStudio APP USB']]) {
      const r = pick([port(i, 'i')], [port(o, 'o')])
      assert.ok(r.input && r.output && r.output.id === 'o', i + ' / ' + o + ': the output is its own')
    }
    let r = pick([port('PartyKeys In', 'i1'), port('PartyKeys In', 'i2')], [port('PartyKeys Out', 'o1'), port('PartyKeys Out', 'o2')])
    assert.ok(!r.output, 'two differently named pairs of the same kind are ambiguous: no guess')
    r = pick([port('PartyKeys In', 'i')], [port('SAM5704 APP', 'o')])
    assert.ok(!r.output, 'a different kind is another device')
    r = pick([port('Casio', 'c')], [port('PartyKeys Out', 'o')])
    assert.ok(!r.output || r.output.id === 'o')   // existing rule for a controller with a separate light keyboard; the party port still needs its own input
  }

  // ---- 7. PopuPiano: 1E palette, then 20 frames with all 29 lamps; 29 keys; no pairing needed ---------------------------------
  {
    const P = mkPair('PopuPiano', 'p', { input: false })
    bind([P], { input: null, output: P.output, midiAccess: access({ output: P.output, input: null }) })
    clock.tick(100)
    assert.ok(run('partyLights'), 'no input needed')
    assert.equal(P.sent[0][2], 0x1e, 'the palette (1E) is uploaded first')
    set('screen = "play"; player = __player; song = {}; player.active = true')
    play([60, 64], [])
    clock.tick(50)
    const f20 = P.sent.filter((f) => f[2] === 0x20)
    assert.ok(f20.length >= 2, 'a clear frame and a lit frame')
    const last = f20.at(-1)
    assert.equal(last[3], 29, 'all 29 lamps in every 20 frame')
    assert.equal(last.length, 4 + 29 * 2 + 1)
    const lamps = new Map(); for (let i = 4; i < last.length - 1; i += 2) lamps.set(last[i], last[i + 1])
    assert.ok(lamps.get(60 - 48) > 0 && lamps.get(64 - 48) > 0 && lamps.get(61 - 48) === 0, 'lamps 12 and 16 are lit (notes 60 and 64)')
    assert.equal(run("keysFromName('PopuPiano MIDI')"), 29)
    noChannelBytes(P.sent, 'PopuPiano')
    unbind()
  }

  // ---- a generic MIDI port is untouched: the ROLI paths still run for it, and no controller is made ------------------------------
  {
    const L = mkPair('LUMI Keys BLOCK', 'l', { maker: 'ROLI Ltd.' })
    bind([L])
    assert.equal(run('partyLights'), null); assert.equal(run('partyBound()'), false)
    assert.equal(run('hasNoteLightPort()'), true, 'a LUMI port is still a note-light port')
    const route = run('noteRoute(60)')
    assert.ok(route[0] === ctx.__out && route[1] === 60)
    ctx.__lit = new Map([[60, 127]])
    run('updateNoteLights(__lit)')
    assert.deepEqual(L.sent.at(-1), [0x90, 60, 127], 'the ROLI Note On light is unchanged')
    run('clearNoteLights()')
    assert.deepEqual(L.sent.at(-1), [0x80, 60, 0], 'and it still clears')
    unbind()
  }

  // ---------------------------------------------------------------------------------------------------------
  // static guards: every site Neon listed carries the party check, and the section never writes a channel message
  const fn = (name) => cut('function ' + name + '(', '\n}\n')
  const section = cut('// <party-lights>', '// </party-lights>')
  assert.ok(!/0x[89a][0-9a-f]\b|\[\s*0x[89a]0/i.test(section), 'the party section never builds a Note On, Note Off or aftertouch message')
  for (const name of ['identifyKeyboard', 'midiLightSweep', 'runMidiLightTest', 'cancelLightTest', 'clearNoteLights', 'noteRoute', 'updateNoteLights', 'syncBlockLinks']) {
    assert.match(fn(name), /isPartyOut|partyBound|hasNoteLightPort|partyClear|cancelPartyTest/, name + ' knows about party outputs')
  }
  assert.match(src, /const exactWanted = .*isPartyOut\(midiOutput\)/, 'exactWanted is false for party outputs')
  assert.match(src, /\.filter\(\(\[p\]\) => p && !isPartyOut\(p\)\)/, 'BLOCKS links are never opened on a party port')
  assert.match(cut('function handleMidiMessage(', 'function handleNoteOn('), /partyTap\(data, portId\)[\s\S]*?return/, 'the SysEx tap runs before the 0xf0 early return')
  assert.match(fn('pairMessage'), /else handleMidiMessage\(data, 16 \* slot, true, \(slot \? midiInput2 : midiInput\)\?\.id\)$/, 'pairMessage passes the port id on')
  assert.match(src, /rank = \(p\) => \(isPartyPort\(p\) \? \(preferParty \? 4 : 2\) : KB_PORT\.test\(label\(p\)\) \? 3/, 'PARTY_PORT is rank 2, or 4 when a PartyKeys is the picked keyboard')
  assert.match(src, /!SOFT_PORT\.test\(label\(p\)\) && !isPartyPort\(p\) &&/, 'Two keyboards as one skips party ports')
  assert.ok(!/partyLights\?\.reportError/.test(src), 'a host-wide MIDI error never fails the controller: it hears its own sends')
  {
    // retry binds the ports first and rebuilds a failed controller afterwards (not before: the bind would dispose it again)
    const retry = cut('function retryMidiOpen() {', '\n}\n')
    assert.ok(retry.indexOf('bindMidiPorts()') < retry.indexOf('syncPartyLights(true)') && /!midiOpening && partyStatus\.state === 'error'/.test(retry), 'retryMidiOpen order')
  }
  assert.match(src, /midiSysexGranted = true/, 'SysEx access is tracked where requestMIDIAccess runs')
  assert.match(src, /syncPartyLights\(\)\s+\/\/ after the ports above/, 'the controller follows every port change')
  assert.match(fn('learnLengthFromNotes'), /isPartyPort\(midiInput\)/, 'a party keyboard never learns its length from notes')
  assert.match(fn('keyboardInfo'), /'partykeys'/, 'keyboardInfo reports the family')
  assert.match(src, /'obTipTwo'.*partykeys/s, '#obTipTwo is hidden for the PartyKeys choice')
  assert.match(src, /choice !== 'partykeys' && !partyBound\(\)/, '#obInstall is hidden for the PartyKeys choice')
  assert.match(src, /profileById\(choice\)\?\.lights/, 'the setup summary asks the profile whether it has lights')
  assert.match(src, /window\.addEventListener\('pagehide'[\s\S]*?disposeParty\(\)/, 'pagehide disposes the controller')
  assert.match(src, /pageshow/, 'and pageshow builds it again')

  console.log('PartyKeys in the app: ports, no channel bytes anywhere, play/pause/resume, hot-plug, SysEx denied, PopuPiano and unscored echoes PASS (production slices, fake ports and clock)')
})().catch((error) => { console.error(error); process.exitCode = 1 })
