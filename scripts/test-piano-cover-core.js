// node --test scripts/test-piano-cover-core.js
// The desktop piano cover pipeline (renderer/piano-cover-core.js) without a browser: mel front end against the PyTorch
// fixture of the iOS tests, silence gate, the token reader and its five runaway stops, chunk plan, seam stitching,
// cancellation. The last test runs the real ONNX models through onnxruntime-web (one WASM thread) when the model cache exists
// (tools/music2midi/fetch-and-build-onnx.sh) and compares the tokens with PyTorch's.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '..')
const FIXTURES = path.join(ROOT, 'ios', 'KeylightTests', 'Fixtures')
const load = () => import('../renderer/piano-cover-core.js')

const T = (i) => 133 + i       // time token, 50 ms steps
const P = (p) => 5 + p         // pitch token
const ON = 3, OFF = 4, BOS = 1, EOS = 2

function fixturePcm() {
  const wav = fs.readFileSync(path.join(FIXTURES, 'golden_3s.wav'))
  return Float32Array.from(new Int16Array(wav.buffer, wav.byteOffset + 44, 48000), (v) => v / 32768)
}
const golden = () => JSON.parse(fs.readFileSync(path.join(FIXTURES, 'golden_3s.json'), 'utf8'))

// A runner that answers with a fixed token list, so the decode loop can be checked without a model. `script` is one list
// for every chunk of a batch, or a list of lists (one per chunk).
function scriptedRunner(script, log = {}) {
  log.begins = 0; log.steps = 0; log.closed = 0; log.inputs = []
  return {
    async begin(mels) {
      log.begins++
      log.batch = mels.length
      const at = mels.map(() => 0)
      return {
        async step(tokens) {
          log.steps++
          log.lastInput = tokens[0]
          log.inputs.push([...tokens])
          return tokens.map((_, b) => {
            const own = Array.isArray(script[0]) ? script[b] : script
            const logits = new Float32Array(400)
            logits[own[Math.min(at[b]++, own.length - 1)]] = 5
            return logits
          })
        },
        close() { log.closed++ }
      }
    }
  }
}

test('log-mel matches the PyTorch fixture', async () => {
  const { logMel, N_FRAMES, N_MELS } = await load()
  const ref = new Float32Array(fs.readFileSync(path.join(FIXTURES, 'golden_3s_mel.bin')).buffer.slice(0))
  const mel = logMel(fixturePcm())
  assert.equal(mel.length, N_FRAMES * N_MELS)
  assert.equal(mel.length, ref.length)
  let max = 0, sum = 0
  for (let i = 0; i < mel.length; i++) { const d = Math.abs(mel[i] - ref[i]); if (d > max) max = d; sum += d }
  const mean = sum / mel.length
  console.log(`mel parity: max abs ${max.toFixed(5)}, mean abs ${mean.toExponential(2)}`)
  assert.ok(max < 0.01, 'max error ' + max)
  assert.ok(mean < 1e-4, 'mean error ' + mean)
})

test('log-mel zero pads a short input and is the floor for silence', async () => {
  const { logMel, N_FRAMES, N_MELS, LOG_FLOOR } = await load()
  const mel = logMel(new Float32Array(1000))
  assert.equal(mel.length, N_FRAMES * N_MELS)
  assert.ok(mel.every((v) => Math.abs(v - Math.log(LOG_FLOOR)) < 1e-6))
  const short = logMel(fixturePcm().subarray(0, 24000))
  const full = logMel(fixturePcm())
  assert.ok(Math.abs(short[0] - full[0]) < 0.5, 'the first frame of a short input is read from the same audio')
})

test('silence gate: -55 dBFS RMS', async () => {
  const { rmsDbfs, isSilent } = await load()
  assert.equal(rmsDbfs(new Float32Array(0)), -Infinity)
  assert.equal(rmsDbfs(new Float32Array(100)), -Infinity)
  assert.ok(isSilent(new Float32Array(48000)))
  const tone = (amp) => Float32Array.from({ length: 48000 }, (_, i) => amp * Math.sin(i / 7))
  assert.ok(isSilent(tone(0.0005)), '-69 dBFS peak is below the gate')
  assert.ok(!isSilent(tone(0.01)), '-37 dBFS peak is above it')
  assert.ok(Math.abs(rmsDbfs(Float32Array.from({ length: 1000 }, () => 0.1)) - -20) < 1e-6)
})

