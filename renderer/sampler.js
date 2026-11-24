// Salamander Grand Piano by Alexander Holm (CC BY 3.0) and bundled Harmonium SoundFont (.sf2).
// Local, single-velocity stereo subset; see LICENSES/piano-samples.md.
export const PIANO_SAMPLES = Object.freeze([
  ['A0', 21], ['C1', 24], ['Fs1', 30], ['C2', 36], ['Fs2', 42],
  ['C3', 48], ['Fs3', 54], ['C4', 60], ['Fs4', 66], ['C5', 72],
  ['Fs5', 78], ['C6', 84], ['Fs6', 90], ['C7', 96], ['Fs7', 102], ['C8', 108]
].map(([name, pitch]) => Object.freeze({ pitch, url: new URL(`./samples/salamander/${name}.mp3`, import.meta.url) })))

export const HARMONIUM_SF2 = new URL('./samples/Harmonium.sf2', import.meta.url)
export const HARMONIUM_TOTAL = 49

const banks = new WeakMap()
const harmoniumBanks = new WeakMap()
const idle = Object.freeze({ state: 'idle', loaded: 0, total: PIANO_SAMPLES.length, error: null })
const harmoniumIdle = Object.freeze({ state: 'idle', loaded: 0, total: HARMONIUM_TOTAL, error: null })
export const pianoStatus = (ctx) => ({ ...(banks.get(ctx)?.status || idle) })
export const harmoniumStatus = (ctx) => ({ ...(harmoniumBanks.get(ctx)?.status || harmoniumIdle) })
export const sampleStatus = (ctx, id = 'sampled-piano') => id === 'harmonium' ? harmoniumStatus(ctx) : pianoStatus(ctx)

export function loadPiano(ctx) {
  const previous = banks.get(ctx)
  if (previous && previous.status.state !== 'unavailable') return previous.promise
  const bank = { status: { ...idle, state: 'loading' }, samples: [], promise: null }
  banks.set(ctx, bank)
  // Native fetch is intentional: bundled same-origin files, bounded timeout, no dependencies.
  bank.promise = Promise.all(PIANO_SAMPLES.map(async ({ pitch, url }) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new PianoSampleError(url.href, `HTTP ${response.status}`)
    const buffer = await ctx.decodeAudioData(await response.arrayBuffer())
    let peak = 0
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      for (const value of buffer.getChannelData(c)) peak = Math.max(peak, Math.abs(value))
    }
    if (!Number.isFinite(peak) || peak === 0) throw new PianoSampleError(url.href, 'Empty or invalid audio')
    if (bank.status.state === 'loading') bank.status = { ...bank.status, loaded: bank.status.loaded + 1 }
    return { pitch, buffer, gain: 1.4 / peak }
  })).then((samples) => {
    bank.samples = samples
    bank.status = { ...bank.status, state: 'ready' }
    return pianoStatus(ctx)
  }).catch((error) => {
    if (!(error instanceof Error)) throw error
    bank.status = { ...bank.status, state: 'unavailable', error: error.message }
    return pianoStatus(ctx)
  })
  return bank.promise
}

