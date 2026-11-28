const assert = require('node:assert/strict')
const { test } = require('node:test')

const load = (name) => import('../renderer/' + name + '.js')
const tick = () => new Promise((resolve) => setImmediate(resolve))
const token = 'staged-song-1'
const jobId = 'cover-job-1'
const range = { lo: 21, hi: 108 }
const raw = [36, 43, 48, 64, 67, 72, 76].map((pitch) => ({ pitch, start: 0, dur: 0.4 }))
raw.push({ pitch: 79, start: 0.5, dur: 0.4 }, { pitch: 80, start: 0.8, dur: 0.03 })

function fakeBridge() {
  const listeners = new Set()
  const calls = []
  let reply
  let acknowledge
  const started = new Promise((resolve) => { reply = resolve })
  const cancelled = new Promise((resolve) => { acknowledge = resolve })
  return {
    calls, reply, acknowledge, listeners,
    request(op, args, timeout) {
      calls.push({ op, args, timeout })
      return op === 'coverStart' ? started : cancelled
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    emit(kind, details = {}) {
      for (const fn of listeners) fn({ kind, jobId, ...details })
    }
  }
}

test('coverStart uses the staged token and sees progress and completion in the first bridge batch', async () => {
  const { generatePianoCover, START_REPLY_MS } = await load('piano-cover-import')
  const bridge = fakeBridge()
  const progress = []
  const result = generatePianoCover(token, { ...bridge, onProgress: (p) => progress.push(p) })
  assert.deepEqual(bridge.calls, [{ op: 'coverStart', args: { token, genre: 'pop', difficulty: 'intermediate' }, timeout: START_REPLY_MS }])
  bridge.reply(jobId)
  bridge.emit('coverProgress', { done: 0, total: 4 })
  bridge.emit('coverProgress', { jobId: 'other-job', done: 4, total: 4 })
  bridge.emit('coverProgress', { done: 2, total: 4 })
  bridge.emit('coverDone', { notes: raw, duration: 3 })
  assert.deepEqual(await result, { notes: raw, duration: 3, modelDifficulty: 'intermediate' })
  assert.deepEqual(progress, [0, 0.5])
  assert.equal(bridge.listeners.size, 0)
})

test('coverError rejects with the native message and releases the event listener', async () => {
  const { generatePianoCover } = await load('piano-cover-import')
  const bridge = fakeBridge()
  const result = generatePianoCover(token, bridge)
  bridge.reply(jobId)
  bridge.emit('coverError', { message: 'Could not decode that audio file' })
  await assert.rejects(result, /Could not decode that audio file/)
  assert.equal(bridge.listeners.size, 0)
  assert.equal(bridge.calls.length, 1)
})

// A minimal valid WAV keeps tag parsing and the usual import metadata path in the test.
function recording() {
  const bytes = Buffer.alloc(46)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(38, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28)
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36)
  bytes.writeUInt32LE(2, 40)
  return new File([bytes], 'Artist - A song.wav', { type: 'audio/wav' })
}

test('cancel mid-cover aborts importFile and unblocks the next shared import after native cleanup', async () => {
  const { generatePianoCover, CANCEL_REPLY_MS } = await load('piano-cover-import')
  const { importFile } = await load('importer')
  const { serializeSongImports } = await load('incoming-file')
  const controller = new AbortController()
  const bridge = fakeBridge()
  const events = []
  let started
  const reachedStart = new Promise((resolve) => { started = resolve })
  const handle = serializeSongImports((file, { importId }) => {
    events.push(importId)
    if (importId === 'next') return 'next saved'
    return importFile(file, {
      signal: controller.signal,
      onStage: (stage, progress) => events.push([stage, progress]),
      cover: {
        difficulty: 'easy', keyRange: () => range,
        generate: (options) => {
          const pending = generatePianoCover(token, { ...options, ...bridge })
          started()
          return pending
        }
      }
    })
  })
  const first = handle(recording(), { importId: 'first' })
  const second = handle(recording(), { importId: 'next' })
  await reachedStart
  bridge.reply(jobId)
  await tick()
  bridge.emit('coverProgress', { done: 2, total: 4 })
  assert.deepEqual(events.at(-1), ['Making a piano cover', 0.45])
  controller.abort()
  await tick()
  assert.deepEqual(bridge.calls.at(-1), { op: 'coverCancel', args: { jobId }, timeout: CANCEL_REPLY_MS })
  assert.ok(!events.includes('next'))
  bridge.emit('coverDone', { notes: raw, duration: 3 })
  bridge.acknowledge(true)
  await assert.rejects(first, { name: 'AbortError' })
  assert.equal(await second, 'next saved')
  assert.equal(bridge.listeners.size, 0)
})

