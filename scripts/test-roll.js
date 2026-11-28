// Unit test for the piano-roll editor model and its coordinate maths: node scripts/test-roll.js
// RollModel (renderer/roll-model.js): selection, every editing operation, undo/redo round trips,
// quantise edge cases, the no-overlap rule. Viewport and hitTest (renderer/roll-geometry.js).
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const load = (f) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', f)).href)

const near = (a, b, eps = 1e-3, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b}`)
const song = (notes, extra = {}) => ({
  title: 'T', importedId: 'imp-1', source: 'audio', tempo: 120, duration: 20, bars: [0, 2, 4, 6], score: { xml: 'x' },
  notes: notes || [
    { pitch: 60, start: 0, dur: 0.5, vel: 90, hand: 'right' },
    { pitch: 64, start: 0.5, dur: 0.5, vel: 90, hand: 'right' },
    { pitch: 67, start: 1, dur: 1, vel: 90, hand: 'right' },
    { pitch: 48, start: 0, dur: 1, vel: 80, hand: 'left' },
    { pitch: 43, start: 2, dur: 1, vel: 80, hand: 'left' }
  ],
  ...extra
})
const shape = (m) => m.notes.map((n) => `${n.pitch}:${n.start}:${n.dur}:${n.hand}:${n.vel}`).join('|')
const noOverlap = (m) => {
  const by = {}
  for (const n of m.notes) {
    assert.ok(n.start >= 0, 'negative start')
    assert.ok(n.dur >= 0.05 - 1e-9, 'too short ' + n.dur)
    assert.ok(n.pitch >= 0 && n.pitch <= 127)
    ;(by[n.pitch] = by[n.pitch] || []).push(n)
  }
  for (const list of Object.values(by)) {
    list.sort((a, b) => a.start - b.start)
    for (let i = 1; i < list.length; i++) assert.ok(list[i].start >= list[i - 1].start + list[i - 1].dur - 1e-6, 'overlap at pitch ' + list[i].pitch)
  }
}
const keyOf = (m, pitch, start) => m.notes.find((n) => n.pitch === pitch && (start == null || Math.abs(n.start - start) < 1e-6)).key

async function main() {
  const { RollModel, pitchLabel } = await load('roll-model.js')
  const { NoteDraft } = await load('editor-model.js')
  const { Viewport, hitTest, visibleNotes, notesInRect, pinchFactors, lowerBound, longest } = await load('roll-geometry.js')
  let n = 0
  const check = (label, fn) => { fn(); n++; process.stdout.write('ok ' + label + '\n') }

  // ---------- editor-model additions ----------
  check('draft group: one undo step, none when nothing changed, redo kept working', () => {
    const d = new NoteDraft(song())
    d.beginGroup(); d.set(d.notes[0].key, 'pitch', 'D4'); d.set(d.notes[1].key, 'pitch', 'E4'); d.endGroup()
    assert.equal(d.history.length, 1)
    d.beginGroup(); d.endGroup()
    assert.equal(d.history.length, 1)
    d.beginGroup(); d.set(d.notes[0].key, 'hand', 'left'); d.set(d.notes[0].key, 'hand', 'right'); d.endGroup()
    assert.equal(d.history.length, 1, 'a change that cancelled itself leaves no step')
    d.undo(); assert.equal(d.dirty, false)
    assert.equal(d.canRedo, true)
    d.redo(); assert.equal(d.dirty, true)
  })
  check('bars are saved from the draft and follow undo', () => {
    const d = new NoteDraft(song())
    assert.deepEqual(d.build().song.bars, [0, 2, 4, 6])
    d.change(() => { d.bars = [0, 4]; d.notes[0].start = 0.1 })
    assert.deepEqual(d.build().song.bars, [0, 4])
    d.undo(); assert.deepEqual(d.bars, [0, 2, 4, 6])
  })

  // ---------- grid ----------
  check('grid comes from the tempo; snapTime never goes below zero', () => {
    const m = new RollModel(song()); m.division = 2
    near(m.step, 0.25)
    near(m.snapTime(0.3), 0.25); near(m.snapTime(0.38), 0.5); near(m.snapTime(-1), 0)
    m.setGridOffset(0.1)
    near(m.snapTime(0.0), 0.1, 1e-6, 'first grid point after zero')
    near(m.snapTime(0.37), 0.35)
    m.nudgeGridOffset(0.2); near(m.gridOffset, 0.3)
    m.nudgeGridOffset(-0.5); near(m.gridOffset, 0.3, 1e-6, 'wraps within one beat (0.5 s)')
    assert.equal(m.beatsPerBar, 4)
    const lines = m.gridLines(0, 2, 1)
    assert.ok(lines.every((l) => l.beat) && lines.length >= 3)
    const m2 = new RollModel(song(null, { timeSignature: { beats: 3, beatType: 4 } }))
    assert.equal(m2.beatsPerBar, 3)
    assert.deepEqual(m2.gridLines(0, 2.9, 1).filter((l) => l.bar).map((l) => l.t), [0, 1.5])
  })

  // ---------- selection ----------
  check('selection: one, many, toggle, box, range, hand, all, summary', () => {
    const m = new RollModel(song())
    m.select([keyOf(m, 60)]); assert.equal(m.selection.size, 1)
    m.select([keyOf(m, 64)], true); assert.equal(m.selection.size, 2)
    m.toggle(keyOf(m, 64)); assert.equal(m.selection.size, 1)
    m.clearSelection(); assert.equal(m.selectBox(0, 0.9, 55, 70), 2)
    assert.equal(m.selectRange(1.5, 2.5), 2)
    m.selectHand('left'); assert.equal(m.selection.size, 2)
    m.selectAll(); assert.equal(m.selection.size, 5)
    m.clearSelection(); assert.match(m.summary(), /none selected/)
    m.select([keyOf(m, 60)]); assert.match(m.summary(), /^1 note selected, C4, right hand/)
    m.selectAll(); assert.match(m.summary(), /5 notes selected, G2 to G4, both hands/)
    m.select([9999]); assert.equal(m.selection.size, 0, 'unknown key ignored')
    assert.equal(pitchLabel(61), 'C#4')
  })

  // ---------- add / delete ----------
  check('addNote: defaults, validation, and it wins a clash', () => {
    const m = new RollModel(song())
    const k = m.addNote(72, 3, 0.5)
    assert.equal(m.byKey(k).hand, 'right'); assert.equal(m.addNote(40, 3, 0.5) != null, true)
    assert.equal(m.byKey(m.notes.find((x) => x.pitch === 40).key).hand, 'left')
    assert.equal(m.addNote(200, 0, 1), null); assert.equal(m.addNote(60.5, 0, 1), null)
    const k2 = m.addNote(60, 0.25, 0.5)             // lands inside the C4 at 0..0.5: the older one is cut
    near(m.byKey(k2).dur, 0.5)
    near(m.notes.find((x) => x.pitch === 60 && x.key !== k2).dur, 0.25)
    const k3 = m.addNote(60, 0.25, 0.3)             // same start as k2: the new one replaces it
    assert.equal(m.byKey(k2), null); assert.ok(m.byKey(k3))
    const k4 = m.addNote(61, -5, 0.01)              // negative start and tiny length are fixed
    assert.equal(m.byKey(k4).start, 0); assert.ok(m.byKey(k4).dur >= 0.05)
    noOverlap(m)
  })
  check('deleteNotes: selection or keys, clears selection, undo brings back', () => {
    const m = new RollModel(song()); const before = shape(m)
    m.select([keyOf(m, 60), keyOf(m, 64)])
    assert.equal(m.deleteNotes(), 2); assert.equal(m.notes.length, 3); assert.equal(m.selection.size, 0)
    assert.equal(m.deleteNotes([]), 0)
    m.undo(); assert.equal(shape(m), before); m.redo(); assert.equal(m.notes.length, 3)
  })

  // ---------- move / resize ----------
  check('moveNotes: time and pitch, clamped at zero and the keyboard edges', () => {
    const m = new RollModel(song())
    const keys = [keyOf(m, 60), keyOf(m, 64)]
    const r = m.moveNotes(keys, 0.25, 2)
    near(r.dStart, 0.25); assert.equal(r.dPitch, 2)
    assert.deepEqual(m.notes.filter((x) => keys.includes(x.key)).map((x) => x.pitch).sort(), [62, 66])
    const r2 = m.moveNotes(keys, -50, 0)             // clamped: the earliest note stops at 0
    near(m.byKey(keys[0]).start, 0, 1e-9); assert.ok(r2.dStart > -50)
    const hi = new RollModel(song([{ pitch: 126, start: 0, dur: 1, vel: 90, hand: 'right' }]))
    assert.equal(hi.moveNotes([hi.notes[0].key], 0, 12).dPitch, 1); assert.equal(hi.notes[0].pitch, 127)
    noOverlap(m)
  })
  check('moveNotes: a drag is one undo step and restarts from the start state each move', () => {
    const m = new RollModel(song()); const before = shape(m)
    const k = keyOf(m, 64); m.select([k])
    m.beginGesture()
    m.moveNotes([k], 0.25, 0); m.moveNotes([k], 0.5, 3); m.moveNotes([k], 1.0, 3)
    m.endGesture()
    near(m.byKey(k).start, 1.5); assert.equal(m.byKey(k).pitch, 67)
    assert.equal(m.draft.history.length, 1)
    m.undo(); assert.equal(shape(m), before); m.redo(); near(m.byKey(k).start, 1.5)
    m.beginGesture(); m.moveNotes([k], 0, 0); m.endGesture()
    assert.equal(m.draft.history.length, 1, 'a drag that went nowhere is not a step')
  })
  check('moveNotes onto a same-pitch note: moved note wins, others shortened, drag back restores', () => {
    const m = new RollModel(song([
      { pitch: 60, start: 0, dur: 1, vel: 90, hand: 'right' },
      { pitch: 62, start: 2, dur: 1, vel: 90, hand: 'right' }
    ]))
    const k = keyOf(m, 62); m.beginGesture()
    m.moveNotes([k], -1.5, -2)                       // now C4 at 0.5, inside the first note
    near(m.notes.find((x) => x.key !== k).dur, 0.5, 1e-6, 'first note cut at the new note')
    m.moveNotes([k], -2, -2)                         // exactly on the first note's start: it is replaced
    assert.equal(m.notes.length, 1)
    m.moveNotes([k], 0, 0)                           // back: the dropped note returns
    assert.equal(m.notes.length, 2); near(m.notes.find((x) => x.key !== k).dur, 1)
    m.endGesture(); assert.equal(m.draft.history.length, 0)
  })
  check('moveToGrid snaps the first note onto the grid', () => {
    const m = new RollModel(song()); const k = keyOf(m, 67, 1)
    m.moveToGrid([k], 0.13, 0); near(m.byKey(k).start, 1.25)
    m.snap = false; m.moveToGrid([k], 0.13, 0); near(m.byKey(k).start, 1.38)
  })
  check('resizeNotes / resizeToEnd: minimum length, no overlap, snap, one undo step', () => {
    const m = new RollModel(song()); const k = keyOf(m, 60)
    m.resizeNotes([k], -5); near(m.byKey(k).dur, 0.05)
    m.undo(); near(m.byKey(k).dur, 0.5)
    m.beginGesture(); m.resizeToEnd([k], 0.7); m.resizeToEnd([k], 1.1); m.endGesture()
    near(m.byKey(k).dur, 1.0); assert.equal(m.draft.history.length, 1)
    m.snap = false; m.resizeToEnd([k], 0.8); near(m.byKey(k).dur, 0.8)
    const two = new RollModel(song([{ pitch: 60, start: 0, dur: 1, vel: 90, hand: 'right' }, { pitch: 60, start: 2, dur: 1, vel: 90, hand: 'right' }]))
    two.resizeNotes([two.notes[0].key], 5)           // would run into the next C4: cut at it
    near(two.notes[0].dur, 2); noOverlap(two)
  })

  // ---------- hand, velocity, duplicate ----------
  check('setHand and setVelocity, with undo', () => {
    const m = new RollModel(song()); const before = shape(m)
    m.select([keyOf(m, 60), keyOf(m, 48)])
    assert.equal(m.setHand(null, 'left'), 1)         // only the one that was not left
    assert.equal(m.setHand(null, 'purple'), 0)
    assert.equal(m.setVelocity(null, 200), 2); assert.ok(m.notes.every((x) => !m.selection.has(x.key) || x.vel === 127))
    assert.equal(m.setVelocity(null, 127), 0)
    m.undo(); m.undo(); assert.equal(shape(m), before)
  })
  check('duplicate: after the span, selects the copies, one undo step', () => {
    const m = new RollModel(song()); const before = shape(m)
    m.select([keyOf(m, 60), keyOf(m, 64)])
    const keys = m.duplicate()
    assert.equal(keys.length, 2); assert.equal(m.notes.length, 7)
    const copy = m.byKey(keys[0]); assert.ok(copy.start >= 1 - 1e-9)
    assert.deepEqual([...m.selection].sort(), keys.slice().sort())
    noOverlap(m)
    m.undo(); assert.equal(shape(m), before)
    m.clearSelection(); assert.deepEqual(m.duplicate([]), [])
    m.select([keyOf(m, 60)]); assert.equal(m.duplicate(null, 10).length, 1)
  })

  // ---------- transpose ----------
  check('transpose: selection, whole song, octaves, refusal at the edge', () => {
    const m = new RollModel(song()); const before = shape(m)
    m.select([keyOf(m, 60)]); assert.equal(m.transpose(12).moved, 1)
    assert.ok(m.notes.some((x) => x.pitch === 72)); assert.ok(m.notes.some((x) => x.pitch === 64))
    m.clearSelection(); assert.equal(m.transpose(-2).moved, 5)
    assert.equal(m.transpose(0).moved, 0)
    const e = m.transpose(100); assert.ok(e.error); assert.equal(m.notes.every((x) => x.pitch < 100), true)
    m.undo(); m.undo(); assert.equal(shape(m), before)
  })
  check('transpose drops stale fingering', () => {
    const m = new RollModel(song([{ pitch: 60, start: 0, dur: 1, vel: 90, hand: 'right', finger: 1 }]))
    m.transpose(2); assert.equal(m.notes[0].finger, undefined)
  })

  // ---------- quantise ----------
  check('quantise: whole song to 1/8, notes land on the grid, undo', () => {
    const m = new RollModel(song([
      { pitch: 60, start: 0.04, dur: 0.2, vel: 90, hand: 'right' },
      { pitch: 62, start: 0.27, dur: 0.2, vel: 90, hand: 'right' },
      { pitch: 64, start: 0.49, dur: 0.2, vel: 90, hand: 'right' }
    ])); const before = shape(m)
    const r = m.quantise({ division: 2 })
    assert.equal(r.moved, 3)
    assert.deepEqual(m.notes.map((x) => x.start), [0, 0.25, 0.5]); noOverlap(m)
    m.undo(); assert.equal(shape(m), before)
  })
  check('quantise: selection only, strength, durations', () => {
    const m = new RollModel(song([
      { pitch: 60, start: 0.1, dur: 0.3, vel: 90, hand: 'right' },
      { pitch: 62, start: 0.6, dur: 0.3, vel: 90, hand: 'right' }
    ]))
    m.select([m.notes[0].key]); m.quantise({ strength: 0.5, division: 2 })
    near(m.notes[0].start, 0.05); near(m.notes[1].start, 0.6)
    m.clearSelection(); m.quantise({ division: 1, durations: true })
    assert.deepEqual(m.notes.map((x) => x.start), [0, 0.5]); assert.deepEqual(m.notes.map((x) => x.dur), [0.5, 0.5])
  })
  check('quantise: chords stay chords; collisions of the same pitch merge; offset grid never goes negative', () => {
    const m = new RollModel(song([
      { pitch: 60, start: 0.51, dur: 0.4, vel: 90, hand: 'right' }, { pitch: 64, start: 0.52, dur: 0.4, vel: 90, hand: 'right' },
      { pitch: 60, start: 0.99, dur: 0.1, vel: 90, hand: 'right' }, { pitch: 60, start: 1.01, dur: 0.1, vel: 90, hand: 'right' }
    ]))
    m.quantise({ division: 1 })
    assert.equal(m.notes.filter((x) => x.start === 0.5).length, 2)
    assert.equal(m.notes.filter((x) => x.pitch === 60 && x.start === 1).length, 1, 'two C4 on the same beat become one')
    noOverlap(m)
    const o = new RollModel(song([{ pitch: 60, start: 0, dur: 0.2, vel: 90, hand: 'right' }]))
    o.setGridOffset(0.3); o.quantise({ division: 1 })
    assert.ok(o.notes[0].start >= 0); near(o.notes[0].start, 0.3)
    assert.equal(new RollModel(song()).quantise({ keys: [] }).moved, 0)
  })
  check('quantise with a very short note and a coarse grid keeps it playable', () => {
    const m = new RollModel(song([{ pitch: 60, start: 0.2, dur: 0.05, vel: 90, hand: 'right' }]))
    m.quantise({ division: 1, durations: true }); assert.ok(m.notes[0].dur >= 0.05); noOverlap(m)
  })

  // ---------- simplify / hands / trim ----------
  check('simplify melody keeps the top line and a sparse bass; reduce keeps top and bottom; undo', () => {
    const chord = (t) => [48, 52, 55, 72].map((p) => ({ pitch: p, start: t, dur: 0.4, vel: 90, hand: p < 60 ? 'left' : 'right' }))
    const m = new RollModel(song([...chord(0), ...chord(0.1), ...chord(0.5)])); const before = shape(m)
    assert.equal(m.notes.length, 12)
    const r = m.simplify('melody'); assert.ok(r.removed > 0)
    assert.ok(m.notes.every((x) => x.pitch === 72 || x.pitch === 48)); noOverlap(m)
    m.undo(); assert.equal(shape(m), before)
    m.simplify('reduce'); assert.ok(m.notes.every((x) => x.pitch === 72 || x.pitch === 48))
    assert.equal(new RollModel(song([{ pitch: 70, start: 0, dur: 1, vel: 90, hand: 'right' }])).simplify('melody').removed, 0)
  })
  check('swapHands and splitHandsAt (selection or all)', () => {
    const m = new RollModel(song()); const before = shape(m)
    m.swapHands(); assert.equal(m.notes.filter((x) => x.hand === 'left').length, 3)
    m.undo(); assert.equal(shape(m), before)
    m.select([keyOf(m, 60)]); m.swapHands(); assert.equal(m.byKey(keyOf(m, 60)).hand, 'left')
    m.clearSelection(); assert.equal(m.splitHandsAt(62), 0, 'already split there')
    assert.equal(m.splitHandsAt(65), 1, 'only E4 changes')
    assert.ok(m.notes.every((x) => x.hand === (x.pitch < 65 ? 'left' : 'right')))
    assert.equal(m.splitHandsAt(65), 0); assert.equal(m.splitHandsAt(-1), 0)
  })
  check('trimSilence: leading silence, long gaps, bars move, nothing to trim is a no-op', () => {
    const m = new RollModel(song([
      { pitch: 60, start: 3, dur: 1, vel: 90, hand: 'right' }, { pitch: 62, start: 4, dur: 1, vel: 90, hand: 'right' },
      { pitch: 64, start: 20, dur: 1, vel: 90, hand: 'right' }
    ], { bars: [0, 2, 4, 6, 20] })); const before = shape(m)
    const r = m.trimSilence({ lead: 0.5, maxGap: 2 })
    near(r.trimmed, 2.5 + 13)
    assert.deepEqual(m.notes.map((x) => x.start), [0.5, 1.5, 4.5]); noOverlap(m)
    assert.equal(m.draft.bars[0], 0)
    m.undo(); assert.equal(shape(m), before); assert.deepEqual(m.draft.bars, [0, 2, 4, 6, 20])
    assert.equal(new RollModel(song()).trimSilence().trimmed, 0)
  })

  // ---------- tempo ----------
  check('changeTempo stretches times and bars; undo restores everything; limits enforced', () => {
    const m = new RollModel(song()); const before = shape(m)
    const r = m.changeTempo(60); near(r.tempo, 60)
    near(m.notes.find((x) => x.pitch === 67).start, 2); near(m.notes.find((x) => x.pitch === 67).dur, 2)
    assert.deepEqual(m.draft.bars, [0, 4, 8, 12]); near(m.step, 0.5)
    m.undo(); assert.equal(shape(m), before); assert.equal(m.tempo, 120); assert.deepEqual(m.draft.bars, [0, 2, 4, 6])
    assert.ok(m.changeTempo(10).error); assert.ok(m.changeTempo('abc').error); assert.ok(m.scaleTime(0).error)
    assert.equal(m.tempo, 120)
    near(m.scaleTime(1.2).tempo, 100)
  })
  check('setGridTempo only moves the grid, notes stay; invalid tempo refused', () => {
    const m = new RollModel(song()); const before = shape(m)
    assert.equal(m.setGridTempo(90).tempo, 90); assert.equal(shape(m), before)
    assert.ok(m.setGridTempo(5).error); m.undo(); assert.equal(m.tempo, 120)
  })

  // ---------- undo/redo round trip + invariants ----------
  check('a long run of mixed operations undoes and redoes exactly, never breaking the rules', () => {
    const m = new RollModel(song()); const start = shape(m)
    const states = [start]
    const ops = [
      () => m.addNote(70, 2.1, 0.4), () => { m.selectAll(); m.transpose(3) }, () => m.quantise({ division: 2 }),
      () => { m.select([m.notes[0].key]); m.moveNotes(null, 0.3, 1) }, () => m.setHand([m.notes[1].key], 'left'),
      () => { m.select([m.notes[2].key]); m.duplicate() }, () => m.deleteNotes([m.notes[3].key]),
      () => m.changeTempo(90), () => m.swapHands(), () => m.trimSilence({ lead: 0 })
    ]
    for (const op of ops) { const h = m.draft.history.length; op(); noOverlap(m); if (m.draft.history.length !== h) states.push(shape(m)) }
    assert.ok(states.length >= 8, 'states ' + states.length)
    for (let i = states.length - 2; i >= 0; i--) { m.undo(); assert.equal(shape(m), states[i], 'undo to ' + i) }
    assert.equal(m.canUndo, false)
    for (let i = 1; i < states.length; i++) { m.redo(); assert.equal(shape(m), states[i], 'redo to ' + i) }
    assert.equal(m.canRedo, false)
    const out = m.build(); assert.ok(out.song, out.error); assert.ok(out.song.notes.length >= 1)
  })
  check('a new edit after undo clears redo; selection never holds removed keys', () => {
    const m = new RollModel(song()); m.addNote(70, 5, 1); m.undo(); assert.equal(m.canRedo, true)
    m.addNote(71, 5, 1); assert.equal(m.canRedo, false)
    const k = keyOf(m, 71); m.select([k]); m.undo(); assert.equal(m.selection.size, 0)
  })
  check('build gives a saveable song: keeps details, drops score once notes change', () => {
    const m = new RollModel(song()); assert.equal(m.build().song.score.xml, 'x')
    m.transpose(1); const { song: s } = m.build(); assert.equal(s.score, null); assert.equal(s.id, 'imp-1')
    const empty = new RollModel(song()); empty.deleteNotes(empty.notes.map((x) => x.key)); assert.ok(empty.build().error)
  })
  check('3000 notes: operations stay fast', () => {
    const notes = []
    for (let i = 0; i < 3000; i++) notes.push({ pitch: 40 + (i * 7) % 40, start: i * 0.13, dur: 0.1, vel: 90, hand: 'right' })
    const m = new RollModel(song(notes, { duration: 400 }))
    const t = Date.now()
    m.selectAll(); m.transpose(1); m.quantise({ division: 4 }); m.moveNotes(null, 1, 0); m.undo()
    assert.ok(Date.now() - t < 2000, 'took ' + (Date.now() - t) + ' ms'); noOverlap(m)
  })

  // ---------- geometry ----------
  check('viewport maps time and pitch both ways', () => {
    const vp = new Viewport({ width: 844, height: 390, keysW: 44, top: 40, pxPerSec: 100, pxPerSemi: 20 })
    vp.t0 = 2; vp.pTop = 80
    near(vp.timeToX(2), 44); near(vp.timeToX(3), 144); near(vp.xToTime(144), 3)
    assert.equal(vp.yToPitch(vp.pitchToY(72) + 10), 72); assert.equal(vp.yToPitch(vp.pitchToY(60) + 1), 60)
    near(vp.t1, 2 + 800 / 100)
    const [a, b] = vp.visiblePitches(); assert.ok(a <= 62 && b >= 80)
  })
  check('zoom keeps the point under the finger fixed; limits hold; pan clamps', () => {
    const vp = new Viewport({ width: 800, height: 400, keysW: 40, top: 0, pxPerSec: 100, pxPerSemi: 20 })
    vp.t0 = 5
    const t = vp.xToTime(300), p = vp.yToPitch(100)
    vp.zoomAt(300, 100, 2, 1)
    near(vp.xToTime(300), t, 1e-6); assert.equal(vp.yToPitch(100), p); near(vp.pxPerSec, 200)
    vp.zoomAt(300, 100, 1000, 1000); assert.equal(vp.pxPerSec, vp.limits.maxPxPerSec); assert.equal(vp.pxPerSemi, vp.limits.maxPxPerSemi)
    vp.zoomAt(300, 100, 1e-6, 1e-6); assert.equal(vp.pxPerSec, vp.limits.minPxPerSec)
    vp.panBy(1e6, 0); assert.ok(vp.t0 >= -0.5)
    vp.panBy(0, 1e6); assert.ok(vp.pTop <= 111 + 1e-9)
    vp.pxPerSemi = 8; vp.clampScroll(); vp.panBy(0, -1e6); assert.ok(vp.pBottom >= 18 - 1e-9)
  })
  check('pinch factors per axis', () => {
    const f = pinchFactors({ x: 0, y: 0 }, { x: 100, y: 10 }, { x: 0, y: 0 }, { x: 200, y: 10 })
    near(f.fx, 2); near(f.fy, Math.hypot(200, 10) / Math.hypot(100, 10), 1e-9, 'close in y: follows overall spread')
    const g = pinchFactors({ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 0 }, { x: 100, y: 50 })
    near(g.fx, 1); near(g.fy, 0.5)
    assert.deepEqual(pinchFactors({ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 5, y: 5 }, { x: 9, y: 9 }), { fx: 1, fy: 1 })
  })
  check('visibleNotes finds only what is on screen, including a long note that began earlier', () => {
    const notes = []
    for (let i = 0; i < 1000; i++) notes.push({ key: i, pitch: 60, start: i, dur: 0.5 })
    notes.push({ key: 9999, pitch: 70, start: 0, dur: 500 }); notes.sort((a, b) => a.start - b.start)
    const md = longest(notes); assert.equal(md, 500)
    const v = visibleNotes(notes, 100, 105, 0, 127, md)
    assert.deepEqual(v.map((x) => x.key).sort((a, b) => a - b), [100, 101, 102, 103, 104, 105, 9999])
    assert.equal(visibleNotes(notes, 100, 105, 0, 127, 0).length, 6, 'without maxDur the long one is missed (why maxDur exists)')
    assert.equal(visibleNotes(notes, 100, 105, 61, 127, md).length, 1)
    assert.equal(lowerBound(notes, 50.5), notes.findIndex((x) => x.start >= 50.5))
  })
  check('a selected short note can still be grabbed by its body with a finger; maxTime no longer caps scrolling at ten minutes', () => {
    const vp = new Viewport({ width: 800, height: 400, keysW: 40, top: 0, pxPerSec: 60, pxPerSemi: 10 })
    vp.t0 = 0; vp.pTop = 70
    const notes = [{ key: 1, pitch: 60, start: 1, dur: 0.5 }]               // 30 px wide at this zoom
    const y = vp.pitchToY(60) + 5
    const mid = vp.timeToX(1.25)
    assert.equal(hitTest(vp, notes, mid, y, { selected: new Set([1]), slop: 22, handle: 16 }).zone, 'body', 'the middle of a selected short note moves it')
    assert.equal(hitTest(vp, notes, vp.timeToX(1.5) + 6, y, { selected: new Set([1]), slop: 22, handle: 16 }).zone, 'end', 'just past the edge resizes it')
    vp.setMaxTime(2000); vp.panBy(-1e7, 0)
    assert.ok(vp.t0 > 1900, 'a song longer than the old 600 s cap scrolls to its end: ' + vp.t0)
    vp.setMaxTime(30); vp.panBy(-1e7, 0)
    assert.ok(vp.t0 <= 38 + vp.rollW / vp.pxPerSec, 'stops about a screenful past the end')
  })
  check('hitTest: body, right edge, finger slop, selected handle, gutter, empty space', () => {
    const vp = new Viewport({ width: 800, height: 400, keysW: 40, top: 0, pxPerSec: 100, pxPerSemi: 20 })
    vp.t0 = 0; vp.pTop = 70
    const notes = [{ key: 1, pitch: 60, start: 1, dur: 1 }, { key: 2, pitch: 62, start: 1, dur: 0.1 }]
    const yOf = (p) => vp.pitchToY(p) + 10
    let h = hitTest(vp, notes, 40 + 150, yOf(60)); assert.equal(h.key, 1); assert.equal(h.zone, 'body')
    h = hitTest(vp, notes, 40 + 195, yOf(60)); assert.equal(h.zone, 'end', 'last stretch resizes')
    assert.equal(hitTest(vp, notes, 40 + 150, yOf(60) + 60), null)
    assert.equal(hitTest(vp, notes, 40 + 150, yOf(60) + 20, { slop: 22 }).key, 1, 'a finger below the note still hits it')
    assert.equal(hitTest(vp, notes, 10, yOf(60)), null, 'gutter')
    assert.equal(hitTest(vp, notes, 40 + 215, yOf(60), {}), null, 'beyond the edge: nothing unless selected')
    h = hitTest(vp, notes, 40 + 215, yOf(60), { selected: new Set([1]), slop: 22 }); assert.equal(h.zone, 'end', 'selected handle reaches past the edge')
    h = hitTest(vp, notes, 40 + 105, yOf(62)); assert.equal(h.key, 2, 'short note: tiny edge zone does not swallow the body')
    const r = notesInRect(vp, notes, 40 + 90, yOf(60) - 5, 40 + 130, yOf(60) + 5); assert.deepEqual(r.map((x) => x.key), [1])
    assert.equal(notesInRect(vp, notes, 40 + 90, 0, 40 + 130, 400).length, 2)
  })

  check('velocity (and finger) edits count as changes: dirty, undoable, kept by an undo step in a gesture', () => {
    const m = new RollModel(song())
    assert.equal(m.dirty, false)
    const k = keyOf(m, 60, 0)
    m.select([k]); assert.equal(m.setVelocity(null, 40), 1)
    assert.equal(m.dirty, true, 'a velocity-only edit is a change, so Done saves it')
    assert.equal(m.canUndo, true, 'and it has an undo step')
    assert.equal(m.byKey(k).vel, 40)
    assert.ok(m.undo()); assert.equal(m.byKey(k).vel, 90); assert.equal(m.dirty, false, 'undone: clean again')
    assert.ok(m.redo()); assert.equal(m.dirty, true)
    m.undo()
    m.beginGesture(); m.setVelocity([k], 10); m.endGesture()
    assert.equal(m.canUndo, true, 'a velocity step inside a gesture is not thrown away as "nothing changed"')
    const m2 = new RollModel(song())
    const k2 = keyOf(m2, 64, 0.5)
    assert.equal(m2.draft.set(k2, 'finger', '3'), null); assert.equal(m2.dirty, true, 'finger')
    assert.equal(m2.draft.set(k2, 'hand', 'left'), null); m2.undo(); m2.undo(); assert.equal(m2.dirty, false)
    const m3 = new RollModel(song()); m3.select([keyOf(m3, 60, 0)]); m3.setVelocity(null, 40)
    const built = m3.build(); assert.equal(built.song.notes.find((x) => x.pitch === 60).vel, 40, 'the saved song carries the velocity')
  })

  const withLyrics = (extra = {}) => song([
    { pitch: 60, start: 1, dur: 0.5, vel: 90, hand: 'right' }, { pitch: 64, start: 3, dur: 0.5, vel: 90, hand: 'right' }
  ], { lyrics: { synced: [{ t: 1, text: 'one' }, { t: 3, text: 'two' }] }, lyricsFromFile: true,
    lyricWords: [{ t: 1, text: 'on', cont: true }, { t: 1.5, text: 'e' }, { t: 3, text: 'two' }], audio: { recording: true }, ...extra })
  check('trim silence retimes the lyric lines and words with the notes and detaches the recording; undo brings both back', () => {
    const m = withLyrics() && new RollModel(withLyrics())
    assert.equal(m.hasRecording, true)
    const asked = []
    const r = m.trimSilence({ lead: 0, confirmDetach: (text) => { asked.push(text); return true } })
    assert.equal(r.trimmed, 1); assert.equal(asked.length, 1, 'the user is warned once, before anything changes')
    assert.match(asked[0], /no longer line up/)
    let out = m.build().song
    assert.deepEqual(out.lyrics.synced.map((l) => l.t), [0, 2], 'lyric lines moved by the same 1 s')
    assert.deepEqual(out.lyricWords.map((l) => l.t), [0, 0.5, 2])
    assert.equal(out.lyricWords[0].cont, true, 'other word fields are kept')
    assert.equal(out.audio, null, 'the old recording is detached, never played against shifted notes')
    assert.equal(m.hasRecording, false)
    assert.ok(m.undo())
    out = m.build().song
    assert.deepEqual(out.lyrics.synced.map((l) => l.t), [1, 3]); assert.deepEqual(out.lyricWords.map((l) => l.t), [1, 1.5, 3])
    assert.deepEqual(out.audio, { recording: true }, 'undo restores the recording')
    assert.equal(m.dirty, false)
  })
  check('declining the recording warning changes nothing; with no recording nobody is asked', () => {
    const m = new RollModel(withLyrics())
    const r = m.trimSilence({ lead: 0, confirmDetach: () => false })
    assert.equal(r.cancelled, true); assert.equal(m.dirty, false); assert.equal(m.canUndo, false)
    assert.equal(m.changeTempo(60, { confirmDetach: () => false }).cancelled, true); assert.equal(m.tempo, 120)
    const plain = new RollModel(withLyrics({ audio: null }))
    let asked = 0
    plain.trimSilence({ lead: 0, confirmDetach: () => { asked++; return false } })
    assert.equal(asked, 0); assert.equal(plain.dirty, true)
    assert.equal(plain.build().song.audio, null)
  })
  check('after the recording is detached the song length follows the notes, not the old recording', () => {
    const m = new RollModel(withLyrics({ duration: 20 }))
    m.trimSilence({ lead: 0 })
    const out = m.build().song
    assert.equal(out.audio, null); near(out.duration, m.end(), 1e-9); assert.ok(out.duration < 5, 'was 20: ' + out.duration)
    m.undo(); assert.equal(m.build().song.duration, 20, 'undo: the recording and its length are back')
  })
  check('change speed stretches lyrics (lines and words) and detaches the recording in the same undo step', () => {
    const m = new RollModel(withLyrics())
    assert.equal(m.changeTempo(60, { confirmDetach: () => true }).tempo, 60)
    let out = m.build().song
    assert.deepEqual(out.lyrics.synced.map((l) => l.t), [2, 6]); assert.deepEqual(out.lyricWords.map((l) => l.t), [2, 3, 6])
    assert.equal(out.audio, null)
    assert.ok(m.undo()); assert.equal(m.tempo, 120); assert.equal(m.canUndo, false, 'one undo step covers notes, lyrics and recording')
    out = m.build().song
    assert.deepEqual(out.lyrics.synced.map((l) => l.t), [1, 3]); assert.deepEqual(out.audio, { recording: true })
  })

  check('grid offset is part of the undo history: a tempo change, nudges and setGridTempo all undo completely', () => {
    const m = new RollModel(song(null, { grid: { offset: 0.1, division: 2 } }))
    near(m.gridOffset, 0.1); assert.equal(m.dirty, false, 'the saved grid is the starting point, not an edit')
    m.changeTempo(60)
    near(m.gridOffset, 0.2, 1e-9, 'scaled with the tempo'); assert.equal(m.tempo, 60)
    assert.ok(m.undo()); assert.equal(m.tempo, 120); near(m.gridOffset, 0.1, 1e-9, 'undo restores the offset with the notes and tempo'); assert.equal(m.dirty, false)
    assert.ok(m.redo()); near(m.gridOffset, 0.2)
    m.undo()
    m.nudgeGridOffset(0.01); near(m.gridOffset, 0.11); assert.equal(m.dirty, true)
    assert.ok(m.undo()); near(m.gridOffset, 0.1); assert.equal(m.dirty, false)
    m.setGridOffset(0.3); assert.ok(m.undo()); near(m.gridOffset, 0.1)
    m.setGridTempo(90); assert.equal(m.tempo, 90); near(m.gridOffset, 0.1)
    assert.ok(m.undo()); assert.equal(m.tempo, 120); near(m.gridOffset, 0.1)
    const q = new RollModel(song(null, { grid: { offset: 0.07, division: 2 } }))
    q.quantise({}); near(q.gridOffset, 0.07, 1e-9, 'quantise leaves the grid alone'); q.undo(); near(q.gridOffset, 0.07)
    assert.equal(q.gridRecord().offset, 0.07)
  })

  process.stdout.write(`\n${n} roll checks passed\n`)
}
main().catch((e) => { console.error(e); process.exit(1) })
