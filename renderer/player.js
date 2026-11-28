// Transport engine:
//   modes:      WATCH / PRACTISE / PLAY
//   advancement: continuous / pauseAndPlay / pauseAndSnap   (pauseAndSnap = wait)
//   audio-clock timing, count-in, metronome, A/B loop, speed, hand filter,
//   wait-mode gating on note groups, five-way scoring hooks.
//
// Two clocks matter here:
//   renderPosition()  - where the audio engine is rendering right now; the note
//                       scheduler works ahead of this.
//   currentPosition() - what the player can actually hear/see: renderPosition
//                       minus the audio output latency. Falling notes, key lights,
//                       wait gating and scoring all use this one so they agree
//                       with the sound.
import { judgeHit, markHit, markWrong, tickMisses, summarize, resetExpected, carryOver, WINDOWS } from './scoring.js'
import { noteGroups } from './songloader.js'

export const WINDOW_KEYS = 24      // a longer keyboard sets player.windowKeys

export class Player {
  // onWindow(start): a song in window parts moved the keys (the app moves the keyboard)
  constructor({ getCtx, onState, onJudgement, onFinish, onWindow }) {
    this.getCtx = getCtx || (() => null)
    this.onState = onState || (() => {})
    this.onJudgement = onJudgement || (() => {})
    this.onFinish = onFinish || (() => {})
    this.onWindow = onWindow || (() => {})

    this.song = null
    this.mode = 'PLAY'
    this.advancement = 'continuous'
    this.rate = 1
    this.minRate = Infinity     // rates used in this attempt; paused setup does not count
    this.handFilter = 'both'
    this.loop = { a: null, b: null, on: false }
    this.endAt = null           // a lesson section ends here instead of at the song end
    this.countIn = 0            // beats, 0 = off
    this.metronome = { on: false, audible: true }
    this.windowStart = 60
    this.windowKeys = WINDOW_KEYS
    this.noteLabels = 'off'
    this.view = 'CASCADE'

    this.score = null
    this.position = 0
    this.playing = false
    this.waiting = false
    this.needPitches = new Set()
    this.finished = false

    // Bumped on every transport discontinuity (play, pause, seek, wait, loop, rate)
    // so the audio scheduler knows to drop what it queued and start over.
    this.epoch = 0
    // Bumped on every jump of the playhead or the notes (seek, loop wrap, restart, song load, speed, hand, window and
    // section changes). The TV page snaps on it; play, pause and waits do not move it, so they ease instead.
    this.rev = 0
    this.loopIteration = 0

    this._anchorAt = 0
    this._anchorPos = 0
    this.tvOutputLatency = null // native route latency in seconds, set by TV mode
    this._countInUntil = 0
    this._countInStart = 0
    this._countInRunBeats = 0   // beats of the count-in that last started (the HUD and the clicks follow it)
    this._groups = []
    this._groupIndex = 0
    this._parts = null          // window parts of the song, see windowAt()
    this._waitSince = 0         // when the current wait began (wait mode hints)
  }

  // ---------- loading ----------
  // stay: where the keys are, when the app can't move them. The window is there, whatever
  // the song, and the app plays any notes they can't reach.
  load(song, stay = null) {
    this.song = song
    this._fitWindow(stay)
    this._partStart = this.windowStart
    this.loop = { a: null, b: null, on: false }
    this.endAt = null
    this.position = 0
    this.playing = false
    this.waiting = false
    this.needPitches.clear()
    this.finished = false
    this.arrangementChangedMidRun = false
    this.sectionStart = 0
    this.score = null
    this.minRate = Infinity
    this._reindex()
    this._emit()
  }

  replaceArrangement(song, stay = null, windowKeys = this.windowKeys) {
    const position = this.currentPosition()
    const wasActive = this.active
    const wasFinished = this.finished
    const loop = this.loop
    const from = this.sectionStart
    const to = this.endAt
    this.windowKeys = windowKeys
    this.load(song, stay)
    if (from || to != null) this.setSection(from, to)
    this.setLoop(loop.a, loop.b, loop.on)
    this.seek(position)
    this.arrangementChangedMidRun = position > 1e-3
    this.finished = wasFinished
    if (wasActive && this.position < this.end - 1e-3) this.play({ countIn: false, quiet: true })
  }

