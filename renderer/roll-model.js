// Pure model behind the piano-roll editor (no DOM). It wraps a NoteDraft (editor-model.js), so
// every operation goes through the draft's undo/redo history, and adds: a selection, a grid
// derived from the tempo, and the editing operations (add, delete, move, resize, hand,
// velocity, duplicate, transpose, quantise, simplify, swap/split hands, trim silence, tempo).
//
// Rules every operation keeps: times are never negative, a note is never shorter than MIN_DUR,
// pitches stay 0..127, and two notes of the same pitch never overlap (the earlier one is
// shortened, or dropped if nothing would be left; with the same start the "preferred" note,
// i.e. the one just moved, added or pasted, wins).
//
// Drags: call beginGesture(), then call the move/resize operation again and again with the
// TOTAL offset since the drag began (they restart from the gesture's start state), then
// endGesture(). The whole gesture is one undo step, and none if nothing moved.
import { NoteDraft, MIN_DUR, MAX_SECONDS, MAX_NOTES } from './editor-model.js'

export const GRID_DIVISIONS = [
  { id: '1', label: '1/4', perBeat: 1 },
  { id: '2', label: '1/8', perBeat: 2 },
  { id: '3', label: '1/8 triplet', perBeat: 3 },
  { id: '4', label: '1/16', perBeat: 4 },
  { id: '8', label: '1/32', perBeat: 8 }
]
const PREC = 1e4
const r4 = (x) => Math.round(x * PREC) / PREC
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))
const handFor = (pitch) => (pitch < 60 ? 'left' : 'right')
const r3 = (x) => Math.round(x * 1000) / 1000

// What the user is told before an edit that moves the song's timing while it has an attached recording. The player has no
// audio offset and cannot stretch audio, so the recording would no longer line up: it is detached from the edited song.
export const RECORDING_WARNING = 'This changes the timing of the song, so its original recording will no longer line up. ' +
  'The recording will be removed from the edited song (Undo brings it back until you press Done). Continue?'

export class RollModel {
  constructor(song, { division = 2, snap = true } = {}) {
    this.draft = new NoteDraft(song)
    this.selection = new Set()
    this.division = division            // grid steps per beat
    this.snap = snap
    const g = song.grid                 // grid settings saved with the song (older songs have none)
    if (g && Number.isInteger(g.division) && g.division >= 1 && g.division <= 16) this.division = g.division
    this.lastError = null
    const ts = song.timeSignature
    this.beatsPerBar = ts && Number.isInteger(ts.beats) && ts.beats > 0 && ts.beats <= 16 ? ts.beats : 4
    if (g && Number.isFinite(g.offset)) { this.draft.gridOffset = this.wrapOffset(g.offset); this.draft.resetBaseline() }   // the starting point, not an edit
  }
  // seconds: where beat 1 of the grid falls. It lives in the draft, so Undo and Redo restore it together with the notes and tempo.
  get gridOffset() { return this.draft.gridOffset }
  set gridOffset(seconds) { this.draft.gridOffset = seconds }
  wrapOffset(seconds) { return Number.isFinite(seconds) ? ((seconds % this.beat) + this.beat) % this.beat : 0 }
  // does the song still carry its original recording (which a timing change would detach)?
  get hasRecording() { return !!this.draft.original.audio && !this.draft.detachAudio }
  // what is saved with the song so the grid comes back as it was left (tempo is the song's own tempo)
  gridRecord() { return { offset: r4(this.gridOffset), division: this.division } }

  // ---------- reading ----------
  get notes() { return this.draft.notes }
  get tempo() { return this.draft.tempo }
  get beat() { return 60 / this.draft.tempo }
  get step() { return this.beat / this.division }
  get dirty() { return this.draft.dirty }
  get canUndo() { return this.draft.canUndo }
  get canRedo() { return this.draft.canRedo }
  byKey(key) { return this.draft.notes[this.draft.indexOf(key)] || null }
  selected() { return this.draft.notes.filter((n) => this.selection.has(n.key)) }
  keysOrSelection(keys) { return keys ? [...keys] : [...this.selection] }
  end() { return this.draft.notes.reduce((m, n) => Math.max(m, n.start + n.dur), 0) }