test('detokenize: notes, offsets and held notes closed at the chunk end', async () => {
  const { detokenize } = await load()
  const notes = detokenize([BOS, T(2), ON, P(60), T(10), OFF, P(60), T(12), ON, P(64), EOS])
  assert.deepEqual(notes.map((n) => [n.pitch, +n.start.toFixed(2), +n.end.toFixed(2), n.closed]), [[60, 0.1, 0.5, false], [64, 0.6, 3, true]])
  assert.deepEqual(detokenize([BOS, T(12), ON, P(64), EOS], { closeHeld: false }), [])
  assert.deepEqual(detokenize([T(2), ON, P(61), EOS]).map((n) => n.pitch), [61], 'a missing BOS is fine')
  // two simultaneous notes, the second pitch token arriving before its onset flag does not make a note
  assert.deepEqual(detokenize([BOS, T(0), ON, P(60), P(64), T(4), OFF, P(60), P(64), EOS]).map((n) => n.pitch), [60, 64])
  // an offset only closes a note that started earlier
  assert.deepEqual(detokenize([BOS, T(4), ON, P(60), OFF, P(60), T(8), OFF, P(60), EOS]).map((n) => +n.end.toFixed(2)), [0.4])
})

test('the five runaway stops', async () => {
  const { createGuard, detokenize, TOKEN } = await load()
  const run = (tokens, maxLength = 320) => { const g = createGuard(maxLength); return tokens.map((t, step) => g.observe(t, step)) }
  // 1. a time index past 62
  assert.equal(run([T(10), ON, T(63)]).pop(), 'runaway:time-range')
  assert.equal(run([T(62)]).pop(), 'go')
  // 2. the time index going backwards
  assert.equal(run([T(10), T(5)]).pop(), 'runaway:time-backwards')
  assert.equal(run([T(10), T(10)]).pop(), 'go', 'the same time twice is not backwards')
  // 3. more than 32 tokens at one time
  const crowd = [T(1), ...Array.from({ length: 33 }, (_, i) => P(i))]
  assert.equal(run(crowd).slice(-2).join(), 'go,runaway:tokens-at-time')
  assert.equal(run(crowd.slice(0, 33)).pop(), 'go', '32 is allowed')
  // 4. the same token eight times
  assert.equal(run([T(1), ON, ...Array(8).fill(P(60))]).pop(), 'runaway:repeat')
  assert.equal(run([T(1), ON, ...Array(7).fill(P(60))]).pop(), 'go')
  // 5. the length limit (the sequence includes BOS, so step 318 is the last one a 320 cache can hold)
  assert.equal(createGuard(320).observe(T(1), 318), 'runaway:max-length')
  assert.equal(createGuard(320).observe(T(1), 317), 'go')
  assert.equal(createGuard(320).observe(TOKEN.eos, 5), 'eos')
  // a runaway chunk closes held notes at the last time token instead of the chunk end
  const notes = detokenize([BOS, T(5), ON, P(60), T(20), ...Array(8).fill(P(61))], { maxLength: 320 })
  assert.deepEqual(notes.map((n) => [n.pitch, +n.start.toFixed(2), +n.end.toFixed(2), n.closed]), [[60, 0.25, 1, false]])
  // tokens after the stop are never read
  assert.deepEqual(detokenize([BOS, T(2), ON, P(60), T(8), T(63), T(9), ON, P(62), T(12), OFF, P(62)]).map((n) => [n.pitch, +n.end.toFixed(2)]), [[60, 0.4]], 'a note left open by a runaway ends at the last good time token')
})

