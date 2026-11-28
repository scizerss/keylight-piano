const assert = require('node:assert/strict')

async function main() {
  const { createLyricsSession, lyricsFingerprint } = await import('../renderer/lyrics-editor.js')
  function setup(record, tapper) {
    let end
    const fake = { time: 0, playing: false, pauses: 0, reviews: 0 }
    const transport = {
      getTime: () => fake.time,
      play: () => { fake.playing = true },
      pause: () => { fake.playing = false; fake.pauses++ },
      seek: (t) => { fake.time = t },
      isPlaying: () => fake.playing,
      onEnd: (cb) => { end = cb }
    }
    const session = createLyricsSession({ record, tapper, transport, onReview: () => { fake.reviews++ } })
    return { session, fake, finish: () => end() }
  }

  const { LyricsTapper } = await import('../renderer/lyrics-model.js')
  const supplied = setup(null, LyricsTapper.fromText('Supplied'))
  assert.equal(supplied.session.step, 'tap')
  assert.equal(supplied.session.tap(), 0)

  const plain = setup({ lyrics: { plain: 'One\nTwo\nThree' } })
  assert.equal(plain.session.step, 'paste')
  assert.equal(plain.session.text, 'One\nTwo\nThree')
  assert.throws(() => plain.session.start('  \n '), /Paste some lyrics/)
  plain.session.start(plain.session.text)
  assert.equal(plain.session.step, 'tap')
  assert.equal(plain.fake.playing, true)
  plain.fake.time = 0.1
  assert.equal(plain.session.tap(), 0)
  assert.equal(plain.session.tapper.lines[0].t, 0)
  plain.fake.time = 2
  assert.equal(plain.session.tap(), 1)
  assert.equal(plain.session.tapper.lines[1].t, 1.85)
  assert.equal(plain.session.undo(), 1)
  assert.equal(plain.session.next, 1)
  assert.equal(plain.session.tapper.timedCount, 1)
  plain.session.restart()
  assert.equal(plain.fake.time, 0)
  assert.equal(plain.session.tapper.timedCount, 0)
  plain.session.tap()
  plain.fake.time = 2.15
  plain.session.tap()
  plain.fake.time = 4.15
  plain.session.tap()
  assert.equal(plain.session.step, 'review')
  assert.equal(plain.fake.playing, false)
  assert.equal(plain.fake.reviews, 1)
  assert.deepEqual(plain.session.save(), {
    lyricWords: [{ t: 0, text: 'One', line: true }, { t: 2, text: 'Two', line: true }, { t: 4, text: 'Three', line: true }],
    lyrics: { synced: [{ t: 0, text: 'One' }, { t: 2, text: 'Two' }, { t: 4, text: 'Three' }] },
    lyricsFromFile: true
  })

  const timed = setup(plain.session.save())
  assert.equal(timed.session.step, 'review')
  assert.equal(timed.session.canSave, false)
  assert.equal(timed.session.dirty, false)
  assert.equal(timed.session.syllableTiming, false)
  assert.equal(timed.session.text, 'One\nTwo\nThree')
  timed.session.editText()
  assert.equal(timed.session.step, 'paste')
  timed.session.start(timed.session.text)
  assert.equal(timed.session.step, 'review')
  assert.equal(timed.session.save(), null)
  timed.session.back()
  assert.equal(timed.session.step, 'review')

  timed.session.preview(0)
  assert.equal(timed.fake.time, 0)
  timed.session.preview(2)
  assert.equal(timed.fake.time, 3)
  assert.equal(timed.fake.playing, true)
  timed.session.tapFrom(2)
  timed.session.review()
  assert.equal(timed.session.tapper.lines[2].t, 4)
  timed.session.tapFrom(2)
  assert.equal(timed.session.step, 'tap')
  assert.equal(timed.session.next, 2)
  assert.equal(timed.fake.time, 1)
  assert.equal(timed.fake.playing, true)
  timed.fake.time = 3.15
  timed.session.tap()
  assert.equal(timed.session.step, 'review')
  assert.equal(timed.session.tapper.lines[2].t, 3)
  assert.equal(timed.session.tapper.timedCount, 3)
  timed.session.nudge(2, -0.1)
  assert.equal(timed.session.tapper.lines[2].t, 2.9)
  timed.session.nudge(2, -1)
  assert.equal(timed.session.tapper.lines[2].t, 2)
  timed.session.nudge(1, 0.1)
  timed.session.nudge(0, -0.1)
  assert.deepEqual(timed.session.tapper.lines.map((line) => line.t), [0, 2, 2])
  timed.session.tapFrom(2)
  assert.equal(timed.session.undo(), 1)
  assert.equal(timed.session.next, 1)
  assert.equal(timed.session.tapper.lines[2].t, 2)
  timed.session.review()
  timed.session.clear(0)
  timed.session.back()
  assert.equal(timed.session.step, 'tap')
  assert.equal(timed.session.next, 0)
  assert.equal(timed.fake.playing, false)
  timed.session.review()
  timed.session.clear(1)
  timed.session.clear(2)
  assert.equal(timed.session.canSave, true)
  assert.equal(timed.session.removesLyrics, true)
  assert.deepEqual(timed.session.save(), { lyricWords: null, lyrics: null, lyricsFromFile: false })

  const edited = setup(plain.session.save())
  edited.session.editText()
  edited.session.start('One\nNew words\nThree')
  assert.deepEqual(edited.session.tapper.lines.map((line) => line.t), [0, null, 4])
  assert.equal(edited.session.next, 1)
  edited.session.review()
  assert.equal(edited.session.dirty, true)
  assert.deepEqual(edited.session.save().lyrics.synced, [{ t: 0, text: 'One' }, { t: 4, text: 'Three' }])

  const plainOnly = setup({ lyrics: { plain: 'Original words' } })
  plainOnly.session.start(plainOnly.session.text)
  plainOnly.session.tap()
  assert.equal(plainOnly.session.dirty, true)
  plainOnly.session.restart()
  plainOnly.session.review()
  assert.equal(plainOnly.session.dirty, false)
  assert.equal(plainOnly.session.canSave, false)
  plainOnly.session.editText()
  plainOnly.session.start('Edited words')
  plainOnly.session.review()
  assert.equal(plainOnly.session.removesLyrics, false)
  assert.equal(plainOnly.session.canSave, false, 'edited plain text with no times cannot be saved (it would keep the old text)')
  assert.equal(plainOnly.session.save(), null)

  const empty = setup()
  empty.session.start('First\nSecond')
  empty.finish()
  assert.equal(empty.session.step, 'review')
  assert.equal(empty.fake.playing, false)
  assert.equal(empty.fake.pauses, 1)
  assert.equal(empty.session.canSave, false)
  assert.equal(empty.session.save(), null)

  const syllables = setup({ lyricWords: [{ t: 1, text: 'Hel', cont: true }, { t: 1.2, text: 'lo' }] })
  assert.equal(syllables.session.syllableTiming, true)
  assert.equal(syllables.session.text, 'Hello')
  assert.equal(syllables.session.save(), null)
  syllables.session.nudge(0, 0.1)
  assert.equal(syllables.session.dirty, true)
  assert.deepEqual(syllables.session.save().lyricWords, [{ t: 1.1, text: 'Hello', line: true }])
  syllables.session.nudge(0, -0.1)
  assert.equal(syllables.session.dirty, false)
  assert.equal(syllables.session.save(), null)
  const legacy = setup({ lyrics: { synced: [{ t: 3, text: 'Legacy' }] } })
  assert.equal(legacy.session.step, 'review')
  assert.equal(legacy.session.syllableTiming, false)
  legacy.session.tapFrom(0)
  assert.equal(legacy.fake.time, 2)

  const record = { title: 'Before', ...plain.session.save() }
  const fingerprint = lyricsFingerprint(record)
  const fresh = { ...structuredClone(record), title: 'After' }
  assert.equal(lyricsFingerprint(fresh), fingerprint)
  fresh.lyricWords[0].t = 0.25
  assert.notEqual(lyricsFingerprint(fresh), fingerprint)
  assert.notEqual(lyricsFingerprint({ ...record, lyrics: { plain: 'Different' } }), fingerprint)

  console.log('lyrics-editor: ok')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