  // ---------- grid ----------
  setDivision(perBeat) { if (Number.isInteger(perBeat) && perBeat >= 1 && perBeat <= 16) this.division = perBeat }
  setGridOffset(seconds) {
    const v = this.wrapOffset(seconds)
    if (Math.abs(v - this.gridOffset) < 1e-9) return
    this.command(() => this.draft.change(() => { this.draft.gridOffset = v }))      // one undo step
  }
  nudgeGridOffset(seconds) { this.setGridOffset(this.gridOffset + seconds) }
  // nearest grid time at or after zero
  snapTime(t, step = this.step) {
    let k = Math.round((t - this.gridOffset) / step)
    let s = this.gridOffset + k * step
    while (s < -1e-9) { k++; s = this.gridOffset + k * step }
    return r4(Math.max(0, s))
  }
  snapDuration(d, step = this.step) { return r4(Math.max(MIN_DUR, Math.max(1, Math.round(d / step)) * step)) }
  // beat lines for the view between two times: [{ t, bar, beat }] (bar = first beat of a bar)
  gridLines(t0, t1, perBeat = 1) {
    const out = []
    const step = this.beat / perBeat
    let k = Math.ceil((t0 - this.gridOffset) / step)
    for (; ; k++) {
      const t = this.gridOffset + k * step
      if (t > t1) break
      if (t < -1e-9) continue
      const beatIndex = k / perBeat
      const onBeat = k % perBeat === 0
      out.push({ t, beat: onBeat, bar: onBeat && Math.round(beatIndex) % this.beatsPerBar === 0 })
      if (out.length > 5000) break
    }
    return out
  }

  // ---------- selection ----------
  select(keys, additive = false) {
    if (!additive) this.selection.clear()
    for (const k of keys) if (this.byKey(k)) this.selection.add(k)
  }
  toggle(key) { if (this.selection.has(key)) this.selection.delete(key); else if (this.byKey(key)) this.selection.add(key) }
  clearSelection() { this.selection.clear() }
  selectAll() { this.selection = new Set(this.draft.notes.map((n) => n.key)) }
  // every note that starts inside [t0, t1] (and pitch inside [p0, p1] if given)
  selectBox(t0, t1, p0 = 0, p1 = 127, additive = false) {
    const lo = Math.min(t0, t1), hi = Math.max(t0, t1), pl = Math.min(p0, p1), ph = Math.max(p0, p1)
    const keys = this.draft.notes.filter((n) => n.start + n.dur > lo && n.start < hi && n.pitch >= pl && n.pitch <= ph).map((n) => n.key)
    this.select(keys, additive)
    return keys.length
  }
  selectRange(t0, t1, additive = false) { return this.selectBox(t0, t1, 0, 127, additive) }
  selectHand(hand, additive = false) { this.select(this.draft.notes.filter((n) => n.hand === hand).map((n) => n.key), additive) }
  pruneSelection() { for (const k of [...this.selection]) if (!this.byKey(k)) this.selection.delete(k) }
  summary() {
    const sel = this.selected()
    if (!sel.length) return `${this.draft.notes.length} ${this.draft.notes.length === 1 ? 'note' : 'notes'}, none selected`
    const names = (p) => pitchLabel(p)
    const lo = sel.reduce((m, n) => Math.min(m, n.pitch), 127), hi = sel.reduce((m, n) => Math.max(m, n.pitch), 0)
    const t0 = sel.reduce((m, n) => Math.min(m, n.start), Infinity), t1 = sel.reduce((m, n) => Math.max(m, n.start + n.dur), 0)
    const hands = new Set(sel.map((n) => n.hand))
    const handText = hands.size === 2 ? 'both hands' : [...hands][0] + ' hand'
    const pitches = lo === hi ? names(lo) : `${names(lo)} to ${names(hi)}`
    return `${sel.length} ${sel.length === 1 ? 'note' : 'notes'} selected, ${pitches}, ${handText}, ${t0.toFixed(2)} s to ${t1.toFixed(2)} s`
  }

  // ---------- gestures ----------
  beginGesture() { this.draft.beginGroup() }
  endGesture() { this.draft.endGroup(); this.pruneSelection() }
  rebaseGesture() { this.draft.rebase() }        // after adding a note inside a gesture: later drag steps keep it
  get inGesture() { return !!this.draft.group }
  // run `fn` as one undo step unless a gesture is already open
  step_(fn) {
    const own = !this.draft.group
    if (own) this.draft.beginGroup()
    else this.draft.restoreBase()
    try { return fn() } finally { if (own) { this.draft.endGroup(); this.pruneSelection() } }
  }
  command(fn) {                         // a command (not a drag): never restarts from the gesture base
    const own = !this.draft.group
    if (own) this.draft.beginGroup()
    try { return fn() } finally { if (own) { this.draft.endGroup(); this.pruneSelection() } }
  }