test('decodeChunk follows the script, stops on EOS and on a runaway, and closes the session', async () => {
  const { decodeChunk } = await load()
  const log = {}
  const tokens = await decodeChunk(scriptedRunner([T(2), ON, P(60), T(8), OFF, P(60), EOS], log), new Float32Array(10), [1, 1])
  assert.deepEqual(tokens, [BOS, T(2), ON, P(60), T(8), OFF, P(60), EOS])
  assert.equal(log.steps, 7)
  assert.equal(log.lastInput, P(60), 'each step is fed the token before it')
  assert.deepEqual([log.begins, log.closed], [1, 1])
  const loop = {}
  const stuck = await decodeChunk(scriptedRunner([T(1), ON, P(60)], loop), new Float32Array(10), [1, 1])
  assert.equal(stuck.length, 1 + 2 + 8, 'BOS, time, onset, then the repeated pitch token is cut after eight in a row')
  assert.ok(loop.steps < 20)
  const endless = {}
  const forever = await decodeChunk(scriptedRunner(Array.from({ length: 400 }, (_, i) => (i % 2 ? P(60 + (i % 7)) : T(Math.min(Math.floor(i / 8), 60)))), endless), new Float32Array(10), [1, 1], { maxLength: 40 })
  assert.ok(forever.length <= 40, 'the length limit applies')
})

test('decodeBatch: every chunk stops on its own, finished ones are fed PAD, batches run to the slowest', async () => {
  const { decodeBatch, runPianoCover } = await load()
  const log = {}
  const tokens = await decodeBatch(scriptedRunner([[T(1), ON, P(60), EOS], [T(1), ON, P(61), T(2), OFF, P(61), T(3), ON, P(62), EOS], [T(1), ON, P(60)]], log), [new Float32Array(1), new Float32Array(1), new Float32Array(1)], [1, 1])
  assert.deepEqual(tokens[0], [BOS, T(1), ON, P(60), EOS])
  assert.equal(tokens[1].at(-1), EOS)
  assert.equal(tokens[1].length, 11)
  assert.equal(tokens[2].length, 11, 'the third runs away after eight repeats')
  assert.equal(log.batch, 3)
  assert.deepEqual(log.inputs[0], [BOS, BOS, BOS])
  assert.equal(log.inputs[4][0], 0, 'a finished chunk is fed PAD')
  assert.equal(log.steps, 10)
  // a batched job gives the same notes as one chunk at a time
  const tone = (len) => Float32Array.from({ length: len }, (_, i) => 0.2 * Math.sin(i / 5))
  const pcm = new Float32Array(48000 * 5)
  pcm.set(tone(48000 * 2), 0)
  pcm.set(tone(48000 * 2), 48000 * 3)
  const script = [T(2), ON, P(60), T(10), OFF, P(60), EOS]
  const one = await runPianoCover(pcm, { runner: scriptedRunner(script), batch: 1 })
  const eight = {}
  const many = await runPianoCover(pcm, { runner: scriptedRunner(script, eight), batch: 8 })
  assert.deepEqual(many, one)
  assert.equal(eight.begins, 1, 'one model call for the whole group')
  assert.equal(eight.batch, 4, 'the silent chunk is left out of the batch')
})

