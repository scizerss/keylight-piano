// Unit tests for the audio-clock note scheduler. node scripts/test-scheduler.js
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

let n = 0
const eq = (actual, expected, msg) => { n++; assert.equal(actual, expected, msg) }
const same = (actual, expected, msg) => { n++; assert.deepEqual(actual, expected, msg) }

// Records what the scheduler would play, the way the app's self-test does.
function sink() {
  const calls = { notes: [], clicks: [], bass: [], hat: [], cancels: 0 }
  return {
    calls,
    note: (pitch, vel, when, dur) => calls.notes.push({ pitch, vel, when, dur }),
    cancel: () => { calls.cancels++ },
    click: (accent, at) => calls.clicks.push({ accent, at }),
    bass: (pitch, dur, at) => calls.bass.push({ pitch, dur, at }),
    hat: (accent, at) => calls.hat.push({ accent, at }),
  }
}

// The player contract scheduler.pump reads, with the audio clock supplied by the test.
function makePlayer(clock, opts = {}) {
  const o = { notes: [], anchorAt: 0, anchorPos: 0, rate: 1, duration: 10, tempo: 120, mode: 'WATCH', running: true, ...opts }
  return {
    epoch: 0,
    song: { title: 'test', tempo: o.tempo, duration: o.duration, notes: o.notes },
    mode: o.mode,
    rate: o.rate,
    clockRunning: o.running,
    position: o.anchorPos,
    end: o.duration,
    _anchorAt: o.anchorAt,
    _anchorPos: o.anchorPos,
    _countInUntil: 0,
    _countInStart: 0,
    _countInRunBeats: 0,
    countIn: 0,
    loop: { a: null, b: null, on: false },
    metronome: { on: false },
    accompanimentNotes() { return o.accompaniment || o.notes },
    nextWaitTime() { return Infinity },
    renderPosition() { return this.clockRunning ? this._anchorPos + Math.max(0, clock.currentTime - this._anchorAt) * this.rate : this.position },
    timeAt(pos) { return this._anchorAt + (pos - this._anchorPos) / this.rate },
    // what the real Player does on a transport jump (seek / loop wrap / speed change)
    jump(pos, rate = this.rate) {
      this.position = pos
      this.rate = rate
      this._anchorPos = pos
      this._anchorAt = clock.currentTime
      this.epoch++
    },
  }
}

const noteAt = (start, i = 0) => ({ pitch: 60 + i, vel: 90, start, dur: 0.4, hand: 'right' })

