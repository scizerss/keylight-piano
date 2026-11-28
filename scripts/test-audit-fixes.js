const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')

const read = (file) => readFileSync(join(__dirname, '..', file), 'utf8')
const cut = (source, from, to) => {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start + from.length)
  assert.ok(start >= 0 && end > start, from)
  return source.slice(start, end)
}
const turn = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('repeated Electron closes wait for the renderer save and download', async () => {
  const busy = deferred(), save = deferred(), download = deferred()
  const win = new EventEmitter()
  const count = { requests: 0, waits: 0, quits: 0 }
  let closeAllowed
  const close = () => {
    let prevented = false
    win.emit('close', { preventDefault() { prevented = true } })
    return !prevented
  }
  win.webContents = { executeJavaScript: () => (++count.requests === 1 ? busy.promise : save.promise) }
  const ctx = {
    app: { quit() { count.quits++; closeAllowed = close() } },
    win, takes: { finished: () => 2, idle: (since, files) => {
      assert.equal(since, 2)
      assert.equal(files, 2)
      count.waits++
      return download.promise
    } },
    log() {}, sleep: () => new Promise(() => {})
  }
  vm.runInNewContext(cut(read('main.js'), 'function saveTakeOnClose(', 'function numberEnv(') + 'saveTakeOnClose(win, takes)', ctx)
  assert.equal(close(), false)
  assert.equal(close(), false)
  busy.resolve(true)
  await turn()
  assert.equal(close(), false)
  save.resolve(2)
  await turn()
  assert.equal(close(), false)
  assert.deepEqual(count, { requests: 2, waits: 1, quits: 0 })
  download.resolve(true)
  await turn()
  assert.equal(count.quits, 1)
  assert.equal(closeAllowed, true)
})

test('Bluetooth success cannot override a newer card or another Connect tap', async () => {
  const app = read('renderer/app.js')
  const inFlight = new Map()
  const settings = { kbChoice: 'roli' }
  const ble = {
    since: new Map(), devices: [{ id: 'party', name: 'PartyKeys' }, { id: 'lumi', name: 'LUMI' }],
    api: { bleConnect(id) { const reply = deferred(); inFlight.set(id, reply); return reply.promise } }
  }
  const ctx = {
    ble, settings, midi: null, setup: { open: false }, performance: { now: () => 1 },
    profileById: (id) => ({ id }), normalizeChoice: (id) => id, isPartyPort: (port) => port.name === 'PartyKeys',
    saveSettings() {}, syncKeyboardChoice() {}, haptic() {}, renderSetup() {}, console: { log() {} }
  }
  vm.createContext(ctx)
  const run = (src) => vm.runInContext(src, ctx)
  run(cut(app, 'let keyboardSelectionGeneration', '\n') + '\n' +
    cut(app, 'function bleConnectTo(', '// Flash one keyboard') +
    cut(app, 'function chooseKeyboard(', '// Settings > Your keyboard'))
  run("bleConnectTo('party')")
  await turn()
  ble.since.clear()               // a connected-device event can clear the spinner before the reply
  run("chooseKeyboard('screen')")
  inFlight.get('party').resolve(true)
  await turn()
  assert.equal(settings.kbChoice, 'screen')
  run("bleConnectTo('party'); bleConnectTo('lumi')")
  await turn()
  inFlight.get('lumi').resolve(true)
  inFlight.get('party').resolve(true)
  await turn()
  assert.equal(settings.kbChoice, 'screen', 'the older PartyKeys success is ignored')
  run("bleConnectTo('party')")
  await turn()
  ble.since.clear()
  inFlight.get('party').resolve(true)
  await turn()
  assert.equal(settings.kbChoice, 'partykeys', 'the current success still sets the choice')
})

test('timed finish judges a skipped tail note inside its late window', async () => {
  const { Player } = await import('../renderer/player.js')
  const ctx = { currentTime: 0 }
  const judgements = []
  let results
  const player = new Player({ getCtx: () => ctx, onJudgement: (j) => judgements.push(j.kind), onFinish: (s) => { results = s } })
  player.load({
    notes: [{ pitch: 60, start: 0, dur: 0.8, hand: 'right' }, { pitch: 61, start: 0.95, dur: 0.05, hand: 'left' }],
    tempo: 120, duration: 1
  }, 48)
  player.play({ countIn: false })
  assert.equal(player.noteOn(60).kind, 'perfect')
  ctx.currentTime = 1
  player.tick()
  assert.equal(results.missed, 1)
  assert.equal(results.overallAccuracy, 0.5)
  assert.equal(results.starRating, 1)
  assert.deepEqual(judgements, ['perfect', 'missed'])
})

