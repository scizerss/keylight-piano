const assert = require('node:assert/strict')
const { test } = require('node:test')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { File } = require('node:buffer')

const source = readFileSync(path.join(__dirname, '../renderer/song-recorder.js'), 'utf8')
const setup = ({ formats = ['audio/mp4'], granted = true, current = true } = {}) => {
  const tracks = [{ stops: 0, stop() { this.stops++ } }, { stops: 0, stop() { this.stops++ } }]
  const state = { now: 0, tracks, contextsClosed: 0 }
  class MediaRecorder {
    static isTypeSupported(mime) { return formats.includes(mime) }
    constructor(stream, { mimeType }) {
      this.mimeType = mimeType
      state.recorder = this
    }
    start() { this.state = 'recording' }
    stop() {
      this.state = 'inactive'
      state.stopCalls = (state.stopCalls || 0) + 1
      if (state.silentStop) return          // a recorder whose stop event never arrives
      queueMicrotask(() => {
        this.ondataavailable({ data: new Blob(['recorded audio'], { type: this.mimeType }) })
        this.onstop()
      })
    }
  }
  class AudioContext {
    createAnalyser() { return { fftSize: 2, getFloatTimeDomainData(samples) { samples.fill(1) } } }
    createMediaStreamSource() { return { connect() {} } }
    async resume() {}
    async close() { state.contextsClosed++ }
  }
  const context = vm.createContext({
    MediaRecorder, AudioContext, File, Date, performance: { now: () => state.now },
    navigator: { mediaDevices: { async getUserMedia(options) {
      state.constraints = JSON.parse(JSON.stringify(options))
      if (!granted) throw new DOMException('denied', 'NotAllowedError')
      return { getTracks: () => tracks }
    } } },
    setInterval: (fn) => { state.tick = fn },
    clearInterval: () => { state.tick = null },
    setTimeout: (fn, ms) => { if (ms === 600000) state.limit = fn; else state.fallback = fn; return ms },
    clearTimeout: (id) => { if (id === 600000) state.limit = null; else if (id !== undefined) state.fallback = null }
  })
  vm.runInContext(source.replace(/^export /gm, '') + '\nthis.start = startBrowserRecording; this.time = recordingTime', context)
  state.start = () => context.start({
    isCurrent: () => current,
    onLevel: (level, seconds) => { state.level = [level, seconds] },
    onEnded: (result, reason) => { state.ended = { result, reason } }
  })
  state.time = context.time
  return state
}

test('permission denial, unsupported recording and late permission after cancel', async () => {
  const denied = setup({ granted: false })
  assert.equal((await denied.start()).status, 'denied')
  assert.equal(denied.recorder, undefined)
  assert.equal((await setup({ formats: [] }).start()).status, 'unsupported')
  const late = setup({ current: false })
  assert.equal((await late.start()).status, 'cancelled')
  assert.deepEqual(late.tracks.map((t) => t.stops), [1, 1])
  assert.equal(late.recorder, undefined)
})

