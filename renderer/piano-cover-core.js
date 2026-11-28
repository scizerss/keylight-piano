// Music2MIDI piano cover, the part that is plain maths: log-mel front end, silence gate, chunk plan, greedy decode loop,
// token reader (held-note closing and the five runaway stops) and seam stitching. It mirrors ios/Keylight/PianoCoverMel.swift
// and PianoCoverTokens.swift, so the desktop app and the iPhone turn the same audio into the same notes. No DOM, no model
// runtime: a runner (renderer/piano-cover-worker.js, or a fake in tests) supplies the encoder and decoder.
//
// Contract with the runner:  runner.begin(logMel: Float32Array[188*384], cond: [genreIndex, difficultyIndex])
//   -> Promise<{ step(token): Promise<Float32Array(400) logits>, close() }>

export const SAMPLE_RATE = 16000
export const CHUNK_SECONDS = 3
export const CHUNK_SAMPLES = 48000
export const N_FFT = 2048
export const HOP = 256
export const N_MELS = 384
export const N_FREQS = N_FFT / 2 + 1
export const N_FRAMES = 1 + Math.floor(CHUNK_SAMPLES / HOP)   // 188
export const F_MIN = 20
export const F_MAX = 8000
export const LOG_FLOOR = 1e-6
export const SILENCE_DBFS = -55
export const MAX_LENGTH = 320                             // the iOS cache length: covers the densest chunk of the spike (301 tokens)
export const MAX_SECONDS = 20 * 60

export const GENRES = ['electronic', 'pop', 'rock', 'soundtrack', 'world_music', 'classical']
export const DIFFICULTIES = ['beginner', 'intermediate', 'advanced']
export const OVERLAPS = { 0: 3, 25: 2.25, 50: 1.5 }       // percent -> hop seconds

export const TOKEN = {
  pad: 0, bos: 1, eos: 2, onset: 3, offset: 4, pitchOffset: 5, timeOffset: 133, timeCount: 200, vocab: 400,
  timeStep: 0.05, maxTimeIndex: 62, maxTokensPerTime: 32, maxRepeats: 8
}

export class CoverError extends Error {
  constructor(message, code) { super(message); this.name = 'CoverError'; this.code = code }
}
const abortError = () => new DOMException('The piano cover was cancelled', 'AbortError')

// ---------- silence gate ----------

export function rmsDbfs(samples) {
  if (!samples.length) return -Infinity
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  const rms = Math.sqrt(sum / samples.length)
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity
}
export const isSilent = (samples, threshold = SILENCE_DBFS) => rmsDbfs(samples) < threshold

// ---------- log-mel front end ----------
// torchaudio MelSpectrogram: periodic Hann, centre reflect pad, power 2, HTK mels (no norm) from 20 to 8000 Hz, log(clamp 1e-6).

const hzToMel = (f) => 2595 * Math.log10(1 + f / 700)
const melToHz = (m) => 700 * (10 ** (m / 2595) - 1)

// Sparse triangular filters: filter m covers bins [start[m], start[m] + weights[m].length).
export function buildFilterbank() {
  const mMin = hzToMel(F_MIN), mMax = hzToMel(F_MAX)
  const pts = new Float64Array(N_MELS + 2)
  for (let i = 0; i < pts.length; i++) pts[i] = melToHz(mMin + (mMax - mMin) * i / (pts.length - 1))
  const start = new Int32Array(N_MELS)
  const weights = []
  const nyquist = SAMPLE_RATE / 2
  for (let m = 0; m < N_MELS; m++) {
    const lo = pts[m], mid = pts[m + 1], hi = pts[m + 2]
    let first = -1
    const w = []
    for (let k = 0; k < N_FREQS; k++) {
      const freq = nyquist * k / (N_FREQS - 1)
      const v = Math.max(0, Math.min((freq - lo) / (mid - lo), (hi - freq) / (hi - mid)))
      if (v > 0) { if (first < 0) first = k; w.push(v) } else if (first >= 0) break
    }
    start[m] = first < 0 ? 0 : first
    weights.push(Float64Array.from(w))
  }
  return { start, weights }
}