  // ---------- overlap rule ----------
  // Fix overlaps and bad values in place. `prefer` = keys that win a clash.
  normalise(prefer = new Set()) {
    const notes = this.draft.notes
    for (const n of notes) {
      n.start = r4(clamp(n.start, 0, MAX_SECONDS))
      n.dur = r4(clamp(n.dur, MIN_DUR, MAX_SECONDS))
      n.pitch = clamp(Math.round(n.pitch), 0, 127)
    }
    const by = new Map()
    for (const n of notes) { if (!by.has(n.pitch)) by.set(n.pitch, []); by.get(n.pitch).push(n) }
    const drop = new Set()
    for (const list of by.values()) {
      if (list.length < 2) continue
      list.sort((a, b) => a.start - b.start || (prefer.has(b.key) ? 1 : 0) - (prefer.has(a.key) ? 1 : 0) || a.key - b.key)
      let cur = null
      for (const n of list) {
        if (!cur) { cur = n; continue }
        if (n.start - cur.start < 1e-6) {                 // same start: one of them goes
          if (prefer.has(cur.key) && !prefer.has(n.key)) drop.add(n.key)
          else if (n.dur >= cur.dur || prefer.has(n.key)) { drop.add(cur.key); cur = n }
          else drop.add(n.key)
          continue
        }
        if (n.start < cur.start + cur.dur - 1e-6) {
          const room = r4(n.start - cur.start)
          if (room < MIN_DUR) { drop.add(cur.key); cur = n; continue }
          cur.dur = room
        }
        cur = n
      }
    }
    if (drop.size) this.draft.notes = notes.filter((n) => !drop.has(n.key))
    this.draft.sort()
    return drop.size
  }
  // apply a mutation of the current notes as one undoable change, then keep the rules
  mutate(fn, prefer) {
    this.draft.change(() => fn(this.draft))
    this.normalise(prefer ? new Set(prefer) : undefined)
  }

