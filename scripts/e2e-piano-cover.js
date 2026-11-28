// End-to-end run of the desktop piano cover in headless Electron: the real worker (onnxruntime-web), the real model files
// and Chromium's own audio decoder, timed, with the process memory sampled. Not part of `npm test` (it needs the model cache).
//
//   npx electron --no-sandbox --ozone-platform=headless scripts/e2e-piano-cover.js -- --song song.mp3 \
//       [--reference song.reference.json --pcm song.pcm16k.f32] [--threads 4] [--batch 8] [--seconds 60] [--no-import] [--out result.json]
//
// Part 1 (needs --reference and --pcm, written by tools/music2midi/dump_reference_tokens.py): the worker gets the reference
//   PCM and its chunk tokens are compared with PyTorch's.
// Part 2: the whole import (Web Audio decode, worker, arranger) of the song, through the same bridge the app uses.
const { app, BrowserWindow, protocol } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { Readable } = require('node:stream')
const scheme = require('../renderer/app-scheme.cjs')

const argv = process.argv.slice(process.argv.indexOf('--') + 1)
function profile0() { return argv.includes('--profile') ? __filename : '' }
const arg = (name, fallback = '') => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : fallback }
const song = arg('song', profile0())
if (!song) { console.error('--song <audio file> is required'); process.exit(2) }
const threads = Number(arg('threads', '4'))
const seconds = Number(arg('seconds', '0'))
const batch = Number(arg('batch', '8'))
const reference = arg('reference')
const pcm = arg('pcm')
const out = arg('out')
const skipImport = argv.includes('--no-import')
const profile = argv.includes('--profile')
const compare = argv.includes('--compare')
const noise = argv.includes('--noise-test')
const sessionOptions = arg('session-options') ? JSON.parse(arg('session-options')) : null
const modelRoot = process.env.KEYLIGHT_COVER_MODELS || path.join(__dirname, '..', 'tools', 'music2midi', '.cache', 'onnx')
const files = { '/__e2e/song': song, '/__e2e/reference.json': reference, '/__e2e/pcm.f32': pcm }

protocol.registerSchemesAsPrivileged([{ scheme: scheme.SCHEME, privileges: scheme.PRIVILEGES }])

