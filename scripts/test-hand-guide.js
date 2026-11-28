const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const load = (f) => import(require('node:url').pathToFileURL(path.join(__dirname, '..', 'renderer', f)).href)

function testAppInput() {
  const app = readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8')
  const slice = (start, end) => app.slice(app.indexOf(start), app.indexOf(end))
  const calls = []
  const mark = (action) => () => { calls.push(action); return true }
  const edit = {}
  const context = vm.createContext({
    $: (id) => ({
      editSong: edit, continuePlay: { click: mark('continue') }, app: { inert: false }
    })[id] || { classList: { contains: (name) => name === 'hidden' } },
    document: {
      querySelector(selector) {
        assert.equal(selector, 'dialog[open]')
        return context.dialogOpen ? {} : null
      }
    },
    player: {
      mode: 'PRACTISE', armed: true, needPitches: new Set([60]),
      startArmed: mark('start'), noteOn: mark('score'), pause: mark('pause'), restart: mark('restart')
    },
    screen: 'play', song: {}, freeplay: false, setup: { open: false }, handGuideRun: null, homeLight: null,
    loopSections: () => null, kbKeys: () => 24, togglePlay: mark('play'),
    cancelSongGuide: () => { context.handGuideRun = null; calls.push('cancel guide') },
    editorBlocked: () => false, guided: { close() {} }, endTake() {}, rollEditor: { open: mark('editor') },
    performance: { now: () => 0 }, held: new Set(), noteVel: new Map(), settings: {},
    tourIsOpen: () => false, routeToJam: () => false, noteOn: mark('sound'), handGuidePress: mark('guide'),
    quizPress: mark('quiz'), exercise: null, airSource: null,
    songRecording: null, initAudio() {}, logMidi() {}, tvKeys() {}, learnLengthFromNotes() {}, calibrateFromNote() {},
    cancelLightTest() {}, cancelCeremony() {}, syncBacking() {}, pumpAudio() {}, syncHudButtons() {}
  })
  vm.runInContext([
    slice('function keyButtonAction(', 'const loopSections ='),
    slice('function restartSong(', '// Wait mode is stopped'),
    slice('function waitArmed(', 'function setMode('),
    slice('function handleNoteOn(', '// release: the key'),
    slice("  $('editSong').onclick", '  // the same editor')
  ].join('\n'), context)

  context.handGuideRun = { kind: 'song' }
  context.handleKeyButton(0, 'press')
  context.handleKeyButton(3, 'press')
  context.handleKeyButton(4, 'press')
  assert.deepEqual(calls.splice(0), [], 'player arrows cannot play or restart under the song guide')

  context.screen = 'home'
  context.handGuideRun = { kind: 'intro' }
  context.handleKeyButton(4, 'press')
  assert.deepEqual(calls.splice(0), [], 'the right arrow cannot continue behind the intro')

  context.screen = 'play'
  context.handGuideRun = { kind: 'song' }
  context.handleKeyButton(4, 'press', { player: true })
  assert.deepEqual(calls.splice(0), ['cancel guide', 'restart'], 'restart clears any pending guide action')
  context.handGuideRun = { kind: 'song' }
  edit.onclick()
  assert.deepEqual(calls.splice(0), ['cancel guide', 'pause', 'editor'], 'editing clears the guide before opening')

  context.dialogOpen = true
  assert.equal(context.waitArmed(), false, 'an open dialog blocks armed Wait')
  context.handleKeyButton(3, 'press')
  context.handleKeyButton(4, 'press')
  context.handleNoteOn(60, 90)
  context.player.armed = false
  context.handleNoteOn(60, 90)
  context.handGuideRun = { kind: 'intro' }
  context.handleNoteOn(60, 90)
  assert.deepEqual(calls.splice(0), ['sound', 'sound', 'sound'], 'MIDI sounds without playing, scoring or advancing the guide under a dialog')

  context.dialogOpen = false
  context.songRecording = { capturing: true }
  context.handleNoteOn(60, 90)
  assert.deepEqual(calls.splice(0), [], 'MIDI is silent while capturing a microphone recording')
  context.songRecording = null
  context.handleNoteOn(60, 90)
  context.handGuideRun = null
  context.player.armed = true
  assert.equal(context.waitArmed(), true)
  context.handleNoteOn(60, 90)
  assert.deepEqual(calls.splice(0), ['sound', 'guide', 'sound', 'quiz', 'start', 'score'])
}

