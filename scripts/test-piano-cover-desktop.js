// node --test scripts/test-piano-cover-desktop.js
// The desktop cover bridge (renderer/piano-cover-desktop.js) with a fake worker, driven through the same
// generatePianoCover() that drives the iPhone: start, progress, done, error, cancel, one job at a time, idle unload.
const assert = require('node:assert/strict')
const { test } = require('node:test')

const load = (name) => import('../renderer/' + name + '.js')

class FakeWorker {
  constructor() { this.posted = []; this.terminated = false; this.onmessage = null; this.onerror = null }
  postMessage(message) { this.posted.push(message); this.log?.(message) }
  terminate() { this.terminated = true }
  say(data) { this.onmessage({ data }) }
}

async function setup(options = {}) {
  const { createDesktopCoverBridge } = await load('piano-cover-desktop')
  const workers = []
  const timers = []
  const bridge = createDesktopCoverBridge({
    createWorker: () => { const w = new FakeWorker(); workers.push(w); return w },
    decode: options.decode || (async () => new Float32Array(16000 * 6).fill(0.1)),
    setTimer: (fn, ms) => { timers.push({ fn, ms, original: fn }); return timers.length },
    clearTimer: (id) => { if (timers[id - 1]) timers[id - 1].fn = null },
    ...options.bridge
  })
  const file = { name: 'song.mp3', size: 10 }
  return { bridge, workers, timers, file, token: bridge.stage(file) }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const events = (bridge) => { const list = []; bridge.subscribe((e) => list.push(e)); return list }

test('stage gives bridge-shaped tokens and coverStart refuses unknown ones', async () => {
  const { bridge, token } = await setup()
  assert.match(token, /^[A-Za-z0-9-]{8,64}$/)
  assert.notEqual(bridge.stage({}), token)
  await assert.rejects(bridge.request('coverStart', { token: 'does-not-exist-1' }), /File not found/)
  await assert.rejects(bridge.request('coverStart', { token: '../../etc/passwd' }), /File not found/)
  await assert.rejects(bridge.request('nope', {}), /Unknown request/)
  bridge.release(token)
  await assert.rejects(bridge.request('coverStart', { token }), /File not found/)
})

test('a job runs: decode, worker start with the PCM transferred, progress and done events', async () => {
  const { bridge, workers, token } = await setup()
  const seen = events(bridge)
  const jobId = await bridge.request('coverStart', { token, genre: 'pop', difficulty: 'intermediate', overlap: 0 })
  assert.match(jobId, /^[0-9a-f-]{36}$/)
  await tick()
  const [worker] = workers
  assert.equal(worker.posted.length, 1)
  const start = worker.posted[0]
  assert.equal(start.type, 'start')
  assert.equal(start.jobId, jobId)
  assert.equal(start.pcm.length, 96000)
  assert.deepEqual([start.genre, start.difficulty, start.overlap], ['pop', 'intermediate', 0])
  assert.equal(start.modelBase, 'keylight://app/cover-models/')
  worker.say({ type: 'progress', jobId, done: 1, total: 2 })
  worker.say({ type: 'progress', jobId: 'someone-else', done: 2, total: 2 })
  worker.say({ type: 'done', jobId, notes: [{ pitch: 60, start: 0, dur: 1 }], duration: 6, metrics: { elapsedMs: 5 } })
  assert.deepEqual(seen.map((e) => e.kind), ['coverProgress', 'coverProgress', 'coverDone'])
  assert.deepEqual(seen[0], { kind: 'coverProgress', jobId, done: 0, total: 0 })
  assert.deepEqual(seen[2].notes, [{ pitch: 60, start: 0, dur: 1 }])
  assert.equal(bridge.busy, false)
})

test('only one job at a time, and a new one can start once the first has ended', async () => {
  const { bridge, workers, token } = await setup()
  const jobId = await bridge.request('coverStart', { token })
  await assert.rejects(bridge.request('coverStart', { token }), (e) => e.message === 'busy')
  await tick()
  workers[0].say({ type: 'done', jobId, notes: [], duration: 1 })
  const next = await bridge.request('coverStart', { token })
  assert.notEqual(next, jobId)
})

test('generatePianoCover drives the bridge like the iOS host: result, progress, busy mapping', async () => {
  const { generatePianoCover } = await load('piano-cover-import')
  const { bridge, workers, token } = await setup()
  const progress = []
  const result = generatePianoCover(token, { request: bridge.request, subscribe: bridge.subscribe, onProgress: (p) => progress.push(p) })
  await tick(); await tick()
  const start = workers[0].posted[0]
  workers[0].say({ type: 'progress', jobId: start.jobId, done: 1, total: 4 })
  workers[0].say({ type: 'progress', jobId: start.jobId, done: 3, total: 4 })
  const notes = [{ pitch: 64, start: 0.5, dur: 0.4 }]
  workers[0].say({ type: 'done', jobId: start.jobId, notes, duration: 6 })
  assert.deepEqual(await result, { notes, duration: 6, modelDifficulty: 'intermediate' })
  assert.deepEqual(progress, [0.25, 0.75])

  const first = generatePianoCover(token, { request: bridge.request, subscribe: bridge.subscribe })
  await tick(); await tick()
  await assert.rejects(generatePianoCover(token, { request: bridge.request, subscribe: bridge.subscribe }), { name: 'CoverBusyError' })
  workers[0].say({ type: 'done', jobId: workers[0].posted.at(-1).jobId, notes: [{ pitch: 60, start: 0, dur: 1 }], duration: 1 })
  assert.equal((await first).notes.length, 1)
})

test('cancel: aborts the decode, tells the worker, sends no terminal event', async () => {
  const { generatePianoCover } = await load('piano-cover-import')
  let release
  const decode = (file, signal) => new Promise((resolve, reject) => {
    release = resolve
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const { bridge, workers, token } = await setup({ decode })
  const seen = events(bridge)
  const controller = new AbortController()
  const run = generatePianoCover(token, { request: bridge.request, subscribe: bridge.subscribe, signal: controller.signal })
  await tick(); await tick()
  controller.abort()
  await assert.rejects(run, (e) => e.name === 'AbortError')
  await tick()
  assert.equal(bridge.busy, false)
  assert.deepEqual(seen.filter((e) => e.kind !== 'coverProgress'), [], 'no coverDone or coverError for a cancelled job')
  assert.equal(workers.length, 0, 'the worker was never needed')
  release?.(new Float32Array(10))
  await tick()
  assert.equal(workers.length, 0, 'a decode that finishes after the cancel does not start a worker')

  // cancel while the worker is running: the worker is told, later events of that job are ignored
  const second = await bridge.request('coverStart', { token })
  await tick()
  release(new Float32Array(16000))
  await tick()
  assert.equal(workers.length, 1)
  await bridge.request('coverCancel', { jobId: second })
  assert.deepEqual(workers[0].posted.at(-1), { type: 'cancel', jobId: second })
  workers[0].say({ type: 'done', jobId: second, notes: [], duration: 1 })
  assert.deepEqual(seen.filter((e) => e.kind === 'coverDone'), [])
  assert.equal(await bridge.request('coverCancel', { jobId: 'unknown-job' }), true, 'cancelling an unknown job is harmless')
  const third = await bridge.request('coverStart', { token })
  assert.ok(third, 'the bridge is free again straight after a cancel')
})

test('a fresh desktop cover waits for an uncancellable decode to settle', async () => {
  const decodes = []
  const { bridge, workers, token } = await setup({
    decode: () => new Promise((resolve) => decodes.push(resolve))
  })
  const first = await bridge.request('coverStart', { token })
  await tick()
  await bridge.request('coverCancel', { jobId: first })
  const second = await bridge.request('coverStart', { token })
  await tick()
  assert.equal(decodes.length, 1)
  decodes[0](new Float32Array(16000))
  await tick()
  assert.equal(decodes.length, 2)
  assert.equal(workers.length, 0, 'the cancelled decode did not start inference')
  decodes[1](new Float32Array(16000))
  await tick()
  assert.equal(workers[0].posted[0].jobId, second)
  bridge.dispose()
})

test('errors: decode failure, worker error message, worker crash', async () => {
  const bad = await setup({ decode: async () => { throw new Error('This audio file could not be read. Try an mp3, m4a or wav file.') } })
  const seen = events(bad.bridge)
  await bad.bridge.request('coverStart', { token: bad.token })
  await tick(); await tick()
  assert.deepEqual(seen.at(-1), { kind: 'coverError', jobId: seen[0].jobId, message: 'This audio file could not be read. Try an mp3, m4a or wav file.' })
  assert.equal(bad.bridge.busy, false)

  const empty = await setup({ decode: async () => new Float32Array(0) })
  const emptyEvents = events(empty.bridge)
  await empty.bridge.request('coverStart', { token: empty.token })
  await tick(); await tick()
  assert.equal(emptyEvents.at(-1).message, 'That audio file is empty')

  const long = await setup({ decode: async () => ({ length: 16000 * 1300 }) })
  const longEvents = events(long.bridge)
  await long.bridge.request('coverStart', { token: long.token })
  await tick(); await tick()
  assert.match(longEvents.at(-1).message, /20 minutes/)

  const w = await setup()
  const wEvents = events(w.bridge)
  const jobId = await w.bridge.request('coverStart', { token: w.token })
  await tick()
  w.workers[0].say({ type: 'error', jobId, message: 'Could not load the piano cover model' })
  assert.equal(wEvents.at(-1).message, 'Could not load the piano cover model')

  const crash = await setup()
  const crashEvents = events(crash.bridge)
  await crash.bridge.request('coverStart', { token: crash.token })
  await tick()
  crash.workers[0].onerror({ preventDefault() {} })
  assert.equal(crashEvents.at(-1).kind, 'coverError')
  assert.equal(crash.workers[0].terminated, true)
  assert.equal(crash.bridge.workerAlive, false)
})

test('the worker is ended after the idle time and not while a job runs', async () => {
  const { bridge, workers, timers, token } = await setup()
  const jobId = await bridge.request('coverStart', { token })
  await tick()
  workers[0].say({ type: 'done', jobId, notes: [], duration: 1 })
  assert.equal(bridge.workerAlive, true)
  const idle = timers.at(-1)
  assert.equal(idle.ms, 60000)
  idle.fn()
  assert.equal(workers[0].terminated, true)
  assert.equal(bridge.workerAlive, false)
  const again = await bridge.request('coverStart', { token })
  await tick()
  assert.equal(workers.length, 2, 'a new worker is made for the next job')
  // a timer that was already due when the job began (the callback is kept even though the bridge cleared the timer)
  const dueIdle = timers.at(-1)
  assert.ok(dueIdle.original, 'the second job scheduled an idle timer on the first done')
  assert.equal(bridge.busy, true)
  dueIdle.original()
  assert.equal(workers[1].terminated, false, 'an idle timer that fires during a job leaves the worker alone')
  workers[1].say({ type: 'done', jobId: again, notes: [], duration: 1 })
  assert.equal(timers.length, 2, 'finishing the job scheduled a new idle timer')
  assert.equal(typeof timers.at(-1).fn, 'function')
  assert.equal(timers.at(-1).ms, 60000, 'and the worker is scheduled to end after the job')
})

test('a crash of the worker of a cancelled job spares the next job that is still decoding', async () => {
  let release
  const pending = new Promise((resolve) => { release = () => resolve(new Float32Array(16000)) })
  const h = await setup({ decode: async (file) => (file.slow ? pending : new Float32Array(16000)) })
  const seen = events(h.bridge)
  const one = await h.bridge.request('coverStart', { token: h.token })
  await tick()
  assert.equal(h.workers.length, 1)
  await h.bridge.request('coverCancel', { jobId: one })
  const two = await h.bridge.request('coverStart', { token: h.bridge.stage({ name: 'slow.mp3', slow: true }) })
  await tick()
  h.workers[0].onerror({ preventDefault() {} })           // the cancelled job's worker dies
  assert.equal(seen.some((e) => e.kind === 'coverError'), false, 'job 2 was never sent to that worker, so it is not failed')
  assert.equal(h.bridge.busy, true)
  release()
  await tick(); await tick()
  assert.equal(h.workers.length, 2, 'job 2 gets a fresh worker')
  assert.equal(h.workers[1].posted[0].jobId, two)
  // and a job that was sent is failed by the crash
  h.workers[1].onerror({ preventDefault() {} })
  assert.equal(seen.at(-1).kind, 'coverError')
})

test('monoFromBuffer averages channels; available() reads the manifest once', async () => {
  const { monoFromBuffer } = await load('piano-cover-desktop')
  const buffer = { numberOfChannels: 2, length: 3, getChannelData: (c) => (c ? Float32Array.of(1, 0, -1) : Float32Array.of(0, 0.5, 1)) }
  assert.deepEqual(Array.from(monoFromBuffer(buffer)), [0.5, 0.25, 0])
  const one = { numberOfChannels: 1, length: 2, getChannelData: () => Float32Array.of(0.25, 0.5) }
  assert.deepEqual(Array.from(monoFromBuffer(one)), [0.25, 0.5])

  let calls = 0
  const ok = await setup({ bridge: { fetchImpl: async (url) => { calls++; assert.equal(url, 'keylight://app/cover-models/manifest.json'); return { ok: true, json: async () => ({ files: { encoder: { sha256: 'a' }, decoder: { sha256: 'b' } } }) } } } })
  assert.equal(await ok.bridge.available(), true)
  assert.equal(await ok.bridge.available(), true)
  assert.equal(calls, 1)
  const missing = await setup({ bridge: { fetchImpl: async () => ({ ok: false }) } })
  assert.equal(await missing.bridge.available(), false)
  const broken = await setup({ bridge: { fetchImpl: async () => { throw new Error('offline') } } })
  assert.equal(await broken.bridge.available(), false)
})

// The real worker module in node (one WASM thread, the real model files) with a fake `self`: cancel handling needs the model.
const MODELS = require('node:path').join(__dirname, '..', 'tools', 'music2midi', '.cache', 'onnx')
const haveModels = require('node:fs').existsSync(require('node:path').join(MODELS, 'manifest.json'))
test('worker: a cancel for a start that is still waiting behind a cancelled job is honoured, and the next start is not refused', { skip: !haveModels && 'no model cache', timeout: 120000 }, async () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const out = []
  const realFetch = globalThis.fetch
  globalThis.self = globalThis
  globalThis.postMessage = (m) => out.push(m)
  globalThis.fetch = async (url, ...rest) => {
    if (String(url).startsWith('keylight://app/cover-models/')) return new Response(fs.readFileSync(path.join(MODELS, String(url).slice('keylight://app/cover-models/'.length))))
    return realFetch(url, ...rest)
  }
  try {
    await import('../renderer/piano-cover-worker.js')
    const tone = (seconds) => Float32Array.from({ length: 16000 * seconds }, (_, i) => 0.2 * Math.sin(i / 5))
    const start = (jobId, pcm) => self.onmessage({ data: { type: 'start', jobId, pcm, genre: 'pop', difficulty: 'intermediate', overlap: 0, modelBase: 'keylight://app/cover-models/', threads: 1, batch: 8 } })
    const cancel = (jobId) => self.onmessage({ data: { type: 'cancel', jobId } })
    const until = async (test) => { for (let i = 0; i < 1200 && !test(); i++) await new Promise((r) => setTimeout(r, 100)) }
    start('A', tone(3))
    cancel('A')
    start('B', tone(3))              // waits for A to unwind
    cancel('B')                      // while it waits
    start('C', new Float32Array(16000))
    await until(() => out.some((m) => m.jobId === 'C' && (m.type === 'done' || m.type === 'error')))
    await new Promise((r) => setTimeout(r, 1500))
    assert.deepEqual(out.filter((m) => m.jobId === 'A' || m.jobId === 'B'), [], 'cancelled jobs send nothing, and B never runs')
    const c = out.filter((m) => m.jobId === 'C')
    assert.equal(c.at(-1).type, 'done', JSON.stringify(c.at(-1)))
  } finally { globalThis.fetch = realFetch; delete globalThis.postMessage }
})
