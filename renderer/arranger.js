// Pure piano arranger for raw transcription notes (no DOM; works in Node and browser).
// Outputs [{ pitch, start, dur, vel, hand }] without .finger so songloader.normalise()
// and assignFingering() can compute fresh fingerings on the arranged part.

export const DIFFICULTIES = Object.freeze(['easy', 'medium', 'full'])
export const DEFAULT_KEY_RANGE = Object.freeze({ lo: 21, hi: 108 })

export const MIN_DUR = 0.08
const OVERLAP_EPS = 0.02
const ONSET_CLUSTER_GAP = 0.03
const MAX_HAND_SPAN = 12
const EASY_LH_MIN_GAP = 0.25
const CHUG_MAX_IOI = 0.36
const CHUG_MAX_GAP = 0.10
const CHUG_MIN_RUN = 3
const PHRASE_REST = 0.35
const PHRASE_LEAP = 12
const MIN_PIANO_PITCH = 21
const MAX_PIANO_PITCH = 108

const VEL_RH_MELODY = 96
const VEL_RH_MELODY_ACCENT = 100
const VEL_RH_HARMONY = 70
const VEL_LH_ROOT = 74
const VEL_LH_ROOT_ACCENT = 78
const VEL_LH_INNER = 62

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

function resolveRange(keyRange) {
  if (!keyRange || typeof keyRange !== 'object') return DEFAULT_KEY_RANGE
  const lo = Math.round(Number(keyRange.lo))
  const hi = Math.round(Number(keyRange.hi))
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi > 127 || lo > hi) return DEFAULT_KEY_RANGE
  return { lo, hi }
}

function resolveDifficulty(difficulty) {
  return DIFFICULTIES.includes(difficulty) ? difficulty : 'medium'
}

// Drop <80 ms blips and out-of-piano pitches, then merge only true same-pitch overlaps.
// Zero-gap repeats (Music2MIDI quantises to 50 ms) are real melody and stay separate.
export function cleanCoverNotes(rawNotes) {
  if (!Array.isArray(rawNotes) || !rawNotes.length) return []
  const cleaned = []
  for (const n of rawNotes) {
    if (!n || typeof n !== 'object') continue
    const pitch = Math.round(Number(n.pitch))
    const rawStart = Number(n.start)
    if (!Number.isInteger(pitch) || pitch < MIN_PIANO_PITCH || pitch > MAX_PIANO_PITCH) continue
    if (!isNum(rawStart) || rawStart < -0.001) continue
    const start = Math.max(0, rawStart)
    const dur = isNum(n.dur) ? n.dur : (isNum(n.end) ? n.end - rawStart : 0)
    if (!isNum(dur) || dur < MIN_DUR) continue
    cleaned.push({ pitch, start, dur })
  }
  cleaned.sort((a, b) => a.start - b.start || a.pitch - b.pitch || b.dur - a.dur)
  return mergeTrueOverlaps(cleaned)
}

function mergeTrueOverlaps(notes) {
  const out = []
  const lastByPitch = new Map()
  for (const n of notes) {
    const prev = lastByPitch.get(n.pitch)
    if (prev && n.start < prev.start + prev.dur - OVERLAP_EPS) {
      prev.dur = Math.max(prev.dur, n.start + n.dur - prev.start)
      continue
    }
    const copy = { pitch: n.pitch, start: n.start, dur: n.dur }
    out.push(copy)
    lastByPitch.set(n.pitch, copy)
  }
  return out
}

// Anchor each cluster to its first note so arpeggios never chain past 30 ms.
function clusterOnsets(notes, gap = ONSET_CLUSTER_GAP) {
  const clusters = []
  for (const n of notes) {
    const last = clusters[clusters.length - 1]
    if (last && n.start - last.start <= gap + 1e-9) {
      last.notes.push(n)
    } else {
      clusters.push({ start: n.start, notes: [n] })
    }
  }
  return clusters
}

