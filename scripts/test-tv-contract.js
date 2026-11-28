// Contract test for TV mode: node scripts/test-tv-contract.js
// The phone's real Player (renderer/player.js) and the real link (renderer/tv-link.js) build the messages. The bridge is
// simulated with a JSON round trip. The TV side is the real reducer, clock and smoother (renderer/tv-sync.js), the same
// code tv.js runs. A fake audio clock drives both sides, so every expected value is exact.
// Prints "tv-contract: ok" when every scenario passes. Protocol and units: docs/TV-MODE.md.
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { readFileSync } = require('node:fs')
const vm = require('node:vm')

const renderer = path.join(__dirname, '..', 'renderer')
const load = (file) => import(pathToFileURL(path.join(renderer, file)).href)

const WALL0 = 1700000000000   // a Date.now() value: the wall clock of the test's audio time 0
const DELAY_MS = 160          // the TV picture delay used by every scenario
const FRAME = 1 / 60

// A song with a count-in-friendly tempo: 120 BPM, so one beat is 0.5 s.
const NOTES = [
  [60, 1.0, 0.5, 1, 0, 90], [62, 1.5, 0.5, 1, 0, 90],
  [64, 2.0, 0.5, 1, 0, 90], [67, 2.0, 0.5, 1, 0, 90],   // a chord at 2.0
  [62, 3.0, 0.5, 1, 0, 90], [60, 3.5, 0.5, 1, 0, 90]
]

