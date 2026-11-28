// Files that arrive from outside the page: "Open in Keylight" / the share sheet on iPhone and iPad (ios-host.js hands each one over
// as a File through window.keylightIncomingFile and the 'keylight-incoming-file' event). Each is sent through the same import
// as a file picked in the app.
//
//   import { mountIncomingFile } from './incoming-file.js'
//   mountIncomingFile({ handle: handleImportFile })          // app.js: the import sheet does the rest
// Without `handle` it imports and saves by itself: mountIncomingFile({ getContext, onImported, onError }).
import { importFile, getImported, saveImported, isAudioFile, isScoreFile, isLyricsFile } from './importer.js'

/** What a file is to the importer: 'audio', 'video', 'score', 'lyrics', or null when Keylight cannot use it. */
export function incomingKind(file) {
  if (!file || typeof file.name !== 'string') return null
  if (isScoreFile(file)) return 'score'
  if (isLyricsFile(file)) return 'lyrics'
  if (/\.(mp4|m4v|mov)$/i.test(file.name) || /^video\//.test(file.type || '')) return isAudioFile(file) ? 'video' : null
  return isAudioFile(file) ? 'audio' : null
}

export function serializeSongImports(handle, onBusy) {
  let active = null
  return async (file, options) => {
    if (!file) return
    if (active && !options?.importId) { onBusy(); return }
    while (active) await active.catch(() => {})
    const job = active = Promise.resolve().then(() => handle(file, options))
    try { return await job } finally { active = null }
  }
}

/**
 * Imports one incoming file. Returns the saved song record, or null when `handle` took it over.
 * Throws an Error with a sentence for the user when the file is not something Keylight can add.
 */
export async function importIncoming(file, { handle, getContext, onStage, onImported, acknowledge, importId } = {}) {
  if (!incomingKind(file)) {
    await acknowledge?.(file)
    throw new Error('Keylight can add audio, video, MIDI and MusicXML files. "' + (file && file.name) + '" is not one of those.')
  }
  if (handle) {
    // The UI can catch import failures, so resolving alone does not confirm a save.
    const outcome = await handle(file, { importId })
    if (outcome === 'saved' || outcome === 'discarded') await acknowledge?.(file)
    return null
  }
  const existing = importId && await getImported(importId)
  if (existing) {
    await acknowledge?.(file)
    return existing
  }
  let song
  try {
    song = await importFile(file, { ctx: getContext ? getContext() : new (globalThis.AudioContext || globalThis.webkitAudioContext)(), simplify: false, lookup: false, onStage })
  } catch (error) {
    await acknowledge?.(file)
    throw error
  }
  const record = await saveImported(importId ? { ...song, id: importId } : song)
  await acknowledge?.(file)
  if (onImported) await onImported(record, song)
  return record
}

/** Starts listening. Files that arrived before this ran are taken first. Returns a function that stops listening. */
export function mountIncomingFile({ target = globalThis, onError = (message) => globalThis.alert && globalThis.alert(message), ...deps } = {}) {
  let chain = Promise.resolve()
  const drain = () => {
    const entry = target.keylightIncomingFile
    const files = entry && typeof entry.take === 'function' ? entry.take() : []
    for (const file of files) {
      // one at a time: two imports share the audio context and the progress display
      chain = chain.then(() => importIncoming(file, {
        ...deps,
        importId: entry.importId?.(file),
        acknowledge: (file) => entry.acknowledge?.(file)
      })).catch((error) => onError(error instanceof Error ? error.message : 'Could not add that file'))
    }
  }
  target.addEventListener('keylight-incoming-file', drain)
  drain()
  return () => target.removeEventListener('keylight-incoming-file', drain)
}
