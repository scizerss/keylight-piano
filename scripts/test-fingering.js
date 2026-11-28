// Finger numbers for beginner melodies and chords. node scripts/test-fingering.js
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

;(async () => {
  const { assignFingering } = await import(pathToFileURL(path.join(__dirname, '..', 'renderer/fingering.js')).href)
  const phrase = (pitches, hand = 'right') => pitches.map((pitch, i) => ({ pitch, hand, start: i * 0.25, dur: 0.25 }))
  const chord = (pitches, hand) => phrase(pitches, hand).map((note) => ({ ...note, start: 0 }))
  const fingers = (notes, opts) => assignFingering(notes, opts).map((note) => note.finger)
  const valid = (f) => Number.isInteger(f) && f >= 1 && f <= 5

  // C through G in one position, mirrored for the left hand.
  const cToG = [60, 62, 64, 65, 67]
  const right = [1, 2, 3, 4, 5]
  const left = [5, 4, 3, 2, 1]
  assert.deepEqual(fingers(phrase(cToG)), right)
  assert.deepEqual(fingers(phrase(cToG, 'left')), left)
  assert.deepEqual(fingers(phrase([...cToG].reverse())), left)
  assert.deepEqual(fingers(phrase([...cToG].reverse(), 'left')), right)
  assert.deepEqual(fingers(phrase([64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 64, 62, 62])),
    [3, 3, 4, 5, 5, 4, 3, 2, 1, 1, 2, 3, 3, 2, 2], 'Ode to Joy stays in one position')

  // The thumb passes under on F in the ascending right-hand C major scale.
  const cMajor = [...cToG, 69, 71, 72]
  assert.deepEqual(fingers(phrase(cMajor)), [1, 2, 3, 1, 2, 3, 4, 5])
  assert.deepEqual(fingers(phrase([...cMajor].reverse())), [5, 4, 3, 2, 1, 3, 2, 1])

  assert.deepEqual(fingers(chord([60, 64, 67], 'right')), [1, 3, 5])
  assert.deepEqual(fingers(chord([60, 64, 67], 'left')), [5, 3, 1])
  assert.deepEqual(fingers(chord([67, 60, 64, 64], 'right')), [5, 1, 3, 3],
    'chord fingers follow pitch rank and duplicate keys share a finger')
  const pinnedChord = chord([60, 64, 67], 'right')
  pinnedChord[0].finger = 2
  const pinnedChordFingers = fingers(pinnedChord)
  assert.equal(pinnedChordFingers[0], 2, 'keep the chord fingering written in the score')
  assert.ok(pinnedChordFingers.every(valid))
  assert.ok(pinnedChordFingers[0] < pinnedChordFingers[1] && pinnedChordFingers[1] < pinnedChordFingers[2])

  // Interleave both hands on the same pitches and onsets, with the latest notes first.
  const rightNotes = phrase(cToG)
  const leftNotes = phrase(cToG, 'left')
  const both = rightNotes.flatMap((note, i) => [note, leftNotes[i]]).reverse()
  const before = both.slice()
  const dataBefore = both.map((note) => ({ ...note }))
  assert.equal(assignFingering(both), both)
  assert.equal(both.length, before.length)
  assert.ok(both.every((note, i) => note === before[i]), 'the same notes stay in input order')
  assert.deepEqual(both.map(({ finger, ...note }) => note), dataBefore)
  assert.deepEqual(rightNotes.map((note) => note.finger), right)
  assert.deepEqual(leftNotes.map((note) => note.finger), left)
  assert.deepEqual(fingers(dataBefore.map((note) => ({ ...note }))), both.map((note) => note.finger),
    'the same input gives the same output on a fresh run')

  const empty = []
  assert.equal(assignFingering(empty), empty)
  assert.ok(valid(fingers(phrase([60]))[0]))
  const repeated = fingers(phrase([64, 64, 64, 64]))
  assert.ok(repeated.every(valid))
  assert.ok(repeated.every((f) => f === repeated[0]), 'keep one finger on a repeated key')
  assert.deepEqual(fingers(phrase([48, 50, 52, 53, 55, 84, 86, 88, 89, 91])), [...right, ...right],
    'a wide leap allows a new five-finger position')
  const bMajor = [59, 61, 63, 64, 66, 68, 70, 71]
  const bMajorFingers = fingers(phrase(bMajor))
  assert.ok(bMajorFingers.every(valid))
  assert.ok([1, 2, 4, 5, 6].every((i) => bMajorFingers[i] !== 1), 'B major can keep the thumb off black keys')
  const pinnedMelody = phrase([60, 62, 64])
  pinnedMelody[1].finger = 3
  const pinnedMelodyFingers = fingers(pinnedMelody)
  assert.equal(pinnedMelodyFingers[1], 3)
  assert.ok(pinnedMelodyFingers.every(valid))

  // A 0.375 s rest breaks the phrase at 240 bpm, but is shorter than a beat at 120 bpm.
  const acrossRest = (opts) => {
    const notes = phrase([...cToG, 64, 65, 67, 69, 71])
    notes.slice(5).forEach((note) => { note.start += 0.375 })
    return fingers(notes, opts)
  }
  assert.deepEqual(acrossRest({ tempo: 240 }), [...right, ...right])
  assert.notDeepEqual(acrossRest({ tempo: 120 }), acrossRest({ tempo: 240 }))
  assert.deepEqual(acrossRest(), acrossRest({ tempo: 120 }))
  assert.deepEqual(acrossRest({ beat: 0.25 }), acrossRest({ tempo: 240 }))
  assert.deepEqual(acrossRest({ beat: 0.25, tempo: 120 }), acrossRest({ tempo: 240 }))

  // C and C-sharp in one phrase never share the thumb, even with other notes between them (was: only neighbours)
  const separatedSharp = fingers(phrase([60, 65, 61, 62, 64, 65, 67]))
  assert.notEqual(separatedSharp[2], 1, 'a separated C-sharp can use a finger other than the thumb')
  assert.notEqual(separatedSharp[0], separatedSharp[2], 'C and C-sharp get different fingers')
  assert.ok(separatedSharp.every(valid))
  // the left hand runs the same rule mirrored: A and B-flat in one phrase never share a finger
  const lhSharp = fingers([57, 53, 58, 60, 57, 53].map((pitch, i) => ({ pitch, start: i * 0.5, dur: 0.4, hand: 'left' })))
  assert.notEqual(lhSharp[0], lhSharp[2], 'left hand: A and B-flat get different fingers')
  assert.ok(lhSharp.every(valid))

  console.log('test-fingering: ok')
})().catch((e) => { console.error(e); process.exit(1) })