const PAGE = `(async (cfg) => {
  const base = 'keylight://app/'
  const core = await import(base + 'piano-cover-core.js')
  const { createDesktopCoverBridge, decodeToMono16k } = await import(base + 'piano-cover-desktop.js')
  const { generatePianoCover } = await import(base + 'piano-cover-import.js')
  const { importFile, decodeFileAudio } = await import(base + 'importer.js')
  const result = { threads: cfg.threads, batch: cfg.batch, crossOriginIsolated: self.crossOriginIsolated, sab: typeof SharedArrayBuffer }
  const newWorker = () => new Worker(base + 'piano-cover-worker.js', { type: 'module' })
  if (cfg.profile) {
    // encoder and decoder step cost by batch size, on this thread (no worker)
    const ort = await import(base + 'vendor/onnxruntime-web/ort.wasm.min.mjs')
    const { createOrtRunner, SESSION_OPTIONS } = await import(base + 'piano-cover-runner.js')
    ort.env.wasm.wasmPaths = { mjs: base + 'vendor/onnxruntime-web/ort-wasm-simd-threaded.mjs', wasm: base + 'vendor/onnxruntime-web/ort-wasm-simd-threaded.wasm' }
    ort.env.wasm.proxy = false
    ort.env.wasm.numThreads = cfg.threads
    const get = async (n) => new Uint8Array(await (await fetch(base + 'cover-models/' + n)).arrayBuffer())
    const opts = { ...SESSION_OPTIONS, ...(cfg.sessionOptions || {}) }
    const encoder = await ort.InferenceSession.create(await get('encoder.onnx'), opts)
    const decoder = await ort.InferenceSession.create(await get('decoder.onnx'), opts)
    const runner = createOrtRunner(ort, { encoder, decoder })
    const mel = new Float32Array(188 * 384).map((_, i) => Math.sin(i / 97) * 3 - 5)
    result.ortThreads = ort.env.wasm.numThreads
    result.profile = []
    for (const B of [1, 4, 8]) {
      let t = performance.now()
      const session = await runner.begin(Array.from({ length: B }, () => mel), [1, 1])
      const encMs = performance.now() - t
      t = performance.now()
      let tok = Array(B).fill(1)
      for (let i = 0; i < 40; i++) { const l = await session.step(tok); tok = l.map(() => 133 + (i % 40)) }
      result.profile.push({ batch: B, encoderMs: Math.round(encMs), encoderPerChunkMs: Math.round(encMs / B), decoderStepMs: +((performance.now() - t) / 40).toFixed(1) })
      session.close()
    }
    return result
  }
  const songBlob = await (await fetch(base + '__e2e/song')).blob()
  if (cfg.noise) {
    // how much does a small change in the audio move the notes? the reference PCM against the same PCM plus noise at -26 dB
    const f1 = (a, b, tol) => {
      const used = new Set(); let hit = 0
      for (const x of a) { const j = b.findIndex((y, k) => !used.has(k) && y.pitch === x.pitch && Math.abs(y.start - x.start) <= tol); if (j >= 0) { used.add(j); hit++ } }
      const p = hit / a.length, r = hit / b.length
      return +(2 * p * r / (p + r)).toFixed(3)
    }
    const run = async (samples) => {
      const worker = newWorker()
      const done = await new Promise((resolve, reject) => {
        worker.onmessage = (e) => { if (e.data.type === 'done') resolve(e.data); else if (e.data.type === 'error') reject(new Error(e.data.message)) }
        worker.postMessage({ type: 'start', jobId: 'n', pcm: samples, genre: 'pop', difficulty: 'intermediate', overlap: 0, modelBase: base + 'cover-models/', threads: cfg.threads, batch: cfg.batch }, [samples.buffer])
      })
      worker.terminate()
      return done.notes
    }
    const full = new Float32Array(await (await fetch(base + '__e2e/pcm.f32')).arrayBuffer())
    const clean = full.slice(0, 16000 * (cfg.seconds || 30))
    let power = 0
    for (const v of clean) power += v * v
    const sigma = Math.sqrt(power / clean.length / 10 ** 2.6)
    let seed = 12345
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
    const noisy = clean.map((v) => v + sigma * (rand() + rand() + rand() + rand() - 2) * 1.7320508)
    const a = await run(clean.slice()), b = await run(noisy)
    result.noiseTest = { notesClean: a.length, notesNoisy: b.length, f1Tol50ms: f1(a, b, 0.0501), f1Tol100ms: f1(a, b, 0.1001) }
    return result
  }
  if (cfg.compare) {
    // Chromium's decode of the song against the PCM the PyTorch reference used: alignment, gain and residual
    const ref = new Float32Array(await (await fetch(base + '__e2e/pcm.f32')).arrayBuffer())
    const ours = await decodeToMono16k(new File([songBlob], cfg.name), null, decodeFileAudio)
    const from = 16000 * 20, len = 16000 * 4, max = 4096
    let best = -Infinity, lag = 0
    for (let l = -max; l <= max; l += 1) {
      let dot = 0
      for (let i = 0; i < len; i += 2) dot += ref[from + i] * (ours[from + i + l] || 0)
      if (dot > best) { best = dot; lag = l }
    }
    let num = 0, den = 0, err = 0, sig = 0
    for (let i = 0; i < len; i++) { const a = ref[from + i], b = ours[from + i + lag] || 0; num += a * b; den += b * b; sig += a * a }
    const gain = num / den
    for (let i = 0; i < len; i++) { const e = ref[from + i] - gain * (ours[from + i + lag] || 0); err += e * e }
    result.compare = { refSamples: ref.length, oursSamples: ours.length, lagSamples: lag, gainRefOverOurs: +gain.toFixed(4), residualSnrDb: +(10 * Math.log10(sig / err)).toFixed(1) }
    return result
  }

  if (cfg.reference) {
    const ref = await (await fetch(base + '__e2e/reference.json')).json()
    let samples = new Float32Array(await (await fetch(base + '__e2e/pcm.f32')).arrayBuffer())
    if (cfg.seconds) samples = samples.slice(0, cfg.seconds * 16000)
    const worker = newWorker()
    const tokens = new Map()
    const t0 = performance.now()
    const done = await new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        const m = e.data
        if (m.type === 'tokens') tokens.set(m.index, m.tokens)
        else if (m.type === 'done') resolve(m)
        else if (m.type === 'error') reject(new Error(m.message))
      }
      worker.onerror = (e) => reject(new Error('worker error ' + e.message))
      worker.postMessage({ type: 'start', jobId: 'parity', pcm: samples, genre: ref.genre, difficulty: ref.difficulty, overlap: 0, modelBase: base + 'cover-models/', threads: cfg.threads, batch: cfg.batch, debug: true }, [samples.buffer])
    })
    worker.terminate()
    result.tokenCounts = [...tokens].map(([i, t]) => t ? t.length : 0)
    result.referenceCounts = [...tokens.keys()].map((i) => ref.tokens[i].indexOf(2) >= 0 ? ref.tokens[i].indexOf(2) + 1 : ref.tokens[i].length)
    let exact = 0, prefix = 0, silent = 0, mismatch = 0, silentNonEmpty = 0, notesIdentical = 0
    const bad = []
    for (const [index, ours] of tokens) {
      let want = ref.tokens[index]
      const stop = want.indexOf(2)                                                                // batched PyTorch pads finished chunks with 0 after EOS
      if (stop >= 0) want = want.slice(0, stop + 1)
      if (ours !== null && JSON.stringify(core.detokenize(ours, { maxLength: core.MAX_LENGTH })) === JSON.stringify(core.detokenize(ref.tokens[index], { maxLength: core.MAX_LENGTH }))) notesIdentical++
      if (ours === null) { silent++; if (want.length > 4) silentNonEmpty++; continue }
      if (ours.length === want.length && ours.every((t, i) => t === want[i])) exact++
      else if (ours.length < want.length && ours.every((t, i) => t === want[i])) prefix++      // our runaway guard stopped it early
      else { mismatch++; bad.push(index) }
    }
    result.parity = { chunks: tokens.size, referenceChunks: ref.tokens.length, exact, prefixAfterRunawayStop: prefix, notesIdentical, silentSkipped: silent, silentButReferenceHadNotes: silentNonEmpty, mismatch, mismatchedChunks: bad.slice(0, 20) }
    result.parityRun = { wallMs: Math.round(performance.now() - t0), loadMs: done.metrics.loadMs, notes: done.notes.length, duration: done.duration, chunks: done.metrics.chunks, ortThreads: done.metrics.threads }
    result.referenceNotes = done.notes
  }

  if (cfg.skipImport) { delete result.referenceNotes; return result }
  // part 2: the song through the bridge, importFile and the arranger, like Add a song does
  const bridge = createDesktopCoverBridge({ createWorker: newWorker, threads: cfg.threads, batch: cfg.batch,
    decode: (file, signal) => decodeToMono16k(file, signal, decodeFileAudio) })
  result.available = await bridge.available()
  const file = new File([songBlob], cfg.name, { type: 'audio/mpeg' })
  const token = bridge.stage(file)
  const progress = []
  let rawFromWebAudio = null
  const t1 = performance.now()
  const song = await importFile(file, { lookup: false, simplify: false, ctx: null, onStage: () => {}, cover: {
    generate: async (options) => {
      const made = await generatePianoCover(token, { ...options, request: bridge.request, subscribe: bridge.subscribe, onProgress: (p) => progress.push(p) })
      rawFromWebAudio = made.notes
      return made
    },
    difficulty: 'easy', keyRange: () => ({ lo: 21, hi: 108 }) } })
  result.importRun = { wallMs: Math.round(performance.now() - t1), rawNotes: song.coverRaw.length, arrangedNotes: song.notes.length, duration: song.duration, tempo: Math.round(song.tempo), progressEvents: progress.length }
  if (result.referenceNotes) {
    // onset/pitch agreement of the Web Audio run with the run on the reference PCM (50 ms)
    const a = rawFromWebAudio.map((n) => [n.pitch, n.start]), b = result.referenceNotes.map((n) => [n.pitch, n.start])
    const used = new Set(); let hit = 0
    for (const [p, s] of a) { const j = b.findIndex(([bp, bs], k) => !used.has(k) && bp === p && Math.abs(bs - s) <= 0.05); if (j >= 0) { used.add(j); hit++ } }
    const precision = hit / a.length, recall = hit / b.length
    result.webAudioVsReferencePcm = { onsetPitchF1: +(2 * precision * recall / (precision + recall)).toFixed(4), ours: a.length, reference: b.length }
    delete result.referenceNotes
  }
  bridge.dispose()
  return result
})`

