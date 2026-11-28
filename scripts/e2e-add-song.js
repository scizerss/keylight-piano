// The real app, headless: Add a song with an audio file and read what the import sheet shows. Not part of `npm test`.
//   npx electron --no-sandbox --ozone-platform=headless scripts/e2e-add-song.js -- --audio file.wav [--cancel-after-ms 1500]
// Needs the piano cover model cache (tools/music2midi/fetch-and-build-onnx.sh). Prints ADD_SONG_RESULT {json}.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const argv = process.argv.slice(process.argv.indexOf('--') + 1)
const arg = (name, fallback = '') => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : fallback }
const audio = arg('audio')
if (!audio) { console.error('--audio <file> is required'); process.exit(2) }
const cancelAfter = Number(arg('cancel-after-ms', '0'))
const then = arg('then')
const thenB64 = then ? fs.readFileSync(then).toString('base64') : ''
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'keylight-e2e-'))
Object.assign(process.env, { LUMI_USERDATA: profile, LUMI_NO_KEYBOARD: '1', LUMI_BACKUP: '0', LUMI_SOUND: '' })

const b64 = fs.readFileSync(audio).toString('base64')
const name = path.basename(audio)
const mime = /\.wav$/i.test(name) ? 'audio/wav' : /\.mp3$/i.test(name) ? 'audio/mpeg' : 'audio/mp4'
const PAGE = `(async () => {
  const $ = (id) => document.getElementById(id)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 100 && !$('importFile'); i++) await sleep(100)
  const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0))
  const file = new File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(mime)} })
  const out = { stages: [] }
  out.manifestStatus = await fetch('keylight://app/cover-models/manifest.json').then((r) => r.status, (e) => String(e))
  const mod = await import('keylight://app/piano-cover-desktop.js')
  out.available = await mod.createDesktopCoverBridge({ createWorker() {}, decode() {} }).available()
  out.platform = [navigator.userAgent.slice(0, 60), typeof globalThis.__keylightIOS, location.search]
  $('impLookup').checked = false       // no cover or lyrics lookup: nothing leaves this machine
  const t0 = performance.now()
  const input = $('importFile')
  const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
  let last = ''
  const cancelAfter = ${cancelAfter}
  for (let i = 0; i < 1800; i++) {
    await sleep(100)
    const stage = $('impStage')?.textContent || ''
    if (stage !== last) { last = stage; out.stages.push([Math.round(performance.now() - t0), $('impBusyTitle')?.textContent, stage]) }
    if (cancelAfter && performance.now() - t0 > cancelAfter && !$('impCancel').hidden) { out.cancelShown = true; $('impCancel').click(); await sleep(1500); break }
    if (!$('impResult').classList.contains('hidden')) break
  }
  out.wallMs = Math.round(performance.now() - t0)
  out.resultShown = !$('impResult').classList.contains('hidden')
  out.sheetHidden = $('importSheet').classList.contains('hidden')
  out.meta = $('impMeta')?.textContent || ''
  out.difficultyRowVisible = !$('impDifficultyRow').hidden
  out.difficulty = $('impDifficulty')?.value
  out.title = $('impTitle')?.value
  if (cancelAfter && ${JSON.stringify(!!then)}) {
    // after a cancel the next song must go through: the same sheet, a short file
    await sleep(500)
    const again = Uint8Array.from(atob(${JSON.stringify(thenB64)}), (c) => c.charCodeAt(0))
    const second = new File([again], 'second.wav', { type: 'audio/wav' })
    const dt2 = new DataTransfer(); dt2.items.add(second); input.files = dt2.files
    const t1 = performance.now()
    input.dispatchEvent(new Event('change', { bubbles: true }))
    for (let i = 0; i < 600 && $('impResult').classList.contains('hidden'); i++) await sleep(100)
    out.afterCancel = { resultShown: !$('impResult').classList.contains('hidden'), wallMs: Math.round(performance.now() - t1), meta: $('impMeta')?.textContent || '' }
  }
  out.status = document.querySelector('#toast, .toast, #status')?.textContent || ''
  return out
})()`

let peakKb = 0
const sampler = setInterval(() => {
  const total = app.getAppMetrics().reduce((sum, m) => sum + (m.memory.workingSetSize || 0), 0)
  if (total > peakKb) peakKb = total
}, 250)

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (e) => { const t = e.message ?? e; if (/IMPORT|COVER/.test(t)) console.log('PAGE ' + String(t).slice(0, 200)) })
  win.webContents.once('did-finish-load', async () => {
    try {
      const result = await win.webContents.executeJavaScript(PAGE)
      const metrics = app.getAppMetrics().reduce((sum, m) => sum + (m.memory.workingSetSize || 0), 0)
      result.memoryMBAtEnd = Math.round(metrics / 1024)
      result.peakMemoryMB = Math.round(peakKb / 1024)
      clearInterval(sampler)
      console.log('ADD_SONG_RESULT ' + JSON.stringify(result))
      app.exit(0)
    } catch (error) { console.error('ADD_SONG_FAIL ' + (error && error.stack || error)); app.exit(1) }
  })
})
require('../main.js')