function assignHandsViterbi(clusters) {
  if (!clusters.length) return []
  const statesPerStep = clusters.map((cl) => {
    const ns = cl.notes.slice().sort((a, b) => a.pitch - b.pitch)
    const m = ns.length
    const cands = []
    for (let k = 0; k <= m; k++) {
      const lh = ns.slice(0, k)
      const rh = ns.slice(k)
      let emit = 0
      let lhCenter = null
      let rhCenter = null
      if (lh.length) {
        const spanL = lh[lh.length - 1].pitch - lh[0].pitch
        if (spanL > MAX_HAND_SPAN) emit += 50 + 8 * (spanL - MAX_HAND_SPAN)
        else if (spanL > 9) emit += 0.6 * (spanL - 9)
        if (lh.length > 4) emit += 12 * (lh.length - 4)
        let sum = 0
        for (const x of lh) {
          sum += x.pitch
          if (x.pitch >= 64) emit += 3 * (x.pitch - 63)
          else if (x.pitch >= 60) emit += 0.6 * (x.pitch - 59)
        }
        lhCenter = sum / lh.length
      }
      if (rh.length) {
        const spanR = rh[rh.length - 1].pitch - rh[0].pitch
        if (spanR > MAX_HAND_SPAN) emit += 50 + 8 * (spanR - MAX_HAND_SPAN)
        else if (spanR > 9) emit += 0.6 * (spanR - 9)
        if (rh.length > 4) emit += 12 * (rh.length - 4)
        let sum = 0
        for (const x of rh) {
          sum += x.pitch
          if (x.pitch < 55) emit += 4 * (55 - x.pitch)
          else if (x.pitch < 60) emit += 0.6 * (60 - x.pitch)
        }
        rhCenter = sum / rh.length
      }
      // Keep treble top melody in the right hand; allow low bass chords (< C4) to stay in the left hand.
      if (m >= 2 && k === m && ns[m - 1].pitch >= 60) emit += 18
      else if (m === 1 && k === 1 && ns[0].pitch >= 60) emit += 1.5
      cands.push({
        lh,
        rh,
        emit,
        lhCenter,
        rhCenter,
        lhMax: lh.length ? lh[lh.length - 1].pitch : null,
        rhMin: rh.length ? rh[0].pitch : null
      })
    }
    return cands
  })

  let dp = statesPerStep[0].map((c) => c.emit)
  const back = [null]
  for (let t = 1; t < statesPerStep.length; t++) {
    const dt = Math.max(clusters[t].start - clusters[t - 1].start, 0.05)
    const timeScale = Math.min(1, 0.5 / dt)
    const prev = statesPerStep[t - 1]
    const cur = statesPerStep[t]
    const nextDp = new Array(cur.length)
    const from = new Array(cur.length)
    for (let j = 0; j < cur.length; j++) {
      const cj = cur[j]
      let best = Infinity
      let bestI = 0
      for (let i = 0; i < prev.length; i++) {
        const ci = prev[i]
        let trans = 0
        if (ci.lhCenter !== null && cj.lhCenter !== null) {
          const jump = Math.abs(cj.lhCenter - ci.lhCenter)
          if (jump > 12) trans += (jump - 12) * 1.4 * (0.5 + timeScale)
          else if (jump > 9) trans += (jump - 9) * 0.4 * (0.5 + timeScale)
        }
        if (ci.rhCenter !== null && cj.rhCenter !== null) {
          const jump = Math.abs(cj.rhCenter - ci.rhCenter)
          if (jump > 9) trans += (jump - 9) * 1.2 * (0.5 + timeScale)
        }
        if (cj.lhMax !== null && ci.rhMin !== null && cj.lhMax >= ci.rhMin) {
          trans += (12 + 2 * (cj.lhMax - ci.rhMin)) * timeScale
        }
        if (cj.rhMin !== null && ci.lhMax !== null && cj.rhMin <= ci.lhMax) {
          trans += (12 + 2 * (ci.lhMax - cj.rhMin)) * timeScale
        }
        if (dt < 0.6 && ci.rhCenter !== null && cj.rhCenter === null && cj.lhMax !== null && Math.abs(cj.lhMax - ci.rhCenter) <= 5) {
          trans += 4 * timeScale
        }
        const val = dp[i] + trans + cj.emit
        if (val < best) {
          best = val
          bestI = i
        }
      }
      nextDp[j] = best
      from[j] = bestI
    }
    dp = nextDp
    back.push(from)
  }

  let pick = 0
  for (let i = 1; i < dp.length; i++) if (dp[i] < dp[pick]) pick = i
  const chosen = new Array(statesPerStep.length)
  for (let t = statesPerStep.length - 1; t >= 0; t--) {
    chosen[t] = pick
    if (t > 0) pick = back[t][pick]
  }

  const out = []
  for (let t = 0; t < statesPerStep.length; t++) {
    const st = statesPerStep[t][chosen[t]]
    for (const n of st.lh) out.push({ pitch: n.pitch, start: n.start, dur: n.dur, hand: 'left' })
    for (const n of st.rh) out.push({ pitch: n.pitch, start: n.start, dur: n.dur, hand: 'right' })
  }
  return out
}

