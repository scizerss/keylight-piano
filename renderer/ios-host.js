// Bootstrap of the iPhone/iPad app, added to index.html by ios/scripts/bundle-renderer.sh (the desktop page never loads it):
// the MIDI shim, file exports through the share sheet, WebAudio recovery after interruptions, and a stand-in for the
// camera/device API that WKWebView leaves out on a custom-scheme page.
import { requestMIDIAccess, onNativeEvent, nativeRequest } from './ios-midi.js'
import { exportBlob } from './ios-export.js'
import { incomingMime } from './incoming-types.js'

Object.defineProperty(navigator, 'requestMIDIAccess', { value: requestMIDIAccess, configurable: true })

// downloads: <a download href=blob:...> goes to the share sheet (Save to Files, AirDrop, ...)
const blobs = new Map()
const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL)
URL.createObjectURL = (blob) => { const url = create(blob); blobs.set(url, blob); return url }
URL.revokeObjectURL = (url) => { blobs.delete(url); revoke(url) }
let exports = Promise.resolve()
function download(anchor) {
  const blob = blobs.get(anchor.href)
  if (!blob || !anchor.download) return false
  exports = exports.then(() => exportBlob(blob, anchor.download)).catch((error) => {
    if (!(error instanceof Error)) throw error
    alert('Export failed: ' + error.message)
  })
  return true
}
const click = HTMLAnchorElement.prototype.click
HTMLAnchorElement.prototype.click = function () { if (!download(this)) click.call(this) }
document.addEventListener('click', (event) => {
  const anchor = event.target instanceof Element ? event.target.closest('a[download]') : null
  if (anchor && download(anchor)) event.preventDefault()
}, true)

// WebAudio: iOS suspends (or "interrupts") the context for a call, Siri, an alarm or a route change; the host says when to resume.
const contexts = new Set()
for (const name of ['AudioContext', 'webkitAudioContext']) {
  const Native = globalThis[name]
  if (!Native) continue
  globalThis[name] = class extends Native { constructor(...args) { super(...args); contexts.add(this) } }
}
let interrupted = false, interruption = 0
let activeSince = document.visibilityState === 'hidden' ? Infinity : performance.now()
document.addEventListener('visibilitychange', () => {
  activeSince = document.visibilityState === 'hidden' ? Infinity : performance.now()
})
const resume = (gesture = false) => {
  if (interrupted && (!gesture || performance.now() - activeSince <= 1000)) return
  const attempt = interruption
  for (const ctx of contexts) if (ctx.state !== 'running' && ctx.state !== 'closed') {
    ctx.resume().then(() => {
      if (gesture && ctx.state === 'running' && interruption === attempt) interrupted = false
    }).catch(() => {})
  }
}
onNativeEvent((event) => {
  if (event?.kind !== 'audio') return
  if (event.state === 'interrupted') { interrupted = true; interruption++ }
  if (event.state === 'resumed') {
    interrupted = false
    if (event.shouldResume === true) resume()
  }
  if (event.state === 'active') { interrupted = false; resume() }
})
// a touch is a user gesture: it also brings back a context that was interrupted while the page was in front
document.addEventListener('pointerdown', () => resume(true), { capture: true, passive: true })

// An insecure (custom scheme) page has no navigator.mediaDevices; the renderer only lists outputs and asks for the camera there.
if (!navigator.mediaDevices) {
  const stub = new EventTarget()
  stub.enumerateDevices = async () => []
  stub.getUserMedia = async () => { throw new DOMException('Camera is not available in this build', 'NotSupportedError') }
  Object.defineProperty(navigator, 'mediaDevices', { value: stub, configurable: true })
}