function testFreshStarts({ HandGuide, handGuideOn, startPositionKey }) {
  const app = readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8')
  const slice = (start, end) => app.slice(app.indexOf(start), app.indexOf(end))
  const makePlayer = () => ({
    armed: true, active: false, mode: 'PRACTISE', position: 0, countIn: 1,
    restart() { this.position = 0; this.active = false },
    play() { this.active = true }
  })
  const settings = { experience: 'new', handGuide: 'auto' }
  const context = vm.createContext({
    HandGuide, handGuideOn, startPositionKey, settings, player: makePlayer(),
    song: {}, freeplay: false, screen: 'play', gameMeta: null, exerciseMeta: null,
    setup: { open: false }, document: { body: { classList: { contains: () => false } } },
    handGuideRun: null, handGuideAfterIntro: true, handGuideStartPlayer: null, handGuideShownKey: '',
    courseExamRun: () => false, tourIsOpen: () => false,
    songGuideTargets: () => [{ pitch: 60, hand: 'right', finger: 1 }],
    renderSongGuide() {}, syncHudButtons() {}, initAudio() {}, cancelLightTest() {}, cancelCeremony() {},
    cancelSongGuide() { context.handGuideRun = null }, syncBacking() {}, pumpAudio() {},
    console: { log() {} }
  })
  vm.runInContext([
    slice('function maybeGuideHands(', 'function renderSongGuide('),
    slice('function playFresh(', '// Wait mode is stopped')
  ].join('\n'), context)
  assert.ok(context.maybeGuideHands(), 'the first piece guides a beginner even after the intro')
  context.cancelSongGuide()
  assert.equal(context.maybeGuideHands(), false, 'one guide per fresh start')
  context.player = makePlayer()
  assert.ok(context.maybeGuideHands(), 'another song in the same position gets a guide')
  context.restartSong(true)
  assert.equal(context.handGuideRun?.kind, 'song', 'retry in Wait brings back the guide')
  assert.equal(context.player.active, false)
  context.player.armed = false
  context.player.mode = 'PLAY'
  context.restartSong(true)
  const timed = context.handGuideRun
  assert.equal(timed?.kind, 'song', 'timed retry also gets a guide')
  assert.equal(context.player.active, false)
  context.cancelSongGuide()
  timed.then()
  assert.equal(context.player.active, true, 'timed play starts when the guide closes')
  assert.equal(context.maybeGuideHands(), false, 'no guide while the song or loop is running')
  context.player.active = false
  context.player.position = 1
  assert.equal(context.maybeGuideHands(), false, 'no guide when resuming mid-song')
  context.player = makePlayer()
  settings.experience = 'some'
  assert.equal(context.maybeGuideHands(), false, 'other players only guide for a new position')
  context.player = makePlayer()
  settings.experience = 'new'
  settings.handGuide = 'off'
  assert.equal(context.maybeGuideHands(), false, 'auto-off stays off on fresh starts')
}

