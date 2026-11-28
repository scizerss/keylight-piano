// Dedicated worker for the desktop piano cover: onnxruntime-web (WebAssembly, SIMD) runs the Music2MIDI encoder and the
// KV-cached decoder, renderer/piano-cover-core.js does everything around them. The page never holds the model.
//
//   in : { type: 'start', jobId, pcm: Float32Array (16 kHz mono, transferred), genre, difficulty, overlap, modelBase, threads, batch }
//        { type: 'cancel', jobId }       the decode loop sees it before the next token
//        (start with debug: true also sends { type: 'tokens', jobId, index, tokens } per chunk, for the parity checks)
//        { type: 'ping' }                answered with { type: 'ready' }
//   out: { type: 'progress', jobId, done, total } | { type: 'done', jobId, notes, duration, metrics } |
//        { type: 'error', jobId, message, code }   (a cancelled job sends nothing, like coverCancel on iOS)
import * as ort from './vendor/onnxruntime-web/ort.wasm.min.mjs'
import { runPianoCover, CoverError } from './piano-cover-core.js'
import { createOrtRunner, makeYielder, SESSION_OPTIONS } from './piano-cover-runner.js'

const ORT_DIR = new URL('./vendor/onnxruntime-web/', import.meta.url).href

let sessions = null          // { encoder, decoder, threads }
let loading = null
let job = null               // { id, controller, finished }
const waiting = new Map()    // starts that wait for a cancelled job to unwind: jobId -> { aborted }
const yieldToEvents = makeYielder()

const hex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('')

async function fetchVerified(base, entry) {
  const response = await fetch(base + entry.name)
  if (!response.ok) throw new CoverError('Could not load the piano cover model', 'model-missing')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length !== entry.bytes || hex(await crypto.subtle.digest('SHA-256', bytes)) !== entry.sha256) {
    throw new CoverError('The piano cover model files are damaged. Reinstall Keylight.', 'model-damaged')
  }
  return bytes
}

async function loadSessions(base, threads) {
  if (sessions) return sessions
  loading ||= (async () => {
    const manifestResponse = await fetch(base + 'manifest.json')
    if (!manifestResponse.ok) throw new CoverError('Could not load the piano cover model', 'model-missing')
    const manifest = await manifestResponse.json()
    ort.env.wasm.wasmPaths = { mjs: ORT_DIR + 'ort-wasm-simd-threaded.mjs', wasm: ORT_DIR + 'ort-wasm-simd-threaded.wasm' }
    ort.env.wasm.proxy = false
    ort.env.wasm.numThreads = threads
    const options = SESSION_OPTIONS
    const encoder = await ort.InferenceSession.create(await fetchVerified(base, manifest.files.encoder), options)
    let decoder
    try { decoder = await ort.InferenceSession.create(await fetchVerified(base, manifest.files.decoder), options) } catch (error) { await encoder.release?.(); throw error }
    sessions = { encoder, decoder, threads: ort.env.wasm.numThreads }
    return sessions
  })()
  try { return await loading } catch (error) { throw error instanceof CoverError ? error : new CoverError('Could not load the piano cover model', 'model-load') } finally { loading = null }
}

async function start(message) {
  const { jobId, pcm, genre, difficulty, overlap, modelBase, threads, batch, debug } = message
  // a cancelled job leaves within one decoder step: wait for it instead of refusing the next start
  const entry = { aborted: false }
  waiting.set(jobId, entry)
  try { while (job?.controller.signal.aborted && !entry.aborted) await job.finished } finally { waiting.delete(jobId) }
  if (entry.aborted) return                    // cancelled while it waited
  if (job) { postMessage({ type: 'error', jobId, message: 'busy', code: 'busy' }); return }
  const controller = new AbortController()
  let finish
  job = { id: jobId, controller, finished: new Promise((resolve) => { finish = resolve }) }
  const t0 = performance.now()
  try {
    const loaded = await loadSessions(modelBase, threads)
    controller.signal.throwIfAborted()
    const loadMs = Math.round(performance.now() - t0)
    let chunks = 0
    const { notes, duration } = await runPianoCover(pcm, {
      runner: createOrtRunner(ort, loaded, { breathe: async () => { await yieldToEvents(); controller.signal.throwIfAborted() } }), genre, difficulty, overlap, batch, signal: controller.signal,
      onProgress: (done, total) => { chunks = total; postMessage({ type: 'progress', jobId, done, total }) },
      onTokens: debug ? (index, tokens) => postMessage({ type: 'tokens', jobId, index, tokens }) : undefined
    })
    postMessage({ type: 'done', jobId, notes, duration, metrics: { elapsedMs: Math.round(performance.now() - t0), loadMs, chunks, threads: loaded.threads } })
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') return
    const known = error instanceof CoverError
    postMessage({ type: 'error', jobId, message: known ? error.message : 'Could not generate a piano cover for this file', code: known ? error.code : 'inference' })
  } finally { job = null; finish() }
}

self.onmessage = (event) => {
  const message = event.data
  if (message?.type === 'start') void start(message)
  else if (message?.type === 'cancel') {
    if (job && job.id === message.jobId) job.controller.abort()
    else if (waiting.has(message.jobId)) waiting.get(message.jobId).aborted = true      // unknown or finished ids are ignored
  }
  else if (message?.type === 'ping') postMessage({ type: 'ready' })
}