function groupMeta(notes) {
  return clusterOnsets(notes, ONSET_CLUSTER_GAP).map((cl) => {
    const sorted = cl.notes.slice().sort((a, b) => a.pitch - b.pitch)
    let maxEnd = 0
    for (const n of sorted) maxEnd = Math.max(maxEnd, n.start + n.dur)
    return {
      start: cl.start,
      maxEnd,
      notes: sorted,
      sig: sorted.map((n) => n.pitch).join(',')
    }
  })
}

// Collapse rapid identical chord re-triggers in the left hand into sustained holds.
function suppressLeftChugging(lhNotes, holdWindow) {
  const groups = groupMeta(lhNotes)
  if (groups.length < CHUG_MIN_RUN) return lhNotes
  const kept = []
  let i = 0
  while (i < groups.length) {
    let j = i + 1
    while (
      j < groups.length &&
      groups[j].sig === groups[i].sig &&
      groups[j].start - groups[j - 1].start <= CHUG_MAX_IOI &&
      groups[j].start - groups[j - 1].maxEnd <= CHUG_MAX_GAP
    ) {
      j++
    }
    if (j - i < CHUG_MIN_RUN) {
      for (let k = i; k < j; k++) kept.push(groups[k])
    } else {
      let active = groups[i].notes.map((n) => ({ ...n }))
      let activeStart = groups[i].start
      kept.push({ start: activeStart, notes: active })
      for (let k = i + 1; k < j; k++) {
        const g = groups[k]
        if (g.start - activeStart < holdWindow) {
          for (let v = 0; v < active.length; v++) {
            const end = g.notes[v].start + g.notes[v].dur
            active[v].dur = Math.max(active[v].dur, end - active[v].start)
          }
        } else {
          for (const n of active) {
            const clipped = g.start - n.start - 0.01
            if (n.start + n.dur > g.start && clipped >= MIN_DUR) n.dur = clipped
          }
          active = g.notes.map((n) => ({ ...n }))
          activeStart = g.start
          kept.push({ start: activeStart, notes: active })
        }
      }
    }
    i = j
  }
  const out = []
  for (const g of kept) out.push(...g.notes)
  return out
}

// Suppress rapid chugging only on inner right-hand voices (below a simultaneous or still-ringing
// higher melody note); never touch the top melody voice.
function suppressRightInnerChugging(rhNotes, holdWindow) {
  const groups = groupMeta(rhNotes)
  if (groups.length < CHUG_MIN_RUN) return rhNotes
  const topSet = new Set()
  const innerByPitch = new Map()
  const activeTop = []
  for (const g of groups) {
    const top = g.notes[g.notes.length - 1]
    let soundingHigher = false
    for (let a = activeTop.length - 1; a >= 0; a--) {
      if (activeTop[a].end <= g.start + 0.05) { activeTop.splice(a, 1); continue }
      if (activeTop[a].pitch > top.pitch) soundingHigher = true
    }
    if (!soundingHigher) {
      topSet.add(top)
      activeTop.push({ pitch: top.pitch, end: top.start + top.dur })
    }
    const innerLimit = soundingHigher ? g.notes.length : g.notes.length - 1
    for (let idx = 0; idx < innerLimit; idx++) {
      const n = g.notes[idx]
      let list = innerByPitch.get(n.pitch)
      if (!list) innerByPitch.set(n.pitch, list = [])
      list.push(n)
    }
  }
  const dropped = new Set()
  for (const list of innerByPitch.values()) {
    if (list.length < CHUG_MIN_RUN) continue
    let i = 0
    while (i < list.length) {
      let j = i + 1
      while (
        j < list.length &&
        list[j].start - list[j - 1].start <= CHUG_MAX_IOI &&
        list[j].start - (list[j - 1].start + list[j - 1].dur) <= CHUG_MAX_GAP
      ) {
        j++
      }
      if (j - i >= CHUG_MIN_RUN) {
        let active = list[i]
        for (let k = i + 1; k < j; k++) {
          const cur = list[k]
          if (cur.start - active.start < holdWindow) {
            active.dur = Math.max(active.dur, cur.start + cur.dur - active.start)
            dropped.add(cur)
          } else {
            const clipped = cur.start - active.start - 0.01
            if (active.start + active.dur > cur.start && clipped >= MIN_DUR) active.dur = clipped
            active = cur
          }
        }
      }
      i = j
    }
  }
  if (!dropped.size) return rhNotes
  return rhNotes.filter((n) => topSet.has(n) || !dropped.has(n))
}