  filteredNotes() {
    if (!this.song) return []
    return this.song.notes.filter((n) => this.handFilter === 'both' || n.hand === this.handFilter)
  }

  get end() { return this.endAt != null ? Math.min(this.endAt, this.song.duration) : this.song.duration }

  // Notes the player is asked to play: the selected hand, inside the keys,
  // before the end of the section.
  playableNotes() {
    const end = this.song ? this.end : Infinity
    const from = this.sectionStart || 0
    return this.speedNotes.filter((n) => this._reachable(n) && n.start < end - 1e-4 && n.start >= from - 1e-4)
  }

  // Notes the app plays for you: the other hand, and anything the keys can't reach.
  accompanimentNotes() {
    if (!this.song) return []
    return this.song.notes.filter((n) => !(this.handFilter === 'both' || n.hand === this.handFilter) || !this._reachable(n))
  }

  // A song can move the keys part way through (song.windows, e.g. a both-hands
  // scale played left hand, then right hand). Each note is played in the window of
  // its own part, so moving the keys never drops a note from the score.
  windowAt(t) {
    if (!this._parts) return this.windowStart
    let start = this._parts[0].start
    for (const p of this._parts) if (t >= p.at - 1e-4) start = p.start
    return start
  }

  _reachable(n) {
    const ws = this.windowAt(n.start)
    return n.pitch >= ws && n.pitch < ws + this.windowKeys
  }

  // Notes per hand the keys can reach: a hand with none can't be played on its own.
  handCounts() {
    const counts = { left: 0, right: 0 }
    if (this.song) for (const n of this.song.notes) if (this._reachable(n)) counts[n.hand === 'left' ? 'left' : 'right']++
    return counts
  }

  _reindex() {
    this.rev++
    this.speedNotes = this.filteredNotes()
    this._groups = noteGroups(this.playableNotes())
    this._groupIndex = this._firstGroupAtOrAfter(this.position)
    // keep judgements for notes that stay playable; new ones behind the playhead are skipped
    this.score = carryOver(this.score, this.playableNotes())
    for (const e of this.score.expected) if (e.state === 'pending' && e.start < this.position - 1e-4) e.state = 'skipped'
    this.finished = false
  }

  _firstGroupAtOrAfter(t) {
    for (let i = 0; i < this._groups.length; i++) if (this._groups[i].time >= t - 1e-4) return i
    return this._groups.length
  }

  // ---------- clocks ----------
  // The count-in clicks at the speed the song is about to play (tempo x rate), so
  // its last beat leads into the first note.
  get countInSeconds() {
    const beat = 60 / ((this.song ? this.song.tempo : 120) * (this.rate || 1))
    return this.countInBeats * beat
  }

  // One bar of the song's meter in beats, 0 when the song doesn't say. 6/8 counts 3, 4/4 counts 4.
  get barBeats() {
    const ts = this.song && this.song.timeSignature
    if (!ts || !(ts.beats > 0) || !(ts.beatType > 0)) return 0
    return Math.max(2, Math.min(8, Math.round((ts.beats * 4) / ts.beatType)))
  }
  // Beats the count-in has: one bar when the meter is known, else the setting. 0 = the user turned it off.
  get countInBeats() { return this.countIn > 0 ? (this.barBeats || this.countIn) : 0 }

  // Start of the bar holding song time `pos` (song seconds), never before the section start.
  barStartAt(pos) {
    const from = this.sectionStart || 0
    const bars = this.song && this.song.bars
    if (Array.isArray(bars) && bars.length > 1 && typeof bars[0] === 'number') {
      let at = from
      for (const b of bars) { if (b <= pos + 0.02) at = Math.max(at, b); else break }
      return at
    }
    const bar = (this.barBeats || 4) * 60 / (this.song && this.song.tempo > 0 ? this.song.tempo : 120)
    return from + Math.floor((pos - from) / bar + 0.02) * bar
  }

  now() {
    const ctx = this.getCtx()
    return ctx ? ctx.currentTime : performance.now() / 1000
  }

  // Seconds between the audio engine rendering a sample and it leaving the speaker.
  outputLatency() {
    if (this.tvOutputLatency != null) return this.tvOutputLatency
    const ctx = this.getCtx()
    if (!ctx) return 0
    const l = (ctx.outputLatency || 0) || (ctx.baseLatency || 0)
    return Math.max(0, Math.min(0.5, l))
  }