// Files opened in Keylight or shared to it (Files, Mail, Messages, AirDrop, other apps' share sheets). The host copies each one into
// its own temporary folder and tells the page with { kind: 'incoming', token, name, size }; the bytes are fetched from
// keylight-app://app/incoming/<token>, wrapped in a File and handed to window.keylightIncomingFile(file), which queues it and fires
// 'keylight-incoming-file' on window; incoming-file.js takes the queue (take()) and imports. A file that arrived before the page was
// ready is found with the incomingList request at start. The importer acknowledges each staged copy after saving or discarding it.
const maxIncomingBytes = 100 * 1024 * 1024
const tooLarge = 'This file is too large to add. The limit is 100 MB.'
const incomingQueue = []
const incomingTokens = new WeakMap()
const incomingFile = (file) => { incomingQueue.push(file); window.dispatchEvent(new CustomEvent('keylight-incoming-file')) }
incomingFile.take = () => incomingQueue.splice(0)
incomingFile.token = (file) => incomingTokens.get(file)
incomingFile.importId = (file) => {
  const token = incomingTokens.get(file)
  return token === undefined ? undefined : 'imp-shared-' + token
}
incomingFile.acknowledge = async (file) => {
  const token = incomingTokens.get(file)
  if (token === undefined) return
  await nativeRequest('incomingDone', { token })
  incomingTokens.delete(file)
}
Object.defineProperty(globalThis, 'keylightIncomingFile', { value: incomingFile, configurable: true })
const claimed = new Set()
async function claimIncoming(info) {
  if (info && info.error) { alert(String(info.error)); return }
  if (!info || typeof info.token !== 'string' || claimed.has(info.token)) return
  claimed.add(info.token)
  const discardOversize = async () => {
    alert(tooLarge)
    await nativeRequest('incomingDone', { token: info.token })
  }
  try {
    const file = await readIncoming(info, discardOversize)
    if (!file) return
    if (file.name.toLowerCase().endsWith(BACKUP_EXTENSION)) { await restoreIncomingBackup(file, info.token); return }
    incomingFile(file)
  } catch (error) {
    alert('Could not open the file: ' + (error instanceof Error ? error.message : 'unknown error'))
  }
}

async function readIncoming(info, discardOversize) {
  if (info.size > maxIncomingBytes) return await discardOversize()
  if (!Number.isSafeInteger(info.size) || info.size <= 0) throw new Error('The file size could not be checked')
  const response = await fetch(new URL('/incoming/' + encodeURIComponent(info.token), location.href))
  if (response.status === 413 || Number(response.headers?.get('Content-Length')) > maxIncomingBytes) return await discardOversize()
  if (!response.ok) throw new Error('The file could not be opened')
  const blob = await response.blob()
  if (blob.size > maxIncomingBytes) return await discardOversize()
  const name = String(info.name || 'song')
  const file = new File([blob], name, { type: incomingMime(name) })
  incomingTokens.set(file, info.token)
  return file
}

incomingFile.readRecording = (info) => readIncoming(info, async () => { throw new Error(tooLarge) })
incomingFile.recoverRecording = nativeRequest('incomingList').then((list) => {
  let recording
  if (Array.isArray(list)) for (const info of list) {
    if (!info?.recording) claimIncoming(info)
    else if (!recording) recording = info
    else if (typeof info.token === 'string') void nativeRequest('incomingDone', { token: info.token }).catch(() => {})   // one recovered recording at most
  }
  return recording
}).catch(() => {})

// The backup files' extension (EXTENSION in backup-format.js; scripts/test-backup.js checks they agree). backup.js is loaded only when
// needed, so a fault there can never stop the MIDI and audio code above.
const BACKUP_EXTENSION = '.keylightbackup'
// A Keylight backup opened from the Files app, Mail or AirDrop ("Open in Keylight"): asks, restores, then reloads the page as the
// Restore button in Settings does. The host's copy is released either way.
async function restoreIncomingBackup(file, token) {
  try {
    const { restoreBackup, BackupError, restorePrompt } = await import('./backup.js')
    const { saveImportedBatch } = await import('./importer.js')
    try {
      const result = await restoreBackup(file, { saveSongs: saveImportedBatch, storage: localStorage, confirm: (plan) => confirm(restorePrompt(plan)) })
      if (result.restored) { alert(`Restored ${result.songs} ${result.songs === 1 ? 'song' : 'songs'} and your settings and progress`); location.reload() }
    } catch (error) {
      if (!(error instanceof Error)) throw error
      alert(error instanceof BackupError ? error.message : 'That did not work: ' + error.message)
    }
  } finally {
    await nativeRequest('incomingDone', { token }).catch(() => {})
    incomingTokens.delete(file)
  }
}
onNativeEvent((event) => { if (event && event.kind === 'incoming') claimIncoming(event) })

// Automatic backup: when the page goes hidden (the app is left, the screen locks) a "progress only" backup goes to the host, which
// keeps it in the Documents folder the Files app shows as "Keylight" (AutoBackup.swift); at most once every 6 hours (backup.js).
// Nothing is shown. A failure is only logged by the host (the local diagnostics list).
let autoBackupRunning = false
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden' || autoBackupRunning) return
  autoBackupRunning = true
  import('./backup.js')
    .then(({ runAutoBackup }) => runAutoBackup({ listSongs: async () => (await import('./importer.js')).listImported(), storage: localStorage, request: nativeRequest }))
    .catch(() => {})
    .finally(() => { autoBackupRunning = false })
})