function parseSf2Samples(ctx, arrayBuffer, url, onSample) {
  if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength < 64) {
    throw new PianoSampleError(url, 'Empty or invalid SoundFont')
  }
  const dv = new DataView(arrayBuffer)
  const u8 = new Uint8Array(arrayBuffer)
  const ascii = (off, len) => {
    let s = ''
    for (let i = 0; i < len && off + i < u8.length && u8[off + i]; i++) s += String.fromCharCode(u8[off + i])
    return s
  }
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'sfbk') {
    throw new PianoSampleError(url, 'Not a SoundFont 2 (sfbk) file')
  }
  const chunks = {}
  const walk = (offset, end) => {
    while (offset + 8 <= end && offset + 8 <= arrayBuffer.byteLength) {
      const id = ascii(offset, 4)
      const size = dv.getUint32(offset + 4, true)
      const start = offset + 8
      if (id === 'RIFF' || id === 'LIST') walk(start + 4, Math.min(end, start + size))
      else chunks[id] = { offset: start, size }
      offset = start + size + (size & 1)
    }
  }
  walk(0, arrayBuffer.byteLength)
  if (!chunks.smpl || !chunks.shdr) throw new PianoSampleError(url, 'Missing smpl or shdr chunk')
  const smplOffset = chunks.smpl.offset
  const totalSamples = chunks.smpl.size >> 1
  const pcm = (smplOffset & 1) === 0 ? new Int16Array(arrayBuffer, smplOffset, totalSamples) : null
  const sampleAt = pcm ? (idx) => pcm[idx] / 32768 : (idx) => dv.getInt16(smplOffset + idx * 2, true) / 32768

  const shdr = chunks.shdr
  const records = []
  for (let pos = shdr.offset; pos + 46 <= shdr.offset + shdr.size; pos += 46) {
    const name = ascii(pos, 20)
    if (name === 'EOS') break
    records.push({
      name,
      start: dv.getUint32(pos + 20, true),
      end: dv.getUint32(pos + 24, true),
      startLoop: dv.getUint32(pos + 28, true),
      endLoop: dv.getUint32(pos + 32, true),
      sampleRate: dv.getUint32(pos + 36, true),
      originalPitch: dv.getUint8(pos + 40),
      pitchCorrection: dv.getInt8(pos + 41),
      sampleLink: dv.getUint16(pos + 42, true),
      sampleType: dv.getUint16(pos + 44, true)
    })
  }
  const used = new Set()
  const samples = []
  for (let i = 0; i < records.length; i++) {
    if (used.has(i)) continue
    const r = records[i]
    if (r.sampleType === 2 && records[r.sampleLink]?.sampleType === 4) continue
    const right = (r.sampleType === 4 && records[r.sampleLink]) ? records[r.sampleLink] : null
    used.add(i)
    if (right) used.add(r.sampleLink)
    const len = r.end - r.start
    if (!(len > 0) || r.end > totalSamples || !(r.sampleRate > 0)) continue
    const buffer = ctx.createBuffer(2, len, r.sampleRate)
    const leftCh = buffer.getChannelData(0)
    const rightCh = buffer.getChannelData(1)
    let peak = 0
    for (let j = 0; j < len; j++) {
      const lv = sampleAt(r.start + j)
      const rv = right && right.start + j < totalSamples ? sampleAt(right.start + j) : lv
      leftCh[j] = lv
      rightCh[j] = rv
      const a = Math.abs(lv) > Math.abs(rv) ? Math.abs(lv) : Math.abs(rv)
      if (a > peak) peak = a
    }
    if (!Number.isFinite(peak) || peak === 0) continue
    const loopStart = Math.max(0, (r.startLoop - r.start) / r.sampleRate)
    const loopEnd = Math.min(len / r.sampleRate, (r.endLoop - r.start) / r.sampleRate)
    samples.push({
      pitch: r.originalPitch,
      detune: r.pitchCorrection || 0,
      buffer,
      gain: 0.95 / peak,
      loop: loopEnd > loopStart,
      loopStart,
      loopEnd,
      release: 0.18
    })
    if (onSample) onSample(samples.length)
  }
  if (!samples.length) throw new PianoSampleError(url, 'No playable samples in SoundFont')
  return samples
}

