// The desktop twin of the iOS HostBridge cover calls. It speaks the same contract as ios/Keylight (coverStart / coverCancel
// requests, coverProgress / coverDone / coverError events), so renderer/piano-cover-import.js drives Mac, Windows and iPhone
// the same way. A "token" names an audio file the page staged here instead of an IncomingStore file.
//
//   const bridge = createDesktopCoverBridge({ createWorker, decode })
//   const token = bridge.stage(file)
//   generatePianoCover(token, { request: bridge.request, subscribe: bridge.subscribe })
//
// One job at a time. The worker is created on the first job and ended after `idleMs` without one, which frees the model.
import { SAMPLE_RATE, MAX_SECONDS } from './piano-cover-core.js'

export const MODEL_BASE = 'keylight://app/cover-models/'
const TOKEN = /^[A-Za-z0-9-]{8,64}$/

// Average the channels of a decoded AudioBuffer (already at 16 kHz) into one Float32Array. Takes anything with
// numberOfChannels, length and getChannelData, so tests can pass a plain object.
export function monoFromBuffer(buffer) {
  const channels = buffer.numberOfChannels
  if (channels === 1) return Float32Array.from(buffer.getChannelData(0))
  const out = new Float32Array(buffer.length)
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < out.length; i++) out[i] += data[i]
  }
  for (let i = 0; i < out.length; i++) out[i] /= channels
  return out
}

// Web Audio decodes and resamples to the context's rate in one step, so a 16 kHz offline context hands back 16 kHz audio.
export async function decodeToMono16k(file, signal, decodeFile) {
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE)
  const buffer = await decodeFile(ctx, file, signal)
  signal?.throwIfAborted()
  if (buffer.sampleRate !== SAMPLE_RATE) throw new Error('Could not decode that audio file')
  return monoFromBuffer(buffer)
}

