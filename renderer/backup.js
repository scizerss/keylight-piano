import { BackupError, EXTENSION, backupRestoreRevision, createBackup, createProgressOnlyBackup, restoreBackup } from './backup-format.js'
import { downloadFile } from './download.js'
import { SHARE_LIMIT_BYTES } from './export-limit.js'
import { COURSE, isItemDone, ownGet, parseProgress, placedAt } from './course/index.js'
export { BackupError, MAGIC, VERSION, EXTENSION, createBackup, createProgressOnlyBackup, backupSize, RECORDINGS_TOO_LARGE, RECORDINGS_LEFT_OUT, readBackup, restoreBackup } from './backup-format.js'

const songsText = (count) => count + (count === 1 ? ' song' : ' songs')

// The question asked before a backup is restored (the Restore button here, and a backup opened in Keylight from the Files app: ios-host.js).
export const restorePrompt = (plan) => `Restore the backup from ${new Date(plan.created).toLocaleString()}?\n\n` +
  `${songsText(plan.songs.length)} and ${Object.keys(plan.storage).length} saved settings and progress entries are added. ` +
  'Songs and entries with the same identity are replaced; everything else you have stays.'

// ----- automatic backup (iPhone and iPad) -----
// ios-host.js calls runAutoBackup when the page goes hidden. It makes a "progress only" backup (songs' notes, progress and settings, no
// recordings) and hands it to the Swift host in chunks, which keeps it in the app's Documents folder (the Files app shows it as
// "Keylight", AutoBackup.swift), at most once every 6 hours. The time is kept under a key that does not start with "lumi.", so it
// never travels inside a backup. Nothing is asked or shown; the caller drops errors.
export const AUTO_BACKUP_KEY = 'keylight.autoBackupAt'
export const AUTO_BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000
export const AUTO_BACKUP_MAX_BYTES = 64 * 1024 * 1024     // AutoBackup.swift / BridgeMessage.maxAutoBackup refuse more
const AUTO_BACKUP_CHUNK = 32768
// settings and bookkeeping that say nothing about use: a page with only these has no progress worth saving (a fresh install
// must not push a good backup out of the Files folder)
const IDLE_KEYS = /^lumi\.(onboarded|settings|libview|libfilter|audioSafeBuffer|support|supportOfferSeen|courseOrder|betaNoticeSeen|importNotice\..*)$/
function hasCourseProgress(raw) {
  const progress = parseProgress(raw)
  if (Object.values(progress.exams).some((exam) => exam.passed) || progress.unlocked.some((level) => level > 1) || placedAt(progress) > 1) return true
  return COURSE.levels.some((level) => [...level.lessons, ...(level.exam ? [level.exam] : [])].some((owner) =>
    owner.items.some((item) => isItemDone(item, ownGet(ownGet(progress.lessons, owner.id), item.id), owner.pass?.minStars || 0))))
}
const hasProgress = (songs, storage) => {
  if (songs.length) return true
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (key === 'lumi.course') {
      if (hasCourseProgress(storage.getItem(key))) return true
    } else if (key != null && key.startsWith('lumi.') && !IDLE_KEYS.test(key)) return true
  }
  return false
}

/**
 * runAutoBackup({ listSongs, storage, request, now? }) -> 'saved' | 'skipped' (saved less than 6 hours ago) | 'nothing' (no progress yet).
 * request(op, params) is nativeRequest. Throws when the host refuses or the backup cannot be made; the time is only kept after a save.
 */
export async function runAutoBackup({ listSongs, storage, request, now = new Date() }) {
  const revision = backupRestoreRevision()
  if (revision === null) return 'skipped'
  const restoreStarted = () => backupRestoreRevision() !== revision
  const last = Number(storage.getItem(AUTO_BACKUP_KEY))
  if (last > 0 && last <= now.getTime() && now.getTime() - last < AUTO_BACKUP_INTERVAL_MS) return 'skipped'   // a time in the future (clock set back) counts as due
  const songs = await listSongs()
  if (restoreStarted()) return 'skipped'
  if (!hasProgress(songs, storage)) return 'nothing'
  const { blob } = await createProgressOnlyBackup({ songs, storage, now, maxBytes: AUTO_BACKUP_MAX_BYTES })
  if (restoreStarted()) return 'skipped'
  const token = await request('autoBackupBegin', { size: blob.size })
  try {
    for (let offset = 0; offset < blob.size; offset += AUTO_BACKUP_CHUNK) {
      if (restoreStarted()) break
      const bytes = new Uint8Array(await blob.slice(offset, offset + AUTO_BACKUP_CHUNK).arrayBuffer())
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      await request('autoBackupChunk', { token, data: btoa(binary) })
    }
    if (restoreStarted()) {
      await request('autoBackupAbort', { token }).catch(() => {})
      return 'skipped'
    }
    await request('autoBackupFinish', { token })
  } catch (error) {
    await request('autoBackupAbort', { token }).catch(() => {})
    throw error
  }
  try { storage.setItem(AUTO_BACKUP_KEY, String(now.getTime())) } catch (_e) { /* the next time the page is hidden saves again */ }
  return 'saved'
}
export function downloadBackup({ blob, name }) { downloadFile(blob, name) }

export function mountBackupControls(container, { listSongs, saveSongs, storage, notice, onRestored }) {
  const make = (text) => Object.assign(document.createElement('button'), { type: 'button', className: 'ghost', textContent: text })
  const backup = make('Back up songs and progress')
  const restore = make('Restore a backup')
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: EXTENSION, hidden: true })
  let busy = false
  const run = async (action) => {
    if (busy) return
    busy = backup.disabled = restore.disabled = true
    try { await action() } catch (error) {
      if (!(error instanceof Error)) throw error
      notice(error instanceof BackupError ? error.message : 'That did not work: ' + error.message)
    } finally { busy = backup.disabled = restore.disabled = false }
  }
  backup.onclick = () => run(async () => {
    // the iPhone/iPad share sheet takes at most SHARE_LIMIT_BYTES: past that the recordings stay out, and the notice says so
    const { IS_IOS } = await import('./platform.js')     // read when used: the page's platform, not at load (the unit tests have no page)
    const result = await createBackup({ songs: await listSongs(), storage, maxBytes: IS_IOS ? SHARE_LIMIT_BYTES : Infinity })
    downloadBackup(result)
    notice(`Backup download requested: ${songsText(result.songs)} with your settings and progress` +
      (result.skipped.length ? `. Left out: ${result.skipped.map((song) => `${song.title} (${song.reason})`).join('; ')}` : '') +
      (result.notice ? `. ${result.notice}` : ''))
  })
  restore.onclick = () => input.click()
  input.onchange = () => run(async () => {
    const file = input.files && input.files[0]
    input.value = ''
    if (!file) return
    const result = await restoreBackup(file, {
      saveSongs, storage,
      confirm: (plan) => confirm(restorePrompt(plan))
    })
    if (result.restored) { notice(`Restored ${songsText(result.songs)} and your settings and progress`); onRestored(result) }
  })
  container.append(backup, restore, input)
  return { backup, restore }
}