// In easy mode, drop lower accompaniment notes that start underneath a still-sustained higher melody note.
function dropRightUnderHeldMelody(rhNotes) {
  const out = []
  let heldPitch = -1
  let heldEnd = -Infinity
  for (const n of rhNotes) {
    if (n.start >= heldEnd - 0.12) {
      heldPitch = n.pitch
      heldEnd = n.start + n.dur
      out.push(n)
    } else if (heldPitch - n.pitch >= 4 && heldEnd - n.start >= 0.12) {
      continue
    } else {
      out.push(n)
      if (n.pitch >= heldPitch || n.start + n.dur > heldEnd) {
        heldPitch = n.pitch
        heldEnd = n.start + n.dur
      }
    }
  }
  return out
}

function pickChordVoices(notes, { keepTop, maxVoices, maxSpan }) {
  const sorted = notes.slice().sort((a, b) => a.pitch - b.pitch || b.dur - a.dur)
  const unique = []
  for (const n of sorted) {
    const prev = unique[unique.length - 1]
    if (!prev || prev.pitch !== n.pitch) unique.push(n)
    else if (n.dur > prev.dur) unique[unique.length - 1] = n
  }
  if (!unique.length) return []
  if (keepTop) {
    const anchor = unique[unique.length - 1]
    const picked = [anchor]
    for (let i = unique.length - 2; i >= 0 && picked.length < maxVoices; i--) {
      if (anchor.pitch - unique[i].pitch <= maxSpan) picked.push(unique[i])
    }
    return picked.reverse()
  }
  const anchor = unique[0]
  const picked = [anchor]
  if (maxVoices === 2) {
    // Root + highest reachable upper voice (fifth or octave) for full bass support.
    for (let i = unique.length - 1; i >= 1; i--) {
      if (unique[i].pitch - anchor.pitch <= maxSpan) {
        picked.push(unique[i])
        break
      }
    }
    return picked
  }
  for (let i = 1; i < unique.length && picked.length < maxVoices; i++) {
    if (unique[i].pitch - anchor.pitch <= maxSpan) picked.push(unique[i])
  }
  return picked
}

function thinHand(handNotes, { keepTop, maxVoices, minGap, maxSpan }) {
  const sorted = handNotes.slice().sort((a, b) => a.start - b.start || a.pitch - b.pitch)
  // Merge consecutive notes within ONSET_CLUSTER_GAP so the final output never violates
  // voice count or hand span under anchored 30 ms clustering (including fingering.js).
  const groups = []
  for (const n of sorted) {
    const last = groups[groups.length - 1]
    if (last && n.start - last.lastStart <= ONSET_CLUSTER_GAP + 1e-9) {
      last.notes.push(n)
      last.lastStart = Math.max(last.lastStart, n.start)
    } else {
      groups.push({ start: n.start, lastStart: n.start, notes: [n] })
    }
  }
  const out = []
  let lastKeptStart = -Infinity
  for (const g of groups) {
    if (minGap > 0 && g.start - lastKeptStart < minGap - 1e-6) continue
    const picked = pickChordVoices(g.notes, { keepTop, maxVoices, maxSpan })
    if (!picked.length) continue
    out.push(...picked)
    lastKeptStart = picked[0].start
  }
  return out
}