let peakTotalKb = 0
const peakByType = {}
let peakRss = 0
function sample() {
  const metrics = app.getAppMetrics()
  const total = metrics.reduce((sum, m) => sum + (m.memory.workingSetSize || 0), 0)
  peakTotalKb = Math.max(peakTotalKb, total)
  for (const m of metrics) peakByType[m.type] = Math.max(peakByType[m.type] || 0, m.memory.workingSetSize || 0)
  peakRss = Math.max(peakRss, process.memoryUsage().rss / 1024)
}

app.whenReady().then(async () => {
  const handler = scheme.createAppHandler({ root: path.join(__dirname, '..', 'renderer'), Readable, modelRoot })
  protocol.handle(scheme.SCHEME, (request) => {
    const url = new URL(request.url)
    const file = files[url.pathname]
    if (file) return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { 'Content-Type': 'application/octet-stream', ...scheme.ISOLATION_HEADERS } })
    return handler(request)
  })
  const win = new BrowserWindow({ width: 900, height: 600, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  win.webContents.setAudioMuted(true)
  win.webContents.on('console-message', (e) => { const text = e.message ?? e; if (/^COVER|thread|WebAssembly|onnx/i.test(text)) console.log('PAGE ' + text.slice(0, 300)) })
  await win.loadURL('keylight://app/models/basic-pitch/model.json')
  const timer = setInterval(sample, 250)
  const t0 = Date.now()
  try {
    const result = await win.webContents.executeJavaScript(`${PAGE}(${JSON.stringify({ threads, batch, seconds, reference: !!reference, name: path.basename(song), skipImport, profile, compare, noise, sessionOptions })})`)
    sample()
    result.totalWallMs = Date.now() - t0
    result.peakMemoryMB = { allProcesses: Math.round(peakTotalKb / 1024), byProcess: Object.fromEntries(Object.entries(peakByType).map(([k, v]) => [k, Math.round(v / 1024)])) }
    result.song = path.basename(song)
    const text = JSON.stringify(result, null, 2)
    console.log('E2E_RESULT ' + JSON.stringify(result))
    if (out) fs.writeFileSync(out, text + '\n')
    clearInterval(timer)
    app.exit(0)
  } catch (error) {
    console.error('E2E_FAIL ' + (error && error.stack || error))
    clearInterval(timer)
    app.exit(1)
  }
})