let melState = null
function mel() {
  if (melState) return melState
  const window = new Float64Array(N_FFT)
  for (let n = 0; n < N_FFT; n++) window[n] = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / N_FFT)
  const cos = new Float64Array(N_FFT / 2), sin = new Float64Array(N_FFT / 2)
  for (let i = 0; i < N_FFT / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / N_FFT); sin[i] = -Math.sin(2 * Math.PI * i / N_FFT) }
  const rev = new Uint16Array(N_FFT)
  const bits = Math.log2(N_FFT)
  for (let i = 0; i < N_FFT; i++) {
    let r = 0
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b)
    rev[i] = r
  }
  melState = { window, cos, sin, rev, fb: buildFilterbank(), re: new Float64Array(N_FFT), im: new Float64Array(N_FFT), power: new Float64Array(N_FREQS) }
  return melState
}

function fft(re, im, s) {
  const n = N_FFT
  for (let i = 0; i < n; i++) { const j = s.rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t } }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const a = i + j, b = a + half
        const tr = re[b] * s.cos[k] - im[b] * s.sin[k]
        const ti = re[b] * s.sin[k] + im[b] * s.cos[k]
        re[b] = re[a] - tr; im[b] = im[a] - ti
        re[a] += tr; im[a] += ti
      }
    }
  }
}

// samples: up to 48000 mono samples at 16 kHz (shorter input is zero padded). Returns Float32Array(188 * 384), frame-major.
export function logMel(samples, out = new Float32Array(N_FRAMES * N_MELS)) {
  const s = mel()
  const n = CHUNK_SAMPLES, pad = N_FFT / 2
  const padded = new Float64Array(n + 2 * pad)
  const copy = Math.min(samples.length, n)
  for (let i = 0; i < copy; i++) padded[pad + i] = samples[i]
  // reflect padding leaves the edge sample out, like torch.stft(center=True, pad_mode='reflect')
  for (let i = 0; i < pad; i++) { padded[i] = padded[pad + pad - i]; padded[pad + n + i] = padded[pad + n - 2 - i] }
  const { re, im, power } = s
  for (let f = 0; f < N_FRAMES; f++) {
    const off = f * HOP
    for (let i = 0; i < N_FFT; i++) { re[i] = padded[off + i] * s.window[i]; im[i] = 0 }
    fft(re, im, s)
    for (let k = 0; k < N_FREQS; k++) power[k] = re[k] * re[k] + im[k] * im[k]
    const row = f * N_MELS
    for (let m = 0; m < N_MELS; m++) {
      const w = s.fb.weights[m], base = s.fb.start[m]
      let acc = 0
      for (let j = 0; j < w.length; j++) acc += power[base + j] * w[j]
      out[row + m] = Math.log(Math.max(acc, LOG_FLOOR))
    }
  }
  return out
}

// ---------- token reader ----------

// One guard per chunk: the decode loop and the token reader both use it, so a runaway sequence is cut the same way in each.
export function createGuard(maxLength) {
  let lastTime = -1, atTime = 0, lastToken = -1, repeats = 0
  return {
    // returns 'go', 'eos' or 'runaway:<why>'. step is the 0-based decode step (0 ..< maxLength - 1)
    observe(token, step) {
      if (token === TOKEN.eos) return 'eos'
      if (token === lastToken) { if (++repeats >= TOKEN.maxRepeats) return 'runaway:repeat' } else { lastToken = token; repeats = 1 }
      if (token >= TOKEN.timeOffset && token < TOKEN.timeOffset + TOKEN.timeCount) {
        const t = token - TOKEN.timeOffset
        if (t > TOKEN.maxTimeIndex) return 'runaway:time-range'
        if (t < lastTime) return 'runaway:time-backwards'
        if (t !== lastTime) { lastTime = t; atTime = 0 }
      } else if (++atTime > TOKEN.maxTokensPerTime) return 'runaway:tokens-at-time'
      if (step + 1 >= maxLength - 1) return 'runaway:max-length'
      return 'go'
    }
  }
}