  get clockRunning() { return this.playing && !this.waiting }

  renderPosition() {
    if (!this.clockRunning) return this.position
    const elapsed = this.now() - this._anchorAt
    return this._anchorPos + Math.max(0, elapsed) * this.rate
  }

  currentPosition() {
    if (!this.clockRunning) return this.position
    const elapsed = this.now() - this.outputLatency() - this._anchorAt
    return this._anchorPos + Math.max(0, elapsed) * this.rate
  }

  // Audio-context time at which song position `pos` is rendered (clock running only).
  timeAt(pos) { return this._anchorAt + (pos - this._anchorPos) / this.rate }

  // ---------- transport ----------
  // opts.countIn === false: start with no count-in (a key press starts Wait mode).
  // opts.quiet: carry on where it is, no count-in and no step back (internal re-starts, e.g. the keys moved).
  play(opts = {}) {
    if (!this.song) return
    if (this.waiting) return          // already "running", just waiting for you
    if (this.finished || this.position >= this.end - 1e-3) this.restart(false)
    const fromStart = this.position <= (this.sectionStart || 0) + 1e-3
    let beats = 0
    if (this.countIn > 0 && opts.countIn !== false) {
      if (fromStart) beats = this.countInBeats
      // Timed play always counts in, also on a resume or from the middle: step back to the
      // start of the bar first, so the count leads into notes you can hear coming.
      else if (!opts.quiet && this.mode === 'PLAY') {
        this.seek(this.barStartAt(this.position))
        beats = this.countInBeats
      }
    }
    let startAt = this.now()
    if (beats > 0) {
      this._countInRunBeats = beats
      this._countInStart = startAt
      this._countInUntil = startAt + beats * 60 / ((this.song.tempo || 120) * (this.rate || 1))
      startAt = this._countInUntil
    } else {
      this._countInUntil = 0
    }
    this._anchorAt = startAt
    this._anchorPos = this.position
    this._groupIndex = this._firstGroupAtOrAfter(this.position)
    this.playing = true
    this.waiting = false
    this.minRate = Math.min(this.minRate, this.rate)
    if (this.mode === 'WATCH') this.advancement = 'continuous'
    this.epoch++
    this._emit()
  }

  // Wait mode, stopped at the start (or finished): the next key press starts it.
  get armed() {
    if (!this.song || this.active || this.mode !== 'PRACTISE' || this.advancement === 'continuous') return false
    return this.finished || this.position <= (this.sectionStart || 0) + 1e-3
  }

  // The notes the first wait stops on: what the pill and the lit keys ask for.
  firstWaitNotes() {
    if (this.finished) return []
    const g = this._groups[this._firstGroupAtOrAfter(this.position)]
    return g ? g.notes.filter((n) => !this._isHit(n)) : []
  }

  // Start an armed Wait mode: no count-in, straight to waiting on the first notes, so the
  // key that started it counts if it is the right one. Returns false when not armed.
  startArmed() {
    if (!this.armed) return false
    if (this.finished || this.position >= this.end - 1e-3) this.restart(false)
    this.play({ countIn: false, quiet: true })
    for (let i = this._groupIndex; i < this._groups.length; i++) {
      const pending = this._groups[i].notes.filter((n) => !this._isHit(n))
      if (pending.length) { this._groupIndex = i; this._enterWait(this._groups[i], pending); break }
    }
    return true
  }

  pause() {
    if (!this.playing && !this.waiting) return
    // Leaving a wait keeps the playhead on the waiting group, so the next play()
    // waits for it again instead of skipping it.
    if (!this.waiting) this.position = this.currentPosition()
    this.playing = false
    this.waiting = false
    this.needPitches.clear()
    this._waitGroup = null
    this._countInUntil = 0
    this.epoch++
    this._emit()
  }

  get active() { return this.playing || this.waiting }
  toggle() { this.active ? this.pause() : this.play() }

  restart(countIn = true) {
    this.arrangementChangedMidRun = false
    this.position = this.sectionStart || 0
    this.waiting = false
    this.needPitches.clear()
    this._waitGroup = null
    this.finished = false
    this.playing = false
    this.score = null
    this.minRate = Infinity
    this._reindex()
    this.epoch++
    // Wait mode doesn't count in: it is armed and the first key starts it
    if (countIn && this.countIn > 0 && !(this.mode === 'PRACTISE' && this.advancement !== 'continuous')) this.play()
    this._emit()
  }