function shiftBounds(groups, range) {
  let minP = Infinity
  let maxP = -Infinity
  for (const g of groups) {
    for (const n of g.notes) {
      if (n.pitch < minP) minP = n.pitch
      if (n.pitch > maxP) maxP = n.pitch
    }
  }
  return {
    minP,
    maxP,
    sLo: Math.ceil((range.lo - minP) / 12),
    sHi: Math.floor((range.hi - maxP) / 12)
  }
}

// Scan up to the first range overflow. Prefer a breath near the end of the fitting span.
function fitPhrasesToRange(groups, range) {
  const phrases = []
  let first = 0
  while (first < groups.length) {
    let min = Infinity
    let max = -Infinity
    let end = first
    for (; end < groups.length; end++) {
      for (const n of groups[end].notes) {
        min = Math.min(min, n.pitch)
        max = Math.max(max, n.pitch)
      }
      if (Math.ceil((range.lo - min) / 12) > Math.floor((range.hi - max) / 12)) break
    }
    let cut = Math.max(first + 1, end)
    if (end < groups.length && end > first + 1) {
      let best = -Infinity
      for (let i = first + Math.ceil((end - first) / 2); i <= end; i++) {
        const gap = Math.max(0, groups[i].start - groups[i - 1].maxEnd)
        const leap = Math.abs(groups[i].anchor - groups[i - 1].anchor)
        const score = gap * 30 + leap * 0.8 + (i - first) / (end - first) * 2
        if (score >= best) { best = score; cut = i }
      }
    }
    phrases.push(groups.slice(first, cut))
    first = cut
  }
  return phrases
}

function foldPitchFallback(pitch, range) {
  let p = pitch
  while (p < range.lo) p += 12
  while (p > range.hi) p -= 12
  if (p < range.lo) p = range.lo
  if (p > range.hi) p = range.hi
  return p
}

function handPhrases(notes, hand) {
  const rawGroups = clusterOnsets(notes, ONSET_CLUSTER_GAP).map((cl) => {
    const sorted = cl.notes.slice().sort((a, b) => a.pitch - b.pitch)
    let maxEnd = 0
    for (const n of sorted) maxEnd = Math.max(maxEnd, n.start + n.dur)
    const anchor = hand === 'right' ? sorted[sorted.length - 1].pitch : sorted[0].pitch
    return { start: cl.start, maxEnd, notes: sorted, anchor }
  })

  if (!rawGroups.length) return []
  const rawPhrases = [[rawGroups[0]]]
  for (let i = 1; i < rawGroups.length; i++) {
    const prev = rawGroups[i - 1]
    const cur = rawGroups[i]
    const rest = cur.start - prev.maxEnd
    const leap = Math.abs(cur.anchor - prev.anchor)
    if (rest >= PHRASE_REST || leap >= PHRASE_LEAP) rawPhrases.push([cur])
    else rawPhrases[rawPhrases.length - 1].push(cur)
  }

  return rawPhrases
}

