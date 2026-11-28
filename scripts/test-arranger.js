// Arranger invariants, real spike MIDI checks, and cover backup/import validation.
// Run: node scripts/test-arranger.js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { pathToFileURL } = require('node:url')

const load = (rel) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', rel)).href)

const KEY_RANGES = [
  { name: '24-key', lo: 48, hi: 71 },
  { name: '48-key', lo: 36, hi: 83 },
  { name: '61-key', lo: 36, hi: 96 },
  { name: '88-key', lo: 21, hi: 108 }
]
const SPIKE_MIDI_DIR = process.env.KEYLIGHT_COVER_SPIKE_MIDI_DIR

function groupByOnset(notes, gap = 0.03) {
  const sorted = notes.slice().sort((a, b) => a.start - b.start || a.pitch - b.pitch)
  const groups = []
  for (const n of sorted) {
    const last = groups[groups.length - 1]
    if (last && n.start - last.start <= gap + 1e-9) last.notes.push(n)
    else groups.push({ start: n.start, notes: [n] })
  }
  return groups
}

function countSamePitchRepeats(notes) {
  const sorted = notes.slice().sort((a, b) => a.start - b.start || a.pitch - b.pitch)
  const last = new Map()
  let count = 0
  for (const n of sorted) {
    const prev = last.get(n.pitch)
    if (prev && n.start >= prev.start + prev.dur - 0.02 && n.start - (prev.start + prev.dur) <= 0.15) count++
    last.set(n.pitch, n)
  }
  return count
}

function assertInvariants(out, { difficulty, keyRange, rawStarts }) {
  for (const n of out) {
    assert.ok(Number.isInteger(n.pitch), 'integer pitch')
    assert.ok(n.pitch >= keyRange.lo && n.pitch <= keyRange.hi, `pitch ${n.pitch} inside [${keyRange.lo}, ${keyRange.hi}]`)
    assert.ok(Number.isFinite(n.start) && n.start >= 0, 'valid start')
    assert.ok(Number.isFinite(n.dur) && n.dur >= 0.08 - 1e-9, `dur ${n.dur} >= 80 ms`)
    assert.ok(Number.isInteger(n.vel) && n.vel >= 1 && n.vel <= 127, 'valid velocity')
    assert.ok(n.hand === 'left' || n.hand === 'right', 'valid hand')
    assert.equal('finger' in n, false, '.finger must be stripped')
    if (rawStarts) assert.ok(rawStarts.has(Math.round(n.start * 1e6)), 'onset preserved without snapping')
  }

  for (const hand of ['right', 'left']) {
    const handNotes = out.filter((n) => n.hand === hand)
    const groups = groupByOnset(handNotes, 0.03)
    let prevLhStart = -Infinity
    for (const g of groups) {
      const pitches = g.notes.map((n) => n.pitch)
      const span = Math.max(...pitches) - Math.min(...pitches)
      assert.ok(span <= 12, `${difficulty} ${hand} chord span ${span} <= 12`)
      if (difficulty === 'easy') {
        assert.ok(g.notes.length <= 1, `easy ${hand} has <= 1 note per onset group (got ${g.notes.length})`)
        if (hand === 'left') {
          assert.ok(g.start - prevLhStart >= 0.25 - 1e-5, `easy LH gap ${g.start - prevLhStart} >= 0.25 s`)
          prevLhStart = g.start
        }
      } else if (difficulty === 'medium') {
        assert.ok(g.notes.length <= 2, `medium ${hand} has <= 2 notes per onset group (got ${g.notes.length})`)
      }
    }
  }

  const right = out.filter((n) => n.hand === 'right')
  const left = out.filter((n) => n.hand === 'left')
  const byPitch = new Map()
  for (const n of right) {
    if (!byPitch.has(n.pitch)) byPitch.set(n.pitch, [])
    byPitch.get(n.pitch).push(n)
  }
  for (const n of left) {
    for (const r of byPitch.get(n.pitch) || []) {
      if (r.start >= n.start + n.dur) break
      const overlap = Math.min(n.start + n.dur, r.start + r.dur) - Math.max(n.start, r.start)
      assert.ok(overlap <= 0.02 + 1e-9, `hands overlap on ${n.pitch} by ${overlap} s`)
    }
  }
  const phrases = []
  let previous
  for (const g of groupByOnset(right)) {
    const low = Math.min(...g.notes.map((n) => n.pitch))
    const high = Math.max(...g.notes.map((n) => n.pitch))
    const end = Math.max(...g.notes.map((n) => n.start + n.dur))
    if (!previous || g.start - previous.end >= 0.35 || Math.abs(high - previous.high) >= 12) {
      phrases.push({ start: g.start, low })
    } else {
      phrases.at(-1).low = Math.min(phrases.at(-1).low, low)
    }
    previous = { end, high }
  }
  let phrase = 0
  for (const n of left) {
    while (phrases[phrase + 1]?.start <= n.start) phrase++
    if (phrases.length) assert.ok(n.pitch < phrases[phrase].low, `LH ${n.pitch} below RH phrase floor ${phrases[phrase].low}`)
  }

  if (difficulty === 'easy') {
    for (const g of groupByOnset(out, 0.03)) {
      const rhCount = g.notes.filter((n) => n.hand === 'right').length
      const lhCount = g.notes.filter((n) => n.hand === 'left').length
      assert.ok(rhCount <= 1 && lhCount <= 1, `easy joint onset group has <= 1 RH + 1 LH (got ${rhCount} RH, ${lhCount} LH)`)
    }
  }
}