test('the import decoder drains cancelled work before starting the next file', async () => {
  const { decodeFileAudio } = await import('../renderer/importer.js')
  const decodes = []
  const ctx = { decodeAudioData() { const work = deferred(); decodes.push(work); return work.promise } }
  const file = { name: 'a.wav', arrayBuffer: async () => new ArrayBuffer(2) }
  const abort = new AbortController()
  const before = assert.rejects(decodeFileAudio(ctx, file, abort.signal), { name: 'AbortError' })
  await turn()
  abort.abort()
  const waiting = new AbortController()
  const dropped = assert.rejects(decodeFileAudio(ctx, file, waiting.signal), { name: 'AbortError' })
  waiting.abort()
  const after = decodeFileAudio(ctx, file)
  await dropped
  await turn()
  assert.equal(decodes.length, 1)
  decodes[0].resolve({ duration: 1 })
  await before
  assert.equal(decodes.length, 2)
  decodes[1].resolve({ duration: 2 })
  assert.deepEqual(await after, { duration: 2 })
})

test('audio output skips stale enumeration and never overlaps native sink changes', async () => {
  const source = cut(read('renderer/audio.js'), "let preferredSink = ''", 'function watchOutputs()')
  const enumerations = [], changes = []
  const ctx = {
    sinkId: '', baseLatency: 0,
    async setSinkId(id) { const work = deferred(); changes.push({ id, work }); await work.promise; this.sinkId = id }
  }
  const setOutput = vm.runInNewContext(source.replace('export async ', 'async ') + 'setOutput', {
    ctx, initAudio() {}, console: { log() {} },
    listOutputs: () => { const work = deferred(); enumerations.push(work); return work.promise }
  })
  const selectA = setOutput('a')
  await turn()
  const selectB = setOutput('b')
  enumerations[0].resolve([{ id: 'a' }])
  await turn()
  assert.equal(changes.length, 0)
  assert.equal(await selectA, false)
  enumerations[1].resolve([{ id: 'b' }])
  await turn()
  const selectC = setOutput('c')
  assert.deepEqual(changes.map((change) => change.id), ['b'])
  assert.equal(enumerations.length, 2, 'enumeration for the next sink waits for the earlier native change')
  changes[0].work.reject(new Error('device disappeared'))
  assert.equal(await selectB, false)
  await turn()
  enumerations[2].resolve([{ id: 'c' }])
  await turn()
  assert.deepEqual(changes.map((change) => change.id), ['b', 'c'], 'stale rejection cannot trigger a default change')
  changes[1].work.resolve()
  assert.equal(await selectC, true)
  assert.equal(ctx.sinkId, 'c')
})

test('backing decodes respect song generations and independent stem selections', async () => {
  const audio = read('renderer/audio.js')
  const decodes = []
  const ctx = { decodeAudioData() { const work = deferred(); decodes.push(work); return work.promise } }
  const source = cut(audio, 'let backingGeneration', '// ---------- imported recording') +
    cut(audio, 'export function clearBacking()', 'export const isBackingPlaying')
  const { loadBackingFile, invalidateBackingLoads, clearBacking, buffers } = vm.runInNewContext(
    source.replaceAll('export ', '') + '({ loadBackingFile, invalidateBackingLoads, clearBacking, buffers: () => ({ backingBuffer, fullBuffer }) })',
    { ctx, backingBuffer: null, fullBuffer: null, initAudio() {}, stopBacking() {} }
  )
  const file = { arrayBuffer: async () => new ArrayBuffer(2) }
  const previousSong = loadBackingFile(file)
  await turn()
  invalidateBackingLoads()
  const replaced = loadBackingFile(file)
  await turn()
  const backing = loadBackingFile(file)
  const full = loadBackingFile(file, 'full')
  await turn()
  decodes[3].resolve({ duration: 4 })
  decodes[2].resolve({ duration: 3 })
  decodes[1].resolve({ duration: 2 })
  decodes[0].reject(new Error('old song decode failure'))
  assert.deepEqual(await Promise.all([previousSong, replaced, backing, full]), [null, null, 3, 4])
  assert.equal(buffers().backingBuffer.duration, 3)
  assert.equal(buffers().fullBuffer.duration, 4)
  const cleared = loadBackingFile(file, 'full')
  await turn()
  clearBacking()
  decodes[4].resolve({ duration: 5 })
  assert.equal(await cleared, null)
  assert.equal(buffers().backingBuffer, null)
  assert.equal(buffers().fullBuffer, null)
})

test('Reduce Motion Results lights the last key once without starting rail or score animation', () => {
  const source = cut(read('renderer/results-motion.js'), 'const root =', '// the dim keyboard')
  const lit = [], labels = []
  const rail = { keys: [{ pc: 0 }, { pc: 1 }, { pc: 2 }], showChord: (on, keys) => lit.push([on, ...keys]) }
  const classList = { contains: (value) => value === 'reduce-motion', add() {}, remove() {} }
  const playResults = vm.runInNewContext(source.replaceAll('export ', '') + 'playResults', {
    IS_IOS: true, haptic() {}, document: { documentElement: { classList }, hidden: false, createElement: () => ({ setAttribute() {} }) },
    getComputedStyle: () => ({ getPropertyValue: () => '' }), createKeyLight: () => rail,
    clearTimeout() {}, cancelAnimationFrame() {}, requestAnimationFrame: () => assert.fail('still results must not animate')
  })
  let announced = 0
  const result = playResults({
    host: { classList, clientWidth: 300, prepend() {} }, earned: 3, celebrate: true, target: 100, lastPc: 2,
    setBig: (label) => labels.push(label), ring: { style: {} }, offset: 0, announce: () => { announced++ }
  })
  assert.deepEqual(lit, [[true, 2]])
  assert.deepEqual(labels, ['100%'])
  assert.equal(announced, 1)
  assert.equal(result.finished, true)
})