test('cancel before the job ID arrives cancels that job when the bridge replies', async () => {
  const { generatePianoCover } = await load('piano-cover-import')
  const bridge = fakeBridge()
  const controller = new AbortController()
  const pending = generatePianoCover(token, { ...bridge, signal: controller.signal, onProgress: () => assert.fail('unexpected progress') })
  controller.abort()
  bridge.reply(jobId)
  bridge.emit('coverProgress', { done: 0, total: 4 })
  bridge.acknowledge(true)
  await assert.rejects(pending, { name: 'AbortError' })
  assert.deepEqual(bridge.calls.at(-1).args, { jobId })
  assert.equal(bridge.listeners.size, 0)
})

test('a missing start reply has a deadline and retains the staged file on cancellation', async ({ mock }) => {
  const { generatePianoCover } = await load('piano-cover-import')
  mock.timers.enable({ apis: ['setTimeout'] })
  for (const abort of [false, true]) {
    const bridge = fakeBridge()
    const controller = new AbortController()
    const pending = generatePianoCover(token, { ...bridge, signal: controller.signal, startReplyMs: 20 })
    const outcome = assert.rejects(pending, { name: abort ? 'AbortError' : 'TimeoutError', cancelUnconfirmed: true })
    if (abort) controller.abort()
    mock.timers.tick(20)
    await outcome
    assert.equal(bridge.calls.length, 1, 'a lost ID must not cancel a different native job')
    assert.equal(bridge.listeners.size, 0)
  }
})

test('only true confirms coverCancel; false, rejection and timeout retain the staged file', async ({ mock }) => {
  const { generatePianoCover } = await load('piano-cover-import')
  mock.timers.enable({ apis: ['setTimeout'] })
  for (const reply of [false, 'reject', 'timeout', true]) {
    const bridge = fakeBridge()
    const controller = new AbortController()
    const pending = generatePianoCover(token, {
      ...bridge, signal: controller.signal, cancelReplyMs: 20,
      request(op, args, timeout) {
        if (op === 'coverStart') return Promise.resolve(jobId)
        assert.equal(timeout, 20, 'the native request itself has a timeout')
        if (reply === 'timeout') return new Promise(() => {})
        if (reply === 'reject') return Promise.reject(new Error('bridge failure'))
        return Promise.resolve(reply)
      }
    })
    await tick()
    controller.abort()
    const outcome = assert.rejects(pending, (error) => error.name === 'AbortError' && !!error.cancelUnconfirmed === (reply !== true))
    await tick()
    if (reply === 'timeout') mock.timers.tick(20)
    await outcome
    assert.equal(bridge.listeners.size, 0)
  }
})

test('timed-out native starts and cancels remove their pending RPC entries', async ({ mock }) => {
  const { generatePianoCover } = await load('piano-cover-import')
  mock.timers.enable({ apis: ['setTimeout'] })
  const posted = []
  globalThis.KeylightNative = { postMessage: (json) => posted.push(JSON.parse(json)) }
  try {
    const stalled = assert.rejects(generatePianoCover(token, { startReplyMs: 20 }), { name: 'TimeoutError', cancelUnconfirmed: true })
    mock.timers.tick(20)
    await stalled
    __keylightNativeReceive({ id: posted[0].id, get result() { assert.fail('expired start request still pending') } })

    const controller = new AbortController()
    const pending = generatePianoCover(token, { signal: controller.signal, cancelReplyMs: 20 })
    __keylightNativeReceive({ id: posted[1].id, result: jobId })
    await tick()
    controller.abort()
    const stopped = assert.rejects(pending, { name: 'AbortError', cancelUnconfirmed: true })
    await tick()
    assert.equal(posted[2].op, 'coverCancel')
    mock.timers.tick(20)
    await stopped
    __keylightNativeReceive({ id: posted[2].id, get result() { assert.fail('expired cancel request still pending') } })
  } finally {
    delete globalThis.KeylightNative
  }
})