export function loadHarmonium(ctx) {
  const previous = harmoniumBanks.get(ctx)
  if (previous && previous.status.state !== 'unavailable') return previous.promise
  const bank = { status: { ...harmoniumIdle, state: 'loading' }, samples: [], promise: null }
  harmoniumBanks.set(ctx, bank)
  bank.promise = (async () => {
    const response = await fetch(HARMONIUM_SF2, { signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new PianoSampleError(HARMONIUM_SF2.href, `HTTP ${response.status}`)
    const bytes = await response.arrayBuffer()
    const samples = parseSf2Samples(ctx, bytes, HARMONIUM_SF2.href, (loaded) => {
      if (bank.status.state === 'loading') bank.status = { ...bank.status, loaded }
    })
    bank.samples = samples
    bank.status = { ...bank.status, loaded: samples.length, total: samples.length, state: 'ready' }
    return harmoniumStatus(ctx)
  })().catch((error) => {
    if (!(error instanceof Error)) throw error
    bank.status = { ...bank.status, state: 'unavailable', error: error.message }
    return harmoniumStatus(ctx)
  })
  return bank.promise
}

export function loadSampled(ctx, id = 'sampled-piano') {
  return id === 'harmonium' ? loadHarmonium(ctx) : loadPiano(ctx)
}

export class PianoSampleError extends Error {
  constructor(url, reason) {
    super(`Sampled instrument unavailable: ${reason} (${url})`)
    this.name = 'PianoSampleError'
    this.url = url
  }
}

// The same release/expression contract as the built-in Voice. Sustain and the
// live 40-voice allocation policy remain owned by audio.js.
export class SampleVoice {
  constructor(ctx, out, note) {
    const id = note.id || 'sampled-piano'
    const bank = (id === 'harmonium' ? harmoniumBanks : banks).get(ctx)
    if (bank?.status.state !== 'ready') throw new PianoSampleError('bundled ' + id, 'Load samples before selecting')
    const sample = bank.samples.reduce((best, item) => Math.abs(item.pitch - note.pitch) < Math.abs(best.pitch - note.pitch) ? item : best)
    this.ctx = ctx
    this.id = id
    this.pitch = note.pitch
    this.shape = { release: sample.release || 0.32 }
    this.pressure = 0
    this.slide = 0.5
    this.bend = 0
    this.bendRange = note.bendRange
    this.dead = false
    this.releaseAt = Infinity
    this.t0 = note.when == null ? ctx.currentTime : Math.max(ctx.currentTime, note.when)
    const velocity = Math.max(0, Math.min(1, note.velocity / 127))
    this.velocity = velocity
    this.sample = sample
    this.baseDetune = sample.detune || 0
    this.source = new AudioBufferSourceNode(ctx, {
      buffer: sample.buffer,
      playbackRate: 2 ** ((note.pitch - sample.pitch) / 12),
      detune: this.baseDetune,
      loop: !!sample.loop,
      loopStart: sample.loopStart || 0,
      loopEnd: sample.loopEnd || 0
    })
    this.filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 2200 + 13800 * velocity, Q: 0.7 })
    this.env = new GainNode(ctx, { gain: 0 })
    this.env.gain.setValueAtTime(0, this.t0)
    this.env.gain.linearRampToValueAtTime(sample.gain * velocity ** 1.3, this.t0 + 0.002)
    this.source.connect(this.filter).connect(this.env).connect(out)
    this.source.onended = () => {
      this.dead = true
      this.source.disconnect()
      this.filter.disconnect()
      this.env.disconnect()
    }
    this.source.start(this.t0)
  }

  _updateFilter() {
    if (this.dead || !this.sample?.loop) return
    const base = 2200 + 13800 * this.velocity
    const cutoff = Math.min(18000, base * (0.7 + 0.6 * this.slide) * (1 + 0.35 * this.pressure))
    this.filter.frequency.setTargetAtTime(cutoff, this.ctx.currentTime, 0.035)
  }

  setPressure(value) {
    this.pressure = Math.max(0, Math.min(1, value))
    this._updateFilter()
  }
  setSlide(value) {
    this.slide = Math.max(0, Math.min(1, value))
    this._updateFilter()
  }
  setBend(semitones) {
    if (this.dead) return
    this.bend = Math.max(-this.bendRange, Math.min(this.bendRange, semitones))
    this.source.detune.setTargetAtTime(this.baseDetune + this.bend * 100, this.ctx.currentTime, 0.012)
  }

  release(seconds = this.shape.release, at = null) {
    const t = at == null ? this.ctx.currentTime : Math.max(this.ctx.currentTime, at)
    if (t >= this.releaseAt) return
    this.releaseAt = t
    const duration = Math.max(0.005, seconds)
    this.env.gain.cancelAndHoldAtTime(t)
    this.env.gain.setTargetAtTime(0, t, duration / 5)
    this.source.stop(t + duration * 1.6 + 0.05)
  }
}