test('archive command replaces the existing zip only after the temporary archive succeeds', () => {
  const script = read('scripts/sign-mac.sh')
  assert.match(script, /^set -euo pipefail$/m)
  assert.doesNotMatch(script, /rm -f "\$OUT"/)
  assert.match(script, /OUT_TMP=\$\(mktemp "\$\{OUT\}\.XXXXXX"\)\nditto -c -k --keepParent "\$APP" "\$OUT_TMP"\nmv -f "\$OUT_TMP" "\$OUT"/)
  assert.match(script, /trap .*rm -f "\$OUT_TMP".* EXIT/)
})

test('import actions report failures and a storage error does not prevent the library from refreshing', async () => {
  const app = read('renderer/app.js')
  const messages = [], refreshed = []
  const ctx = vm.createContext({
    THIS_COMPUTER: 'this device', SETTINGS_WRITE_ERROR: 'Storage unavailable',
    recordDiagnosticFailure() {}, showSettingsStorageError: (msg) => messages.push(msg),
    status: (msg) => messages.push(msg), premium: () => false,
    openPaywall: async () => { throw new Error('purchase service unavailable') },
    getImported: async () => null, askConfirm: async () => true, deleteImported: async () => {},
    libTiles: new Map(), store: { set() {} }, recent: () => [],
    loadImportedLibrary: async () => { refreshed.push('library'); if (refreshed.length === 1) throw new Error('library unavailable') },
    renderRecent: () => refreshed.push('recent')
  })
  Object.defineProperty(ctx, 'localStorage', { get() { throw new Error('storage denied') } })
  const actions = vm.runInContext(
    cut(app, 'async function openImportSheet()', 'function showImportSheet()') +
    cut(app, 'async function openImported(', 'async function openFile(') +
    cut(app, 'async function removeImportedSong(', 'function openItem(') +
    '({ openImportSheet, openImported, removeImportedSong })', ctx
  )
  await actions.openImportSheet()
  await actions.openImported('missing')
  await actions.removeImportedSong({ file: 'imported:old', id: 'old', title: 'Old' })
  assert.match(messages[0], /purchase service unavailable/)
  assert.match(messages[2], /library unavailable/)
  assert.equal(messages[3], 'Storage unavailable')
  assert.deepEqual(refreshed, ['library', 'library', 'recent'])
})

test('maintenance refuses to export an empty storage snapshot after a read failure', async () => {
  for (const storage of [
    { get length() { throw new Error('storage denied') } },
    { length: 1, key: () => 'lumi.settings', getItem() { throw new Error('read refused') } }
  ]) {
    const sent = []
    const ctx = {
      window: { keylightMaintenance: { async call(op, payload) { sent.push({ op, payload }) } } },
      location: { search: '?task=export' }, URLSearchParams, localStorage: storage
    }
    await vm.runInNewContext(read('renderer/maintenance.js'), ctx)
    assert.deepEqual(sent.map(({ op }) => op), ['done'])
    assert.equal(sent[0].payload.ok, false)
    assert.equal(sent[0].payload.error, 'Could not export local settings')
  }
})

test('a stalled audio decode times out and releases the shared import slot', async () => {
  const { decodeFileAudio } = await import('../renderer/importer.js')
  let calls = 0
  const ctx = {
    decodeAudioData() {
      calls++
      if (calls === 1) return new Promise(() => {})
      return Promise.resolve({ duration: 2, sampleRate: 16000 })
    }
  }
  const file = { name: 'a.mp3', size: 128, arrayBuffer: async () => new ArrayBuffer(8) }
  await assert.rejects(() => decodeFileAudio(ctx, file, undefined, 25), /took too long to decode/i)
  const ok = await decodeFileAudio(ctx, file, undefined, 200)
  assert.equal(ok.duration, 2)
})

test('partyColorV migration preserves an explicit one-colour setting while defaulting unset values to rgb', () => {
  const app = read('renderer/app.js')
  const migration = cut(app, 'if (!settings.partyColorV) {', '// TV mode (iPhone and iPad only):')
  const run = (saved) => {
    const ctx = { settings: { partyColor: 'rgb', ...saved } }
    vm.runInNewContext(migration, ctx)
    return ctx.settings
  }
  const keptOne = run({ partyColor: 'one' })
  assert.equal(keptOne.partyColor, 'one')
  assert.equal(keptOne.partyColorV, 1)
  const unset = run({ partyColor: undefined })
  assert.equal(unset.partyColor, 'rgb')
  assert.equal(unset.partyColorV, 1)
  const keptRgb = run({ partyColor: 'rgb' })
  assert.equal(keptRgb.partyColor, 'rgb')
  assert.equal(keptRgb.partyColorV, 1)
})