test('normal stop collects WebM and releases all tracks and metering', async () => {
  const mic = setup({ formats: ['audio/webm;codecs=opus'] })
  const recording = await mic.start()
  assert.deepEqual(mic.constraints, { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
  mic.now = 2250
  mic.tick()
  assert.deepEqual(mic.level, [1, 2.25])
  assert.equal(mic.time(63), '01:03')
  const job = recording.finish()
  // the last chunk arrives after stop(), so the tracks stay open until the stop event
  assert.deepEqual(mic.tracks.map((t) => t.stops), [0, 0])
  assert.equal(job, recording.finish())
  const result = await job
  assert.deepEqual(mic.tracks.map((t) => t.stops), [1, 1])
  assert.equal(result.status, 'saved')
  assert.match(result.file.name, /^Recording [\d-]+ \d\d-\d\d\.webm$/)
  assert.equal(result.file.type, 'audio/webm')
  assert.equal(mic.tick, null)
  assert.equal(mic.contextsClosed, 1)
})

test('short recordings are rejected, cancel discards and the cap keeps audio', async () => {
  const short = setup()
  assert.equal((await (await short.start()).finish()).status, 'tooShort')
  const cancelled = setup()
  const capture = await cancelled.start()
  cancelled.now = 2200
  const discard = capture.finish(true)
  assert.deepEqual(cancelled.tracks.map((t) => t.stops), [1, 1])   // a discard releases the microphone at once
  assert.equal((await discard).status, 'cancelled')
  assert.deepEqual(cancelled.tracks.map((t) => t.stops), [1, 1])
  const limited = setup({ formats: ['audio/mp4', 'audio/webm;codecs=opus'] })
  await limited.start()
  limited.now = 600000
  limited.limit()
  assert.equal(limited.ended.reason, 'limit')
  assert.equal((await limited.ended.result).file.type, 'audio/mp4')
})

test('an unexpected recorder stop offers the partial file and releases the tracks', async () => {
  const mic = setup()
  await mic.start()
  mic.now = 2900
  mic.recorder.stop()
  await Promise.resolve()
  assert.equal(mic.ended.reason, 'interrupted')
  assert.equal((await mic.ended.result).status, 'saved')
  assert.deepEqual(mic.tracks.map((t) => t.stops), [1, 1])
})

test('record sheet exposes settings for a native denial and a review action for an interruption', () => {
  const app = readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8')
  const isolated = app.slice(app.indexOf('function renderSongRecorder('), app.indexOf('function openSongRecorder('))
  const elements = new Map()
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { classList: { toggle() {} }, setAttribute() {} })
    return elements.get(id)
  }
  const context = vm.createContext({ $: element, IS_IOS: true, recordingMessages: {} })
  vm.runInContext(isolated + 'renderSongRecorder("denied")', context)
  assert.equal(element('impRecordSettings').hidden, false)
  assert.equal(element('impRecordUse').hidden, true)
  vm.runInContext('renderSongRecorder("review")', context)
  assert.equal(element('impRecordSettings').hidden, true)
  assert.equal(element('impRecordUse').hidden, false)
  assert.equal(element('impRecordStart').hidden, true)
})

test('finish() on a recorder that already stopped resolves at once and releases everything', async () => {
  const mic = setup()
  const capture = await mic.start()
  mic.now = 3000
  mic.recorder.state = 'inactive'
  const result = await capture.finish()
  assert.equal(result.status, 'failed')                              // nothing was collected
  assert.deepEqual(mic.tracks.map((t) => t.stops), [1, 1])
  assert.equal(mic.stopCalls, undefined)
  const discarded = setup()
  const second = await discarded.start()
  discarded.recorder.state = 'inactive'
  assert.equal((await second.finish(true)).status, 'cancelled')
})

test('a stop event that never arrives is settled by the timeout and the tracks are released', async () => {
  const mic = setup()
  mic.silentStop = true
  const capture = await mic.start()
  mic.now = 4000
  const job = capture.finish()
  assert.deepEqual(mic.tracks.map((t) => t.stops), [0, 0])
  assert.equal(typeof mic.fallback, 'function')
  mic.fallback()
  assert.equal((await job).status, 'failed')                         // no chunk ever arrived
  assert.deepEqual(mic.tracks.map((t) => t.stops), [1, 1])
})

test('a recorder error fails the recording, releases the tracks and tells the page once', async () => {
  const mic = setup()
  await mic.start()
  mic.now = 5000
  mic.recorder.onerror()
  assert.equal(mic.ended.reason, 'interrupted')
  assert.equal((await mic.ended.result).status, 'failed')
  assert.deepEqual(mic.tracks.map((t) => t.stops), [1, 1])
  assert.equal(mic.contextsClosed, 1)
  const finished = setup()
  const capture = await finished.start()
  finished.now = 2000
  const job = capture.finish()
  finished.recorder.onerror()
  assert.equal(finished.ended, undefined)                            // the caller already knows
  assert.equal((await job).status, 'failed')
})

test('the cancelled outcome has a calm message', () => {
  const literal = source.match(/export const recordingMessages = (\{[\s\S]*?\n\})/)[1]
  const messages = vm.runInNewContext('(' + literal + ')')
  assert.match(messages.cancelled, /cancelled/i)
  assert.doesNotMatch(Object.values(messages).join(' '), /[\u2013\u2014]/)
})