  // Lesson sections: play from..to once, then finish (no endless loop).
  setSection(from, to) {
    this.sectionStart = Math.max(0, from || 0)
    this.endAt = to != null && to > this.sectionStart ? to : null
    this.score = null
    this.minRate = Infinity
    this._reindex()
    this.seek(this.sectionStart)
  }

  seek(pos) {
    const clamped = Math.max(0, Math.min(this.song ? this.song.duration : 0, pos))
    const wasRunning = this.active
    if (this.score) {
      for (const e of this.score.expected) {
        if (e.start >= clamped - 1e-4) { if (e.state !== 'pending') resetExpected(this.score, e) }
        else if (e.state === 'pending') e.state = 'skipped'
      }
    }
    this.position = clamped
    this.waiting = false
    this.needPitches.clear()
    this._waitGroup = null
    this._groupIndex = this._firstGroupAtOrAfter(clamped)
    this._anchorAt = this.now()
    this._anchorPos = clamped
    this._countInUntil = 0
    this.playing = wasRunning
    this.rev++
    this.epoch++
    this._emit()
  }

  // Jump back to the loop start and make every note in the loop playable again.
  _loopBack() {
    this.loopIteration++
    this.seek(this.loop.a)   // seek puts the loop's notes back to pending
  }

  // ---------- modes / settings ----------
  setMode(mode) {
    const wasActive = this.active
    if (wasActive) this.pause()
    this.mode = mode
    this.advancement = mode === 'PRACTISE' ? 'pauseAndSnap' : 'continuous'
    this._groupIndex = this._firstGroupAtOrAfter(this.position)
    this.epoch++
    this._emit()
  }
  setAdvancement(a) {
    if (this.waiting) this.pause()
    this.advancement = a
    this._groupIndex = this._firstGroupAtOrAfter(this.position)
    this.epoch++
    this._emit()
  }
  setRate(r) {
    // not a jump: keep every judgement, just continue the clock at the new rate
    const pos = this.currentPosition()
    this.position = pos
    this.rate = r
    if (this.clockRunning) this.minRate = Math.min(this.minRate, r)
    this._anchorAt = this.now()
    this._anchorPos = pos
    if (this._countInUntil > this._anchorAt) this._anchorAt = this._countInUntil
    this.rev++
    this.epoch++
    this._emit()
  }
  setHandFilter(hand) {
    if (this.active) this.pause()
    this.handFilter = hand
    this._reindex()
    this.epoch++
    this._emit()
  }
  setLoop(a, b, on) { this.loop = { a, b, on: !!on }; this._emit() }
  setCountIn(beats) { this.countIn = beats; this._emit() }
  setMetronome(on) { this.metronome.on = on; this._emit() }
  setWindowStart(s) {
    if (s === this.windowStart) return
    const wasActive = this.active
    if (this.active) this.pause()      // freezes the real position
    // the octave buttons move a song's window parts with it, so the next part still
    // follows the keys
    if (this._parts) {
      for (const p of this._parts) p.start += s - this.windowStart
      this._partStart = s
    }
    this.windowStart = s
    this._reindex()
    this.epoch++
    if (wasActive && !this.playing) this.play({ quiet: true })
    this._emit()
  }
  // The keyboard turned out longer or shorter: fit the song to it again.
  setWindowKeys(n, stay = null) {
    if (n === this.windowKeys) return
    const wasActive = this.active
    if (this.active) this.pause()
    this.windowKeys = n
    if (this.song) {
      this._fitWindow(stay)
      this._partStart = this.windowStart
      this._reindex()
      this.epoch++
    }
    if (wasActive && !this.playing) this.play({ quiet: true })
    this._emit()
  }
  _fitWindow(stay) {
    this._parts = stay == null ? windowParts(this.song, this.windowKeys) : null
    this.windowStart = stay ?? (this._parts ? this._parts[0].start : fitWindow(this.song.notes, this.windowKeys))
  }
  setNoteLabels(v) { this.noteLabels = v; this._emit() }
  setView(v) { this.view = v; this._emit() }

  keyIndexFor(pitch) {
    const i = pitch - this.windowStart
    return i >= 0 && i < this.windowKeys ? i : -1
  }