// Tokens of one chunk -> notes in chunk seconds { pitch, start, end, closed }. A note still held at the end of the chunk
// (no offset token) is closed at the chunk end, or at the last time token when the sequence ran away.
export function detokenize(tokens, { maxLength = Infinity, chunkDuration = CHUNK_SECONDS, closeHeld = true } = {}) {
  const pending = []
  let time = -1, on = -1, pitch = -1, runaway = false
  const guard = createGuard(maxLength)
  const list = tokens[0] === TOKEN.bos ? tokens.slice(1) : tokens
  for (let step = 0; step < list.length; step++) {
    const token = list[step]
    const verdict = guard.observe(token, step)
    if (verdict !== 'go') { if (verdict.startsWith('runaway')) runaway = true; break }
    if (token === TOKEN.bos || token === TOKEN.pad) continue
    if (token === TOKEN.onset) on = 1
    else if (token === TOKEN.offset) on = 0
    else if (token >= TOKEN.timeOffset && token < TOKEN.timeOffset + TOKEN.timeCount) { time = token - TOKEN.timeOffset; on = -1; pitch = -1 }
    else if (token >= TOKEN.pitchOffset && token < TOKEN.timeOffset) pitch = token - TOKEN.pitchOffset
    else continue
    if (time === -1 || on === -1 || pitch === -1) continue
    if (on === 1) pending.push({ onset: time, offset: -1, pitch })
    else for (const p of pending) if (p.onset < time && p.offset === -1 && p.pitch === pitch) p.offset = time
    pitch = -1
  }
  const notes = []
  for (const p of pending) {
    const start = p.onset * TOKEN.timeStep
    if (!(start < chunkDuration)) continue
    if (p.offset === -1) {
      if (!closeHeld) continue
      const end = runaway ? Math.min(time * TOKEN.timeStep, chunkDuration) : chunkDuration
      if (end > start) notes.push({ pitch: p.pitch, start, end, closed: end === chunkDuration })
    } else {
      const end = Math.min(p.offset * TOKEN.timeStep, chunkDuration)
      if (end > start) notes.push({ pitch: p.pitch, start, end, closed: false })
    }
  }
  return notes
}

// ---------- chunk plan and stitching ----------

export const hopSeconds = (overlap) => {
  const hop = OVERLAPS[overlap]
  if (!hop) throw new CoverError('Unsupported overlap ' + overlap, 'overlap')
  return hop
}
const hopSamples = (overlap) => Math.round(hopSeconds(overlap) * SAMPLE_RATE)

// Same windows as PianoCoverAudio.ChunkReader: full chunks while 3 s remain, then one zero-padded tail for what is left over.
export function planChunks(totalSamples, overlap = 0) {
  const hop = hopSamples(overlap)
  const chunks = []
  if (totalSamples <= 0) return chunks
  let n = 0
  while (totalSamples - n * hop >= CHUNK_SAMPLES) { chunks.push({ index: n, start: n * hop, length: CHUNK_SAMPLES }); n++ }
  const covered = n === 0 ? 0 : CHUNK_SAMPLES + (n - 1) * hop
  if (totalSamples > covered) chunks.push({ index: n, start: n * hop, length: totalSamples - n * hop })
  return chunks
}

// chunks: [{ offset (seconds), notes (detokenize output) }]. Keeps notes that start in each chunk's trusted centre window,
// then joins same-pitch notes that touch across a seam. Returns [{ pitch, start, dur }].
export function stitch(chunks, overlap = 0, totalDuration = null, seamJoin = 0.055) {
  if (!chunks.length) return []
  const margin = (CHUNK_SECONDS - hopSeconds(overlap)) / 2
  const last = chunks.length - 1
  const kept = []
  chunks.forEach((chunk, idx) => {
    const lo = idx === 0 ? 0 : margin
    const hi = idx === last ? CHUNK_SECONDS + 0.15 : CHUNK_SECONDS - margin
    for (const note of chunk.notes) {
      if (!(note.start >= lo && note.start < hi)) continue
      const start = chunk.offset + note.start
      let end = chunk.offset + note.end
      if (totalDuration > 0) { if (start >= totalDuration) continue; end = Math.min(end, totalDuration) }
      if (!(end > start)) continue
      kept.push({ pitch: note.pitch, start, end, closed: note.closed, chunk: idx })
    }
  })
  kept.sort((a, b) => a.start - b.start || a.pitch - b.pitch || a.chunk - b.chunk)
  const merged = []
  const lastByPitch = new Map()
  for (const note of kept) {
    const at = lastByPitch.get(note.pitch)
    if (at !== undefined) {
      const prev = merged[at]
      if (note.chunk !== prev.chunk && (note.start < prev.end || (prev.closed && note.start <= prev.end + seamJoin))) {
        merged[at] = { pitch: prev.pitch, start: prev.start, end: Math.max(prev.end, note.end), closed: note.closed, chunk: note.chunk }
        continue
      }
    }
    lastByPitch.set(note.pitch, merged.length)
    merged.push(note)
  }
  return merged.map((n) => ({ pitch: n.pitch, start: n.start, dur: n.end - n.start }))
}