// The record sheet's state machine in renderer/app.js, sliced out and run against fakes.
function sheetHarness({ ios = true, requests = {} } = {}) {
  const app = readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8')
  const slice = app.slice(app.indexOf('function recordingLevel('), app.indexOf('const handleImportFile'))
  const elements = new Map()
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, { id, hidden: false, disabled: false, textContent: '', value: 0, focused: 0,
        classList: { toggle() {}, contains: () => element.hiddenSheet && id === 'importSheet', remove() {}, add() {} },
        setAttribute() {}, focus() { this.focused++ } })
    }
    return elements.get(id)
  }
  const log = { requests: [], windowKeydown: null, native: null, opened: 0, imported: [], acks: [] }
  const messages = vm.runInNewContext('(' + source.match(/export const recordingMessages = (\{[\s\S]*?\n\})/)[1] + ')')
  const context = vm.createContext({
    $: element, IS_IOS: ios, canMakeCovers: () => ios, recordingMessages: messages, recordingTime: (n) => String(n),
    muteForMicrophone() {}, stopAll() {}, tvLink: { isConnected: () => false }, player: null, jamUi: null,
    showImportSheet() { log.opened++ }, closeImportSheet() {}, startBrowserRecording: async () => ({ status: 'unsupported' }),
    androidRequest: async (op, args) => { log.requests.push([op, args]); return typeof requests[op] === 'function' ? requests[op](args) : requests[op] },
    androidEvents: (fn) => { log.native = fn },
    handleImportFile: async (file, options) => { log.imported.push(file); log.importOptions = options; return log.outcome },
    window: { addEventListener: (type, fn, capture) => { if (type === 'keydown' && capture) log.windowKeydown = fn } },
    document: { hidden: false, addEventListener() {}, querySelector: (selector) => (selector === 'dialog[open]' && log.dialog ? {} : null) },
    globalThis: null
  })
  context.globalThis = context
  context.keylightIncomingFile = {
    readRecording: async (info) => ({ name: info.name, info }),
    importId: () => 'imp-shared-x',
    acknowledge: async (file) => { log.acks.push(file.info.token) },
    recoverRecording: Promise.resolve(undefined)
  }
  vm.runInContext('let songRecording = null; let importOpener = null; let activeSongImport = null;\n' + slice + `
this.api = { open: openSongRecorder, start: startSongRecording, use: useSongRecording, wire: wireSongRecorder,
  session: () => songRecording }`, context)
  return { api: context.api, element, log, context, messages }
}

test('a cancelled start resets the sheet calmly instead of leaving it blank', async () => {
  const h = sheetHarness({ requests: { recordStart: { status: 'cancelled' } } })
  h.api.open()
  await h.api.start()
  assert.equal(h.element('impRecordStatus').textContent, h.messages.cancelled)
  assert.equal(h.api.session().capturing, false)
  assert.equal(h.element('impRecordStart').disabled, false)
  assert.equal(h.element('impRecordStart').hidden, false)
})

test('a recording event nobody is waiting for is released, the visible one is kept', async () => {
  const h = sheetHarness()
  h.api.wire()
  h.api.open()                                          // sheet open, not capturing, no result
  h.log.native({ kind: 'recordInterrupted', result: { status: 'saved', file: { token: 'leaked-token-1' } } })
  assert.equal(JSON.stringify(h.log.requests.at(-1)), JSON.stringify(['incomingDone', { token: 'leaked-token-1' }]))
  const before = h.log.requests.length
  h.api.session().result = { status: 'saved', file: { token: 'kept-token-22' } }
  h.log.native({ kind: 'recordInterrupted', result: { status: 'saved', file: { token: 'kept-token-22' } } })
  assert.equal(h.log.requests.length, before)           // same recording as the one on screen
  const none = sheetHarness()
  none.api.wire()
  none.log.native({ kind: 'recordAutoStopped', result: { status: 'saved', file: { token: 'no-sheet-token' } } })
  assert.equal(JSON.stringify(none.log.requests.at(-1)), JSON.stringify(['incomingDone', { token: 'no-sheet-token' }]))
})