  // ---------- per-frame tick ----------
  tick() {
    if (!this.song) return this.snapshot()
    // a song in window parts: move the keys as the playhead enters the next part
    // (also while stopped, so a restart takes them back to the first part)
    if (this._parts) {
      const ws = this.windowAt(this.currentPosition())
      if (ws !== this._partStart) {
        this._partStart = ws
        this.windowStart = ws
        this.onWindow(ws)
        return this.snapshot()
      }
    }
    if (!this.clockRunning) return this.snapshot()
    const pos = this.currentPosition()

    // loop
    if (this.loop.on && this.loop.a != null && this.loop.b != null && pos >= this.loop.b) {
      this._loopBack()
      return this.snapshot()
    }

    // wait mode: stop at the next required group. Checking only the next group
    // (not a time window) means a late frame still snaps back to it.
    if (this.mode === 'PRACTISE' && this.advancement !== 'continuous' && this.now() >= this._countInUntil) {
      const next = this._groups[this._groupIndex]
      if (next && pos >= next.time - 0.005) {
        const pending = next.notes.filter((n) => !this._isHit(n))
        if (pending.length) { this._enterWait(next, pending); return this.snapshot() }
        this._groupIndex++
      }
    }

    // missed notes roll off
    if (this.mode !== 'WATCH') {
      for (const missed of tickMisses(this.score, pos)) this.onJudgement({ kind: 'missed', pitch: missed.pitch, hand: missed.hand })
    }

    if (pos >= this.end) this._finish()
    return this.snapshot()
  }

  // Next wait point in song time, so the scheduler never plays past it.
  nextWaitTime() {
    if (this.mode !== 'PRACTISE' || this.advancement === 'continuous') return Infinity
    const next = this._groups[this._groupIndex]
    return next ? next.time : Infinity
  }

  _isHit(note) {
    return this.score.expected.some((e) => e.note === note && e.state === 'hit')
  }

  _enterWait(group, pending) {
    // pauseAndSnap freezes exactly on the group; pauseAndPlay stops a hair before
    // so the notes are visibly still arriving.
    this.position = Math.max(0, group.time - (this.advancement === 'pauseAndSnap' ? 0 : 0.03))
    this.playing = false
    this.waiting = true
    this.needPitches = new Set(pending.map((n) => n.pitch))
    this._waitGroup = group
    this._waitSince = this.now()
    this.epoch++
    this._emit()
  }

  _resumeFromWait() {
    const group = this._waitGroup
    this.waiting = false
    this.playing = true
    this.position = group ? group.time : this.position
    this._countInUntil = 0
    this._anchorAt = this.now()
    this._anchorPos = this.position
    this.needPitches.clear()
    if (group) { this._groupIndex = this._groups.indexOf(group) + 1; this._waitGroup = null }
    this.epoch++
    this._emit()
    this.onJudgement({ kind: 'resume' })
  }

  // ---------- input ----------
  noteOn(pitch) {
    if (!this.song) return
    if (this.waiting && this.needPitches.has(pitch)) {
      this.needPitches.delete(pitch)
      const waited = this.now() - this._waitSince
      let res
      for (const note of this._waitGroup?.notes || []) {
        if (note.pitch !== pitch) continue
        const hit = markHit(this.score, note, waited)
        if (hit) { res ||= hit; this.onJudgement(hit) }
      }
      if (this.needPitches.size === 0) this._resumeFromWait()
      return res || { kind: 'waitHit', pitch }
    }
    // A wrong key while the song waits: the notes still to find will count as
    // hinted. Keys the song itself has at this moment (the other hand, played
    // along) and notes of this group already found are not wrong.
    if (this.waiting && this._waitGroup) {
      const t = this._waitGroup.time
      const inSong = this.song.notes.some((n) => n.pitch === pitch && Math.abs(n.start - t) < WINDOWS.edge)
      if (!inSong) {
        markWrong(this.score, this._waitGroup.notes)
        this.onJudgement({ kind: 'wrong', pitch })
        return { kind: 'wrong', pitch }
      }
    }
    if (this.mode !== 'WATCH' && this.clockRunning && this.now() >= this._countInUntil - WINDOWS.edge) {
      // signed song time: just before the downbeat it is slightly negative, so an
      // early press on the first note is judged 'early', not ignored
      const t = this._anchorPos + (this.now() - this.outputLatency() - this._anchorAt) * this.rate
      const res = judgeHit(this.score, pitch, t)
      if (res) { this.onJudgement(res); return res }
    }
    this.onJudgement({ kind: 'free', pitch })
    return { kind: 'free', pitch }
  }

