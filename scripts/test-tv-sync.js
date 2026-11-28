// Tests for renderer/tv-sync.js, the TV page's pure logic: node scripts/test-tv-sync.js
// Prints "tv-sync: ok" when every check passes. Active and upcoming notes are checked against
// renderer/player.js (the phone's own code) on small and random songs. The phone-to-TV path is in test-tv-contract.js.
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const renderer = path.join(__dirname, '..', 'renderer')
const load = (file) => import(pathToFileURL(path.join(renderer, file)).href)

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `expected ${a} to be near ${b}`)
const sameList = (a, b) => assert.ok(a.length === b.length && a.every((x, i) => x === b[i]), `lists differ: ${a.length} vs ${b.length}`)
const pitches = (list) => list.map((n) => n.pitch)

// small seeded generator (mulberry32), so the random songs are the same on every run
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// A validated state as the page sees it (validateState's output), for the clock tests.
function st(over) {
  return { at: 1000, position: 10, rate: 1, playing: true, waiting: false, delayMs: 0, countInUntilMs: 0,
    countInStartMs: 0, countInBeats: 0, rev: 0, waitAt: null, end: null, loop: null, ...over }
}

async function main() {
  const T = await load('tv-sync.js')
  const { Player } = await load('player.js')

  // ---------------------------------------------------------------- clock
  {
    const s = st({ at: 1000, position: 10, delayMs: 200 })
    near(T.targetPosition(s, 1500), 10.7)                                   // 700 ms of song, delay included
    near(T.targetPosition({ ...s, rate: 0.5 }, 1500), 10.35)                // half speed
    near(T.targetPosition({ ...s, delayMs: undefined }, 1500), 10.5)        // no delay field: 0
  }
  {
    const s = st({ at: 1000, position: 10, playing: false, delayMs: 200 })
    assert.equal(T.targetPosition(s, 9000), 10)                             // paused: no extrapolation
    assert.equal(T.targetPosition({ ...s, playing: true, waiting: true }, 9000), 10)   // waiting
  }
  {
    // count-in: the phone's clock starts at countInUntil, so the picture holds until then (plus the delay)
    const s = st({ at: 1000, position: 0, delayMs: 0, countInUntilMs: 2000 })
    assert.equal(T.targetPosition(s, 1500), 0)
    near(T.targetPosition(s, 2500), 0.5)
    near(T.targetPosition({ ...s, delayMs: 200 }, 1900), 0.1)
  }
  {
    // the hitch: just before a wait point, with a 200 ms delay, the picture must not pass it
    const s = st({ at: 0, position: 1.95, delayMs: 200, waitAt: 2.0 })
    assert.equal(T.targetPosition(s, 0), 2.0)
    assert.equal(T.targetPosition({ ...s, position: 1.999, delayMs: 600 }, 0), 2.0)
    near(T.targetPosition({ ...s, waitAt: null }, 0), 2.15)                 // no wait mode: no stop
  }
  {
    // resumed from a wait: the position sits exactly on the group just left; the next stop is the group after it
    const s = st({ at: 5000, position: 2.0, delayMs: 0, waitAt: 3.0 })
    near(T.targetPosition(s, 5100), 2.1)
    assert.equal(T.targetPosition(s, 5000), 2.0)
  }
  {
    // a group at 0 the phone is about to stop at: the picture stays at 0 (the start-at-a-group case)
    const s = st({ at: 0, position: 0, delayMs: 160, waitAt: 0 })
    assert.equal(T.targetPosition(s, 0), 0)
    assert.equal(T.targetPosition(s, 100), 0)
    assert.equal(T.targetPosition(s, 500), 0)
  }
  {
    // a group the phone passed without stopping has no waitAt, so nothing holds the picture there
    const s = st({ at: 0, position: 1.95, delayMs: 200, waitAt: null })
    near(T.targetPosition(s, 201), 2.351)
  }
  {
    // A/B loop: hold at B until the phone wraps; past B nothing is clamped
    const s = st({ at: 0, position: 4.9, delayMs: 0, loop: { a: 1, b: 5 } })
    assert.equal(T.targetPosition(s, 500), 5)
    near(T.targetPosition({ ...s, position: 5.2 }, 500), 5.7)
    near(T.targetPosition({ ...s, loop: null }, 500), 5.4)
  }
  {
    const s = st({ at: 0, position: 1.9, delayMs: 160, loop: { a: 1, b: 2 }, loopIteration: 0 })
    for (const waitAt of [1.998, 2, 2.005]) {
      const frame = T.frameClock({ ...s, waitAt }, 0)
      assert.equal(frame.iteration, 0)
      assert.equal(frame.target, Math.min(waitAt, 2))
    }
    assert.equal(T.frameClock({ ...s, waitAt: 2.006 }, 0).iteration, 1)
  }
  {
    // a seek exactly to loop B holds there too (the phone wraps on its next tick): the picture never runs past B
    const s = st({ at: 0, position: 2.0, delayMs: 160, loop: { a: 0, b: 2 } })
    assert.equal(T.targetPosition(s, 0), 2.0)
    assert.equal(T.stopLimit(st({ position: 2, loop: { a: 0, b: 2 } })), 2)
  }
  {
    const s = st({ at: 0, position: 99.9, delayMs: 0, duration: 100 })
    assert.equal(T.targetPosition(s, 500), 100)
    assert.equal(T.targetPosition({ ...s, duration: 99.95 }, 500), 99.95)
  }
  {
    // the end of a lesson section (the phone's player.end): the picture stops there, never past the duration
    const s = st({ at: 0, position: 10, delayMs: 0, duration: 100, end: 12 })
    near(T.targetPosition(s, 5000), 12)
    assert.equal(T.targetPosition({ ...s, end: 150 }, 200000), 100)         // no end before the duration
    assert.equal(T.targetPosition({ ...s, position: 12.5, end: 12 }, 9000), 12.5)   // already past: holds, never backwards
  }
  {
    // stopLimit is the most the picture may show: waitAt, loop B, end and duration, never below the position
    assert.equal(T.stopLimit(st({ position: 1, duration: 9 })), 9)
    assert.equal(T.stopLimit(st({ position: 1, waitAt: 4, end: 3, duration: 9 })), 3)
    assert.equal(T.stopLimit(st({ position: 5, waitAt: 4 })), 5)
    assert.equal(T.stopLimit(st({ position: 1, loop: { a: 0, b: 2 }, duration: 9 })), 2)
    assert.equal(T.stopLimit(st({ position: 3, loop: { a: 0, b: 2 } })), Infinity)
  }

  {
    const s = T.createSmoother()
    const playing = st({ at: 0, receivedAt: 0, position: 0, delayMs: 160 })
    const fresh = T.frameClock(playing, T.STALE_MS - 5)
    const shown = s.update(fresh, 'k')
    const stale = T.frameClock(playing, T.STALE_MS + 10000)
    assert.equal(stale.stale, true)
    assert.equal(s.update(stale, 'k'), shown)
    assert.equal(T.frameClock({ ...playing, waiting: true }, 20000).stale, false)
    assert.equal(T.frameClock({ ...playing, playing: false }, 20000).stale, false)
    const resumed = T.frameClock({ ...playing, at: 20000, receivedAt: 20000, position: 3 }, 20000)
    assert.equal(s.update(resumed, 'reset-on-resume'), 3.16)
  }

  // ---------------------------------------------------------------- smoother
  {
    const s = T.createSmoother()
    const base = st({ at: 1000, position: 10, delayMs: 160 })
    assert.equal(s.update(T.frameClock(base, 1000), 'a'), 10.16)            // first frame snaps to the target
  }
  {
    // steady playback with a perfect state: after one second of frames at 60 fps the picture is within 5 ms
    const s = T.createSmoother()
    const state = st({ at: 1000, position: 10, delayMs: 160 })
    let shown = null
    for (let k = 0; k <= 60; k++) {
      const nowMs = 1000 + Math.round((k * 1000) / 60)
      shown = s.update(T.frameClock(state, nowMs), 'k')
    }
    const raw = T.targetPosition(state, 2000)                               // 1 s after the state, delay included
    assert.ok(Math.abs(shown - raw) < 0.005, `lag ${((raw - shown) * 1000).toFixed(2)} ms`)
  }
  {
    // the count-in holds: no advance before the anchor, and the advance starts at the anchor, not at the frame that
    // straddles it
    const s = T.createSmoother()
    const state = st({ at: 1000, position: 0, delayMs: 0, countInUntilMs: 2000 })
    for (let t = 1000; t <= 2000; t += 16) assert.equal(s.update(T.frameClock(state, t), 'c'), 0, `held at ${t}`)
    const after = s.update(T.frameClock(state, 2010), 'c')
    assert.ok(after > 0 && after <= 0.011, `advance only after the anchor, got ${after}`)
  }
  {
    // a 0.2 s backwards seek (new rev) snaps; the same move without a new rev is eased, not snapped
    const s = T.createSmoother()
    const before = st({ at: 1000, position: 4.0, delayMs: 0, rev: 1 })
    s.update(T.frameClock(before, 1000), 'k1')
    s.update(T.frameClock(before, 1100), 'k1')
    const seek = st({ at: 1100, position: 3.9, delayMs: 0, rev: 2 })       // 0.2 s back from the shown 4.1
    near(s.update(T.frameClock(seek, 1100), 'k2'), 3.9)                       // snapped at once
    const s2 = T.createSmoother()
    s2.update(T.frameClock(before, 1000), 'k1')
    s2.update(T.frameClock(before, 1100), 'k1')
    const same = st({ at: 1100, position: 3.9, delayMs: 0, rev: 1 })
    const held = s2.update(T.frameClock(same, 1100), 'k1')
    near(held, 4.1)                                                           // no new rev, and it plays: held, never back
    let v = held, last = 1100
    for (let t = 1116; t <= 2100; t += 16) { v = s2.update(T.frameClock(same, t), 'k1'); last = t }
    assert.ok(Math.abs(v - T.targetPosition(same, last)) < 0.005, `absorbed within about a second, off by ${v - T.targetPosition(same, last)}`)
  }
  {
    // a large error snaps even without a new key; a small one is corrected a share at a time
    const s = T.createSmoother()
    s.update(T.frameClock(st({ at: 0, position: 10, delayMs: 0 }), 0), 'k')
    assert.equal(s.update(T.frameClock(st({ at: 0, position: 10.6, delayMs: 0 }), 0), 'k'), 10.6)   // 0.6 s: snap
    const tick = 1000 / 60
    const d = T.createSmoother()
    d.update(T.frameClock(st({ at: 0, position: 10, delayMs: 0 }), 0), 'k')
    near(d.update(T.frameClock(st({ at: 0, position: 10.2, delayMs: 0 }), tick), 'k'), 10.03 + tick / 1000)
    near(d.update(T.frameClock(st({ at: 0, position: 9.9, delayMs: 0 }), tick * 2), 'k'),
      10.03 + tick / 1000) // playing: held, never back
    const ease = (fps) => {
      const p = T.createSmoother()
      p.update(T.frameClock(st({ at: 0, position: 10, delayMs: 0, playing: false }), 0), 'k')
      for (let f = 1; f <= fps / 10; f++) {
        p.update(T.frameClock(st({ at: 0, position: 9.9, delayMs: 0, playing: false }), f * 1000 / fps), 'k')
      }
      return p.value()
    }
    assert.ok(ease(60) < 10 && ease(60) > 9.9, 'paused: a small error eases back')
    near(ease(30), ease(120))
  }
  {
    // the phone's state arrives once a second, sampled at the frame it lands in, with no picture delay: every frame
    // advances by exactly its own time (the advance must not restart at the sample)
    const s = T.createSmoother()
    let state = st({ at: 1000, position: 10, delayMs: 0 })
    let prev = null, prevNow = null, worst = 0
    for (let k = 0; k <= 180; k++) {
      const nowMs = 1000 + Math.round((k * 1000) / 60)
      if (k > 0 && k % 60 === 0) state = st({ at: nowMs, position: 10 + (nowMs - 1000) / 1000, delayMs: 0 })
      const v = s.update(T.frameClock(state, nowMs), 'k')
      if (prev !== null) worst = Math.max(worst, Math.abs((v - prev) - (nowMs - prevNow) / 1000))
      prev = v
      prevNow = nowMs
    }
    assert.ok(worst < 1e-9, `a frame was off by ${(worst * 1000).toFixed(4)} ms`)
  }
  {
    // while it plays the picture never moves back, even when the phone's position steps back 7 ms; it catches up
    const s = T.createSmoother()
    s.update(T.frameClock(st({ at: 0, position: 10, delayMs: 0 }), 0), 'k')
    let v = 10
    for (let t = 16; t <= 160; t += 16) v = s.update(T.frameClock(st({ at: 0, position: 10, delayMs: 0 }), t), 'k')
    let prev = v
    const stepped = st({ at: 160, position: 10.16 - 0.007, delayMs: 0 })
    for (let t = 160; t <= 400; t += 16) {
      const next = s.update(T.frameClock(stepped, t), 'k')
      assert.ok(next >= prev - 1e-12, `moved back at ${t} ms: ${prev} -> ${next}`)
      prev = next
    }
    assert.ok(Math.abs(prev - T.targetPosition(stepped, 400)) < 0.005, 'and it catches up with the phone')
  }
  {
    // the stop clamp applies last: the picture never passes a wait point it was told about
    const s = T.createSmoother()
    const playing = st({ at: 0, position: 1.95, delayMs: 0, waitAt: 2.0 })
    let shown = 0
    for (let t = 0; t <= 300; t += 16) shown = s.update(T.frameClock(playing, t), 'w')
    assert.equal(shown, 2.0)
    // the phone reports the pauseAndPlay stop 30 ms before the group: the picture eases back to it
    const waiting = st({ at: 300, position: 1.97, delayMs: 0, waitAt: 2.0, waiting: true, playing: true })
    let prev = shown
    for (let t = 300; t <= 900; t += 16) {
      const v = s.update(T.frameClock(waiting, t), 'w')
      assert.ok(v <= prev + 1e-12, 'eases back, never forward while held')
      prev = v
    }
    assert.ok(Math.abs(prev - 1.97) < 0.001, `eased to 1.97 within 1 ms, got ${prev}`)
  }
  {
    const s = T.createSmoother()
    assert.equal(s.update({ target: NaN }, 'a'), null)
    assert.equal(s.update(null, 'a'), null)
  }

  // ---------------------------------------------------------------- song decoder
  {
    const s = T.decodeSong({ t: 'song', id: 'x', title: 'T', artist: 'A', duration: 10, tempo: 100, keyCount: 24,
      windowStart: 48, notes: [[60, 1.0, 0.5, 1, 2, 90], [48, 0.5, 1, 0, 0, 80]] })
    assert.equal(s.id, 'x')
    assert.equal(s.keyCount, 24)
    assert.deepEqual(s.notes.map((n) => [n.pitch, n.start, n.hand]), [[48, 0.5, 'left'], [60, 1.0, 'right']])
    assert.equal(s.notes[1].finger, 2)
    assert.equal(s.notes[1].vel, 90)
  }
  {
    const good1 = [60, 0, 0.5, 1, 0, 90]
    const good2 = [62, 1, 0.5, 0, 9, 300]          // a finger and a velocity out of range: the note stays, both reset
    const bad = [
      [200, 0, 1, 1], [60, -1, 1, 1], [60, NaN, 1, 1], [60, 0, 0, 1], [60, 0, -2, 1], [60, 0, Infinity, 1],
      [60, 0, 1, 2], [60, 0, 1, 'r'], ['60', 0, 1, 1], [60, 0, 1], null, 5, 'note', {}
    ]
    const s = T.decodeSong({ t: 'song', id: 'x', duration: 5, notes: [good1, ...bad, good2] })
    assert.deepEqual(pitches(s.notes), [60, 62])
    assert.equal(s.notes[1].finger, 0)
    assert.equal(s.notes[1].vel, 100)
  }
  {
    for (const m of [null, undefined, 'song', 3, [], { t: 'state', notes: [] }, { t: 'song', notes: [] },
      { t: 'song', id: 'a', notes: [] }, { t: 'song', id: 'a', duration: 0, notes: [] },
      { t: 'song', id: 'a', duration: 5, notes: 'x' }, { t: 'song', id: {}, duration: 5, notes: [] }]) {
      assert.equal(T.decodeSong(m), null, JSON.stringify(m))
    }
    const big = { t: 'song', id: 'big', duration: 5, notes: [] }
    for (let i = 0; i < 60000; i++) big.notes.push([60 + (i % 12), i * 0.001, 0.5, i % 2])
    assert.equal(T.decodeSong(big).notes.length, 60000, 'large songs keep every note')
  }
  {
    const s = T.decodeSong({ t: 'song', id: 7, duration: 3, tempo: 999, keyCount: 7, windowStart: 200, notes: [] })
    assert.equal(s.id, '7')
    assert.equal(s.title, 'Untitled')
    assert.equal(s.artist, '')
    assert.equal(s.tempo, 120)
    assert.equal(s.keyCount, 24)
    assert.equal(s.windowStart, 60)
    assert.deepEqual(s.notes, [])
  }
  {
    // the clear message: no id, so it is not a song; the reducer drops the song instead
    assert.equal(T.isClearSong({ t: 'song', id: null }), true)
    assert.equal(T.isClearSong({ t: 'song', id: 'x' }), false)
    assert.equal(T.isClearSong({ t: 'song' }), false)
    assert.equal(T.isClearSong(null), false)
    assert.equal(T.decodeSong({ t: 'song', id: null, duration: 5, notes: [] }), null)
  }
  {
    const notes = [{ pitch: 60, start: 2, dur: 1 }, { pitch: 64, start: 2, dur: 1 }, { pitch: 67, start: 2.5, dur: 1 }]
    assert.deepEqual(pitches(T.waitGroupNotes(notes, 2, [60])), [60])
    assert.deepEqual(pitches(T.waitGroupNotes(notes, 2, [60, 64, 67])), [60, 64])
    assert.deepEqual(T.waitGroupNotes(notes, 2, null), [])
  }

  // ---------------------------------------------------------------- active and upcoming notes
  const song = T.decodeSong({ t: 'song', id: 's', duration: 10, notes: [
    [60, 1.0, 10, 1, 0, 90], [64, 1.0, 0.5, 1, 0, 90], [67, 3.0, 1, 1, 0, 90],
    [72, 3.5, 1, 1, 0, 90], [48, 6.5, 1, 0, 0, 90]] })
  {
    assert.deepEqual(pitches(T.activeNotes(song.notes, 5)), [60])          // the long note outlasts the others
    assert.deepEqual(pitches(T.activeNotes(song.notes, 1.0)), [60, 64])
    assert.deepEqual(pitches(T.activeNotes(song.notes, 1.5)), [60])        // 64 ends at 1.5, exclusive
    assert.deepEqual(pitches(T.activeNotes(song.notes, 0.5)), [])
  }
  {
    assert.deepEqual(pitches(T.upcomingNotes(song.notes, 0)), [60, 64])
    assert.deepEqual(pitches(T.upcomingNotes(song.notes, 0.9)), [60, 64])
    assert.deepEqual(pitches(T.upcomingNotes(song.notes, 1.0)), [67])      // the group at 1.0 has started
    assert.deepEqual(pitches(T.upcomingNotes(song.notes, 1.5)), [67])
    assert.deepEqual(pitches(T.upcomingNotes(song.notes, 4.4)), [])        // 2.1 s away: beyond the lead
    assert.deepEqual(pitches(T.upcomingNotes(song.notes, 4.6)), [48])
    assert.deepEqual(pitches(T.upcomingNotes(song.notes, 7)), [])
  }
  {
    const player = new Player({})
    player.load({ title: 's', notes: song.notes, duration: song.duration, tempo: song.tempo })
    for (const pos of [-1, 0, 0.5, 0.9999, 1, 1.0001, 1.5, 3, 3.5, 5, 6.5, 6.5001, 8.4, 9]) {
      sameList(T.activeNotes(song.notes, pos), player.activeNotes(pos))
      sameList(T.upcomingNotes(song.notes, pos), player.upcomingNotes(pos))
    }
  }
  {
    // random songs, with positions on and around every note edge
    const rand = rng(20261118)
    for (let k = 0; k < 8; k++) {
      const raw = []
      const count = 60 + Math.floor(rand() * 240)
      for (let i = 0; i < count; i++) {
        const start = Math.round(rand() * 30000) / 1000
        const dur = Math.round((0.05 + rand() * (k % 2 ? 8 : 1.5)) * 1000) / 1000
        raw.push([40 + Math.floor(rand() * 56), start, dur, rand() < 0.5 ? 0 : 1])
      }
      const s = T.decodeSong({ t: 'song', id: 'fuzz' + k, duration: 40, notes: raw })
      const p = new Player({})
      p.load({ title: 'fuzz', notes: s.notes, duration: 40, tempo: 120 })
      const positions = []
      for (let i = 0; i < 300; i++) positions.push(-1 + rand() * 33)
      for (const n of s.notes.slice(0, 80)) positions.push(n.start, n.start - 1e-4, n.start + 1e-4, n.start + n.dur, n.start + n.dur - 1e-4)
      for (const pos of positions) {
        sameList(T.activeNotes(s.notes, pos), p.activeNotes(pos))
        sameList(T.upcomingNotes(s.notes, pos), p.upcomingNotes(pos))
      }
    }
  }

  // ---------------------------------------------------------------- feedback and calibration flashes
  {
    // the flash keeps the time it has left when it arrives: 5000 - 4000 ms of wall time, from performance time 100 ms
    const f = T.feedbackUntil([[60, 'perfect', 5000], [64, 'good', 6000], [60, 'late', 4500], ['x', 'a', 1], [61, 'bad']],
      4000, 100)
    assert.equal(f.size, 2)
    assert.deepEqual(f.get(60), { kind: 'late', until: 600, wall: 4500 })    // the later entry wins; no delay added
    assert.deepEqual(f.get(64), { kind: 'good', until: 2100, wall: 6000 })
    assert.equal(T.feedbackUntil(null, 0, 0).size, 0)
    assert.equal(T.feedbackUntil([[60, 'perfect', 3000]], 4000, 100).size, 0)  // already expired: dropped
  }
  {
    // a repeated entry keeps its object (drawScene spawns a word once per object), within FEEDBACK_SAME_MS
    const first = T.feedbackUntil([[60, 'perfect', 5000]], 4000, 100)
    const again = T.feedbackUntil([[60, 'perfect', 5003]], 4010, 150, first)
    assert.equal(again.get(60), first.get(60))
    assert.equal(again.get(60).until, 150 + 993)                            // the object takes the newer expiry
    assert.notEqual(T.feedbackUntil([[60, 'good', 5003]], 4010, 150, first).get(60), first.get(60))   // another kind
    assert.notEqual(T.feedbackUntil([[60, 'perfect', 5020]], 4010, 150, first).get(60), first.get(60)) // a new press
  }
  {
    const c = { startAt: 1000, periodMs: 750, count: 3 }
    // flashes start at 1000, 1750, 2500 (k = 0..2); none after the last one
    const on = [1000, 1079, 1750, 1829, 2500, 2579]
    const off = [999, 1080, 1749, 1830, 2499, 2580, 2999, 3250, 3329]
    for (const t of on) assert.equal(T.flashOn(c, t), true, `on at ${t}`)
    for (const t of off) assert.equal(T.flashOn(c, t), false, `off at ${t}`)
    assert.equal(T.flashOn({ startAt: 1000, periodMs: 750, count: 0 }, 1000), false)
    assert.equal(T.flashOn(null, 1000), false)
  }
  {
    // the calm sweep: the dot is on the centre mark (x = 0.5) exactly when each old flash started, and gone outside the run
    const c = { startAt: 1000, periodMs: 750, count: 3 }
    for (const t of [1000, 1750, 2500]) assert.ok(Math.abs(T.sweepPos(c, t).x - 0.5) < 1e-9, `on the mark at ${t}`)
    assert.ok(T.sweepPos(c, 1000 - 375 - 1) === null, 'nothing before the first approach')
    assert.ok(T.sweepPos(c, 625).x < 0.01 && T.sweepPos(c, 625).fade < 0.1, 'the first approach starts at the left, faded')
    assert.ok(T.sweepPos(c, 2500 + 375) === null, 'nothing after the last crossing')
    assert.equal(T.sweepPos(null, 1000), null)
  }

  // ---------------------------------------------------------------- validators
  {
    const throwing = new Proxy({}, { get() { throw new Error('boom') } })
    const junk = [null, undefined, 0, 1, 'x', [], {}, { t: 'other' }, Object.create(null), throwing]
    for (const f of [T.validateState, T.validateKeys, T.validateScore, T.validateScreen, T.validateCalib, T.validatePrefs, T.decodeSong]) {
      for (const j of junk) assert.equal(f(j), null)
    }
  }
  {
    const state = { t: 'state', at: 1700000000000, position: 12.5, rate: 1, playing: true, waiting: false,
      needPitches: [60, 64, 'x', 200, 60], countInStart: 0, countInUntil: 0, countInBeats: 0, rev: 3, waitAt: 13.0,
      end: 20, loop: null, handFilter: 'left', view: 'CLASSIC', noteLabels: 'names', windowStart: 48, delayMs: 160, waitMode: true }
    const v = T.validateState(state)
    assert.deepEqual(v.needPitches, [60, 64])
    assert.equal(v.delayMs, 160)
    assert.equal(v.handFilter, 'left')
    assert.equal(v.waitMode, true)
    assert.equal(v.rev, 3)
    assert.equal(v.waitAt, 13.0)
    assert.equal(v.end, 20)
    assert.equal(v.at, 1700000000000)
    // wire times are used as they arrive: no seconds-to-ms guessing, so a seconds value is kept as it is
    assert.equal(T.validateState({ ...state, at: 1700000000 }).at, 1700000000)
    assert.equal(T.validateState({ ...state, delayMs: 9999 }).delayMs, 600)
    assert.equal(T.validateState({ ...state, loop: { a: 1, b: 2, on: false } }).loop, null)
    assert.equal(T.validateState({ ...state, waitAt: null, end: undefined, rev: undefined }).waitAt, null)
    const counted = T.validateState({ ...state, countInStart: 1700000000000, countInUntil: 1700000002000, countInBeats: 2 })
    assert.deepEqual([counted.countInStartMs, counted.countInUntilMs, counted.countInBeats], [1700000000000, 1700000002000, 2])
    for (const bad of [{ position: -1 }, { playing: 'yes' }, { rate: 0 }, { rate: 5 }, { delayMs: 'x' },
      { view: 'WEIRD' }, { loop: { a: 5, b: 3 } }, { loop: { a: -1, b: 3 } }, { windowStart: 300 },
      { waitMode: 1 }, { at: 'now' }, { at: -1 }, { waitAt: -1 }, { waitAt: 'x' }, { end: 'x' }, { end: -2 },
      { countInBeats: 99 }, { countInBeats: 1.5 }, { rev: -1 }, { rev: 1.5 }, { countInUntil: -5 }, { countInStart: 'x' }]) {
      assert.equal(T.validateState({ ...state, ...bad }), null, JSON.stringify(bad))
    }
  }
  {
    const k = T.validateKeys({ t: 'keys', held: [60, 'a', 61, 61, 200],
      feedback: [[60, 'perfect', 1700000000000], [61, '', 5], [62, 'good', 'x'], [63, 'late', 1700000000500], [64, 'good', -1]] })
    assert.deepEqual(k.held, [60, 61])
    assert.deepEqual(k.feedback, [[60, 'perfect', 1700000000000], [63, 'late', 1700000000500]])
    assert.equal(T.validateKeys({ t: 'keys' }), null)
    assert.equal(T.validateKeys({ t: 'keys', held: [], feedback: 'x' }), null)
  }
  {
    assert.deepEqual(T.validateScore({ t: 'score', accuracy: 0.93, streak: 12, hits: 40, misses: 3 }),
      { accuracy: 0.93, streak: 12, hits: 40, misses: 3 })
    // accuracy is a 0..1 fraction on the wire: a percentage is not guessed at
    assert.equal(T.validateScore({ t: 'score', accuracy: 93, streak: 0, hits: 0, misses: 0 }), null)
    for (const bad of [{ accuracy: 1.5 }, { accuracy: -1 }, { streak: -1 }, { hits: 1.5 }]) {
      assert.equal(T.validateScore({ t: 'score', accuracy: 0.5, streak: 0, hits: 0, misses: 0, ...bad }), null, JSON.stringify(bad))
    }
  }
  {
    const s = T.validateScreen({ t: 'screen', name: 'play', song: { title: 'Fur Elise', artist: 'Beethoven' } })
    assert.deepEqual(s.song, { title: 'Fur Elise', artist: 'Beethoven' })
    const r = T.validateScreen({ t: 'screen', name: 'results',
      results: { stars: 4, accuracy: 0.94, longestStreak: 21, hits: 62, misses: 3, best: true } })
    assert.deepEqual(r.results, { stars: 4, accuracy: 0.94, longestStreak: 21, hits: 62, misses: 3, best: true })
    for (const bad of [{ name: 'menu' }, { song: 5 }, { results: { stars: 6, accuracy: 0.5, longestStreak: 0, hits: 0, misses: 0, best: false } },
      { results: { stars: 2, best: 'yes' } }, { results: { stars: 2, accuracy: 94 } }]) {
      assert.equal(T.validateScreen({ t: 'screen', name: 'play', ...bad }), null, JSON.stringify(bad))
    }
  }
  {
    assert.deepEqual(T.validateCalib({ t: 'calib', startAt: 1700000000000, periodMs: 1400, count: 14 }),
      { startAt: 1700000000000, periodMs: 1400, count: 14 })
    assert.equal(T.validateCalib({ t: 'calib', startAt: 1700000000000, periodMs: 10, count: 14 }), null)
    assert.equal(T.validateCalib({ t: 'calib', startAt: 1700000000000, periodMs: 1400, count: 0 }), null)
    assert.equal(T.validateCalib({ t: 'calib', startAt: -5, periodMs: 1400, count: 14 }), null)
    assert.deepEqual(T.validatePrefs({ t: 'prefs' }), { showNames: true, theme: 'dark' })
    assert.equal(T.validatePrefs({ t: 'prefs', showNames: 'no' }), null)
  }

  // ---------------------------------------------------------------- reducer
  {
    const m = T.createTVModel()
    const clock = { wallMs: 1700000000000, perfMs: 500 }
    const songMsg = { t: 'song', id: 'a', title: 'A', duration: 10, notes: [[60, 1, 0.5, 1]] }
    assert.equal(T.applyTVMessage(m, songMsg, clock), 'song')
    assert.equal(m.song.id, 'a')
    assert.equal(T.applyTVMessage(m, { t: 'state', at: clock.wallMs, position: 0, playing: false, waiting: false, rev: 4 }, clock), 'state')
    assert.equal(m.state.duration, 10)
    assert.equal(m.key, 'a|4|')
    T.applyTVMessage(m, { t: 'state', at: clock.wallMs, position: 0, playing: true, waiting: false, rev: 4, loop: { a: 1, b: 2 } }, clock)
    assert.equal(m.key, 'a|4|1-2')                                          // a loop changes the key
    T.applyTVMessage(m, { t: 'score', accuracy: 0.5, streak: 1, hits: 1, misses: 1 }, clock)
    assert.equal(m.score.accuracy, 0.5)
    T.applyTVMessage(m, { t: 'keys', held: [60], feedback: [[60, 'perfect', clock.wallMs + 260]] }, clock)
    assert.deepEqual([...m.held], [60])
    assert.equal(m.feedback.get(60).until, 760)
    assert.equal(T.applyTVMessage(m, { t: 'song', id: null }, clock), 'song')   // the Playground: the song goes
    assert.deepEqual([m.song, m.state, m.score, m.key], [null, null, null, ''])
    assert.equal(m.feedback.size, 0)
    assert.equal(T.applyTVMessage(m, { t: 'state', at: 'x' }, clock), null)
    assert.equal(T.applyTVMessage(m, { t: 'nope' }, clock), null)
    assert.equal(T.applyTVMessage(m, null, clock), null)
    // a new song drops the old state, the score and the keys; the same song keeps them
    T.applyTVMessage(m, songMsg, clock)
    T.applyTVMessage(m, { t: 'state', at: clock.wallMs, position: 0, playing: false, waiting: false }, clock)
    T.applyTVMessage(m, { t: 'score', accuracy: 0.5, streak: 1, hits: 1, misses: 1 }, clock)
    T.applyTVMessage(m, { ...songMsg, notes: [[61, 1, 0.5, 1]] }, clock)
    assert.ok(m.state !== null && m.score !== null, 'same song id keeps the state and score')
    T.applyTVMessage(m, { ...songMsg, id: 'b' }, clock)
    assert.deepEqual([m.state, m.score], [null, null])
    assert.equal(T.waitNotesOf(m).length, 0)
  }
}

main().then(
  () => process.stdout.write('tv-sync: ok\n'),
  (e) => { process.stderr.write(String((e && e.stack) || e) + '\n'); process.exit(1) }
)