test('a library failure after Use offers the recording again instead of keeping it hidden', async () => {
  const h = sheetHarness()
  h.api.open({ status: 'saved', file: { token: 'lib-error-tok', name: 'Recording.m4a' } })
  h.log.outcome = undefined
  await h.api.use(false)
  assert.equal(h.log.imported.length, 1)
  assert.deepEqual(h.log.acks, [])                      // still not released
  assert.ok(h.api.session(), 'the review is open again')
  assert.equal(h.api.session().result.file.token, 'lib-error-tok')
  assert.equal(h.element('impRecordStatus').textContent, 'Could not save the recording. Try again.')
  assert.equal(h.element('impRecordUse').hidden, false)
  const saved = sheetHarness()
  saved.api.open({ status: 'saved', file: { token: 'saved-token-1', name: 'Recording.m4a' } })
  saved.log.outcome = 'saved'
  await saved.api.use(false)
  assert.deepEqual(saved.log.acks, ['saved-token-1'])
  assert.equal(saved.api.session(), null)
})

test('iOS asks for the recording type before handing it off to the importer', async () => {
  const file = { token: 'saved-song-token', name: 'Recording.m4a' }
  for (const [button, cover] of [['impFullRecording', true], ['impSoloRecording', false]]) {
    const h = sheetHarness()
    h.api.wire()
    h.api.open({ status: 'saved', file })
    await h.api.use()
    assert.equal(h.log.imported.length, 0)
    assert.equal(h.element('impRecordingKind').hidden, false)
    assert.equal(h.element('impRecordingKindHeading').focused, 1)
    h.log.outcome = 'saved'
    await h.element(button).onclick()
    assert.equal(h.log.imported.length, 1)
    assert.equal(h.log.importOptions.coverRecording, cover)
    assert.deepEqual(h.log.acks, [file.token])
  }
})

test('Escape and Tab belong to a dialog opened above the sheet', () => {
  const h = sheetHarness()
  h.api.wire()
  const event = (key) => ({ key, shiftKey: false, stopped: false, prevented: false, stopPropagation() { this.stopped = true }, preventDefault() { this.prevented = true } })
  const plain = event('Escape')
  h.log.windowKeydown(plain)
  assert.equal(plain.prevented, true)                   // the sheet handles it when nothing is above it
  h.log.dialog = true
  const above = event('Escape')
  h.log.windowKeydown(above)
  assert.equal(above.stopped || above.prevented, false)
})

test('discarding right after Stop, or with a stop event that never comes, releases at once and settles', async () => {
  const stopped = setup()
  const first = await stopped.start()
  stopped.now = 3000
  const normal = first.finish()
  assert.deepEqual(stopped.tracks.map((t) => t.stops), [0, 0])
  const discard = first.finish(true)                                   // cancel pressed before the trailing chunk
  assert.deepEqual(stopped.tracks.map((t) => t.stops), [1, 1])
  assert.equal((await discard).status, 'cancelled')
  assert.equal(await normal, await discard)
  const silent = setup()
  silent.silentStop = true
  const second = await silent.start()
  silent.now = 3000
  assert.equal((await second.finish(true)).status, 'cancelled')        // does not wait for a stop event
  assert.deepEqual(silent.tracks.map((t) => t.stops), [1, 1])
})

test('a recording recovered at launch is released when the sheet is already in use', async () => {
  const h = sheetHarness()
  h.context.keylightIncomingFile.recoverRecording = Promise.resolve({ token: 'recovered-tok-1', name: 'Recording.m4a' })
  h.api.open()
  h.api.wire()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(JSON.stringify(h.log.requests.at(-1)), JSON.stringify(['incomingDone', { token: 'recovered-tok-1' }]))
  assert.equal(h.log.opened, 0)
  const idle = sheetHarness()
  idle.context.keylightIncomingFile.recoverRecording = Promise.resolve({ token: 'recovered-tok-2', name: 'Recording.m4a' })
  idle.api.wire()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(idle.log.opened, 1)
  assert.equal(idle.api.session().result.file.token, 'recovered-tok-2')
})
