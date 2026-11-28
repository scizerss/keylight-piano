// Run with node scripts/test-tv-link.js. Covers the encoders and the createTVLink send rules in renderer/tv-link.js
// and the tap maths in renderer/tv-calibrate.js, on the production calibration schedule.
// The phone-to-TV path with a real Player is in test-tv-contract.js.
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const path = require('node:path')

// Print the case name on success, then rethrow so a failed assert exits non zero.
async function check(name, fn) {
  try { await fn(); console.log('ok - ' + name) }
  catch (error) { console.error('FAILED - ' + name); throw error }
}

async function main() {
  const url = (file) => pathToFileURL(path.join(__dirname, '..', 'renderer', file)).href
  const { encodeSong, encodeSongClear, encodeState, encodeKeys, encodeScore, encodeScreen, encodeCalib, audibleAt,
    waitAtOf, createTVLink } = await import(url('tv-link.js'))
  const { CALIB, makeSchedule, resultFromTaps } = await import(url('tv-calibrate.js'))
  const T = await import(url('tv-sync.js'))
  const { createScore } = await import(url('scoring.js'))
  const CONNECTED = { type: 'tv', event: 'connected', width: 1, height: 1 }
  const READY = { type: 'tv', event: 'ready' }

  // One harness for the link cases: a fake player, a send log and a clock (ms, starting at 0).
  function harness(opts) {
    const o = opts || {}
    const sent = [], clock = { t: 0 }, events = []
    const notesA = [{ pitch: 60, start: 1, dur: 0.5, hand: 'left' }, { pitch: 64, start: 2, dur: 0.5, hand: 'right' }]
    const h = { sent, clock, events, notesA }
    const tv = T.createTVModel()
    const packets = []
    h.player = {
      speedNotes: notesA, song: { duration: 30, tempo: 120, bars: null }, windowStart: 48,
      playing: false, waiting: false, mode: 'PLAY', advancement: 'continuous', score: createScore([]),
      needPitches: new Set(), countIn: 0, end: 30, rev: 0, _groups: [], _groupIndex: 0,
      _isHit: () => false, _anchorAt: 0,
      get active() { return this.playing || this.waiting },
      outputLatency: () => 0,
      snapshot: () => ({
        now: 0, position: 1, playing: h.player.playing, waiting: h.player.waiting, needPitches: h.player.needPitches,
        loop: { a: null, b: null, on: false }, rate: 1, countInStart: 0, countInUntil: h.player.countInBeats ? 1 : 0,
        countInSeconds: 0, countInBeats: h.player.countInBeats, handFilter: 'both', windowStart: 48
      })
    }
    h.player.score.streak = 0
    h.current = o.player === undefined ? h.player : o.player
    h.link = createTVLink({
      send: (op) => {
        sent.push(op)
        if (['song', 'songChunk'].includes(op.msg?.t)) packets.push(op.msg)
      }, now: () => clock.t, perfNow: () => clock.t, getPlayer: () => h.current,
      getSong: () => (h.current ? { id: 's1', title: 'Song', artist: 'Artist', keyCount: 24 } : null),
      getScreen: () => ({ name: h.screen ?? (h.current ? 'play' : 'idle'), song: h.current ? { title: 'Song', artist: 'Artist' } : null }),
      getSettings: () => ({ delayMs: 160, view: 'CASCADE', noteLabels: 'off' }),
      getKeys: () => ({ held: new Set([60]), feedback: new Map() }),
      enabled: o.enabled === undefined ? true : o.enabled, allowed: o.allowed, onEvent: (ev) => events.push(ev)
    })
    h.msgs = () => sent.filter((e) => e.op === 'tvSend').map((e) => e.msg)
    h.types = () => h.msgs().map((m) => m.t)
    h.flush = () => {
      while (packets.length) {
        const ack = T.receiveSongPacket(tv, packets.shift())
        if (ack) h.link.onNative({ type: 'tv', event: ack.op, ...ack })
      }
    }
    h.ready = () => { h.link.onNative(CONNECTED); h.link.onNative(READY); h.flush() }
    return h
  }

  await check('calibration reaches the TV before its first cue while a song ACK is pending', () => {
    const h = harness()
    h.link.onNative(CONNECTED)
    h.link.onNative(READY)
    assert.ok(h.types().includes('song'))
    assert.ok(!h.types().includes('screen'), 'the player screen waits for its song')
    h.screen = 'calibrate'
    h.link.sendScreen()
    h.link.sendCalib(makeSchedule(1000))
    assert.deepEqual(h.types().slice(-2), ['screen', 'calib'])
    assert.equal(h.msgs().at(-2).name, 'calibrate')
    const receiver = T.createTVModel()
    for (const msg of h.msgs().slice(-2)) T.applyTVMessage(receiver, msg, { wallMs: 1000, perfMs: 1000 })
    assert.equal(receiver.screen.name, 'calibrate')
    assert.equal(receiver.calib.count, CALIB.count)
    h.screen = 'play'
    h.link.sendScreen()
    assert.equal(h.msgs().filter((msg) => msg.t === 'screen').at(-1).name, 'calibrate')
    h.flush()
    assert.equal(h.msgs().filter((msg) => msg.t === 'screen').at(-1).name, 'play')
  })

  // Encoders.
  const songPlayer = {
    speedNotes: [
      { pitch: 60, start: 1.23456, dur: 0.5, hand: 'left', finger: 3, vel: 90 },
      { pitch: 72, start: 2, dur: 0.25, hand: 'right', vel: undefined }
    ],
    song: { duration: 30.0004, tempo: 96, bars: [0, 2.5] }, windowStart: 48
  }
  await check('E1 encodeSong builds a song message', () => {
    assert.deepEqual(encodeSong(songPlayer, { id: 'abc', title: 'Title', artist: 'Composer', keyCount: 24 }), {
      t: 'song', id: 'abc', title: 'Title', artist: 'Composer', duration: 30, tempo: 96, keyCount: 24,
      windowStart: 48, bars: [0, 2.5], notes: [[60, 1.235, 0.5, 0, 3, 90], [72, 2, 0.25, 1, 0, 100]]
    })
  })
  await check('E2 encodeSong without bars, and bad input', () => {
    const msg = encodeSong({ ...songPlayer, song: { duration: 10, tempo: 120 } }, {})
    assert.deepEqual([msg.bars, msg.duration, msg.tempo], [null, 10, 120])
    assert.equal(encodeSong({ speedNotes: null }, {}), null)
  })
  await check('E2b encodeSongClear is the message that drops the TV song', () => {
    assert.deepEqual(encodeSongClear(), { t: 'song', id: null })
  })
  const wall = 1700000000000
  const snap = {
    now: 100, position: 12.5, rate: 0.5, playing: true, waiting: false, needPitches: new Set([60, 64]),
    countInStart: 101, countInUntil: 103, countInSeconds: 2, countInBeats: 2, loop: { a: 4, b: 8, on: true },
    handFilter: 'left', windowStart: 48
  }
  const ctx = { wallMs: wall, delayMs: 160, view: 'CASCADE', noteLabels: 'off', rev: 2, waitAt: 13, end: 20 }
  await check('E3 encodeState sends ms wall times, rev, waitAt, end and the count in beats', () => {
    assert.deepEqual(encodeState(snap, ctx), {
      t: 'state', at: wall, position: 12.5, rate: 0.5, playing: true, waiting: false,
      needPitches: [60, 64], rev: 2, waitAt: 13, end: 20,
      countInStart: wall + 1000, countInUntil: wall + 3000, countInBeats: 2,
      loop: { a: 4, b: 8 }, handFilter: 'left', view: 'CASCADE', noteLabels: 'off', windowStart: 48, waitMode: false, delayMs: 160
    })
  })
  await check('E4 encodeState drops a finished count in, an off loop and missing waits', () => {
    const msg = encodeState({ ...snap, countInStart: 0, countInUntil: 0, loop: { a: 4, b: 8, on: false } },
      { wallMs: wall, delayMs: 160 })
    assert.deepEqual([msg.countInStart, msg.countInUntil, msg.loop, msg.waitAt, msg.end, msg.countInBeats, msg.rev],
      [0, 0, null, null, null, 0, 0])
  })
  await check('E4b encodeState maps Sheet to Cascade and passes wait mode through', () => {
    const msg = encodeState(snap, { ...ctx, view: 'SHEET', waitMode: true })
    assert.deepEqual([msg.view, msg.waitMode], ['CASCADE', true])
    assert.equal(encodeState(snap, { ...ctx, view: 'COLORNOTE' }).view, 'COLORNOTE')
  })
  await check('E4c encodeState keeps the at it is given (the audible start), and falls back to the wall clock', () => {
    assert.equal(encodeState(snap, { ...ctx, at: wall + 40 }).at, wall + 40)
    assert.equal(encodeState(snap, { ...ctx, at: undefined }).at, wall)
  })
  await check('E4d audibleAt waits for the output latency after the anchor', () => {
    const p = { _anchorAt: 10, outputLatency: () => 0.04 }
    const playing = { playing: true, waiting: false, now: 9 }
    assert.equal(audibleAt(p, playing, wall), wall + 1040)                  // the anchor + latency is 1.04 s ahead
    assert.equal(audibleAt(p, { ...playing, now: 11 }, wall), wall)         // already audible: the wall clock
    assert.equal(audibleAt(p, { ...playing, playing: false }, wall), wall)  // paused: no start to wait for
    assert.equal(audibleAt({ _anchorAt: NaN }, playing, wall), wall)
  })
  const feedback = new Map([[60, { kind: 'perfect', until: 1220 }], [0, { kind: 'good', until: 1100 }],
    [64, { kind: 'missed', until: 900 }]])
  await check('E5 encodeKeys keeps live feedback in wall ms and drops stale entries', () => {
    const msg = encodeKeys(new Set([60, 64]), feedback, 1000, wall)
    assert.deepEqual([msg.held, msg.feedback.length], [[60, 64], 2])
    assert.deepEqual(msg.feedback, [[60, 'perfect', wall + 220], [0, 'good', wall + 100]])
  })
  await check('E6 encodeScore keeps the four counters', () => assert.deepEqual(
    encodeScore({ accuracy: 0.92, streak: 14, hits: 40, misses: 3 }),
    { t: 'score', accuracy: 0.92, streak: 14, hits: 40, misses: 3 }))
  await check('E7 encodeScreen of idle carries no extra keys', () => {
    const msg = encodeScreen({ name: 'idle' })
    assert.deepEqual([msg, 'song' in msg, 'results' in msg], [{ t: 'screen', name: 'idle' }, false, false])
  })
  await check('E8 encodeScreen of play carries the song', () => assert.deepEqual(
    encodeScreen({ name: 'play', song: { title: 'T', artist: 'A' } }),
    { t: 'screen', name: 'play', song: { title: 'T', artist: 'A' } }))
  await check('E9 encodeScreen of results carries the results', () => {
    const results = { stars: 3, accuracy: 0.9, longestStreak: 12, hits: 40, misses: 4, best: true }
    assert.deepEqual(encodeScreen({ name: 'results', results }), { t: 'screen', name: 'results', results })
  })
  await check('E10 encodeCalib passes the schedule through', () => assert.deepEqual(
    encodeCalib({ startAt: 5000, periodMs: 1400, count: 14 }),
    { t: 'calib', startAt: 5000, periodMs: 1400, count: 14 }))
  await check('E11 waitAtOf is the first group with a note still to play, in wait mode only', () => {
    const n60 = { pitch: 60 }, n64 = { pitch: 64 }, n72 = { pitch: 72 }
    const hit = new Set([n60])
    const p = {
      mode: 'PRACTISE', advancement: 'pauseAndSnap', score: {}, _groupIndex: 0,
      _groups: [{ time: 1, notes: [n60] }, { time: 2, notes: [n64, n60] }, { time: 3, notes: [n72] }],
      _isHit: (n) => hit.has(n)
    }
    assert.equal(waitAtOf(p), 2)                                            // group 1 is all hit: skipped
    p._groupIndex = 2
    assert.equal(waitAtOf(p), 3)
    assert.equal(waitAtOf({ ...p, mode: 'PLAY' }), null)
    assert.equal(waitAtOf({ ...p, advancement: 'continuous' }), null)
    assert.equal(waitAtOf({ ...p, score: null }), null)
    p._groupIndex = 3
    assert.equal(waitAtOf(p), null)                                         // nothing left to stop for
  })

  // Link behaviour.
  await check('L1 a disabled link sends nothing', () => {
    const h = harness({ enabled: false })
    h.link.onNative(CONNECTED); h.link.onNative(READY); h.flush()
    h.link.sendState(); h.link.sendKeys(new Set([60]), new Map()); h.link.sendScore(); h.link.sendScreen()
    h.link.sendCalib({ startAt: 1, periodMs: 1400, count: 14 }); h.link.tick(); h.link.setSoundRoute('phone')
    assert.deepEqual(h.sent, [])
  })
  await check('a locked attached TV only receives the Premium screen until access is granted', () => {
    const h = harness({ allowed: false })
    h.link.setSoundRoute('phone')
    h.ready()
    assert.equal(h.link.isConnected(), true)
    assert.equal(h.link.isReady(), false)
    h.link.sendScreen()
    h.link.sendState()
    h.link.sendScore()
    h.link.sendKeys(new Set([60]))
    h.link.sendCalib({ count: 1 })
    h.link.resnapshot()
    h.link.tick()
    assert.deepEqual(h.sent, [
      { op: 'tvSound', route: 'tv' },
      { op: 'tvSend', msg: { t: 'screen', name: 'premium' } }
    ])

    h.sent.length = 0
    h.link.setAllowed(true)
    h.flush()
    assert.equal(h.link.isReady(), true)
    assert.deepEqual(h.types(), ['song', 'score', 'keys', 'state', 'screen'])
    assert.equal(h.msgs().at(-1).name, 'play')
    assert.deepEqual(h.sent[0], { op: 'tvSound', route: 'phone' })

    h.sent.length = 0
    h.link.setAllowed(false)
    h.link.tick()
    assert.equal(h.link.isReady(), false)
    assert.deepEqual(h.sent, [
      { op: 'tvSound', route: 'tv' },
      { op: 'tvSend', msg: { t: 'screen', name: 'premium' } }
    ])
  })

  await check('L2 a link that never connected sends nothing', () => {
    const h = harness()
    h.link.sendState(); h.link.sendKeys(new Set([60]), new Map()); h.link.sendScore(); h.link.sendScreen()
    h.link.tick()
    assert.deepEqual(h.sent, [])
  })
  await check('L3 ready sends the song, the score and keys snapshots, the state and the screen, in that order', () => {
    const h = harness(); h.ready()
    assert.deepEqual(h.types(), ['song', 'score', 'keys', 'state', 'screen'])
    assert.deepEqual(h.msgs()[2], { t: 'keys', held: [60], feedback: [] })
  })
  await check('a TV page failure pauses delivery until the page is ready again', () => {
    const h = harness()
    h.link.onNative(CONNECTED)
    assert.equal(h.link.isConnected(), true)
    assert.equal(h.link.isReady(), false)
    h.link.sendState()
    assert.deepEqual(h.types(), [])
    h.link.onNative(READY); h.flush()
    h.sent.length = 0
    h.link.onNative({ type: 'tv', event: 'notReady' })
    assert.equal(h.link.isConnected(), true)
    assert.equal(h.link.isReady(), false)
    assert.equal(h.events.at(-1).event, 'notReady')
    h.link.sendState()
    assert.deepEqual(h.types(), [])
    h.link.onNative(READY); h.flush()
    assert.deepEqual(h.types(), ['song', 'score', 'keys', 'state', 'screen'])
  })
  await check('L4 the song is re-sent only for a new speedNotes array', () => {
    const h = harness(); h.ready(); h.sent.length = 0
    h.link.sendState()
    assert.deepEqual(h.types(), ['state'])
    h.sent.length = 0; h.player.speedNotes = h.notesA.slice(); h.link.sendState()
    assert.deepEqual(h.types(), ['song'])
    h.flush()
    assert.deepEqual(h.types(), ['song', 'score', 'keys', 'state'])
    h.sent.length = 0; h.link.sendState()
    assert.deepEqual(h.types(), ['state'])
  })
  await check('a lost acknowledgement retransmits, then restores the phone and retries on foreground', () => {
    const h = harness()
    h.link.onNative(CONNECTED)
    h.link.onNative(READY)
    const original = h.msgs()[0]
    for (const t of [2100, 4200, 6300]) { h.clock.t = t; h.link.tick() }
    assert.deepEqual(h.msgs(), [original, original, original])
    assert.equal(h.link.isReady(), false)
    assert.equal(h.events.at(-1).event, 'songFailed')
    h.link.resnapshot(true)
    assert.ok(h.msgs().at(-1).songGen > original.songGen)
    h.flush()
    assert.equal(h.link.isReady(), true)
    assert.equal(h.events.at(-1).event, 'songRecovered')
  })
  await check('L5 scores are throttled to ten a second, tick flushes the last', () => {
    const h = harness(); h.ready(); h.sent.length = 0    // the ready snapshot counts as the last score at 0 ms
    h.clock.t = 0; h.link.sendScore()
    for (let t = 10; t <= 290; t += 10) { h.clock.t = t; h.link.sendScore() }
    h.clock.t = 300; h.link.tick()
    const scores = h.msgs().filter((m) => m.t === 'score')
    assert.equal(scores.length, 3)                                          // at 100, 200 and the flush at 300
    assert.equal(typeof scores[0].streak, 'number')
  })
  await check('L6 state goes out once a second while playing and on entry to Wait', () => {
    const h = harness(); h.clock.t = 0; h.ready(); h.sent.length = 0; h.player.playing = true
    for (let t = 100; t <= 3000; t += 100) { h.clock.t = t; h.link.tick() }
    assert.deepEqual(h.types(), ['state', 'state', 'state'])               // at 100 (a change), 1100 and 2100
    h.player.playing = false; h.clock.t = 3100; h.link.tick()
    const before = h.sent.length
    for (let t = 3200; t <= 5000; t += 100) { h.clock.t = t; h.link.tick() }
    assert.equal(h.sent.length, before)
    h.player.waiting = true; h.clock.t = 5100; h.link.tick()
    const waitingBefore = h.sent.length
    for (let t = 5200; t <= 7200; t += 100) { h.clock.t = t; h.link.tick() }
    assert.equal(h.sent.length, waitingBefore)
  })
  await check('L7 keys go out straight away', () => {
    const h = harness(); h.ready(); h.sent.length = 0
    h.link.sendKeys(new Set([60, 64]), new Map())
    assert.deepEqual(h.sent, [{ op: 'tvSend', msg: { t: 'keys', held: [60, 64], feedback: [] } }])
  })
  await check('L8 a disconnect stops the link, a reconnect re-sends the whole picture', () => {
    const h = harness(); h.ready()
    h.link.onNative({ type: 'tv', event: 'disconnected' }); h.sent.length = 0
    h.link.sendState(); h.link.sendScore(); h.link.sendKeys(new Set([60]), new Map())
    assert.deepEqual(h.sent, [])
    h.ready()
    assert.deepEqual(h.types(), ['song', 'score', 'keys', 'state', 'screen'])
  })
  await check('L9 the sound route is sent before the TV connects', () => {
    const h = harness(); h.link.setSoundRoute('phone')
    assert.deepEqual(h.sent, [{ op: 'tvSound', route: 'phone' }])
    h.link.setSoundRoute('bogus')
    assert.equal(h.sent.length, 1)
  })
  await check('muting uses the playback route on the native bridge', () => {
    const h = harness()
    h.link.setSoundRoute('muted')
    assert.deepEqual(h.sent, [{ op: 'tvSound', route: 'tv' }])
  })
  await check('L10 the sound event is kept for the UI', () => {
    const h = harness()
    h.link.onNative({ type: 'tv', event: 'sound', route: 'phone', outputs: ['Speaker'], portTypes: ['Speaker'], latencyMs: 12 })
    assert.deepEqual(h.link.sound(), { route: 'phone', outputs: ['Speaker'], portTypes: ['Speaker'], latencyMs: 12 })
  })
  await check('L12 wait mode is sent only while practising with a wait', () => {
    const h = harness(); h.ready()
    h.player.mode = 'PRACTISE'; h.player.advancement = 'pauseAndSnap'
    h.link.sendState()
    assert.equal(h.msgs().pop().waitMode, true)
    h.player.mode = 'PLAY'; h.player.advancement = 'continuous'
    h.link.sendState()
    assert.equal(h.msgs().pop().waitMode, false)
  })
  await check('L11 onEvent sees every tv event and nothing else', () => {
    const h = harness(); h.ready()
    h.link.onNative({ type: 'tv', event: 'disconnected' })
    h.link.onNative({ type: 'tv', event: 'sound', route: 'tv', outputs: [], latencyMs: 5 })
    h.link.onNative({ type: 'other' })
    assert.equal(h.events.length, 4)
    assert.deepEqual(h.events.map((e) => e.event), ['connected', 'ready', 'disconnected', 'sound'])
  })
  await check('L13 a partial chord hit sends the new wait before the keys', () => {
    const h = harness(); h.ready()
    h.player.mode = 'PRACTISE'; h.player.advancement = 'pauseAndSnap'
    h.player.waiting = true; h.player.needPitches = new Set([60, 64]); h.link.sendState()
    h.sent.length = 0
    h.player.needPitches.delete(60)                                          // the player's noteOn does not emit
    h.link.sendKeys(new Set([60]), new Map())
    assert.deepEqual(h.types(), ['state', 'keys'])
    assert.deepEqual(h.msgs()[0].needPitches, [64])
  })
  await check('L14 rev counts the player transport and stays monotonic across players', () => {
    const h = harness(); h.ready()
    const lastState = () => h.msgs().filter((m) => m.t === 'state').pop()
    const rev0 = lastState().rev
    h.player.rev = 3; h.link.sendState()
    const rev1 = lastState().rev
    assert.ok(rev1 > rev0, 'a seek, restart or speed change raises rev')
    const next = { ...h.player, rev: 0, score: createScore([]), snapshot: h.player.snapshot, speedNotes: h.notesA.slice() }
    h.current = next; h.link.sendState(); h.flush()
    const rev2 = lastState().rev
    assert.ok(rev2 > rev1, 'a new player starts above the last rev sent')
    next.rev = 1; h.link.sendState()
    assert.ok(lastState().rev > rev2)
  })
  await check('L15 a new score object is sent at once (a restart)', () => {
    const h = harness(); h.ready(); h.sent.length = 0
    h.player.score = createScore([]); h.player.score.streak = 0
    h.link.tick()
    assert.ok(h.types().includes('score'))
    assert.deepEqual(h.types().filter((t) => t === 'score').length, 1)
  })
  await check('L16 the Playground: the song is cleared, the screen is sent and keys go out', () => {
    const h = harness(); h.ready(); h.sent.length = 0
    h.current = null                                                         // startFreeplay: no player, no song
    h.link.sendScreen()
    assert.equal(h.msgs()[0].t, 'song')
    assert.equal(h.msgs()[0].id, null)
    h.flush()
    assert.deepEqual(h.types(), ['song', 'screen', 'keys'])
    h.sent.length = 0; h.link.sendScreen()
    assert.deepEqual(h.types(), ['screen'])                                  // cleared once, not again
  })
  await check('L17 without a player on ready, the snapshots still go out', () => {
    const h = harness({ player: null }); h.ready()
    assert.deepEqual(h.types(), ['song', 'screen', 'keys'])
  })
  await check('L18 the state carries the count in beats, the end and the next wait point', () => {
    const h = harness(); h.ready()
    h.player.mode = 'PRACTISE'; h.player.advancement = 'pauseAndSnap'; h.player.countInBeats = 2; h.player.end = 1.5
    h.player.playing = true
    h.player._groups = [{ time: 1, notes: [h.player.speedNotes[0]] }, { time: 2, notes: [h.player.speedNotes[1]] }]
    h.player._isHit = () => false
    h.player.score = createScore([])
    h.link.sendState()
    const msg = h.msgs().pop()
    assert.deepEqual([msg.countInBeats, msg.end, msg.waitAt], [2, 1.5, 1])
  })

  await check('L19 a TV resized event keeps ready state and forwards the new size', () => {
    const h = harness()
    h.ready()
    h.link.onNative({ type: 'tv', event: 'sound', route: 'tv', outputs: ['TV'], portTypes: ['airplay'], latencyMs: 120 })
    h.sent.length = 0
    h.link.onNative({ type: 'tv', event: 'resized', width: 3840, height: 2160 })
    assert.equal(h.link.isConnected(), true)
    assert.equal(h.link.isReady(), true)
    assert.equal(h.link.sound()?.route, 'tv')
    assert.deepEqual(h.events.at(-1), { type: 'tv', event: 'resized', width: 3840, height: 2160 })
    h.link.sendKeys()
    assert.ok(h.types().includes('keys'), 'link keeps sending without waiting for a new ready')
  })
  await check('L20 a replacement TV connected event during calibration resets ready until the new page is ready', () => {
    const h = harness()
    h.ready()
    h.screen = 'calibrate'
    h.link.sendScreen()
    h.link.sendCalib(makeSchedule(1000))
    h.sent.length = 0
    h.link.onNative({ type: 'tv', event: 'connected', width: 1920, height: 1080 })
    assert.equal(h.link.isConnected(), true)
    assert.equal(h.link.isReady(), false, 'replacement window must not inherit ready before its page boots')
    h.link.sendKeys()
    assert.equal(h.types().length, 0, 'messages pause until the replacement TV sends ready')
    h.link.onNative(READY)
    assert.equal(h.link.isReady(), true)
    assert.ok(h.types().includes('screen'), 'resyncs cleanly once the replacement page is ready')
  })

  // Calibration: the production schedule, with the phone's own constants.
  const schedule = makeSchedule(1000)
  const tapsWith = (offsetAt) => Array.from({ length: schedule.count }, (_, k) => schedule.startAt + schedule.periodMs * k + offsetAt(k))
  await check('C1 makeSchedule leads the first flash and uses 14 flashes 1.4 s apart', () => assert.deepEqual(
    makeSchedule(1000), { startAt: 2500, periodMs: 1400, count: 14 }))
  await check('C1b the production constants: 14 flashes, 1400 ms apart, 0 to 600 ms', () => {
    assert.deepEqual([CALIB.count, CALIB.periodMs, CALIB.dropFirst, CALIB.minTaps, CALIB.maxIqrMs, CALIB.minDelayMs, CALIB.maxDelayMs],
      [14, 1400, 4, 8, 90, 0, 600])
  })
  await check('C2 fourteen even taps give that offset', () => assert.deepEqual(
    resultFromTaps(schedule, tapsWith(() => 180)), { ok: true, delayMs: 180 }))
  await check('C2b every supported delay comes back within 1 ms on the production schedule', () => {
    const big = makeSchedule(1700000000000)
    for (const delay of [0, 100, 300, 450, 600]) {
      const taps = Array.from({ length: big.count }, (_, k) => big.startAt + big.periodMs * k + delay)
      const res = resultFromTaps(big, taps)
      assert.equal(res.ok, true, `delay ${delay}`)
      assert.ok(Math.abs(res.delayMs - delay) <= 1, `delay ${delay} came back as ${res.delayMs}`)
    }
  })
  await check('C2c small tap jitter around a long delay still reads the delay', () => {
    const jitter = [-20, 20, -10, 10, 0, -20, 20, -10, 10, 0, 20, -20, 10, -10]
    const taps = tapsWith((k) => 450 + jitter[k])
    const res = resultFromTaps(schedule, taps)
    assert.ok(res.ok && Math.abs(res.delayMs - 450) <= 1, JSON.stringify(res))
  })
  await check('C3 tap order does not matter', () => assert.deepEqual(
    resultFromTaps(schedule, tapsWith(() => 180).reverse()), { ok: true, delayMs: 180 }))
  await check('C4 the first four taps are dropped, the middle half sets the delay', () => {
    const jitter = [150, 160, 170, 180, 150, 160, 170, 180, 150, 160]
    assert.deepEqual(resultFromTaps(schedule, tapsWith((k) => (k < 4 ? 300 : jitter[k - 4]))),
      { ok: true, delayMs: 160 })
  })
  await check('C5 fewer than eight kept taps are too few', () => {
    assert.deepEqual(resultFromTaps(schedule, tapsWith(() => 180).slice(0, 11)), { ok: false, reason: 'too-few' })
    assert.deepEqual(resultFromTaps(schedule, tapsWith(() => 180).slice(0, 12)), { ok: true, delayMs: 180 })
  })
  await check('C6 a wide spread of taps is uneven', () => assert.deepEqual(
    resultFromTaps(schedule, tapsWith((k) => (k < 4 ? 180 : k % 2 === 0 ? 100 : 300))),
    { ok: false, reason: 'uneven' }))
  await check('C7 slightly early taps calibrate to zero, very early or aliased taps are rejected', () => {
    for (const offset of [-100, -50, -0.25]) {
      assert.deepEqual(resultFromTaps(schedule, tapsWith(() => offset)), { ok: true, delayMs: 0 })
    }
    for (const offset of [-101, 750]) {
      assert.deepEqual(resultFromTaps(schedule, tapsWith(() => offset).slice(0, 13)), { ok: false, reason: 'out-of-range' })
    }
  })
  await check('C8 a delay over 600 ms and duplicate taps are rejected', () => {
    assert.deepEqual(resultFromTaps(schedule, tapsWith(() => 650)), { ok: false, reason: 'out-of-range' })
    assert.deepEqual(resultFromTaps(schedule, Array(12).fill(schedule.startAt + 100)), { ok: false, reason: 'duplicate' })
  })
  await check('C9 bad tap values are ignored', () => {
    assert.deepEqual(resultFromTaps(schedule, null), { ok: false, reason: 'too-few' })
    const taps = tapsWith(() => 180); taps.push(NaN, 'x')
    assert.deepEqual(resultFromTaps(schedule, taps), { ok: true, delayMs: 180 })
  })
}

main().then(() => { console.log('tv-link: ok'); process.exit(0) })
  .catch((error) => { console.error(error); process.exit(1) })