  _finish() {
    if (this.finished) return
    this.finished = true
    this.playing = false
    this.position = this.end
    this.epoch++
    if (this.mode !== 'WATCH') {
      for (const missed of tickMisses(this.score)) this.onJudgement({ kind: 'missed', pitch: missed.pitch, hand: missed.hand })
    }
    const summary = summarize(this.score, this.mode)
    this.onFinish(summary)
    this._emit()
  }

  // ---------- render snapshot ----------
  activeNotes(pos = this.currentPosition()) {
    return this.speedNotes.filter((n) => pos >= n.start - 1e-4 && pos < n.start + n.dur)
  }

  // The next note group (native: lookahead 2.0 s, at most one group).
  upcomingNotes(pos = this.currentPosition()) {
    const lead = 2.0
    const out = []
    let t = null
    for (const n of this.speedNotes) {
      if (n.start <= pos + 1e-4) continue
      if (t == null) t = n.start
      if (n.start > t + 1e-3) break
      if (n.start - pos <= lead) out.push(n)
    }
    return out
  }

  snapshot() {
    const pos = this.currentPosition()
    const now = this.now()
    return {
      position: pos,
      playing: this.playing,
      waiting: this.waiting,
      needPitches: this.needPitches,
      waitNotes: this._waitGroup ? this._waitGroup.notes : [],
      mode: this.mode,
      view: this.view,
      noteLabels: this.noteLabels,
      windowStart: this.windowStart,
      handFilter: this.handFilter,
      loop: this.loop,
      loopIteration: this.loopIteration,
      rate: this.rate,
      countInStart: this._countInStart,
      countInUntil: this._countInUntil,
      countInBeats: this._countInUntil > now ? this._countInRunBeats : 0,
      // a running count-in keeps the length it started with, even if the speed changes
      countInSeconds: this._countInUntil > this._countInStart ? this._countInUntil - this._countInStart : this.countInSeconds,
      tempo: this.song ? this.song.tempo : 120,
      now,
      activeNotes: this.activeNotes(pos),
      upcomingNotes: this.upcomingNotes(pos),
      summary: this.mode === 'WATCH' ? null : this.score
    }
  }

  _emit() { this.onState({}) }
}

// Pick the window of `keys` keys that covers the most notes, aligned to an octave.
export function fitWindow(notes, keys = WINDOW_KEYS) {
  if (!notes || !notes.length) return 60
  const spans = new Map()
  for (const n of notes) {
    const base = Math.floor(n.pitch / 12) * 12
    spans.set(base, (spans.get(base) || 0) + 1)
  }
  const covered = (start) => notes.filter((n) => n.pitch >= start && n.pitch < start + keys).length
  // the first key that puts middle C nearest the middle of the keys
  const centre = 66 - Math.ceil(keys / 2)
  let bestStart = 60, best = -1
  for (const base of spans.keys()) {
    for (let cand = base; cand > base - keys && cand >= 0; cand -= 12) {
      const count = covered(cand)
      // ties go to the window closer to middle C, where songs are usually written
      if (count > best || (count === best && Math.abs(cand - centre) < Math.abs(bestStart - centre))) { best = count; bestStart = cand }
    }
  }
  return bestStart
}

// song.windows = [{ at, start? }]: where each window part begins (song seconds) and
// its first key. A part without a start gets the window that fits its own notes.
function windowParts(song, keys) {
  const parts = song && song.windows
  if (!Array.isArray(parts) || !parts.length) return null
  // a longer keyboard that has every note at once doesn't need to move
  if (keys > WINDOW_KEYS) {
    const start = fitWindow(song.notes, keys)
    if (song.notes.every((n) => n.pitch >= start && n.pitch < start + keys)) return null
  }
  return parts.map((p, i) => {
    const until = i + 1 < parts.length ? parts[i + 1].at : Infinity
    const own = song.notes.filter((n) => n.start >= p.at - 1e-4 && n.start < until - 1e-4)
    return { at: p.at, start: Number.isFinite(p.start) ? p.start : fitWindow(own, keys) }
  })
}
