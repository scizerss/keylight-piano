// node --test scripts/test-cover-review-fixes.js
// Regression tests for the eight confirmed findings of the independent review of the iOS piano cover (commit 9f6e7cc).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '..')
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8')
const load = (rel) => import(pathToFileURL(path.join(ROOT, 'renderer', rel)).href)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// a host whose coverStart answers and whose coverCancel can be made to hang
function host({ hangCancel = false } = {}) {
  const listeners = new Set()
  const calls = []
  return {
    calls, listeners,
    request: async (op, args) => { calls.push({ op, args }); return op === 'coverStart' ? 'job-1' : hangCancel ? new Promise(() => {}) : true },
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    emit: (kind, details = {}) => { for (const fn of [...listeners]) fn({ kind, jobId: 'job-1', ...details }) }
  }
}
function fakePage() {
  const listeners = new Set()
  return { hidden: false, addEventListener: (_t, fn) => listeners.add(fn), removeEventListener: (_t, fn) => listeners.delete(fn), listeners,
    set(hidden) { this.hidden = hidden; for (const fn of [...listeners]) fn() } }
}

test('1. a track with more than two channels is read as at most stereo (iOS, PianoCoverAudio.swift)', {
  skip: fs.existsSync(path.join(ROOT, 'ios', 'Keylight', 'PianoCoverAudio.swift')) ? false : 'native iOS source is outside this repository'
}, () => {
  const swift = read('ios', 'Keylight', 'PianoCoverAudio.swift')
  assert.match(swift, /let srcChannels = min\(2, max\(1, Int\(asbd\?\.mChannelsPerFrame \?\? 2\)\)\)/)
  assert.ok(!/let srcChannels = max\(1,/.test(swift), 'the unclamped count is gone')
})

test('2. a host that never answers coverCancel does not hang the import, and the staged file is flagged as still in use', async () => {
  const { generatePianoCover } = await load('piano-cover-import.js')
  // the watchdog fires, the cancel gets no reply
  const hung = host({ hangCancel: true })
  const t0 = Date.now()
  await assert.rejects(generatePianoCover('token-1', { request: hung.request, subscribe: hung.subscribe, inactivityMs: 20, cancelReplyMs: 50, page: null }),
    (e) => e.name === 'CoverTimeoutError' && e.cancelUnconfirmed === true)
  assert.ok(Date.now() - t0 < 1000, 'bounded, not forever')
  assert.deepEqual(hung.calls.map((c) => c.op), ['coverStart', 'coverCancel'])
  // the user cancels and the host is hung
  const controller = new AbortController()
  const cancelled = host({ hangCancel: true })
  const run = generatePianoCover('token-1', { request: cancelled.request, subscribe: cancelled.subscribe, signal: controller.signal, cancelReplyMs: 50, page: null })
  await wait(5)
  controller.abort()
  await assert.rejects(run, (e) => e.name === 'AbortError' && e.cancelUnconfirmed === true)
  // a host that confirms is not flagged
  const fine = host()
  await assert.rejects(generatePianoCover('token-1', { request: fine.request, subscribe: fine.subscribe, inactivityMs: 20, page: null }), (e) => e.name === 'CoverTimeoutError' && !e.cancelUnconfirmed)
})

test('2. app.js keeps the staged file when the cancel is unconfirmed', () => {
  const app = read('renderer', 'app.js')
  assert.match(app, /if \(e\?\.cancelUnconfirmed\) \{[\s\S]*?return 'unconfirmed'/)
  const incoming = read('renderer', 'incoming-file.js')
  assert.match(incoming, /outcome === 'saved' \|\| outcome === 'discarded'/, 'only saved and discarded release the file')
})

test('3. the silence watchdog waits while the page is hidden and starts again when it is back', async () => {
  const { generatePianoCover } = await load('piano-cover-import.js')
  const bridge = host()
  const page = fakePage()
  const progress = []
  const run = generatePianoCover('token-1', { request: bridge.request, subscribe: bridge.subscribe, inactivityMs: 60, cancelReplyMs: 20, page, onProgress: (p) => progress.push(p) })
  await wait(5)
  bridge.emit('coverProgress', { done: 1, total: 4 })
  page.set(true)                       // the app goes to the background: the host pauses
  await wait(200)                      // far past the 60 ms limit
  assert.equal(bridge.calls.some((c) => c.op === 'coverCancel'), false, 'no cancel while hidden')
  page.set(false)                      // back: the clock starts fresh
  await wait(20)
  bridge.emit('coverProgress', { done: 2, total: 4 })
  await wait(20)
  bridge.emit('coverDone', { notes: [{ pitch: 60, start: 0, dur: 1 }], duration: 4 })
  assert.deepEqual((await run).notes, [{ pitch: 60, start: 0, dur: 1 }])
  assert.deepEqual(progress, [0.25, 0.5])
  assert.equal(page.listeners.size, 0, 'the listener is removed')
  // and a job that stays silent while visible still times out
  const silent = host()
  await assert.rejects(generatePianoCover('token-1', { request: silent.request, subscribe: silent.subscribe, inactivityMs: 30, cancelReplyMs: 20, page: fakePage() }), { name: 'CoverTimeoutError' })
})

test('4. a key-count change re-arranges the playing cover before the window and hands are touched', () => {
  const app = read('renderer', 'app.js')
  const body = app.slice(app.indexOf('function applyKeyCount() {'), app.indexOf('function setKeyboardWindow('))
  const refresh = body.indexOf('refreshPlayingCover()')
  assert.ok(refresh > 0, 'applyKeyCount refreshes the cover')
  assert.ok(refresh < body.indexOf('player.setWindowKeys('), 'before setWindowKeys')
  assert.ok(refresh < body.indexOf('recheckHands()'), 'before recheckHands')
  assert.equal(body.match(/refreshPlayingCover\(\)/g).length, 1, 'and only once')
})

test('5. an uncalibrated 88-key keyboard keeps A0 to B0 in reach', async () => {
  const { coverKeyRange, playerWindowStart } = await load('cover-keys.js')
  assert.deepEqual(coverKeyRange(88, 24), { lo: 21, hi: 108 })
  assert.deepEqual(coverKeyRange(49, 48), { lo: 48, hi: 96 })
  assert.deepEqual(coverKeyRange(24, 200), { lo: 104, hi: 127 })
  // the octave-snapped base of an uncalibrated keyboard is 24: the window must start at A0 (21) instead
  assert.equal(playerWindowStart({ keys: 88, calibrated: false, wide: false, start: 21, base: 24 }), 21)
  assert.equal(playerWindowStart({ keys: 88, calibrated: true, wide: false, start: 21, base: 21 }), 21)
  assert.equal(playerWindowStart({ keys: 88, calibrated: true, wide: false, start: 21, base: 33 }), 33, 'a calibrated keyboard keeps what it learned')
  assert.equal(playerWindowStart({ keys: 49, calibrated: false, wide: false, start: 36, base: 36 }), 36)
  assert.equal(playerWindowStart({ keys: 24, calibrated: false, wide: true, start: 30, base: 48 }), 30, 'a wide on-screen window starts where the song wants it')
  const app = read('renderer', 'app.js')
  assert.match(app, /player\.setWindowStart\(playerWindowStart\(\{/)
  assert.match(app, /function coverKeyRange\(\) \{ return coverRange\(kbKeys\(\)/)
})

test('6. the Today practice glyphs keep their violet outside the iPhone/iPad app', () => {
  const css = read('renderer', 'home.css')
  assert.match(css, /data-id="ear"\] \.pr-glyph, #screen-home \.pr-chip\[data-id="echo"\] \.pr-glyph \{ --tint: 182, 156, 255; \}/)
  assert.ok(!/--tint: 242, 239, 232/.test(css))
  assert.match(read('renderer', 'ios.css'), /html\.ios #screen-home \.pr-glyph \{[^}]*color: var\(--ivory\)/, 'iOS sets the ivory itself')
})

test('7. a phrase that starts within the onset cluster gap after a left-hand onset still lowers its ceiling', async () => {
  const { separateHands } = await load('arranger.js')
  const right = [{ pitch: 76, start: 0, dur: 0.9, vel: 80 }, { pitch: 60, start: 1.04, dur: 0.5, vel: 80 }]
  const left = [{ pitch: 64, start: 1.0, dur: 0.5 }, { pitch: 67, start: 1.03, dur: 0.5 }]
  const kept = separateHands(left, right, { lo: 21, hi: 108 })
  assert.deepEqual(kept.map((n) => n.pitch), [52, 55], 'both left notes sit below the right hand\'s 60 that starts 10 ms after them')
  const apart = separateHands(left, [right[0], { ...right[1], start: 1.2 }], { lo: 21, hi: 108 })
  assert.deepEqual(apart.map((n) => n.pitch), [64, 67], 'a phrase that starts clearly later does not')
})

test('8. an arrangement is only kept next to the notes it arranges', async () => {
  const { importedRecord } = await load('importer.js')
  const { createBackup, readBackup, MAGIC, VERSION } = await load('backup-format.js')
  const arrangement = { difficulty: 'easy', keyRange: { lo: 48, hi: 71 } }
  const raw = [{ pitch: 60, start: 0, dur: 0.5 }, { pitch: 64, start: 0.5, dur: 0.5 }]
  const notes = [{ pitch: 60, start: 0, dur: 0.5, hand: 'right' }]
  const song = { id: 'imp-fix8', title: 'T', artist: 'A', notes, duration: 2, tempo: 120, source: 'audio' }
  assert.equal(importedRecord({ ...song, coverArrangement: arrangement }).coverArrangement, null, 'importer: no coverRaw')
  assert.deepEqual(importedRecord({ ...song, coverRaw: raw, coverArrangement: arrangement }).coverArrangement, arrangement)
  assert.equal(importedRecord({ ...song, coverRaw: [], coverArrangement: arrangement }).coverArrangement, null, 'importer: coverRaw that does not validate')
  const storage = { length: 0, key: () => null, getItem: () => null }
  const made = await createBackup({ songs: [{ ...song, id: 'imp-fix8a', coverArrangement: arrangement }, { ...song, id: 'imp-fix8b', coverRaw: raw, coverArrangement: arrangement }], storage, now: new Date(2026, 10, 26, 12, 0) })
  const plan = await readBackup(new File([made.blob], 'b.keylightbackup'))
  assert.equal(plan.songs[0].coverArrangement, null, 'backup: no coverRaw')
  assert.deepEqual(plan.songs[1].coverArrangement, arrangement)
  // an arrangement that is not valid still rejects the backup, with or without notes
  const forge = (songs) => {
    const body = new TextEncoder().encode(JSON.stringify({ format: 'keylight-backup', version: VERSION, created: new Date().toISOString(), songs, storage: {} }))
    const head = new Uint8Array(MAGIC.length + 4)
    head.set(new TextEncoder().encode(MAGIC))
    new DataView(head.buffer).setUint32(MAGIC.length, body.length, true)
    return new File([head, body], 'bad.keylightbackup')
  }
  await assert.rejects(readBackup(forge([{ ...song, coverArrangement: { difficulty: 'nope', keyRange: { lo: 48, hi: 71 } } }])), /cover arrangement/)
  const app = read('renderer', 'app.js')
  assert.match(app, /const arrangement = record\?\.coverRaw \? record\.coverArrangement : null/, 'bestFor')
})