async function main() {
  const T = await load('tv-sync.js')
  const { Player } = await load('player.js')
  const { createTVLink, encodeSong } = await load('tv-link.js')
  const { summarize } = await load('scoring.js')

  // One phone and one TV, wired together. opts.latency: the audio output latency in seconds.
  function rig(opts) {
    const o = opts || {}
    const audio = { currentTime: 0, outputLatency: o.latency || 0 }
    const r = {
      audio,
      sent: [],                      // what the phone handed to the native bridge
      tv: T.createTVModel(),
      smoother: T.createSmoother(),
      shown: null,                   // the TV's displayed position after the last frame
      held: new Set(),
      feedback: new Map(),
      wall: () => (o.wall0 ?? WALL0) + audio.currentTime * 1000,
      perf: () => audio.currentTime * 1000 + 50
    }
    r.link = createTVLink({
      enabled: true,
      // JSON both ways, as the native bridge does
      send: (op) => r.sent.push(JSON.parse(JSON.stringify(op))),
      now: () => r.wall(),
      perfNow: () => r.perf(),
      getPlayer: () => r.player,
      getSong: () => (r.player && r.player.song ? { id: 'contract', title: 'Contract', artist: 'Test', keyCount: 24 } : null),
      getScreen: () => ({ name: r.player ? 'play' : 'idle', song: r.player ? { title: 'Contract', artist: 'Test' } : null }),
      getSettings: () => ({ delayMs: DELAY_MS, view: 'CASCADE', noteLabels: 'off' }),
      getKeys: () => ({ held: r.held, feedback: r.feedback })
    })
    r.player = new Player({
      getCtx: () => audio,
      onState: () => r.link.sendState()
    })
    r.player.load({ title: 'Contract', artist: 'Test', duration: 4, tempo: 120,
      timeSignature: o.timeSignature, notes: o.notes || NOTES.map(([pitch, start, dur, h, finger, vel]) => ({ pitch, start, dur, hand: h ? 'right' : 'left', finger, vel })) })
    if (o.countIn) r.player.setCountIn(o.countIn)
    return r
  }
  // Native events: the TV connects and says it is ready.
  function connect(r) {
    r.link.onNative({ type: 'tv', event: 'connected', width: 1, height: 1 })
    r.link.onNative({ type: 'tv', event: 'ready' })
  }
  // Hand the queued messages to the TV, in order, at the current time.
  function flush(r) {
    const delivered = []
    while (r.sent.length) {
      const op = r.sent.shift()
      if (op.op !== 'tvSend') continue
      const { msg } = op
      delivered.push(msg)
      const clock = { wallMs: r.wall(), perfMs: r.perf() }
      if (msg.t === 'song' || msg.t === 'songChunk') {
        const ack = T.receiveSongPacket(r.tv, msg)
        if (ack && !r.dropAck?.(msg)) r.link.onNative({ type: 'tv', event: ack.op, ...ack })
      } else {
        T.applyTVMessage(r.tv, msg, clock)
      }
    }
    return delivered
  }
  // One display frame: the phone's tick (as the app's frame loop does), the link's tick, delivery, then the TV's frame.
  function frame(r) {
    r.audio.currentTime += FRAME
    if (r.player) r.player.tick()
    r.link.tick()
    flush(r)
    const st = r.tv.state
    r.shown = st && r.tv.song ? r.smoother.update(T.frameClock(st, r.wall()), r.tv.key) : null
    return r.shown
  }
  const runUntil = (r, t, each) => {
    while (r.audio.currentTime < t - 1e-9) {
      frame(r)
      if (each) each(r.audio.currentTime)
    }
  }

  const cases = []
  const check = (name, fn) => cases.push([name, fn])

  check('the TV receiver shows the Premium screen and resumes its normal screen after unlock', () => {
    const source = readFileSync(path.join(renderer, 'tv.js'), 'utf8')
    const model = T.createTVModel()
    const screens = []
    const context = vm.createContext({
      model, applyTVMessage: T.applyTVMessage, tvNow: () => WALL0,
      performance: { now: () => 0 }, refresh: () => screens.push(model.screen.name)
    })
    vm.runInContext(source.slice(source.indexOf('function receive('), source.indexOf('// The state object decides')), context)
    context.__keylightTVReceive({ t: 'screen', name: 'premium' })
    context.__keylightTVReceive({ t: 'screen', name: 'idle' })
    assert.deepEqual(screens, ['premium', 'idle'])
  })

  check('the phone draws its notes until ready and restores them on failure and disconnect', () => {
    const source = readFileSync(path.join(renderer, 'app.js'), 'utf8')
    const classes = new Set()
    const classList = {
      toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
      contains: (name) => classes.has(name)
    }
    const orientation = []
    let allowed = false, unlockHidden = true, offers = 0, editorCloses = 0
    const link = createTVLink({ enabled: true, allowed, send() {}, onEvent: (ev) => context.tvOnEvent(ev) })
    const context = vm.createContext({
      tvLink: link, screen: 'play', player: {}, song: {}, freeplay: false,
      settings: { tvCalibOffered: false, tvPhoneNotes: false },
      tvAllowed: () => allowed,
      tvSetup: () => 'airplay', tvOfferCalibration: () => offers++,
      document: { body: { classList } },
      $: (id) => ({ classList: { toggle: (name, on) => { if (id === 'tvUnlock') unlockHidden = on } } }),
      tvStopPreview() {}, tvApplyMute() {}, tvCal: null, tvRefreshSettings() {}, tvSyncRemote() {},
      lyricsEditor: { close: () => editorCloses++ }, syncLyricEditorButton() {},
      enterPlayer: () => orientation.push('landscape'), leavePlayer: () => orientation.push('unlocked')
    })
    vm.runInContext(source.slice(source.indexOf('const playingSong ='), source.indexOf('let tvCal =')) +
      source.slice(source.indexOf('function tvOnEvent('), source.indexOf('// The remote\'s controls')), context)
    link.onNative({ type: 'tv', event: 'connected' })
    link.onNative({ type: 'tv', event: 'ready' })
    assert.equal(vm.runInContext('tvHidesNotes()', context), false)
    assert.equal(unlockHidden, false)
    assert.equal(offers, 0)
    allowed = true
    link.setAllowed(allowed)
    assert.equal(vm.runInContext('tvHidesNotes()', context), true)
    assert.equal(unlockHidden, true)
    for (const [event, remote] of [['notReady', false], ['ready', true], ['disconnected', false]]) {
      link.onNative({ type: 'tv', event })
      assert.equal(vm.runInContext('tvHidesNotes()', context), remote, event)
    }
    assert.equal(offers, 1)
    assert.equal(editorCloses, 2)
    assert.deepEqual(orientation, ['unlocked', 'landscape', 'unlocked', 'landscape'])
  })

  check('TV delay settings migrate AirPlay, keep HDMI separate, and nudge during play without a flash', () => {
    const source = readFileSync(path.join(renderer, 'app.js'), 'utf8')
    const elements = new Map()
    const $ = (id) => {
      if (!elements.has(id)) elements.set(id, { classList: { remove() {} }, addEventListener() {} })
      return elements.get(id)
    }
    let lastDelay, previews = 0, paywallOpens = 0
    const settings = { tvDelayMs: 230 }
    const context = vm.createContext({
      $, settings, DEFAULT_DELAY_MS: 160, MAX_DELAY_MS: 600,
      tvDeviceName: () => 'iPhone', tvRefreshSettings() {}, androidEvents() {}, saveSettings() {},
      onEntitlementChange() {}, openPaywall: () => paywallOpens++,
      tvPreview: () => previews++, tvPreviewing: false,
      tvLink: { setSoundRoute() {}, sendState: () => { lastDelay = vm.runInContext('tvDelay()', context) } },
      document: { querySelectorAll: () => [] }
    })
    vm.runInContext(source.slice(source.indexOf('function tvSetup('), source.indexOf('function tvAudioPortName(')) +
      source.slice(source.indexOf('function tvSaveDelay('), source.indexOf('// Live preview')) +
      source.slice(source.indexOf('function tvInitIOS('), source.indexOf('/* ============================== player callbacks')) +
      '\ntvInitIOS()', context)
    $('tvUnlock').onclick()
    $('tvSettingsUnlock').onclick()
    assert.equal(paywallOpens, 2)
    const select = (value) => $('tvSetup').onchange({ target: { value } })
    select('cable')
    assert.equal(lastDelay, 0)
    $('tvRemoteDelayUp').onclick()
    assert.equal(lastDelay, 10)
    assert.equal(previews, 0)
    select('airplay')
    assert.equal(lastDelay, 230)
    $('tvDelayDown').onclick()
    assert.equal(lastDelay, 220)
    assert.equal(previews, 1)
    select('cable')
    assert.equal(lastDelay, 10)
  })

  check('the ready snapshot: song, score, keys, state, screen, and the TV reads the same notes the phone has', () => {
    const r = rig()
    connect(r)
    assert.equal(r.sent[0].msg.t, 'song')                                   // the song first: a score follows it
    assert.deepEqual(r.sent.map((op) => op.msg.t), ['song'])
    assert.deepEqual(flush(r).map((msg) => msg.t), ['song', 'score', 'keys', 'state', 'screen'])
    assert.equal(r.tv.song.id, 'contract')
    assert.equal(r.tv.score.accuracy, 0)
    assert.equal(r.tv.screen.name, 'play')                                   // the phone is on its play screen with the song
    const phone = encodeSong(r.player, { id: 'contract', title: 'Contract', artist: 'Test', keyCount: 24 })
    assert.equal(r.tv.song.notes.length, phone.notes.length)
    r.tv.song.notes.forEach((n, i) => {
      assert.deepEqual([n.pitch, n.hand], [phone.notes[i][0], phone.notes[i][3] === 0 ? 'left' : 'right'])
      assert.ok(Math.abs(n.start - phone.notes[i][1]) < 1e-9, 'start, as the phone rounds it')
    })
    assert.equal(r.tv.song.duration, 4)
  })

  check('a song above the bridge limit arrives in acknowledged chunks without truncation', () => {
    const r = rig()
    const size = 105000
    r.player.speedNotes = Array.from({ length: size }, (_, k) => ({
      pitch: 60 + k % 12, start: 1 + k % 2900 / 1000, dur: 0.125, hand: 'right', finger: 3, vel: 100
    }))
    assert.ok(JSON.stringify(encodeSong(r.player, { id: 'contract' })).length > 2_000_000)

    let dropped = false
    r.dropAck = (msg) => {
      if (msg.t !== 'songChunk' || dropped) return false
      dropped = true
      return true
    }
    connect(r)
    const partial = flush(r)
    assert.deepEqual(partial.map((msg) => msg.t), ['song', 'songChunk'])
    assert.equal(r.tv.song, null)
    assert.equal(r.tv.state, null)
    r.audio.currentTime = 2.1
    r.link.tick()
    const rest = flush(r)
    assert.deepEqual(rest[0], partial[1], 'resend the same packet after a lost acknowledgement')
    for (const msg of [...partial, ...rest]) assert.ok(JSON.stringify(msg).length < 400_000)
    assert.equal(r.tv.song.notes.length, size)
    assert.equal(r.tv.state.position, 0)
  })

  check('a reindex supersedes a pending transfer with the same song ID', () => {
    const r = rig()
    r.player.speedNotes = Array(4200).fill(r.player.speedNotes[0])
    connect(r)
    const [old] = r.sent.splice(0)
    r.player.setHandFilter('right')
    const gen = r.sent[0].msg.songGen
    assert.ok(gen > old.msg.songGen)
    r.link.onNative({ type: 'tv', event: 'songAck', songGen: old.msg.songGen, next: 0 })
    flush(r)
    assert.equal(r.tv.song.songGen, gen)
    assert.equal(r.tv.state.handFilter, 'right')
    assert.equal(T.receiveSongPacket(r.tv, { t: 'songChunk', songGen: old.msg.songGen, offset: 0,
      notes: Array(T.SONG_CHUNK_NOTES).fill(NOTES[0]) }), null)
  })

  check('a phone page reload after a clock rollback can send a new song to the same TV page', () => {
    const original = rig()
    connect(original)
    flush(original)
    const olderGen = original.tv.song.songGen

    const reloaded = rig({ wall0: WALL0 - 10_000 })
    reloaded.tv = original.tv
    reloaded.player.speedNotes = Array(4200).fill(reloaded.player.speedNotes[0])
    connect(reloaded)
    flush(reloaded)
    assert.ok(reloaded.tv.song.songGen < olderGen)
    assert.equal(reloaded.tv.song.notes.length, 4200)
    assert.ok(reloaded.tv.state, 'the new transfer is acknowledged before state is sent')
  })

  check('a 3/4 song transmits the running three beats with the four-beat preference', () => {
    const r = rig({ countIn: 4, timeSignature: { beats: 3, beatType: 4 } })
    connect(r)
    r.player.play()
    flush(r)
    assert.equal(r.player.snapshot().countInBeats, 3)
    assert.equal(r.tv.state.countInBeats, 3)
    assert.equal(T.countInOf(r.tv.state, r.wall()).seconds, 1.5)
    r.audio.currentTime = 1.6
    assert.equal(r.player.snapshot().countInBeats, 0)
  })

  check('count-in: the TV holds until the count ends, one picture delay ahead of the phone, and reads the beats the phone draws', () => {
    const r = rig({ countIn: 2 })
    connect(r)
    flush(r)
    r.player.play()                                                         // count-in: 2 beats = 1.0 s at 120 BPM
    flush(r)
    const st = r.tv.state
    assert.equal(st.countInBeats, 2)
    const c = T.countInOf(st, r.wall())
    assert.ok(Math.abs(c.seconds - 1.0) < 1e-9, `count-in length ${c.seconds}`)
    assert.ok(Math.abs(c.untilS - (WALL0 + 1000) / 1000) < 1e-9)
    let worst = 0
    runUntil(r, 2.0, (t) => {
      const expected = Math.max(0, t + DELAY_MS / 1000 - 1.0)              // the phone's position, as the TV picture shows it
      if (t < 0.8) assert.equal(r.shown, 0, `held in the count-in at ${t.toFixed(3)} s`)
      if (t > 1.2) worst = Math.max(worst, Math.abs(r.shown - expected))
    })
    assert.ok(worst < 0.005, `steady error ${(worst * 1000).toFixed(2)} ms`)
  })

  check('count-in timestamps follow the audible start and end, including a refresh during the output delay', () => {
    const r = rig({ countIn: 2, latency: 0.25 })
    connect(r)
    r.player.play()
    flush(r)
    assert.deepEqual([r.tv.state.countInStartMs, r.tv.state.countInUntilMs, r.tv.state.at],
      [WALL0 + 250, WALL0 + 1250, WALL0 + 1250])
    assert.equal(T.countInOf(r.tv.state, WALL0 + 249), null)
    assert.equal(T.countInOf(r.tv.state, WALL0 + 250).beats, 2)
    assert.equal(T.countInOf(r.tv.state, WALL0 + 1250), null)
    r.audio.currentTime = 1.05
    assert.equal(r.player.snapshot().countInBeats, 0)
    r.link.resnapshot()
    flush(r)
    assert.deepEqual([r.tv.state.countInStartMs, r.tv.state.countInUntilMs, r.tv.state.countInBeats],
      [WALL0 + 250, WALL0 + 1250, 2])
    r.audio.currentTime = 1.25
    r.link.resnapshot()
    flush(r)
    assert.equal(r.tv.state.countInBeats, 0)
  })

  check('wait mode: the TV stops at the group the phone stops at, reports waitAt, and resumes after the notes are played', () => {
    const r = rig()
    connect(r)
    r.player.setMode('PRACTISE')                                            // pauseAndSnap
    r.player.play()
    flush(r)
    let maxBeforeStop = -Infinity
    runUntil(r, 3.0, () => {
      if (!r.player.waiting) maxBeforeStop = Math.max(maxBeforeStop, r.shown)
      if (r.player.waiting) return
    })
    assert.ok(r.player.waiting, 'the phone stopped at the first group')
    flush(r)
    assert.equal(r.tv.state.waiting, true)
    assert.equal(r.tv.state.waitAt, 1.0)
    assert.deepEqual(r.tv.state.needPitches, [60])
    assert.ok(maxBeforeStop <= 1.0 + 1e-9, `the picture never passed the stop: ${maxBeforeStop}`)
    for (let i = 0; i < 30; i++) frame(r)
    assert.ok(Math.abs(r.shown - 1.0) < 0.001, `held at the stop: ${r.shown}`)
    // play the note: the phone resumes and the next stop is the chord at 2.0
    r.held.add(60); r.player.noteOn(60); r.link.sendKeys(r.held, r.feedback)
    flush(r)
    assert.equal(r.player.waiting, false)
    assert.equal(r.tv.state.waiting, false)
    assert.equal(r.tv.state.waitAt, 1.5)                                    // the next group with a note to play
  })

  check('a partial chord: the TV hears the new wait before the keys, and waits on the notes still to play', () => {
    const r = rig()
    connect(r)
    r.player.setMode('PRACTISE')
    r.player.play()
    flush(r)
    // play the single notes at 1.0 and 1.5 as the phone stops for them, and stop at the chord at 2.0
    let guard = 0
    while (!(r.player.waiting && r.player.position === 2.0) && guard++ < 600) {
      frame(r)
      if (r.player.waiting && r.player.position !== 2.0) {
        for (const p of [...r.player.needPitches]) { r.held.add(p); r.player.noteOn(p) }
        r.link.sendKeys(r.held, r.feedback)
      }
    }
    assert.ok(r.player.waiting && r.player.position === 2.0, 'the phone stops at the chord')
    flush(r)
    assert.deepEqual([...r.tv.state.needPitches].sort((a, b) => a - b), [64, 67])
    assert.equal(r.tv.state.waitAt, 2.0)
    r.sent.length = 0
    r.held.add(64)
    r.player.noteOn(64)                                                     // a partial hit: the player does not emit
    r.link.sendKeys(r.held, r.feedback)
    // the score moved with the earlier single notes, so it may go out too; the wait must come before the keys
    assert.deepEqual(r.sent.map((op) => op.msg.t).filter((t) => t !== 'score'), ['state', 'keys'])
    flush(r)
    assert.deepEqual([...r.tv.state.needPitches], [67])
    assert.deepEqual(T.waitNotesOf(r.tv).map((n) => [n.pitch, n.start]), [[67, 2.0]])
    r.held.add(67)
    r.player.noteOn(67)
    r.link.sendKeys(r.held, r.feedback)
    flush(r)
    assert.equal(r.tv.state.waiting, false)
    assert.equal(r.tv.state.waitAt, 3.0)
  })

  check('pauseAndPlay: the TV clamps at the group, then eases back to the 30 ms stop the phone reports', () => {
    const r = rig()
    connect(r)
    r.player.setMode('PRACTISE')
    r.player.setAdvancement('pauseAndPlay')
    r.player.play()
    flush(r)
    let previous = -Infinity
    let clampedOk = true
    runUntil(r, 1.2, () => {
      if (!r.player.waiting && r.shown > 1.0 + 1e-9) clampedOk = false
    })
    assert.ok(clampedOk, 'the picture holds at the group while the phone plays into it')
    assert.ok(r.player.waiting)
    assert.ok(Math.abs(r.player.position - 0.97) < 1e-9, 'the phone stops 30 ms before the group')
    flush(r)
    assert.equal(r.tv.state.waitAt, 1.0)
    const after = []
    for (let i = 0; i < 60; i++) { frame(r); after.push(r.shown) }
    for (const v of after) { assert.ok(v <= previous + 1e-12 || previous === -Infinity); previous = v }
    assert.ok(Math.abs(r.shown - 0.97) < 0.001, `eased to the phone's stop: ${r.shown}`)
  })

  check('the end of a section: the picture stops at the phone’s end, never past it', () => {
    const r = rig()
    connect(r)
    r.player.setSection(0, 1.5)
    r.player.play()
    flush(r)
    assert.equal(r.tv.state.end, 1.5)
    let highest = -Infinity
    runUntil(r, 3.0, () => { highest = Math.max(highest, r.shown) })
    assert.ok(highest <= 1.5 + 1e-9, `highest ${highest}`)
    assert.ok(Math.abs(r.shown - 1.5) < 0.001, `held at the end: ${r.shown}`)
  })

  check('a 0.2 s backwards seek snaps the picture at once (the phone sends a new rev)', () => {
    const r = rig()
    connect(r)
    r.player.play()
    flush(r)
    runUntil(r, 1.2)
    const before = r.shown
    const revBefore = r.tv.state.rev
    r.player.seek(1.0)                                                      // the phone's seek: rev goes up
    flush(r)
    assert.ok(r.tv.state.rev > revBefore, 'rev changed on the seek')
    const frameNow = frame(r)
    const target = T.frameClock(r.tv.state, r.wall()).target
    assert.equal(frameNow, target, 'snapped to the target')
    // where the picture would have been one frame later, without the seek, minus where it is now: the 0.2 s seek
    const withoutSeek = before + FRAME
    assert.ok(Math.abs((withoutSeek - frameNow) - 0.2) < 1e-6, `moved back by ${(withoutSeek - frameNow).toFixed(6)} s`)
  })

  check('live feedback keeps its full length on the TV: the phone’s 260 ms, with no delay added', () => {
    const r = rig()
    connect(r)
    r.player.play()
    flush(r)
    runUntil(r, 0.5)
    r.held.add(60)
    r.feedback.set(60, { kind: 'perfect', until: r.perf() + 260 })
    r.link.sendKeys(r.held, r.feedback)
    flush(r)
    const entry = r.tv.feedback.get(60)
    assert.equal(entry.kind, 'perfect')
    assert.ok(Math.abs((entry.until - r.perf()) - 260) < 1e-9, `remaining ${entry.until - r.perf()} ms`)
  })

  check('audio latency: the picture does not run ahead of the sound when a play starts', () => {
    const latency = 0.04
    const r = rig({ latency })
    connect(r)
    r.player.play()
    flush(r)
    let worst = 0
    runUntil(r, 1.0, (t) => {
      // the sound starts 40 ms after the playhead; the TV draws the phone's sound one delay ahead of the wall clock
      const expected = Math.max(0, t + DELAY_MS / 1000 - latency)
      if (t > 0.1) worst = Math.max(worst, Math.abs(r.shown - expected))
    })
    assert.ok(worst < 0.005, `steady error ${(worst * 1000).toFixed(2)} ms`)
  })

  check('native latency changes resnapshot the corresponding audible position and reset the smoother', () => {
    const r = rig({ latency: 0.04 })
    connect(r)
    r.player.play()
    flush(r)
    const rev = r.tv.state.rev
    r.audio.currentTime = 0.1
    r.link.onNative({ type: 'tv', event: 'sound', route: 'tv', portTypes: ['AirPlay'], latencyMs: 250 })
    flush(r)
    assert.ok(r.tv.state.rev > rev)
    assert.equal(r.tv.state.at, WALL0 + 250)
    assert.equal(r.tv.state.position, 0)
    r.audio.currentTime = 1.1
    r.link.tick()
    flush(r)
    assert.ok(Math.abs(r.tv.state.position - 0.85) < 1e-9)
    const newRev = r.tv.state.rev
    r.link.resnapshot(true)
    flush(r)
    assert.ok(r.tv.state.rev > newRev)
  })

  check('TV and phone sound use native latency for both judging and picture, muted uses Web Audio', () => {
    const r = rig({ latency: 0.7 })
    connect(r)
    for (const [route, nativeMs, effective] of [['tv', 850, 0.85], ['phone', 40, 0.04], ['muted', 850, 0.5]]) {
      r.link.setSoundRoute(route)
      r.link.onNative({ type: 'tv', event: 'sound', route: route === 'phone' ? 'phone' : 'tv', latencyMs: nativeMs })
      r.player.restart(false)
      r.player.play()
      flush(r)
      const start = r.audio.currentTime
      assert.equal(r.tv.state.at, r.wall() + effective * 1000)
      r.audio.currentTime = start + 1 + effective
      r.link.sendState()
      flush(r)
      assert.equal(r.tv.state.position, r.player.currentPosition())
      assert.ok(Math.abs(r.tv.state.position - 1) < 1e-9)
      assert.equal(r.player.noteOn(60).kind, 'perfect')
    }
    r.link.setSoundRoute('tv')
    assert.equal(r.player.outputLatency(), 0.85)
    r.link.onNative({ type: 'tv', event: 'disconnected' })
    assert.equal(r.player.outputLatency(), 0.5)
  })

  check('the TV predicts B to A before the phone wraps and reconciles the same iteration', () => {
    const r = rig()
    connect(r)
    r.player.setLoop(1, 2, true)
    r.player.seek(1.7)
    r.player.play()
    flush(r)
    const key = r.tv.key
    runUntil(r, 0.2)
    assert.equal(r.player.loopIteration, 0)
    assert.ok(r.shown < 1.1, 'TV is already in the next iteration')
    const predicted = r.shown
    runUntil(r, 0.32)
    assert.equal(r.tv.state.loopIteration, 1)
    assert.equal(r.tv.key, key, 'the phone confirmation leaves the TV’s reset key intact')
    assert.ok(r.shown > predicted && r.shown < 1.25, 'the picture advances without wrapping again')
  })

  check('loop prediction respects Wait stops before B and after wrapping to A', () => {
    const r = rig()
    connect(r)
    r.player.setMode('PRACTISE')
    r.player.setLoop(0.9, 1.06, true)
    r.player.seek(0.98)
    r.player.play()
    flush(r)
    const early = T.frameClock(r.tv.state, r.wall())
    assert.equal(early.target, 1)
    assert.equal(early.iteration, 0)
    r.player.seek(1.03)
    flush(r)
    const after = T.frameClock(r.tv.state, r.wall())
    assert.equal(after.target, 1)
    assert.equal(after.iteration, 1)
    assert.equal(r.tv.state.loopWaitAt, 1)
  })

  check('a Wait group on or just beyond B blocks a predicted wrap', () => {
    for (const b of [1, 0.995]) {
      const r = rig()
      connect(r)
      r.player.setMode('PRACTISE')
      r.player.setLoop(0.8, b, true)
      r.player.seek(0.96)
      r.player.play()
      flush(r)
      assert.equal(r.tv.state.waitAt, 1)
      assert.equal(r.tv.state.loopWaitAt, null)
      assert.equal(T.frameClock(r.tv.state, r.wall()).iteration, 0)
    }
  })

  check('the Playground: the TV drops the song and shows idle; the phone sends no wait point', () => {
    const r = rig()
    connect(r)
    r.player.play()
    flush(r)
    runUntil(r, 0.5)
    r.player = null                                                         // startFreeplay: no player
    r.link.sendScreen()
    flush(r)
    assert.equal(r.tv.song, null)
    assert.equal(r.tv.state, null)
    assert.equal(r.tv.screen.name, 'idle')
    assert.equal(r.tv.key, '')
  })

  check('a restart sends a fresh score at once, and the TV starts the song from zero', () => {
    const r = rig()
    connect(r)
    r.player.play()
    flush(r)
    runUntil(r, 0.5)
    r.sent.length = 0
    r.player.restart(false)
    const delivered = flush(r)
    assert.ok(delivered.some((msg) => msg.t === 'score'), 'a score snapshot went out immediately after the restart transfer')
    assert.deepEqual([r.tv.score.hits, r.tv.score.misses, r.tv.score.accuracy], [0, 0, 0])
    assert.equal(r.tv.state.position, 0)
  })

  check('a seek after a hit: the TV takes the phone’s reset score at once, not the one from before the seek', () => {
    const r = rig()
    connect(r)
    r.player.play()
    flush(r)
    runUntil(r, 1.0)
    r.held.add(60)
    r.player.noteOn(60)                                                     // the note at 1.0: a hit
    r.link.sendScore()                                                      // as the app does after a judgement
    flush(r)
    const hit = summarize(r.player.score, r.player.mode)
    assert.ok(hit.totalNotesHit >= 1, 'the note was judged as a hit')
    assert.equal(r.tv.score.hits, hit.totalNotesHit)
    r.player.pause()
    r.player.seek(0)                                                        // the score is reset in place: the same object
    flush(r)
    const after = summarize(r.player.score, r.player.mode)
    assert.equal(after.totalNotesHit, 0)
    assert.equal(r.tv.score.hits, 0, 'the TV dropped the pre-seek hit')
    assert.equal(r.tv.score.accuracy, after.overallAccuracy)
  })

  let failed = 0
  for (const [name, fn] of cases) {
    try {
      fn()
      process.stdout.write('ok - ' + name + '\n')
    } catch (error) {
      failed += 1
      process.stderr.write('FAILED - ' + name + '\n' + String((error && error.stack) || error) + '\n')
    }
  }
  if (failed) throw new Error(failed + ' contract case(s) failed')
}

main().then(
  () => process.stdout.write('tv-contract: ok\n'),
  (e) => { process.stderr.write(String((e && e.stack) || e) + '\n'); process.exit(1) }
)
