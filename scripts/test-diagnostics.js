const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const vm = require('node:vm')

async function storageFailures() {
  const source = readFileSync(require.resolve('../renderer/app.js'), 'utf8')
  const failures = [], messages = [], notices = new Map()
  let readError = true, saves = 0
  const context = vm.createContext({
    recordDiagnosticFailure: (...args) => failures.push(args), status: (message) => messages.push(message),
    $: (id) => {
      if (!notices.has(id)) notices.set(id, { textContent: '', classList: { add() {}, remove() {}, toggle() {} } })
      return notices.get(id)
    },
    importedSongs: [{ id: 'previous' }], libraryReadFailed: false, importedLibraryLoaded: false, pendingLibraryRead: null,
    LIBRARY_READ_ERROR: 'Could not read saved songs', LIBRARY_WRITE_ERROR: 'Could not write saved songs',
    renderLibrary() {}, updateHome() {},
    dbListSongs: async () => { if (readError) throw Error('Unreadable database'); return [{ id: 'saved' }] },
    dbSaveSong: async (song) => { saves++; return song },
    localStorage: {
      getItem: () => { if (readError) throw Error('Unreadable settings'); return '{}'; },
      setItem: () => { saves++; throw Error('Storage full') }
    }
  })
  vm.runInContext(source.slice(source.indexOf('const settingReadFailures'), source.indexOf('const settings = Object.assign')) +
    source.slice(source.indexOf('function loadImportedLibrary()'), source.indexOf('function coverTile(')), context)
  const run = (code) => vm.runInContext(code, context)
  assert.equal(run('store.get("lumi.settings", null)'), null)
  run('store.set("lumi.settings", {})')
  await run('loadImportedLibrary()')
  assert.equal(context.importedSongs[0].id, 'previous', 'an unreadable database keeps the last library in memory')
  await assert.rejects(run('saveImported({ id: "previous" })'), /Could not read saved songs/)
  assert.equal(saves, 0, 'failed reads do not allow writes over unread data')
  assert.match(notices.get('settingsStorageNotice').textContent, /could not read/)
  assert.match(notices.get('libraryStorageNotice').textContent, /Could not read saved songs/)
  assert.ok(messages.length)
  readError = false
  run('store.get("lumi.settings", null)')
  run('store.set("lumi.settings", {})')
  assert.match(notices.get('settingsStorageNotice').textContent, /could not save/)
  await run('loadImportedLibrary()')
  assert.equal(context.importedSongs[0].id, 'saved')
  await run('saveImported({ id: "saved" })')
  assert.equal(saves, 2)
  assert.deepEqual(failures.map((failure) => failure[1]), ['Read settings or progress', 'Read saved songs', 'Save settings or progress'])
}

async function main() {
  const { diagnosticReport, mountDiagnostics } = await import('../renderer/diagnostics.js')
  const report = diagnosticReport({
    version: '0.3.0', platform: 'Windows', midiAvailable: true,
    inputs: [{ name: 'Keyboard', state: 'connected', serial: 'secret-serial' }], outputs: [],
    keyboard: 'Keyboard', range: 'C3-B4', audio: { base: .002, output: .028, sampleRate: 48000 },
    lights: { transport: 'MIDI notes', state: 'Disconnected', boards: 0 },
    camera: { running: true, calibrated: false },
    song: { title: 'private-song' }, token: 'private-token', path: '/private/home/person'
  })
  assert.match(report, /Keyboard \(connected\)/)
  assert.match(report, /Audio buffer: 2\.0 ms/)
  assert.match(report, /Output delay estimate: 28\.0 ms/)
  assert.match(report, /Camera calibration: Not set/)
  for (const secret of ['secret-serial', 'private-song', 'private-token', '/private/home/person']) assert.equal(report.includes(secret), false)
  assert.match(diagnosticReport({ version: 'dev', platform: 'Android' }), /MIDI available: No/)
  assert.match(diagnosticReport({ version: 'dev', platform: 'Android' }), /Audio buffer: Not reported/)
  const beta = diagnosticReport({
    version: '1.0.0 (6)', platform: 'iOS', midiStatus: 'Could not connect to Piano. Try again.',
    failures: [
      { at: '2026-11-22T10:00:00.000Z', area: 'MIDI', operation: 'Open Piano', detail: 'MIDI input is busy' },
      { at: '2026-11-22T10:01:00.000Z', area: 'Storage', operation: 'Read saved songs', detail: 'UnknownError' }
    ],
    nativeLog: [
      { message: 'JavaScript object is missing', source: 'app.js', line: 123 },
      { message: 'Page failed to start loading', code: -1001 },
      { message: 'Uncaught JavaScript error', source: '/private/user/data.js', line: 10 }
    ]
  })
  assert.match(beta, /Version: 1\.0\.0 \(6\)\nPlatform: iOS/)
  assert.match(beta, /MIDI status: Could not connect to Piano/)
  assert.match(beta, /MIDI: Open Piano \(MIDI input is busy\)/)
  assert.match(beta, /Storage: Read saved songs \(UnknownError\)/)
  assert.match(beta, /Native log:\n- JavaScript object is missing \(app\.js:123\)\n- Page failed to start loading \(code -1001\)/)
  assert.doesNotMatch(beta, /\/private\/user/)
  assert.doesNotMatch(diagnosticReport({ version: 'dev', nativeLog: { error: 'Unknown operation' } }), /Native log:/)
  const controls = new Map()
  globalThis.document = { getElementById(id) {
    if (!controls.has(id)) controls.set(id, {})
    return controls.get(id)
  } }
  const dialog = document.getElementById('diagnosticsDialog')
  dialog.addEventListener = () => {}
  dialog.showModal = () => { dialog.open = true }
  try {
    mountDiagnostics(() => ({ version: 'dev' }), { share: true, getNativeLog: async () => ({}) })
    await controls.get('openDiagnostics').onclick()
    assert.equal(dialog.open, true)
    assert.match(controls.get('diagnosticsReport').textContent, /Keylight connection report/i)
    assert.equal(controls.get('saveDiagnostics').textContent, 'Share report')
  } finally { delete globalThis.document }
  await storageFailures()
  console.log('diagnostics: connection values, unavailable measurements and private-field exclusion pass')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