async function importedCover() {
  const { importFile } = await load('importer')
  return importFile(recording(), {
    ctx: { decodeAudioData() { assert.fail('native cover should decode the audio') } },
    cover: {
      difficulty: 'easy', keyRange: () => range,
      generate: async () => ({ notes: raw, duration: 3, modelDifficulty: 'intermediate' })
    }
  })
}

test('changing difficulty rebuilds from cleaned raw notes, keeps the original audio, and assigns new fingers', async () => {
  const { rearrangeCover } = await load('importer')
  const easy = await importedCover()
  const full = rearrangeCover(easy, 'full', range)
  assert.equal(easy.title, 'A song')
  assert.equal(easy.artist, 'Artist')
  assert.equal(easy.duration, 3)
  assert.ok(full.notes.length > easy.notes.length)
  assert.strictEqual(full.coverRaw, easy.coverRaw)
  assert.strictEqual(full.audio, easy.audio)
  assert.ok(full.coverRaw.every((note) => note.dur >= 0.08 && !('finger' in note)))
  assert.ok(full.notes.every((note) => note.finger >= 1 && note.finger <= 5))
  assert.deepEqual(rearrangeCover(full, 'easy', range).notes, easy.notes)
})

test('changing keyboard size fits the same difficulty into the new range and restores it on switching back', async () => {
  const { rearrangeCover } = await load('importer')
  const large = await importedCover()
  const small = { lo: 48, hi: 71 }
  const resized = rearrangeCover(large, large.coverArrangement.difficulty, small)
  assert.ok(large.notes.some(({ pitch }) => pitch < small.lo || pitch > small.hi))
  assert.ok(resized.notes.every(({ pitch }) => pitch >= small.lo && pitch <= small.hi))
  assert.deepEqual(resized.coverArrangement, { difficulty: 'easy', keyRange: small })
  assert.strictEqual(rearrangeCover(resized, 'easy', small), resized)
  assert.deepEqual(rearrangeCover(resized, 'easy', range).notes, large.notes)
})

test('a roll edit drops the cover arrangement, and undo or a grid-only change preserves it', async () => {
  const { RollModel } = await load('roll-model')
  const record = { ...(await importedCover()), importedId: 'imp-cover' }
  const draft = new RollModel(record)
  draft.setGridTempo(100)
  assert.deepEqual(draft.build().song.coverRaw, record.coverRaw)
  draft.select([draft.notes[0].key])
  draft.deleteNotes()
  const edited = draft.build().song
  assert.equal(edited.coverModelDifficulty, undefined)
  assert.equal(edited.coverRaw, undefined)
  assert.equal(edited.coverArrangement, undefined)
  draft.undo()
  assert.deepEqual(draft.build().song.coverRaw, record.coverRaw)
})

test('backup round trip keeps imported canonical notes and the selected arrangement', async () => {
  const { createBackup, readBackup } = await load('backup-format')
  const { rearrangeCover } = await load('importer')
  const record = { ...rearrangeCover(await importedCover(), 'medium', { lo: 48, hi: 71 }), id: 'imp-cover' }
  const storage = { length: 0, key: () => null, getItem: () => null }
  const backup = await createBackup({ songs: [record], storage })
  assert.deepEqual(backup.skipped, [])
  const { songs: [restored] } = await readBackup(new File([backup.blob], 'test.keylightbackup'))
  assert.equal(restored.coverModelDifficulty, 'intermediate')
  assert.deepEqual(restored.coverRaw, record.coverRaw)
  assert.deepEqual(restored.coverArrangement, record.coverArrangement)
  assert.ok(rearrangeCover(restored, 'full', range).notes.length > 0)
})