test('cancel lands before the next token and before the next chunk', async () => {
  const { decodeChunk, runPianoCover } = await load()
  const controller = new AbortController()
  const log = {}
  const runner = scriptedRunner(Array.from({ length: 200 }, (_, i) => (i % 4 === 0 ? T(i / 4) : [0, ON, P(60 + (i % 7)), OFF][i % 4])), log)
  const original = runner.begin
  runner.begin = async (...a) => {
    const session = await original(...a)
    return { step: async (t) => { const v = await session.step(t); if (log.steps === 5) controller.abort(); return v }, close: () => session.close() }
  }
  await assert.rejects(decodeChunk(runner, new Float32Array(10), [1, 1], { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(log.steps, 5, 'no token is decoded after the cancel')
  assert.equal(log.closed, 1, 'the session is closed')

  const before = new AbortController(); before.abort()
  const idle = {}
  await assert.rejects(runPianoCover(Float32Array.from({ length: 96000 }, (_, i) => 0.2 * Math.sin(i / 5)), { runner: scriptedRunner([EOS], idle), signal: before.signal }), { name: 'AbortError' })
  assert.equal(idle.begins, 0)

  const between = new AbortController()
  const chunkLog = {}
  const progress = []
  await assert.rejects(runPianoCover(Float32Array.from({ length: 144000 }, (_, i) => 0.2 * Math.sin(i / 5)), {
    runner: scriptedRunner([T(1), ON, P(60), EOS], chunkLog), signal: between.signal,
    onProgress: (done, total) => { progress.push([done, total]); if (done === 1) between.abort() }
  }), { name: 'AbortError' })
  assert.deepEqual(progress, [[0, 3], [1, 3]])
  assert.equal(chunkLog.begins, 1, 'the second chunk never starts')
})

test('a cancel message that is already waiting is seen between decoder steps, which plain awaits would never allow', async () => {
  const { makeYielder } = await import('../renderer/piano-cover-runner.js')
  const waiting = () => {
    const { port1, port2 } = new MessageChannel()
    const seen = { got: false }
    port1.onmessage = () => { seen.got = true }
    port2.postMessage('cancel')
    return { seen, close: () => { port1.close(); port2.close() } }
  }
  const starved = waiting()
  for (let i = 0; i < 200; i++) await Promise.resolve()
  assert.equal(starved.seen.got, false, 'microtasks alone starve the event loop (what a worker running a job does)')
  const breathing = waiting()
  const breathe = makeYielder()
  await breathe()
  assert.equal(breathing.seen.got, true, 'one yield lets the waiting message run')
  starved.close(); breathing.close()
})

test('chunk plan matches the iOS reader', async () => {
  const { planChunks } = await load()
  const plan = (n, o) => planChunks(n, o).map((c) => [c.start, c.length])
  assert.deepEqual(plan(0, 0), [])
  assert.deepEqual(plan(1, 0), [[0, 1]])
  assert.deepEqual(plan(48000, 0), [[0, 48000]])
  assert.deepEqual(plan(48001, 0), [[0, 48000], [48000, 1]])
  assert.deepEqual(plan(96000, 0), [[0, 48000], [48000, 48000]])
  assert.deepEqual(plan(100000, 50), [[0, 48000], [24000, 48000], [48000, 48000], [72000, 28000]])
  assert.deepEqual(plan(96000, 50), [[0, 48000], [24000, 48000], [48000, 48000]])
  assert.deepEqual(plan(100000, 25).map((c) => c[0]), [0, 36000, 72000])
  assert.equal(plan(195 * 16000, 0).length, 65)
  assert.throws(() => planChunks(1000, 10), /overlap/)
})

test('stitch: centre windows, seam joins and the duration clamp', async () => {
  const { stitch } = await load()
  const n = (pitch, start, end, closed = false) => ({ pitch, start, end, closed })
  // no overlap: a note held to the end of one chunk and restarted at the top of the next is one note
  assert.deepEqual(stitch([{ offset: 0, notes: [n(60, 2.5, 3, true)] }, { offset: 3, notes: [n(60, 0, 0.5)] }], 0), [{ pitch: 60, start: 2.5, dur: 1 }])
  // a gap above the 55 ms tolerance, or a chunk that did not hold the note to its end, stays two notes
  assert.equal(stitch([{ offset: 0, notes: [n(60, 2.5, 2.9)] }, { offset: 3, notes: [n(60, 0, 0.5)] }], 0).length, 2)
  assert.equal(stitch([{ offset: 0, notes: [n(60, 2.5, 3, true)] }, { offset: 3, notes: [n(60, 0.1, 0.5)] }], 0).length, 2)
  // 50% overlap: only the centre half of every chunk after the first is trusted (0.75 s .. 2.25 s)
  const half = stitch([{ offset: 0, notes: [n(60, 0.2, 0.4), n(62, 2.4, 2.6)] }, { offset: 1.5, notes: [n(62, 0.9, 1.1), n(64, 0.5, 0.7), n(65, 0.8, 1)] }], 50)
  assert.deepEqual(half.map((x) => [x.pitch, +x.start.toFixed(2)]), [[60, 0.2], [65, 2.3], [62, 2.4]], 'chunk 0 drops its trailing margin, chunk 1 its leading margin')
  // the last chunk keeps notes to 0.15 s past its end; everything is clamped to the song length
  const tail = stitch([{ offset: 0, notes: [n(60, 2.9, 3.0)] }], 0, 2.95)
  assert.deepEqual(tail.map((x) => +x.dur.toFixed(2)), [0.05])
  assert.deepEqual(stitch([{ offset: 0, notes: [n(60, 2.99, 3)] }], 0, 2.5), [])
  assert.deepEqual(stitch([], 0), [])
})

test('runPianoCover: scripted chunks to notes, silence skipped, progress and options', async () => {
  const { runPianoCover } = await load()
  const tone = (len) => Float32Array.from({ length: len }, (_, i) => 0.2 * Math.sin(i / 5))
  const pcm = new Float32Array(48000 * 3)
  pcm.set(tone(48000), 0)
  pcm.set(tone(48000), 96000)          // the middle chunk is silent
  const log = {}
  const progress = []
  const result = await runPianoCover(pcm, { runner: scriptedRunner([T(2), ON, P(60), T(10), OFF, P(60), EOS], log), onProgress: (d, t) => progress.push([d, t]) })
  assert.equal(log.begins, 2, 'the silent chunk is not decoded')
  assert.deepEqual(progress, [[0, 3], [1, 3], [2, 3], [3, 3]])
  assert.equal(result.duration, 9)
  assert.deepEqual(result.notes.map((x) => [x.pitch, +x.start.toFixed(2), +x.dur.toFixed(2)]), [[60, 0.1, 0.4], [60, 6.1, 0.4]])
  await assert.rejects(runPianoCover(new Float32Array(0), { runner: scriptedRunner([EOS]) }), /empty/)
  await assert.rejects(runPianoCover(new Float32Array(16000 * 1201), { runner: scriptedRunner([EOS]) }), /20 minutes/)
  await assert.rejects(runPianoCover(pcm, { runner: scriptedRunner([EOS]), genre: 'polka' }), /genre/)
})

// Needs the model cache and the vendored onnxruntime-web; one WASM thread because node cannot start the pthread workers.
const MODELS = path.join(ROOT, 'tools', 'music2midi', '.cache', 'onnx')
const haveModels = fs.existsSync(path.join(MODELS, 'manifest.json'))
test('token parity with PyTorch on the 3-second fixture (real ONNX models)', { skip: !haveModels && 'no model cache: run tools/music2midi/fetch-and-build-onnx.sh', timeout: 120000 }, async () => {
  const crypto = require('node:crypto')
  const ort = await import(pathToFileURL(path.join(ROOT, 'renderer', 'vendor', 'onnxruntime-web', 'ort.wasm.min.mjs')).href)
  const { createOrtRunner, SESSION_OPTIONS } = await import('../renderer/piano-cover-runner.js')
  const { decodeChunk, decodeBatch, logMel, detokenize, GENRES, DIFFICULTIES } = await load()
  const manifest = JSON.parse(fs.readFileSync(path.join(MODELS, 'manifest.json'), 'utf8'))
  const bytes = (entry) => {
    const data = fs.readFileSync(path.join(MODELS, entry.name))
    assert.equal(crypto.createHash('sha256').update(data).digest('hex'), entry.sha256, entry.name + ' matches the manifest')
    return new Uint8Array(data)
  }
  const dir = pathToFileURL(path.join(ROOT, 'renderer', 'vendor', 'onnxruntime-web') + path.sep).href
  ort.env.wasm.numThreads = 1
  ort.env.wasm.proxy = false
  ort.env.wasm.wasmPaths = { mjs: dir + 'ort-wasm-simd-threaded.mjs', wasm: dir + 'ort-wasm-simd-threaded.wasm' }
  const options = SESSION_OPTIONS
  const encoder = await ort.InferenceSession.create(bytes(manifest.files.encoder), options)
  const decoder = await ort.InferenceSession.create(bytes(manifest.files.decoder), options)
  const g = golden()
  assert.equal(GENRES[g.cond_index[0]], g.genre)
  assert.equal(DIFFICULTIES[g.cond_index[1]], g.difficulty)
  const tokens = await decodeChunk(createOrtRunner(ort, { encoder, decoder }), logMel(fixturePcm()), g.cond_index)
  const batched = await decodeBatch(createOrtRunner(ort, { encoder, decoder }), [logMel(fixturePcm()), logMel(fixturePcm())], g.cond_index)
  assert.deepEqual(batched, [g.tokens, g.tokens], 'two copies of the chunk in one batch give the same tokens')
  console.log(`token parity: ${tokens.length} tokens, PyTorch ${g.tokens.length}`)
  assert.deepEqual(tokens, g.tokens)
  assert.ok(detokenize(tokens).length > 5)
})