function transposeHandToRange(notes, hand, range) {
  if (!notes.length) return notes
  let outOfRange = false
  for (const n of notes) {
    if (n.pitch < range.lo || n.pitch > range.hi) { outOfRange = true; break }
  }
  if (!outOfRange) return notes

  const rawPhrases = handPhrases(notes, hand)

  const phrases = []
  for (const p of rawPhrases) phrases.push(...fitPhrasesToRange(p, range))

  const target = hand === 'right'
    ? range.lo + 0.65 * (range.hi - range.lo)
    : range.lo + 0.25 * (range.hi - range.lo)
  const lhUpperLimit = range.lo + Math.floor((range.hi - range.lo) * 0.45)
  const narrow = range.hi - range.lo <= 36

  const optionsPerPhrase = phrases.map((groups) => {
    const { maxP, sLo, sHi } = shiftBounds(groups, range)
    let sum = 0
    let count = 0
    for (const g of groups) for (const n of g.notes) { sum += n.pitch; count++ }
    const mean = sum / count
    if (sLo > sHi) return [{ shift: null, emit: 0 }]
    const opts = []
    for (let s = sLo; s <= sHi; s++) {
      let emit = Math.abs(s) * 4 + Math.abs(mean + 12 * s - target) * 0.08
      if (hand === 'left' && narrow && s > 0 && maxP + 12 * s > lhUpperLimit) {
        emit += 10 + (maxP + 12 * s - lhUpperLimit) * 0.6
      }
      opts.push({ shift: s, emit })
    }
    return opts
  })

  let dp = optionsPerPhrase[0].map((o) => o.emit)
  const back = [null]
  for (let t = 1; t < optionsPerPhrase.length; t++) {
    const prevPhrase = phrases[t - 1]
    const curPhrase = phrases[t]
    const rest = curPhrase[0].start - prevPhrase[prevPhrase.length - 1].maxEnd
    const restScale = rest >= 1.5 ? 0.25 : rest >= 0.8 ? 0.55 : 1.0
    const transWeight = (hand === 'right' ? 6.0 : 3.2) * restScale
    const prev = optionsPerPhrase[t - 1]
    const cur = optionsPerPhrase[t]
    const nextDp = new Array(cur.length)
    const from = new Array(cur.length)
    for (let j = 0; j < cur.length; j++) {
      let best = Infinity
      let bestI = 0
      for (let i = 0; i < prev.length; i++) {
        const jump = prev[i].shift !== null && cur[j].shift !== null
          ? Math.abs(cur[j].shift - prev[i].shift) * transWeight
          : 0
        const val = dp[i] + jump + cur[j].emit
        if (val < best) { best = val; bestI = i }
      }
      nextDp[j] = best
      from[j] = bestI
    }
    dp = nextDp
    back.push(from)
  }

  let pick = 0
  for (let i = 1; i < dp.length; i++) if (dp[i] < dp[pick]) pick = i
  const shifts = new Array(phrases.length)
  for (let t = phrases.length - 1; t >= 0; t--) {
    shifts[t] = optionsPerPhrase[t][pick].shift
    if (t > 0) pick = back[t][pick]
  }

  const shifted = []
  for (let t = 0; t < phrases.length; t++) {
    const s = shifts[t]
    for (const g of phrases[t]) {
      for (const n of g.notes) {
        const pitch = s === null ? foldPitchFallback(n.pitch, range) : n.pitch + 12 * s
        shifted.push({ pitch, start: n.start, dur: n.dur, hand })
      }
    }
  }
  shifted.sort((a, b) => a.start - b.start || a.pitch - b.pitch)
  return mergeTrueOverlaps(shifted).map((n) => ({ ...n, hand }))
}

// The right-hand phrases set the register ceiling. Keep each left-hand onset group together.
export function separateHands(left, right, range) {
  if (!left.length || !right.length) return left
  const phrases = handPhrases(right, 'right').map((groups) => {
    let lowest = Infinity
    for (const g of groups) for (const n of g.notes) lowest = Math.min(lowest, n.pitch)
    return { start: groups[0].start, lowest }
  })
  const rightByPitch = Array.from({ length: 128 }, () => [])
  const nextAtPitch = new Uint32Array(128)
  for (const n of right) rightByPitch[n.pitch].push(n)

  const groups = clusterOnsets(left, ONSET_CLUSTER_GAP)
  const kept = []
  let at = 0
  for (let i = 0; i < phrases.length; i++) {
    const first = at
    const boundary = phrases[i + 1]?.start ?? Infinity
    let min = Infinity
    let max = -Infinity
    while (at < groups.length && groups[at].start < boundary) {
      for (const n of groups[at].notes) {
        min = Math.min(min, n.pitch)
        max = Math.max(max, n.pitch)
      }
      at++
    }
    const lowestRight = phrases[i].lowest
    const needed = Math.max(0, Math.ceil((max - lowestRight + 1) / 12))
    const octavesDown = Math.min(needed, Math.floor((min - range.lo) / 12))
    for (let j = first; j < at; j++) {
      let groupCeiling = lowestRight
      const lastOnset = groups[j].notes.at(-1).start
      for (let k = i + 1; k < phrases.length && phrases[k].start <= lastOnset + ONSET_CLUSTER_GAP + 1e-9; k++) {
        groupCeiling = Math.min(groupCeiling, phrases[k].lowest)
      }
      for (const n of groups[j].notes) {
        const down = Math.max(octavesDown, Math.ceil((n.pitch - groupCeiling + 1) / 12))
        const pitch = n.pitch - 12 * down
        if (pitch < range.lo) continue
        const candidates = rightByPitch[pitch]
        let k = nextAtPitch[pitch]
        while (k < candidates.length && candidates[k].start + candidates[k].dur <= n.start + OVERLAP_EPS + 1e-9) k++
        nextAtPitch[pitch] = k
        if (k < candidates.length && candidates[k].start < n.start + n.dur - OVERLAP_EPS - 1e-9) continue
        kept.push({ ...n, pitch })
      }
    }
  }
  kept.sort((a, b) => a.start - b.start || a.pitch - b.pitch)
  return mergeTrueOverlaps(kept)
}