;(async () => {
  const { SongScheduler, metronomeBeats } = await import(pathToFileURL(path.join(__dirname, '..', 'renderer/scheduler.js')).href)

  // ---------- look-ahead window, order, exact times ----------
  {
    const clock = { currentTime: 10 }
    const out = sink()
    const sch = new SongScheduler(out)
    const p = makePlayer(clock, { notes: [0, 0.1, 0.15, 0.25, 0.5].map((t, i) => noteAt(t, i)), anchorAt: 10 })
    sch.pump(p, { ctx: clock, accompany: true, band: null })
    eq(out.calls.notes.length, 3, 'one pump queues only the notes inside the 0.2 s look-ahead')
    same(out.calls.notes.map((x) => x.pitch), [60, 61, 62], 'notes are queued in start order')
    same(out.calls.notes.map((x) => x.when), [10, 10.1, 10.15], 'each note is queued at its audio-clock time')
    same(out.calls.notes.map((x) => x.dur), [0.4, 0.4, 0.4], 'duration is passed through at rate 1')

    sch.pump(p, { ctx: clock, accompany: true, band: null })
    eq(out.calls.notes.length, 3, 'a second pump at the same clock time queues nothing new')

    clock.currentTime = 10.1
    sch.pump(p, { ctx: clock, accompany: true, band: null })
    eq(out.calls.notes.length, 4, 'the window slides: 0.25 s note joins')
    eq(out.calls.notes[3].pitch, 63, 'the new note is the next one in order')

    for (const t of [10.2, 10.3, 10.4, 10.5]) { clock.currentTime = t; sch.pump(p, { ctx: clock, accompany: true, band: null }) }
    eq(out.calls.notes.length, 5, 'sweeping the clock queues the last note too')
    const starts = out.calls.notes.map((x) => Math.round((x.when - 10) * 1e6) / 1e6)
    same([...new Set(starts)], [0, 0.1, 0.15, 0.25, 0.5], 'no note is queued twice while the window slides')
  }

  // ---------- boundary: a horizon a float hair past a note queues it once ----------
  {
    const clock = { currentTime: 10 }
    const out = sink()
    const sch = new SongScheduler(out)
    const p = makePlayer(clock, { notes: [noteAt(0.2)], anchorAt: 10 })
    sch.pump(p, { ctx: clock, accompany: true, band: null })
    eq(out.calls.notes.length, 0, 'a note exactly on the horizon waits for the pump that reaches past it')
    clock.currentTime = 10.0000000000001
    sch.pump(p, { ctx: clock, accompany: true, band: null })
    eq(out.calls.notes.length, 1, 'a horizon just past a note queues it')
    clock.currentTime = 10.1
    sch.pump(p, { ctx: clock, accompany: true, band: null })
    eq(out.calls.notes.length, 1, 'the next pump does not queue that boundary note again')
  }

  // ---------- speed (rate) ----------
  {
    const clock = { currentTime: 20 }
    const out = sink()
    const sch = new SongScheduler(out)
    const p = makePlayer(clock, { notes: [0, 0.3, 0.9].map((t, i) => noteAt(t, i)), anchorAt: 20, rate: 2 })
    sch.pump(p, { ctx: clock, accompany: true, band: null })
    same(out.calls.notes.map((x) => x.pitch), [60, 61], 'at double speed the window covers twice the song time')
    same(out.calls.notes.map((x) => x.when), [20, 20.15], 'note times are scaled by the rate')
    eq(out.calls.notes[0].dur, 0.2, 'a note is half as long at double speed')
  }

  // ---------- end of the song and A/B loop clamp the horizon ----------
  {
    const clock = { currentTime: 30 }
    const out = sink()
    const sch = new SongScheduler(out)
    const p = makePlayer(clock, { notes: [noteAt(0.25), noteAt(0.5, 1)], anchorAt: 30, duration: 0.3 })
    sch.pump(p, { ctx: clock, accompany: true, band: null })
    clock.currentTime = 31
    sch.pump(p, { ctx: clock, accompany: true, band: null })
    same(out.calls.notes.map((x) => x.pitch), [60], 'nothing after the end of the song is queued')

    const clock2 = { currentTime: 40 }
    const out2 = sink()
    const sch2 = new SongScheduler(out2)
    const p2 = makePlayer(clock2, { notes: [noteAt(0.2), noteAt(0.3, 1)], anchorAt: 40 })
    p2.loop = { a: 0, b: 0.3, on: true }
    sch2.pump(p2, { ctx: clock2, accompany: true, band: null })
    clock2.currentTime = 41
    sch2.pump(p2, { ctx: clock2, accompany: true, band: null })
    same(out2.calls.notes.map((x) => x.pitch), [60], 'an active A/B loop stops the horizon at its B point')
  }

  // ---------- wait mode never plays past the next wait point ----------
  {
    const clock = { currentTime: 50 }
    const out = sink()
    const sch = new SongScheduler(out)
    const p = makePlayer(clock, { notes: [noteAt(0.1), noteAt(0.4, 1)], anchorAt: 50, mode: 'PRACTISE' })
    p.nextWaitTime = () => 0.25
    sch.pump(p, { ctx: clock, accompany: true, band: null })
    clock.currentTime = 51
    sch.pump(p, { ctx: clock, accompany: true, band: null })
    same(out.calls.notes.map((x) => x.pitch), [60], 'nextWaitTime() clamps the horizon in PRACTISE')
  }

  // ---------- sources: WATCH synths the song, a recording silences it ----------
  {
    const clock = { currentTime: 60 }
    const out = sink()
    const sch = new SongScheduler(out)
    const p = makePlayer(clock, { notes: [noteAt(0)], anchorAt: 60 })
    sch.pump(p, { ctx: clock, accompany: true, band: null, watchSynth: false })
    eq(out.calls.notes.length, 0, 'a recording playing the song means no synthesised notes')
  }
  {
    const clock = { currentTime: 70 }
    const out = sink()
    const sch = new SongScheduler(out)
    const p = makePlayer(clock, { notes: [noteAt(0)], anchorAt: 70, mode: 'PLAY' })
    sch.pump(p, { ctx: clock, accompany: false, band: null })
    eq(out.calls.notes.length, 0, 'PLAY without accompaniment queues no notes')
  }
  {
    const clock = { currentTime: 80 }
    const out = sink()
    const sch = new SongScheduler(out)
    // the song's own notes (pitch 60) differ from the accompaniment (pitch 63): only accompanimentNotes() may sound
    const p = makePlayer(clock, { notes: [noteAt(0, 0)], accompaniment: [noteAt(0, 3)], anchorAt: 80, mode: 'PRACTISE' })
    sch.pump(p, { ctx: clock, accompany: true, band: null })
    same(out.calls.notes.map((x) => x.pitch), [63], 'accompaniment mode plays the other hand from accompanimentNotes()')
  }

  // ---------- cancel on a transport change, never replay what was heard ----------
  {
    const clock = { currentTime: 90 }
    const out = sink()
    const sch = new SongScheduler(out)
    const p = makePlayer(clock, { notes: [0, 0.1, 1, 1.05].map((t, i) => noteAt(t, i)), anchorAt: 90 })
    sch.pump(p, { ctx: clock, accompany: true, band: null })
    eq(out.calls.notes.length, 2, 'the first pass queues the opening notes')
    const before = out.calls.notes.length
    const cancelsBefore = out.calls.cancels
    clock.currentTime = 91
    p.jump(1.0)                       // seek to 1 s: epoch++, anchors move to the clock
    sch.pump(p, { ctx: clock, accompany: true, band: null })
    eq(out.calls.cancels - cancelsBefore, 1, 'a seek cancels the queue')
    same(out.calls.notes.slice(before).map((x) => x.when), [91, 91.05], 'after a seek only notes from the new position are queued')
    eq(out.calls.notes.slice(before).map((x) => x.pitch).includes(60), false, 'notes before the seek are not replayed')
  }

  // ---------- stop / pause: nothing scheduled while the clock is not running ----------
  {
    const clock = { currentTime: 100 }
    const out = sink()
    const sch = new SongScheduler(out)
    const p = makePlayer(clock, { notes: [noteAt(0.1)], anchorAt: 100 })
    sch.pump(p, { ctx: clock, accompany: true, band: null })
    eq(out.calls.notes.length, 1, 'a running clock queues notes')
    const cancelsBefore = out.calls.cancels
    clock.currentTime = 100.1
    p.clockRunning = false
    p.position = 0.1
    p.epoch++
    sch.pump(p, { ctx: clock, accompany: true, band: null })
    eq(out.calls.cancels - cancelsBefore, 1, 'pausing cancels what was queued')
    eq(out.calls.notes.length, 1, 'a paused player schedules nothing')
    eq(sch.cursor, 0.1, 'a pause leaves the cursor at the playhead')
  }

  // ---------- reset() ----------
  {
    const clock = { currentTime: 110 }
    const out = sink()
    const sch = new SongScheduler(out)
    const p = makePlayer(clock, { notes: [0, 0.1, 0.6].map((t, i) => noteAt(t, i)), anchorAt: 110 })
    sch.pump(p, { ctx: clock, accompany: true, band: null })
    clock.currentTime = 110.6
    sch.pump(p, { ctx: clock, accompany: true, band: null })
    eq(out.calls.notes.length, 3, 'notes up to the cursor are queued')
    sch.reset()
    eq(out.calls.cancels, 2, 'reset() cancels the queue')
    eq(sch.epoch, -1, 'reset() forces a re-init on the next pump')
    const before = out.calls.notes.length
    clock.currentTime = 111
    sch.pump(p, { ctx: clock, accompany: true, band: null })
    eq(out.calls.cancels, 3, 'the pump after reset cancels again')
    eq(out.calls.notes.length, before, 'reset never replays what was already heard')
  }

  // ---------- count-in clicks on their own beat grid ----------
  {
    const clock = { currentTime: 50 }
    const out = sink()
    const sch = new SongScheduler(out)
    const p = makePlayer(clock, { notes: [noteAt(0)], anchorAt: 52, anchorPos: 0 })
    p._countInStart = 50
    p._countInRunBeats = 4
    p._countInUntil = 52
    for (const t of [50, 50.4, 51.0, 51.5]) { clock.currentTime = t; sch.pump(p, { ctx: clock, accompany: true, band: null }) }
    same(out.calls.clicks.map((c) => c.at), [50, 50.5, 51, 51.5], 'the count-in clicks on its own beat grid')
    eq(out.calls.clicks[3].accent, true, 'the last count-in click is accented')
    eq(out.calls.clicks.slice(0, 3).some((c) => c.accent), false, 'the earlier count-in clicks are not')
    eq(out.calls.notes.length, 0, 'the song itself waits for the count-in to finish')
  }

  // ---------- metronome ----------
  {
    const clock = { currentTime: 40 }
    const out = sink()
    const sch = new SongScheduler(out)
    const p = makePlayer(clock, { notes: [], anchorAt: 40, tempo: 120 })
    p.metronome.on = true
    sch.pump(p, { ctx: clock, accompany: true, band: null })
    same(out.calls.clicks.map((c) => c.at), [40], 'first metronome click lands on beat 0 and is the only one in the window')
    eq(out.calls.clicks[0].accent, true, 'beat 0 of the bar is accented')
    clock.currentTime = 40.4
    sch.pump(p, { ctx: clock, accompany: true, band: null })
    same(out.calls.clicks.map((c) => c.at), [40, 40.5], 'the next pump adds beat 1, never repeating beat 0')
    eq(out.calls.clicks[1].accent, false, 'beat 1 is unaccented')
    clock.currentTime = 42.1
    sch.pump(p, { ctx: clock, accompany: true, band: null })
    same(out.calls.clicks.map((c) => c.at), [40, 40.5, 41, 41.5, 42], 'a coarse pump catches up every beat it missed')
    eq(out.calls.clicks[4].accent, true, 'beat 4 of the bar is accented again')
  }

  // ---------- metronome accent vs the song's meter ----------
  {
    const { Player } = await import(pathToFileURL(path.join(__dirname, '..', 'renderer/player.js')).href)
    const clk = { currentTime: 0, outputLatency: 0 }
    const out = sink()
    const sch = new SongScheduler(out)
    const pw = new Player({ getCtx: () => clk })
    pw.load({ title: 'waltz', tempo: 120, duration: 8, timeSignature: { beats: 3, beatType: 4 }, notes: [noteAt(0)] })
    pw.setCountIn(0); pw.setMode('WATCH'); pw.setMetronome(true); pw.play()
    sch.pump(pw, { ctx: clk, accompany: true, band: null })
    for (let i = 0; i < 60; i++) { clk.currentTime += 0.05; sch.pump(pw, { ctx: clk, accompany: true, band: null }) }
    eq(pw.barBeats, 3, 'a 3/4 song has three beats to the bar')
    const accents = out.calls.clicks.filter((c) => c.accent).map((c) => Math.round(c.at * 100) / 100)
    same(accents, [0, 1.5, 3], 'the metronome accents the first beat of every bar (3/4: every 3 beats)')
  }

  // ---------- metronomeBeats: the clicks follow the score's bar lines ----------
  {
    const f = (song, barBeats) => metronomeBeats(song, barBeats).map((c) => (c.accent ? '*' : '') + c.t.toFixed(2)).join(' ')
    const ts = (beats, beatType) => ({ beats, beatType })
    eq(f({ tempo: 120, duration: 3, timeSignature: ts(3, 4) }, 3), '*0.00 0.50 1.00 *1.50 2.00 2.50 *3.00', 'no bar lines: a steady 3/4 grid')
    eq(f({ tempo: 120, duration: 2 }, 0), '*0.00 0.50 1.00 1.50 *2.00', 'unknown meter: an accent every 4 beats')
    eq(f({ tempo: 120, duration: 3, bars: [0, 0.5, 2], timeSignature: ts(3, 4) }, 3), '0.00 *0.50 1.00 1.50 *2.00 2.50 3.00',
      '3/4 with a one-beat pickup (Amazing Grace): the pickup is unaccented, every bar starts on its downbeat')
    eq(f({ tempo: 120, duration: 3.5, bars: [0, 1.5, 3.5], timeSignature: ts(4, 4) }, 4), '0.00 0.50 1.00 *1.50 2.00 2.50 3.00 *3.50',
      '4/4 with a three-beat pickup (When the Saints)')
    eq(f({ tempo: 120, duration: 3.25, bars: [0, 0.25, 1.75, 3.25], timeSignature: ts(6, 8) }, 3), '*0.25 0.75 1.25 *1.75 2.25 2.75 *3.25',
      '6/8 with an eighth-note pickup (Greensleeves): no click before the first bar line, three per bar after it')
    eq(f({ tempo: 120, duration: 1.75, bars: [0, 0.25, 1.0, 1.75], timeSignature: ts(3, 8) }, 2), '0.00 *0.25 0.50 0.75 *1.00 1.25 1.50 *1.75',
      '3/8 with a pickup (Für Elise): three eighth clicks per bar, on the bar lines')
    eq(f({ tempo: 120, duration: 1.5, bars: [0, 0.75, 1.5], timeSignature: ts(3, 8) }, 2), '*0.00 0.25 0.50 *0.75 1.00 1.25 *1.50',
      '3/8 without a pickup: the first bar is a full bar')
    eq(f({ tempo: 120, duration: 4.5, bars: [0, 2, 4.5], timeSignature: ts(4, 4) }, 4), '*0.00 0.50 1.00 1.50 *2.00 2.63 3.25 3.88 *4.50',
      'a slower bar keeps four beats, stretched (not mistaken for a pickup)')
    same(metronomeBeats({ tempo: 120, duration: 1, bars: [0, 'x'] }, 4).length, 3, 'unusable bar lines fall back to the steady grid')
    eq(f({ tempo: 120, duration: 2, bars: [0, 0.5], timeSignature: ts(3, 4) }, 3), '0.00 *0.50 1.00 1.50 *2.00',
      'two bar lines, the first a pickup: the bars after it are full bars, not pickup-long')
    eq(f({ tempo: 120, duration: 1.8, bars: [0, 0.5], timeSignature: ts(3, 4) }, 3), '0.00 *0.50 1.00 1.50',
      'a short song with a pickup still counts the pickup back from the first bar line, and stops at its end')
  }
  {
    // the scheduler queues the bar-aware clicks: a 3/4 song with a pickup on a real Player
    const { Player } = await import(pathToFileURL(path.join(__dirname, '..', 'renderer/player.js')).href)
    const clk = { currentTime: 0, outputLatency: 0 }
    const out = sink()
    const sch = new SongScheduler(out)
    const pw = new Player({ getCtx: () => clk })
    pw.load({ title: 'grace', tempo: 120, duration: 4, timeSignature: { beats: 3, beatType: 4 }, bars: [0, 0.5, 2, 3.5], notes: [noteAt(0)] })
    pw.setCountIn(0); pw.setMode('WATCH'); pw.setMetronome(true); pw.play()
    sch.pump(pw, { ctx: clk, accompany: true, band: null })
    for (let i = 0; i < 60; i++) { clk.currentTime += 0.05; sch.pump(pw, { ctx: clk, accompany: true, band: null }) }
    same(out.calls.clicks.filter((c) => c.accent).map((c) => Math.round(c.at * 100) / 100), [0.5, 2],
      'the accents land on the bar lines after the pickup, not on beat 1 of the song')
    eq(new Set(out.calls.clicks.map((c) => Math.round(c.at * 1000))).size, out.calls.clicks.length, 'no click is queued twice')
  }

  // ---------- generated band ----------
  {
    const clock = { currentTime: 60 }
    const out = sink()
    const sch = new SongScheduler(out)
    const p = makePlayer(clock, { notes: [], anchorAt: 60 })
    const band = [{ time: 0.05, pitch: 36, accent: false }, { time: 0.05, pitch: 0, accent: true }, { time: 0.5, pitch: 40, accent: false }]
    sch.pump(p, { ctx: clock, band })
    eq(out.calls.bass.length, 1, 'only band events with a pitch start a bass note')
    same(out.calls.bass[0], { pitch: 36, dur: 0.3, at: 60.05 }, 'the bass note gets its time and duration')
    same(out.calls.hat.map((h) => h.accent), [false, true], 'every band event gets a hat, with its accent')
    eq(out.calls.hat.length, 2, 'band events beyond the window wait for the next pump')
    clock.currentTime = 60.4
    sch.pump(p, { ctx: clock, band })
    same(out.calls.hat.map((h) => h.at), [60.05, 60.05, 60.5], 'the later band event is queued once the window reaches it')
  }

  // ---------- against the real Player's anchor maths ----------
  {
    const { Player } = await import(pathToFileURL(path.join(__dirname, '..', 'renderer/player.js')).href)
    const clk = { currentTime: 100, outputLatency: 0 }
    const rec = []
    const out = sink()
    out.note = (pitch, vel, when, dur) => rec.push({ pitch, when, dur })
    const sch = new SongScheduler(out)
    const song = {
      title: 'real', tempo: 120, duration: 4,
      notes: [0, 0.5, 1, 1.5, 2].map((t, i) => ({ pitch: 60 + i, start: t, dur: 0.4, vel: 90, hand: 'right' })),
    }
    const pw = new Player({ getCtx: () => clk })
    pw.load(song); pw.setCountIn(0); pw.setMode('WATCH'); pw.play()
    for (let i = 0; i < 45; i++) { sch.pump(pw, { ctx: clk, accompany: true, band: null }); clk.currentTime += 0.05 }
    eq(rec.length, 5, 'a real Player played through the window schedules every note exactly once')
    same(rec.map((r) => r.pitch), [60, 61, 62, 63, 64], 'the real Player schedules them in song order')
    same(rec.map((r) => Math.round(r.when * 1e6) / 1e6), [100, 100.5, 101, 101.5, 102], 'times follow the real Player\'s timeAt()')
  }

  console.log(`scheduler: ${n} assertions passed (look-ahead window, order, no duplicates, boundary, rate, end/loop/wait clamps, sources, seek/pause/reset, count-in, metronome, band, real Player)`)
})().catch((e) => { console.error(e); process.exit(1) })