  // ---------- operations ----------
  addNote(pitch, start, dur, hand, vel = 100) {
    if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127) return null
    if (this.draft.notes.length >= MAX_NOTES) return null
    return this.command(() => {
      let key = null
      this.draft.change(() => {
        const note = this.draft.keyed({ pitch, start: r4(Math.max(0, start)), dur: r4(Math.max(MIN_DUR, dur || this.step)), vel: clamp(Math.round(vel), 0, 127), hand: hand || handFor(pitch) })
        key = note.key
        this.draft.notes.push(note)
      })
      this.normalise(new Set([key]))          // a new note wins a clash
      return this.byKey(key) ? key : null
    })
  }
  deleteNotes(keys) {
    const set = new Set(this.keysOrSelection(keys))
    if (!set.size) return 0
    let n = 0
    this.command(() => this.mutate((d) => { const before = d.notes.length; d.notes = d.notes.filter((x) => !set.has(x.key)); n = before - d.notes.length }))
    for (const k of set) this.selection.delete(k)
    return n
  }
  // Move by dStart seconds and dPitch semitones (totals since the gesture began). The shift is
  // limited so nothing goes before 0 or outside 0..127.
  moveNotes(keys, dStart, dPitch) {
    const set = new Set(this.keysOrSelection(keys))
    return this.step_(() => {
      const moving = this.draft.notes.filter((n) => set.has(n.key))
      if (!moving.length) return null
      const minStart = moving.reduce((m, n) => Math.min(m, n.start), Infinity)
      const maxEnd = moving.reduce((m, n) => Math.max(m, n.start + n.dur), 0)
      const lo = moving.reduce((m, n) => Math.min(m, n.pitch), 127), hi = moving.reduce((m, n) => Math.max(m, n.pitch), 0)
      const ds = clamp(dStart, -minStart, MAX_SECONDS - maxEnd)
      const dp = clamp(Math.round(dPitch), -lo, 127 - hi)
      if (!ds && !dp) return { dStart: 0, dPitch: 0 }
      this.mutate((d) => {
        for (const n of d.notes) if (set.has(n.key)) {
          n.start = r4(n.start + ds)
          if (dp) { n.pitch += dp; delete n.finger }
        }
      }, set)
      return { dStart: ds, dPitch: dp }
    })
  }
  // Move so the first selected note starts exactly at `time`, snapped to the grid if snapping is on
  moveToGrid(keys, dStart, dPitch) {
    const set = new Set(this.keysOrSelection(keys))
    const base = this.draft.group ? this.draft.group.base.notes.filter((n) => set.has(n.key)) : this.draft.notes.filter((n) => set.has(n.key))
    if (!base.length) return null
    let ds = dStart
    if (this.snap) {
      const first = base.reduce((m, n) => Math.min(m, n.start), Infinity)
      ds = this.snapTime(first + dStart) - first
    }
    return this.moveNotes(keys, ds, dPitch)
  }
  // Change length by dDur seconds (total since the gesture began), each note at least MIN_DUR
  resizeNotes(keys, dDur) {
    const set = new Set(this.keysOrSelection(keys))
    return this.step_(() => {
      this.mutate((d) => {
        for (const n of d.notes) if (set.has(n.key)) n.dur = r4(clamp(n.dur + dDur, MIN_DUR, MAX_SECONDS - n.start))
      }, set)
    })
  }
  // set the end of every selected note to `time` (snapped if on); used while dragging a handle
  resizeToEnd(keys, endTime) {
    const set = new Set(this.keysOrSelection(keys))
    const base = (this.draft.group ? this.draft.group.base.notes : this.draft.notes).filter((n) => set.has(n.key))
    if (!base.length) return null
    const anchor = base.reduce((m, n) => (n.start + n.dur > m.start + m.dur ? n : m), base[0])
    let end = endTime
    if (this.snap) end = Math.max(anchor.start + MIN_DUR, this.snapTime(endTime))
    return this.resizeNotes(keys, end - (anchor.start + anchor.dur))
  }
  setHand(keys, hand) {
    if (hand !== 'left' && hand !== 'right') return 0
    const set = new Set(this.keysOrSelection(keys))
    let n = 0
    this.command(() => { const todo = this.draft.notes.filter((x) => set.has(x.key) && x.hand !== hand); if (todo.length) { n = todo.length; this.mutate(() => todo.forEach((x) => { x.hand = hand; delete x.finger })) } })
    return n
  }
  setVelocity(keys, vel) {
    const v = clamp(Math.round(vel), 1, 127)
    const set = new Set(this.keysOrSelection(keys))
    let n = 0
    this.command(() => { const todo = this.draft.notes.filter((x) => set.has(x.key) && x.vel !== v); if (todo.length) { n = todo.length; this.mutate(() => todo.forEach((x) => { x.vel = v })) } })
    return n
  }
  // Copy the notes right after their own span (rounded up to a whole beat) or `offset` seconds later;
  // the copies become the selection.
  duplicate(keys, offset) {
    const set = new Set(this.keysOrSelection(keys))
    const src = this.draft.notes.filter((n) => set.has(n.key))
    if (!src.length) return []
    if (this.draft.notes.length + src.length > MAX_NOTES) return []
    const t0 = Math.min(...src.map((n) => n.start)), t1 = Math.max(...src.map((n) => n.start + n.dur))
    const shift = offset != null ? offset : Math.max(this.beat, Math.ceil((t1 - t0) / this.beat - 1e-9) * this.beat)
    if (t1 + shift > MAX_SECONDS) return []
    const keys2 = []
    this.command(() => this.mutate((d) => {
      for (const n of src) { const c = d.keyed({ ...n, start: r4(n.start + shift) }); keys2.push(c.key); d.notes.push(c) }
    }, keys2))
    this.selection = new Set(keys2.filter((k) => this.byKey(k)))
    return [...this.selection]
  }
  // Shift pitch by `semitones`; keys = null means the selection, or the whole song when nothing is
  // selected. Refused (returns an error) if a note would leave 0..127.
  transpose(semitones, keys) {
    const st = Math.round(semitones)
    if (!st) return { moved: 0 }
    const set = keys ? new Set(keys) : this.selection.size ? new Set(this.selection) : new Set(this.draft.notes.map((n) => n.key))
    const target = this.draft.notes.filter((n) => set.has(n.key))
    if (!target.length) return { moved: 0 }
    if (target.some((n) => n.pitch + st < 0 || n.pitch + st > 127)) return { error: 'That would move a note off the keyboard' }
    this.command(() => this.mutate(() => target.forEach((n) => { n.pitch += st; delete n.finger }), set))
    return { moved: target.length }
  }
  // Snap note starts to the grid. strength 0..1 (1 = exactly on the grid). durations: also snap lengths.
  // keys = null: selection, or the whole song when nothing is selected.
  quantise({ keys = null, strength = 1, durations = false, division = this.division } = {}) {
    const set = keys ? new Set(keys) : this.selection.size ? new Set(this.selection) : new Set(this.draft.notes.map((n) => n.key))
    const target = this.draft.notes.filter((n) => set.has(n.key))
    if (!target.length) return { moved: 0 }
    const step = this.beat / division
    const s = clamp(strength, 0, 1)
    let moved = 0
    this.command(() => this.mutate(() => {
      for (const n of target) {
        const snapped = this.snapTime(n.start, step)
        const start = r4(n.start + (snapped - n.start) * s)
        if (Math.abs(start - n.start) > 1e-6) moved++
        n.start = start
        if (durations) n.dur = this.snapDuration(n.dur, step)
      }
    }, set))
    return { moved }
  }
  // Keep a melody: the top note of every chord stays as right hand; the lowest stays as left hand
  // (at most one per `bassGap` seconds). mode 'melody' = top note only; 'reduce' = top + bottom of every chord.
  simplify(mode = 'melody', split = 55) {
    const sorted = [...this.draft.notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch)
    const groups = []
    for (const n of sorted) {
      const g = groups[groups.length - 1]
      if (g && n.start - g.start < 0.06) g.notes.push(n)
      else groups.push({ start: n.start, notes: [n] })
    }
    const keep = new Set()
    let lastBass = -Infinity
    for (const g of groups) {
      const top = g.notes.reduce((a, b) => (b.pitch > a.pitch ? b : a))
      const low = g.notes.reduce((a, b) => (b.pitch < a.pitch ? b : a))
      if (mode === 'melody') {
        if (top.pitch >= split) keep.add(top.key)
        if (low.pitch < split && g.start - lastBass >= 0.25) { keep.add(low.key); lastBass = g.start }
      } else { keep.add(top.key); keep.add(low.key) }
    }
    if (!keep.size) return { removed: 0 }
    const removed = this.draft.notes.length - keep.size
    if (removed <= 0) return { removed: 0 }
    this.command(() => this.mutate((d) => {
      d.notes = d.notes.filter((n) => keep.has(n.key))
      if (mode === 'melody') for (const n of d.notes) n.hand = n.pitch >= split ? 'right' : 'left'
    }))
    this.pruneSelection()
    return { removed }
  }
  swapHands(keys) {
    const set = new Set(this.keysOrSelection(keys))
    const target = (set.size ? this.draft.notes.filter((n) => set.has(n.key)) : this.draft.notes)
    if (!target.length) return 0
    this.command(() => this.mutate(() => target.forEach((n) => { n.hand = n.hand === 'left' ? 'right' : 'left'; delete n.finger })))
    return target.length
  }
  // pitch below `pitch` -> left hand, at or above -> right hand (selection, else whole song)
  splitHandsAt(pitch, keys) {
    if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127) return 0
    const set = new Set(this.keysOrSelection(keys))
    const target = set.size ? this.draft.notes.filter((n) => set.has(n.key)) : this.draft.notes
    const todo = target.filter((n) => n.hand !== (n.pitch < pitch ? 'left' : 'right'))
    if (!todo.length) return 0
    this.command(() => this.mutate(() => todo.forEach((n) => { n.hand = n.pitch < pitch ? 'left' : 'right'; delete n.finger })))
    return todo.length
  }
  // Remove the silence before the first note (keep `lead` seconds) and shorten any gap longer than
  // maxGap seconds to maxGap (Infinity = leave gaps). Bar times move with the notes.
  trimSilence({ lead = 0, maxGap = Infinity, confirmDetach = null } = {}) {
    const notes = this.draft.notes
    if (!notes.length) return { trimmed: 0 }
    const first = notes.reduce((m, n) => Math.min(m, n.start), Infinity)
    // sounding intervals, merged, to find the silent gaps
    const iv = notes.map((n) => [n.start, n.start + n.dur]).sort((a, b) => a[0] - b[0])
    const cuts = []                                  // [from, length removed]
    if (first > lead + 1e-6) cuts.push([0, first - lead])
    if (Number.isFinite(maxGap)) {
      let reach = iv[0][1]
      for (let i = 1; i < iv.length; i++) {
        if (iv[i][0] - reach > maxGap + 1e-6) cuts.push([reach + maxGap, iv[i][0] - reach - maxGap])
        reach = Math.max(reach, iv[i][1])
      }
    }
    if (!cuts.length) return { trimmed: 0 }
    const total = cuts.reduce((s, c) => s + c[1], 0)
    const map = (t) => { let out = t; for (const [from, len] of cuts) { if (t >= from + len) out -= len; else if (t > from) out -= t - from } return Math.max(0, out) }
    if (this.hasRecording && confirmDetach && !confirmDetach(RECORDING_WARNING)) return { trimmed: 0, cancelled: true }
    this.command(() => this.mutate((d) => {
      for (const n of d.notes) { const s = map(n.start), e = map(n.start + n.dur); n.start = s; n.dur = Math.max(MIN_DUR, e - s) }
      if (d.bars) d.bars = d.bars.map(map).filter((t, i, a) => i === 0 || t > a[i - 1])
      this.retimeLyrics(d, map)
    }))
    return { trimmed: r4(total) }
  }
  // Time-stretch: every time (notes, bar lines) times `factor`; the tempo changes by 1 / factor.
  // Apply the same time mapping to the lyric lines and words (they are timed to the song), and drop the recording that
  // no longer lines up with it (the player cannot offset or stretch it).
  retimeLyrics(d, map) {
    const limit = (t) => r3(clamp(map(t), 0, MAX_SECONDS))
    if (d.lyrics) d.lyrics = d.lyrics.map((l) => ({ ...l, t: limit(l.t) }))
    if (d.lyricWords) d.lyricWords = d.lyricWords.map((l) => ({ ...l, t: limit(l.t) }))
    if (this.draft.original.audio) d.detachAudio = true
  }
  scaleTime(factor, { confirmDetach = null } = {}) {
    if (!Number.isFinite(factor) || factor < 0.1 || factor > 10) return { error: 'Pick a speed change between a tenth and ten times' }
    const newTempo = this.draft.tempo / factor
    if (newTempo < 20 || newTempo > 400) return { error: 'Tempo must stay between 20 and 400 beats a minute' }
    if (this.end() * factor > MAX_SECONDS) return { error: 'The song would be too long' }
    if (Math.abs(factor - 1) < 1e-9) return { tempo: this.draft.tempo }
    if (this.hasRecording && confirmDetach && !confirmDetach(RECORDING_WARNING)) return { tempo: this.draft.tempo, cancelled: true }
    this.command(() => this.mutate((d) => {
      for (const n of d.notes) { n.start = r4(n.start * factor); n.dur = r4(Math.max(MIN_DUR, n.dur * factor)) }
      if (d.bars) d.bars = d.bars.map((t) => r4(t * factor))
      d.tempo = Math.round(newTempo * 1000) / 1000
      this.retimeLyrics(d, (t) => t * factor)
      d.gridOffset = d.gridOffset * factor            // inside the same undo step as the notes and tempo
    }))
    return { tempo: this.draft.tempo }
  }
  // Change the tempo and stretch the notes to match (same music, different speed)
  changeTempo(bpm, opts) {
    const t = Number(bpm)
    if (!Number.isFinite(t) || t < 20 || t > 400) return { error: 'Type a tempo from 20 to 400 beats a minute' }
    return this.scaleTime(this.draft.tempo / t, opts)
  }
  // Set only the tempo the grid is drawn from: notes do not move (use when the grid does not fit)
  setGridTempo(bpm) {
    const err = this.draft.setTempo(bpm)
    return err ? { error: err } : { tempo: this.draft.tempo }
  }
  undo() { const ok = this.draft.undo(); this.pruneSelection(); return ok }
  redo() { const ok = this.draft.redo(); this.pruneSelection(); return ok }
  build() { const r = this.draft.build(); if (r.song) r.song.grid = this.gridRecord(); return r }
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
export const pitchLabel = (p) => NAMES[p % 12] + (Math.floor(p / 12) - 1)
export const isBlackKey = (p) => [1, 3, 6, 8, 10].includes(p % 12)