;(async () => {
  const { guideTargets, startPositionKey, cTargets, HandGuide, autoOffUpdate, handGuideOn } = await load('hand-guide.js')
  testFreshStarts({ HandGuide, handGuideOn, startPositionKey })

  const notes = [
    { pitch: 64, time: 0, hand: 'right', finger: 3 },
    { pitch: 60, time: 0.5, hand: 'right', finger: 1 },
    { pitch: 62, time: 1, hand: 'right', finger: 2 },
    { pitch: 67, time: 1.5, hand: 'right', finger: 5 },
    { pitch: 65, time: 2, hand: 'right', finger: 4 },
    { pitch: 48, time: 0.2, hand: 'left', finger: 5 },
    { pitch: 50, time: 0.7, hand: 'left', finger: 4 },
    { pitch: 52, time: 1.2, hand: 'left', finger: 3 },
    { pitch: 53, time: 1.7, hand: 'left', finger: 2 },
    { pitch: 55, time: 2.2, hand: 'left', finger: 1 }
  ]

  // Order: right hand 1->5 first, then left hand 5->1.
  const ordered = guideTargets(notes)
  assert.deepEqual(ordered.map((t) => `${t.hand}:${t.finger}@${t.pitch}`), [
    'right:1@60', 'right:2@62', 'right:3@64', 'right:4@65', 'right:5@67',
    'left:5@48', 'left:4@50', 'left:3@52', 'left:2@53', 'left:1@55'
  ])
  assert.deepEqual(ordered[0], { pitch: 60, finger: 1, hand: 'right' })

  // Phrase window: only notes before first time + phraseSeconds.
  const phrase = [
    { pitch: 60, time: 0, hand: 'right', finger: 1 },
    { pitch: 62, time: 3.9, hand: 'right', finger: 2 },
    { pitch: 64, time: 4, hand: 'right', finger: 3 },
    { pitch: 65, time: 9, hand: 'right', finger: 4 }
  ]
  assert.deepEqual(guideTargets(phrase).map((t) => t.pitch), [60, 62])
  assert.deepEqual(guideTargets(phrase, { phraseSeconds: 10 }).map((t) => t.pitch), [60, 62, 64, 65])
  assert.deepEqual(guideTargets([], { phraseSeconds: 10 }), [])

  // Unique by finger: the first pitch seen wins, later ones are dropped.
  const repeat = [
    { pitch: 60, time: 0, hand: 'right', finger: 1 },
    { pitch: 60, time: 0.2, hand: 'right', finger: 1 },
    { pitch: 72, time: 1, hand: 'right', finger: 1 },
    { pitch: 60, time: 1, hand: 'left', finger: 1 }
  ]
  assert.deepEqual(guideTargets(repeat).map((t) => `${t.hand}:${t.finger}@${t.pitch}`), ['right:1@60', 'left:1@60'])

  // Window filtering: [windowStart, windowStart + windowKeys).
  const windowed = guideTargets(notes, { windowStart: 60, windowKeys: 5 })
  assert.deepEqual(windowed.map((t) => t.pitch), [60, 62, 64])
  assert.deepEqual(guideTargets(notes, { windowStart: 48, windowKeys: 8 }).map((t) => t.pitch), [48, 50, 52, 53, 55])

  // Hand filter.
  assert.deepEqual(guideTargets(notes, { hand: 'right' }).map((t) => t.hand), ['right', 'right', 'right', 'right', 'right'])
  assert.deepEqual(guideTargets(notes, { hand: 'left' }).map((t) => t.finger), [5, 4, 3, 2, 1])

  // Notes without a finger (or finger 0, or no hand) are skipped.
  const fingerless = [
    { pitch: 60, time: 0, hand: 'right' },
    { pitch: 62, time: 0.5, hand: 'right', finger: 0 },
    { pitch: 64, time: 1, finger: 2 },
    { pitch: 65, time: 1.5, hand: 'right', finger: 2 }
  ]
  assert.deepEqual(guideTargets(fingerless), [{ pitch: 65, finger: 2, hand: 'right' }])

  // startPositionKey: stable, order-independent, hands separated.
  const key = startPositionKey([
    { pitch: 60, finger: 1, hand: 'right' },
    { pitch: 62, finger: 2, hand: 'right' },
    { pitch: 48, finger: 5, hand: 'left' }
  ])
  assert.equal(key, 'R:1@60,2@62|L:5@48')
  assert.equal(startPositionKey(ordered), 'R:1@60,2@62,3@64,4@65,5@67|L:5@48,4@50,3@52,2@53,1@55')
  assert.equal(startPositionKey(ordered.slice().reverse()), startPositionKey(ordered))
  assert.equal(startPositionKey([{ pitch: 48, finger: 5, hand: 'left' }]), 'L:5@48')
  assert.equal(startPositionKey([]), '')

  // cTargets: every C in the window.
  assert.deepEqual(cTargets(48, 24), [48, 60])
  assert.deepEqual(cTargets(48, 48), [48, 60, 72, 84])
  assert.deepEqual(cTargets(49, 8), [])
  assert.deepEqual(cTargets(60, 13), [60, 72])

  // HandGuide presses: ok / wrong / done / ignored.
  const guide = new HandGuide([
    { pitch: 60, finger: 1, hand: 'right' },
    { pitch: 62, finger: 2, hand: 'right' },
    { pitch: 48, finger: 5, hand: 'left' }
  ])
  assert.equal(guide.done, false)
  assert.deepEqual(guide.current(), { pitch: 60, finger: 1, hand: 'right' })
  assert.equal(guide.press(61), 'wrong')
  assert.equal(guide.current().pitch, 60)
  assert.deepEqual(guide.placed, [])
  assert.equal(guide.press(60), 'ok')
  assert.deepEqual(guide.placed, [{ pitch: 60, finger: 1, hand: 'right' }])
  assert.equal(guide.current().pitch, 62)
  assert.equal(guide.press(48), 'wrong')
  assert.equal(guide.press(62), 'ok')
  assert.equal(guide.current().pitch, 48)
  assert.equal(guide.press(48), 'done')
  assert.equal(guide.done, true)
  assert.equal(guide.current(), null)
  assert.equal(guide.placed.length, 3)
  assert.equal(guide.press(60), 'ignored')
  assert.deepEqual(new HandGuide([]).current(), null)

  // Skip: advances without placing.
  const skipped = new HandGuide([
    { pitch: 60, finger: 1, hand: 'right' },
    { pitch: 62, finger: 2, hand: 'right' }
  ])
  assert.equal(skipped.skip(), 'ok')
  assert.equal(skipped.current().pitch, 62)
  assert.deepEqual(skipped.placed, [])
  assert.equal(skipped.skip(), 'done')
  assert.equal(skipped.done, true)
  assert.deepEqual(skipped.placed, [])
  assert.equal(skipped.skip(), 'ignored')

  // Overlay: 1 Hz pulse — on for the first half of each second, off for the second.
  const pulse = new HandGuide([
    { pitch: 60, finger: 1, hand: 'right' },
    { pitch: 62, finger: 2, hand: 'right' }
  ])
  const at = (ms, opts) => pulse.overlay(ms, opts).get(60)
  assert.deepEqual(at(0), { kind: 'pulse', on: true, hand: 'right', finger: 1 })
  assert.equal(at(499).on, true)
  assert.equal(at(500).on, false)
  assert.equal(at(999).on, false)
  assert.equal(at(1000).on, true)
  assert.equal(at(1500).on, false)
  assert.equal(pulse.overlay(0).size, 1)
  assert.equal(pulse.overlay(0).has(62), false)
  assert.equal(pulse.overlay(0, { pulseHz: 2 }).get(60).on, true)
  assert.equal(pulse.overlay(250, { pulseHz: 2 }).get(60).on, false)

  // Reduce motion: the pulse is always on.
  assert.equal(at(500, { reduceMotion: true }).on, true)
  assert.equal(at(999, { reduceMotion: true }).on, true)

  // Placed keys are steady; the next target keeps pulsing.
  pulse.press(60)
  const overlay = pulse.overlay(500)
  assert.deepEqual(overlay.get(60), { kind: 'placed', on: true, hand: 'right', finger: 1 })
  assert.deepEqual(overlay.get(62), { kind: 'pulse', on: false, hand: 'right', finger: 2 })
  pulse.press(62)
  assert.deepEqual([...pulse.overlay(500).values()].map((e) => e.kind), ['placed', 'placed'])

  // anyOf: the find-C step — any target completes the guide in one press.
  const findC = new HandGuide([
    { pitch: 60, finger: 0, hand: 'right' },
    { pitch: 72, finger: 0, hand: 'right' },
    { pitch: 84, finger: 0, hand: 'right' }
  ], { anyOf: true })
  assert.deepEqual([...findC.overlay(0).keys()], [60, 72, 84])
  assert.equal(findC.overlay(0).get(72).on, true)
  assert.equal(findC.overlay(500).get(72).on, false)
  assert.equal(findC.press(61), 'wrong')
  assert.equal(findC.done, false)
  assert.equal(findC.press(72), 'done')
  assert.equal(findC.done, true)
  assert.deepEqual(findC.placed, [{ pitch: 72, finger: 0, hand: 'right' }])
  assert.deepEqual([...findC.overlay(0).entries()], [[72, { kind: 'placed', on: true, hand: 'right', finger: 0 }]])
  assert.equal(findC.press(72), 'ignored')
  const skippedC = new HandGuide([{ pitch: 60, finger: 0, hand: 'right' }], { anyOf: true })
  assert.equal(skippedC.skip(), 'done')

  // autoOffUpdate: counted runs only, five in a row at >= 85% switches it off.
  assert.deepEqual(autoOffUpdate(2, { accuracy: 1, counted: false }), { runs: 2, turnOff: false })
  assert.deepEqual(autoOffUpdate(2, { accuracy: 0.85, counted: true }), { runs: 3, turnOff: false })
  assert.deepEqual(autoOffUpdate(2, { accuracy: 0.84, counted: true }), { runs: 0, turnOff: false })
  assert.deepEqual(autoOffUpdate(0, { accuracy: 0.9 }), { runs: 1, turnOff: false })
  assert.deepEqual(autoOffUpdate(4, { accuracy: 0.9 }), { runs: 5, turnOff: true })
  assert.deepEqual(autoOffUpdate(5, { accuracy: 0.95 }), { runs: 6, turnOff: true })
  assert.deepEqual(autoOffUpdate(0, { accuracy: 0.1 }), { runs: 0, turnOff: false })

  // handGuideOn.
  assert.equal(handGuideOn('always', { experience: 'new' }), true)
  assert.equal(handGuideOn('always', { experience: 'experienced' }), true)
  assert.equal(handGuideOn('off', { experience: 'new' }), false)
  assert.equal(handGuideOn('auto', { experience: 'new' }), true)
  assert.equal(handGuideOn('auto', { experience: 'some' }), true)
  assert.equal(handGuideOn('', { experience: 'new' }), false)
  assert.equal(handGuideOn(undefined, {}), false)

  testAppInput()
  console.log('hand-guide: ok')
})().catch((e) => { console.error(e); process.exit(1) })