export function createDesktopCoverBridge({
  createWorker, decode, modelBase = MODEL_BASE, threads = 1, batch = 8, idleMs = 60_000, decodeTimeoutMs = 60_000, fetchImpl = globalThis.fetch,
  setTimer = setTimeout, clearTimer = clearTimeout, uuid = () => crypto.randomUUID()
} = {}) {
  const listeners = new Set()
  const staged = new Map()
  let worker = null
  let idleTimer = null
  let job = null            // { id, token, controller }
  let decoding = null       // Web Audio keeps decoding even after the job is cancelled
  let counter = 0
  let available

  const emit = (event) => { for (const fn of [...listeners]) fn(event) }
  const endWorker = () => { clearTimer(idleTimer); idleTimer = null; if (worker) { worker.terminate(); worker = null } }
  const scheduleIdle = () => { clearTimer(idleTimer); if (idleMs > 0) idleTimer = setTimer(() => { if (!job) endWorker() }, idleMs) }

  function ensureWorker() {
    if (worker) return worker
    worker = createWorker()
    worker.onmessage = (event) => {
      const m = event.data
      if (!job || m?.jobId !== job.id) return
      if (m.type === 'progress') emit({ kind: 'coverProgress', jobId: m.jobId, done: m.done, total: m.total })
      else if (m.type === 'done') finish({ kind: 'coverDone', jobId: m.jobId, duration: m.duration, notes: m.notes, metrics: m.metrics })
      else if (m.type === 'error') finish({ kind: 'coverError', jobId: m.jobId, message: m.message })
    }
    worker.onerror = (event) => {
      endWorker()
      // only a job that was handed to this worker can have crashed it; one still decoding gets a fresh worker
      if (job?.sent) finish({ kind: 'coverError', jobId: job.id, message: 'Could not generate a piano cover for this file' })
      event?.preventDefault?.()
    }
    return worker
  }

  function finish(event) {
    const done = job
    job = null
    scheduleIdle()
    if (done) emit(event)
  }

  async function run(current, { genre, difficulty, overlap }) {
    if (job !== current || current.controller.signal.aborted) return      // cancelled before it began
    const file = current.file
    try {
      if (decoding) await decoding.catch(() => {})
      if (job !== current) return
      emit({ kind: 'coverProgress', jobId: current.id, done: 0, total: 0 })
      current.controller.signal.throwIfAborted()
      const decodeMs = Number.isFinite(decodeTimeoutMs) ? decodeTimeoutMs : 60_000
      let decodeTimer
      const rawWork = Promise.resolve(decode(file, current.controller.signal))
      const work = decoding = (decodeMs > 0
        ? Promise.race([rawWork, new Promise((_, reject) => {
          decodeTimer = setTimeout(() => {
            console.warn?.('Keylight desktop cover decode timed out after ' + decodeMs + ' ms; releasing slot')
            reject(new Error('This audio file took too long to decode. Try another file or convert it to mp3, m4a or wav.'))
          }, decodeMs)
          decodeTimer.unref?.()
        })]).finally(() => clearTimeout(decodeTimer))
        : rawWork)
      let pcm
      try { pcm = await work }
      finally { if (decoding === work) decoding = null }
      current.controller.signal.throwIfAborted()
      if (!pcm.length) throw new Error('That audio file is empty')
      if (pcm.length / SAMPLE_RATE > MAX_SECONDS) throw new Error('Recordings up to 20 minutes can be added')
      if (job !== current) return
      clearTimer(idleTimer)
      current.sent = true
      ensureWorker().postMessage({ type: 'start', jobId: current.id, pcm, genre, difficulty, overlap, modelBase, threads, batch }, [pcm.buffer])
    } catch (error) {
      if (job !== current || current.controller.signal.aborted) return
      finish({ kind: 'coverError', jobId: current.id, message: error?.message || 'Could not decode that audio file' })
    }
  }

  const bridge = {
    // the page's file picker or drop: keep the File under a token, as IncomingStore keeps a staged file
    stage(file) {
      const token = `desk-${Date.now().toString(36)}-${(++counter).toString(36)}-${uuid().replace(/-/g, '').slice(0, 12)}`
      staged.set(token, file)
      return token
    },
    release(token) { staged.delete(token) },

    // nativeRequest(op, args, timeoutMs) lookalike
    async request(op, args = {}) {
      if (op === 'coverStart') {
        if (!TOKEN.test(args.token || '') || !staged.has(args.token)) throw new Error('File not found')
        if (job) throw new Error('busy')
        const current = { id: uuid(), token: args.token, file: staged.get(args.token), controller: new AbortController(), sent: false }
        job = current
        queueMicrotask(() => { void run(current, { genre: args.genre || 'pop', difficulty: args.difficulty || 'intermediate', overlap: args.overlap || 0 }) })
        return current.id
      }
      if (op === 'coverCancel') {
        if (job && job.id === args.jobId) {
          const cancelled = job
          job = null
          cancelled.controller.abort()
          if (cancelled.sent) worker?.postMessage({ type: 'cancel', jobId: cancelled.id })     // the worker has never heard of a job still decoding
          scheduleIdle()
        }
        return true
      }
      throw new Error('Unknown request ' + op)
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },

    // true when the model files are installed (a build without them keeps Basic Pitch)
    available() {
      available ||= Promise.resolve().then(async () => {
        try {
          const response = await fetchImpl(modelBase + 'manifest.json')
          if (!response.ok) return false
          const manifest = await response.json()
          return !!(manifest?.files?.encoder?.sha256 && manifest?.files?.decoder?.sha256)
        } catch { return false }
      })
      return available
    },
    dispose() { job?.controller.abort(); job = null; endWorker(); listeners.clear(); staged.clear() },
    get busy() { return !!job },
    get workerAlive() { return !!worker }
  }
  bridge.request = bridge.request.bind(bridge)
  bridge.subscribe = bridge.subscribe.bind(bridge)
  return bridge
}