test('watchdog resets on matching progress and waits for native cancellation after inactivity', async ({ mock }) => {
  const { generatePianoCover, CANCEL_REPLY_MS } = await load('piano-cover-import')
  const bridge = fakeBridge()
  mock.timers.enable({ apis: ['setTimeout'] })
  const errors = []
  const pending = generatePianoCover(token, { ...bridge, onTimeout: (message) => errors.push(message) })
  bridge.reply(jobId)
  await tick()
  mock.timers.tick(100_000)
  bridge.emit('coverProgress', { done: 1, total: 4 })
  mock.timers.tick(100_000)
  bridge.emit('coverProgress', { jobId: 'unrelated-job', done: 1, total: 10 })
  assert.equal(bridge.calls.length, 1)
  mock.timers.tick(20_000)
  assert.deepEqual(errors, ['The piano cover stopped responding. Try again.'])
  await tick()
  assert.deepEqual(bridge.calls.at(-1), { op: 'coverCancel', args: { jobId }, timeout: CANCEL_REPLY_MS })
  assert.equal(bridge.listeners.size, 0)
  bridge.acknowledge(true)
  await assert.rejects(pending, /The piano cover stopped responding/)
})

test('busy coverStart shows a friendly message', async () => {
  const { generatePianoCover } = await load('piano-cover-import')
  const bridge = fakeBridge()
  const request = async () => { throw new DOMException('busy', 'OperationError') }
  await assert.rejects(generatePianoCover(token, { ...bridge, request }), {
    message: 'Another song is still being made into a piano cover.'
  })
  assert.equal(bridge.listeners.size, 0)
})

test('cover import distinguishes silence, malformed notes and oversized output', async () => {
  const { importFile } = await load('importer')
  const { MAX_NOTES } = await load('editor-model')
  const importNotes = (notes) => importFile(recording(), {
    cover: { difficulty: 'easy', keyRange: () => range, generate: async () => ({ notes, duration: 3 }) }
  })
  await assert.rejects(importNotes([]), /No notes could be heard/)
  await assert.rejects(importNotes([{ pitch: 60, start: 0, dur: 0.05 }]), /No notes could be heard/)
  await assert.rejects(importNotes([...raw, { pitch: 12.5, start: 0, dur: 1 }]), /contains invalid notes/)
  await assert.rejects(importNotes(Array(MAX_NOTES + 1).fill(raw[0])), /too many notes/)
})

test('replacing the playing arrangement preserves transport and uses a separate best-score key', async () => {
  const { Player } = await load('player')
  const { rearrangeCover, coverScoreFile } = await load('importer')
  const saved = await importedCover()
  const next = rearrangeCover(saved, 'easy', { lo: 48, hi: 71 })
  const ctx = { currentTime: 0 }
  const player = new Player({ getCtx: () => ctx })
  player.load(saved, 21)
  player.setMode('PLAY')
  player.setCountIn(4)
  player.setLoop(0.5, 2.5, true)
  player.seek(1.25)
  player.play({ countIn: false })
  ctx.currentTime = 0.25
  player.replaceArrangement(next, 48, 24)
  assert.ok(player.active)
  assert.equal(player.position, 1.5)
  assert.equal(player.windowStart, 48)
  assert.equal(player.windowKeys, 24)
  assert.deepEqual(player.loop, { a: 0.5, b: 2.5, on: true })
  assert.ok(player.arrangementChangedMidRun)
  player.pause()
  player.replaceArrangement(saved, 21, 88)
  assert.equal(player.active, false)
  assert.equal(player.currentPosition(), 1.5)
  player.restart(false)
  assert.equal(player.arrangementChangedMidRun, false)
  assert.notEqual(coverScoreFile(token, saved.coverArrangement), coverScoreFile(token, next.coverArrangement))
  assert.notEqual(coverScoreFile(token, saved.coverArrangement), coverScoreFile(token, { ...saved.coverArrangement, difficulty: 'full' }))
  assert.equal(coverScoreFile(token, null), token)
})