;(async () => {
  const { arrange, cleanCoverNotes, DIFFICULTIES } = await load('arranger.js')
  const { parseMidi } = await load('smf.js')
  const { normalise } = await load('songloader.js')
  const { assignFingering } = await load('fingering.js')
  const { checkNotes } = await load('editor-model.js')
  const { cleanCoverRaw, cleanCoverArrangement } = await load('importer.js')
  const { createBackup, readBackup, MAGIC, VERSION } = await load('backup-format.js')

  let passed = 0
  const check = async (label, fn) => {
    await fn()
    passed++
    process.stdout.write('ok ' + label + '\n')
  }

  await check('drops <80 ms blips, merges true overlaps, preserves zero-gap repeats', () => {
    const raw = [
      { pitch: 72, start: 0.0, dur: 0.05 },    // blip: dropped
      { pitch: 72, start: 0.0, dur: 0.079 },   // blip: dropped
      { pitch: 64, start: 0.5, dur: 0.20 },    // repeat 1
      { pitch: 64, start: 0.7, dur: 0.20 },    // zero-gap repeat 2 (start == prev.end)
      { pitch: 64, start: 0.9, dur: 0.20 },    // zero-gap repeat 3
      { pitch: 64, start: 1.09, dur: 0.20 },   // 10 ms legato touch (prev.end - 0.01): kept
      { pitch: 67, start: 2.0, dur: 0.40 },    // base note
      { pitch: 67, start: 2.1, dur: 0.50 },    // true overlap (start < prev.end - 0.02): merged
      { pitch: 10, start: 3.0, dur: 0.30 },    // below A0: dropped
      { pitch: 120, start: 3.0, dur: 0.30 }    // above C8: dropped
    ]
    const cleaned = cleanCoverNotes(raw)
    const e4 = cleaned.filter((n) => n.pitch === 64)
    const g4 = cleaned.filter((n) => n.pitch === 67)
    assert.equal(cleaned.filter((n) => n.pitch === 72).length, 0)
    assert.equal(e4.length, 4, 'all 4 repeated melody notes kept')
    assert.equal(g4.length, 1, 'true overlap merged into 1 note')
    assert.ok(Math.abs(g4[0].dur - 0.6) < 1e-6)
  })

  await check('repeated melody notes preserved while left-hand chugging is suppressed', () => {
    const fixture = []
    // Repeated top melody: 8 consecutive C5 notes, zero gap, 0.15 s each (7 repeats).
    for (let i = 0; i < 8; i++) {
      fixture.push({ pitch: 72, start: i * 0.15, dur: 0.15, finger: 3 })
    }
    // Rapid left-hand chugging chord C3+G3 every 0.15 s underneath.
    for (let i = 0; i < 8; i++) {
      fixture.push({ pitch: 48, start: i * 0.15, dur: 0.15, finger: 5 })
      fixture.push({ pitch: 55, start: i * 0.15, dur: 0.15, finger: 1 })
    }
    const rawMelRepeats = countSamePitchRepeats(fixture.filter((n) => n.pitch === 72))
    assert.equal(rawMelRepeats, 7)

    for (const difficulty of DIFFICULTIES) {
      const out = arrange(fixture, { difficulty, keyRange: { lo: 21, hi: 108 } })
      const rhTop = out.filter((n) => n.hand === 'right' && n.pitch === 72)
      const lh = out.filter((n) => n.hand === 'left')
      assert.equal(rhTop.length, 8, `${difficulty}: all 8 repeated melody notes kept`)
      assert.equal(countSamePitchRepeats(rhTop), rawMelRepeats, `${difficulty}: melody repeat count preserved`)
      const lhGroups = groupByOnset(lh, 0.03)
      assert.ok(lhGroups.length < 8, `${difficulty}: left-hand chugging reduced from 8 groups to ${lhGroups.length}`)
      assertInvariants(out, { difficulty, keyRange: { lo: 21, hi: 108 } })
    }
  })

  await check('onset clustering <= 0.03 s keeps 50 ms quantized steps separate', () => {
    const raw = [
      { pitch: 64, start: 0.00, dur: 0.20 },
      { pitch: 67, start: 0.05, dur: 0.20 },   // 50 ms later: must NOT cluster into 0.00
      { pitch: 72, start: 0.10, dur: 0.20 }
    ]
    const easy = arrange(raw, { difficulty: 'easy', keyRange: { lo: 21, hi: 108 } })
    assert.deepEqual(easy.map((n) => n.pitch), [64, 67, 72])
    assert.deepEqual(easy.map((n) => n.start), [0.00, 0.05, 0.10])
  })

  await check('phrase-level transposition prevents mid-phrase octave wraps on 24/48/61/88 keys', () => {
    // Melody phrase crossing B4/C5 boundary (would wrap violently under per-note folding on 24-key C3..B4).
    const phrase1 = [67, 69, 71, 72, 74, 72, 71, 69].map((pitch, i) => ({ pitch, start: i * 0.25, dur: 0.24 }))
    // Second phrase after a 1 s rest in a lower register that still fits shifted or unshifted.
    const phrase2 = [67, 69, 71, 69, 67].map((pitch, i) => ({ pitch, start: 3.0 + i * 0.25, dur: 0.24 }))
    const bass = [
      { pitch: 36, start: 0.0, dur: 0.9 },
      { pitch: 43, start: 1.0, dur: 0.9 },
      { pitch: 36, start: 3.0, dur: 0.9 }
    ]
    const raw = [...phrase1, ...phrase2, ...bass]

    for (const kr of KEY_RANGES) {
      const out = arrange(raw, { difficulty: 'easy', keyRange: kr })
      assertInvariants(out, { difficulty: 'easy', keyRange: kr })
      const rh = out.filter((n) => n.hand === 'right' && n.start < 2.5)
      assert.equal(rh.length, phrase1.length, `${kr.name}: all phrase 1 notes kept`)
      // Consecutive intervals inside phrase 1 must match the original intervals exactly (zero octave wrap).
      for (let i = 1; i < rh.length; i++) {
        const origDiff = phrase1[i].pitch - phrase1[i - 1].pitch
        const gotDiff = rh[i].pitch - rh[i - 1].pitch
        assert.equal(gotDiff, origDiff, `${kr.name}: interval preserved at step ${i} (${gotDiff} vs ${origDiff})`)
      }
    }
  })

  await check('velocity shaped by role, .finger stripped, normalise + assignFingering + checkNotes pass', () => {
    const raw = [
      { pitch: 48, start: 0.0, dur: 0.5, vel: 80, finger: 2 },
      { pitch: 55, start: 0.0, dur: 0.5, vel: 80, finger: 1 },
      { pitch: 64, start: 0.0, dur: 0.5, vel: 80, finger: 1 },
      { pitch: 72, start: 0.0, dur: 0.5, vel: 80, finger: 5 },
      { pitch: 74, start: 0.5, dur: 0.5, vel: 80, finger: 4 }
    ]
    const out = arrange(raw, { difficulty: 'medium', keyRange: { lo: 21, hi: 108 } })
    const mel = out.filter((n) => n.hand === 'right' && (n.pitch === 72 || n.pitch === 74))
    const acc = out.filter((n) => !(n.hand === 'right' && (n.pitch === 72 || n.pitch === 74)))
    assert.ok(mel.length === 2 && acc.length > 0)
    const minMelVel = Math.min(...mel.map((n) => n.vel))
    const maxAccVel = Math.max(...acc.map((n) => n.vel))
    assert.ok(minMelVel > maxAccVel, `melody vel (${minMelVel}) louder than accompaniment (${maxAccVel})`)
    assert.ok(out.every((n) => !('finger' in n)), '.finger stripped before normalise')

    const song = normalise('Test Cover', { notes: out, tempo: 120 })
    assert.equal(song.notes.length, out.length)
    assert.ok(song.notes.every((n) => Number.isInteger(n.finger) && n.finger >= 1 && n.finger <= 5))
    const checked = checkNotes(song.notes)
    assert.equal(checked.error, undefined)

    // Re-arranging with existing fingers still strips them and lets assignFingering recompute cleanly.
    const reArranged = arrange(song.notes, { difficulty: 'easy', keyRange: { lo: 48, hi: 71 } })
    assert.ok(reArranged.every((n) => !('finger' in n)))
    assignFingering(reArranged, { tempo: 120 })
    assert.ok(reArranged.every((n) => Number.isInteger(n.finger) && n.finger >= 1 && n.finger <= 5))
  })

  await check('deterministic output and <50 ms runtime on 2,000 notes', () => {
    const big = []
    for (let i = 0; i < 500; i++) {
      const t = i * 0.25
      big.push({ pitch: 36 + (i % 12), start: t, dur: 0.22 })
      big.push({ pitch: 43 + (i % 12), start: t, dur: 0.22 })
      big.push({ pitch: 60 + ((i * 2) % 14), start: t, dur: 0.22 })
      big.push({ pitch: 67 + ((i * 3) % 16), start: t, dur: 0.22 })
    }
    assert.equal(big.length, 2000)

    // Warm JIT once, then measure.
    arrange(big, { difficulty: 'medium', keyRange: { lo: 48, hi: 71 } })
    const t0 = performance.now()
    const run1 = arrange(big, { difficulty: 'medium', keyRange: { lo: 48, hi: 71 } })
    const elapsed = performance.now() - t0
    const run2 = arrange(big, { difficulty: 'medium', keyRange: { lo: 48, hi: 71 } })
    assert.deepEqual(run1, run2, 'identical runs produce identical output')
    assert.ok(elapsed < 50, `2,000-note arrange took ${elapsed.toFixed(2)} ms (target < 50 ms)`)
    process.stdout.write(`  (2,000-note arrange: ${elapsed.toFixed(2)} ms)\n`)
  })

  await check('arranges a dense 20-minute song on 24 keys', () => {
    const raw = []
    for (let i = 0; i < 4800; i++) {
      const t = i * 0.25
      const step = i % 12
      const top = 71 + Math.min(step, 12 - step)
      for (const pitch of [31 + i % 13, top - 12, top]) raw.push({ pitch, start: t, dur: 0.25 })
    }
    const opts = { difficulty: 'full', keyRange: KEY_RANGES[0] }
    arrange(raw, opts)
    const t0 = performance.now()
    const out = arrange(raw, opts)
    const ms = performance.now() - t0
    assertInvariants(out, opts)
    assert.ok(out.length >= 4800, 'melody survives arrangement')
    assert.ok(ms < 200, `dense arrange took ${ms.toFixed(2)} ms (target < 200 ms)`)
    console.log(`  (${raw.length} notes over 20 minutes: ${ms.toFixed(2)} ms)`)
  })

  const spikeFiles = SPIKE_MIDI_DIR && fs.existsSync(SPIKE_MIDI_DIR)
    ? fs.readdirSync(SPIKE_MIDI_DIR).filter((f) => f.endsWith('.mid')).sort().map((f) => path.join(SPIKE_MIDI_DIR, f))
    : []
  if (!spikeFiles.length) console.log('skipped: spike MIDIs not found')
  const fixture = path.join(__dirname, 'fixtures', 'cover-pop-intermediate.mid')
  await check('MIDI fixture and available spike MIDIs pass invariants across all difficulties and ranges', () => {
    const files = [fixture, ...spikeFiles]
    let maxMs = 0
    let worstCase = ''
    for (const source of files) {
      const file = path.basename(source)
      const buf = fs.readFileSync(source)
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      const parsed = parseMidi(ab)
      const rawStarts = new Set(parsed.notes.map((n) => Math.round(Math.max(0, n.start) * 1e6)))

      for (const difficulty of DIFFICULTIES) {
        for (const kr of KEY_RANGES) {
          const t0 = performance.now()
          const out = arrange(parsed.notes, { difficulty, keyRange: kr })
          const ms = performance.now() - t0
          if (ms > maxMs) { maxMs = ms; worstCase = `${file} ${difficulty} ${kr.name}` }
          assert.ok(out.length > 0, `${file} ${difficulty} ${kr.name} produced notes`)
          assertInvariants(out, { difficulty, keyRange: kr, rawStarts })
          if (parsed.notes.length <= 2100) {
            assert.ok(ms < 50, `${file} (${parsed.notes.length} notes) ${difficulty} ${kr.name}: ${ms.toFixed(1)} ms < 50 ms`)
          }
        }
      }
      // Determinism + normalise integration on each MIDI at easy/24-key.
      const a = arrange(parsed.notes, { difficulty: 'easy', keyRange: { lo: 48, hi: 71 } })
      const b = arrange(parsed.notes, { difficulty: 'easy', keyRange: { lo: 48, hi: 71 } })
      assert.deepEqual(a, b, `${file}: deterministic`)
      const song = normalise(file, { notes: a, tempo: parsed.tempo })
      assert.equal(checkNotes(song.notes).error, undefined, `${file}: checkNotes ok`)
    }
    process.stdout.write(`  (verified ${files.length} MIDIs (${spikeFiles.length} spike + 1 fixture) x ${DIFFICULTIES.length} difficulties x ${KEY_RANGES.length} ranges; max ${maxMs.toFixed(2)} ms on ${worstCase})\n`)
  })

  await check('importer and backup-format validate and round-trip coverRaw and coverArrangement', async () => {
    const raw = [{ pitch: 60, start: 0.5, dur: 0.25 }, { pitch: 48, start: 0, dur: 0.5 }]
    const arr = { difficulty: 'easy', keyRange: { lo: 48, hi: 71 } }

    assert.deepEqual(cleanCoverRaw(raw), [{ pitch: 48, start: 0, dur: 0.5 }, { pitch: 60, start: 0.5, dur: 0.25 }])
    assert.equal(cleanCoverRaw([]), null)
    assert.equal(cleanCoverRaw([{ pitch: 128, start: 0, dur: 0.2 }]), null)
    assert.equal(cleanCoverRaw([{ pitch: 60, start: 0, dur: 0.01 }]), null)
    assert.deepEqual(cleanCoverArrangement(arr), arr)
    assert.equal(cleanCoverArrangement({ difficulty: 'expert', keyRange: { lo: 48, hi: 71 } }), null)
    assert.equal(cleanCoverArrangement({ difficulty: 'easy', keyRange: { lo: 72, hi: 48 } }), null)

    const arranged = arrange(raw, arr)
    const storage = { length: 0, key: () => null, getItem: () => null }
    const song = {
      id: 'imp-cover1', title: 'Cover', artist: 'A', album: '', duration: 2, tempo: 120,
      notes: arranged, coverRaw: raw, coverArrangement: arr, source: 'audio', added: 1700000000000
    }
    const legacy = {
      id: 'imp-old1', title: 'Legacy', artist: 'B', album: '', duration: 2, tempo: 120,
      notes: arranged, source: 'score', added: 1700000000000
    }
    const made = await createBackup({ songs: [song, legacy], storage, now: new Date(2026, 10, 26, 12, 0) })
    assert.deepEqual(made.skipped, [])
    const plan = await readBackup(new File([made.blob], 'b.keylightbackup'))
    assert.deepEqual(plan.songs[0].coverRaw, cleanCoverRaw(raw))
    assert.deepEqual(plan.songs[0].coverArrangement, arr)
    assert.equal(plan.songs[1].coverRaw, null)
    assert.equal(plan.songs[1].coverArrangement, null)
    assert.equal(plan.songs[1].coverModelDifficulty, null)

    const forge = (songs) => {
      const manifest = { format: 'keylight-backup', version: VERSION, created: new Date().toISOString(), songs, storage: {} }
      const body = new TextEncoder().encode(JSON.stringify(manifest))
      const head = new Uint8Array(MAGIC.length + 4)
      head.set(new TextEncoder().encode(MAGIC))
      new DataView(head.buffer).setUint32(MAGIC.length, body.length, true)
      return new File([head, body], 'bad.keylightbackup')
    }
    await assert.rejects(readBackup(forge([{ ...song, coverModelDifficulty: 'nope' }])), /model difficulty/)
    await assert.rejects(readBackup(forge([{ ...song, coverRaw: [] }])), /cover notes/)
    await assert.rejects(readBackup(forge([{ ...song, coverRaw: [{ pitch: 60, start: -1, dur: 0.2 }] }])), /cover note 1/)
    await assert.rejects(readBackup(forge([{ ...song, coverArrangement: { difficulty: 'nope', keyRange: { lo: 48, hi: 71 } } }])), /cover arrangement/)
    await assert.rejects(readBackup(forge([{ ...song, coverArrangement: { difficulty: 'easy', keyRange: { lo: 80, hi: 40 } } }])), /key range/)
  })

  console.log(`test-arranger: ok (${passed} checks)`)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