function shapeHandVelocity(notes, hand) {
  if (!notes.length) return []
  const groups = clusterOnsets(notes, ONSET_CLUSTER_GAP)
  const out = []
  let prevEnd = -Infinity
  for (const g of groups) {
    const sorted = g.notes.slice().sort((a, b) => a.pitch - b.pitch)
    const phraseStart = g.start - prevEnd >= 0.4
    let maxEnd = 0
    for (let i = 0; i < sorted.length; i++) {
      const n = sorted[i]
      maxEnd = Math.max(maxEnd, n.start + n.dur)
      let vel
      if (hand === 'right') {
        const isMelody = i === sorted.length - 1
        vel = isMelody ? (phraseStart ? VEL_RH_MELODY_ACCENT : VEL_RH_MELODY) : VEL_RH_HARMONY
      } else {
        const isRoot = i === 0
        vel = isRoot ? (phraseStart ? VEL_LH_ROOT_ACCENT : VEL_LH_ROOT) : VEL_LH_INNER
      }
      out.push({ pitch: n.pitch, start: n.start, dur: n.dur, vel, hand })
    }
    prevEnd = Math.max(prevEnd, maxEnd)
  }
  return out
}

export function arrange(rawNotes, opts = {}) {
  const difficulty = resolveDifficulty(opts && opts.difficulty)
  const range = resolveRange(opts && opts.keyRange)
  const cleaned = cleanCoverNotes(rawNotes)
  if (!cleaned.length) return []

  const clusters = clusterOnsets(cleaned, ONSET_CLUSTER_GAP)
  const handed = assignHandsViterbi(clusters)

  let rh = handed.filter((n) => n.hand === 'right').sort((a, b) => a.start - b.start || a.pitch - b.pitch)
  let lh = handed.filter((n) => n.hand === 'left').sort((a, b) => a.start - b.start || a.pitch - b.pitch)

  const chugWindow = difficulty === 'full' ? 0.40 : 0.55
  lh = suppressLeftChugging(lh, chugWindow)
  if (difficulty !== 'easy') rh = suppressRightInnerChugging(rh, chugWindow)

  const maxRH = difficulty === 'easy' ? 1 : difficulty === 'medium' ? 2 : Infinity
  const maxLH = difficulty === 'easy' ? 1 : difficulty === 'medium' ? 2 : Infinity
  const lhGap = difficulty === 'easy' ? EASY_LH_MIN_GAP : 0

  rh = thinHand(rh, { keepTop: true, maxVoices: maxRH, minGap: 0, maxSpan: MAX_HAND_SPAN })
  if (difficulty === 'easy') rh = dropRightUnderHeldMelody(rh)
  lh = thinHand(lh, { keepTop: false, maxVoices: maxLH, minGap: lhGap, maxSpan: MAX_HAND_SPAN })

  rh = transposeHandToRange(rh, 'right', range)
  lh = separateHands(transposeHandToRange(lh, 'left', range), rh, range)

  const out = [
    ...shapeHandVelocity(rh, 'right'),
    ...shapeHandVelocity(lh, 'left')
  ]
  out.sort((a, b) => a.start - b.start || a.pitch - b.pitch || (a.hand === 'left' ? -1 : 1))
  return out
}