// ---------- greedy decode ----------

export function argmax(values) {
  let best = 0, bestValue = -Infinity
  for (let i = 0; i < values.length; i++) if (values[i] > bestValue) { bestValue = values[i]; best = i }
  return best
}

// Greedy decode of several chunks side by side (the decoder is memory bound, so a batch costs little more than one chunk).
// Every chunk is its own sequence: it stops on its own EOS or runaway and is fed PAD until the slowest one is done. Checks
// `signal` before every step, so Cancel lands within one decoder step. Returns one token list per chunk (BOS first, stop token last).
export async function decodeBatch(runner, mels, cond, { signal, maxLength = MAX_LENGTH } = {}) {
  signal?.throwIfAborted()
  const session = await runner.begin(mels, cond)
  try {
    const tokens = mels.map(() => [TOKEN.bos])
    const guards = mels.map(() => createGuard(maxLength))
    const finished = mels.map(() => false)
    let current = mels.map(() => TOKEN.bos)
    let running = mels.length
    for (let step = 0; step < maxLength - 1 && running > 0; step++) {
      signal?.throwIfAborted()
      const logits = await session.step(current)
      current = current.map((_, b) => {
        if (finished[b]) return TOKEN.pad
        const next = argmax(logits[b])
        tokens[b].push(next)
        if (guards[b].observe(next, step) !== 'go') { finished[b] = true; running--; return TOKEN.pad }
        return next
      })
    }
    return tokens
  } finally { session.close() }
}

export async function decodeChunk(runner, melValues, cond, options) {
  return (await decodeBatch(runner, [melValues], cond, options))[0]
}

// The whole job: mono 16 kHz samples in, raw notes out (silence gated, runaway guarded, held notes closed, seams stitched).
// onProgress(done, total) fires before the first chunk and after every batch of chunks. Cancel with `signal`.
export async function runPianoCover(pcm, { runner, genre = 'pop', difficulty = 'intermediate', overlap = 0, batch = 1, signal, onProgress, onTokens } = {}) {
  const genreIndex = GENRES.indexOf(genre), difficultyIndex = DIFFICULTIES.indexOf(difficulty)
  if (genreIndex < 0 || difficultyIndex < 0) throw new CoverError('Unknown genre or difficulty', 'options')
  if (!pcm || !pcm.length) throw new CoverError('That audio file is empty', 'empty')
  if (pcm.length / SAMPLE_RATE > MAX_SECONDS) throw new CoverError('Recordings up to 20 minutes can be added', 'too-long')
  const plan = planChunks(pcm.length, overlap)
  onProgress?.(0, plan.length)
  const decoded = new Array(plan.length)
  let finished = 0
  for (let at = 0; at < plan.length; at += batch) {
    signal?.throwIfAborted()
    const group = plan.slice(at, at + batch)
    const live = []                       // the chunks of this group that are not silent
    for (const item of group) {
      const chunk = new Float32Array(CHUNK_SAMPLES)
      chunk.set(pcm.subarray(item.start, item.start + item.length))
      decoded[item.index] = { offset: item.start / SAMPLE_RATE, notes: [] }
      if (isSilent(chunk)) onTokens?.(item.index, null)
      else live.push({ item, mel: logMel(chunk) })
    }
    if (live.length) {
      const tokens = await decodeBatch(runner, live.map((l) => l.mel), [genreIndex, difficultyIndex], { signal })
      live.forEach(({ item }, i) => {
        decoded[item.index].notes = detokenize(tokens[i], { maxLength: MAX_LENGTH })
        onTokens?.(item.index, tokens[i])
      })
    }
    finished += group.length
    onProgress?.(finished, plan.length)
  }
  signal?.throwIfAborted()
  const duration = pcm.length / SAMPLE_RATE
  return { notes: stitch(decoded, overlap, duration), duration }
}

export { abortError }
