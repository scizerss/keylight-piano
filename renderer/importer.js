// Song import: MIDI / MusicXML (also compressed .mxl) files, and audio
// recordings turned into notes.
//
// Audio goes through Spotify's Basic Pitch model (Apache-2.0, runs locally with
// TensorFlow.js), then gets cleaned up for a 24-key keyboard. Title, artist and
// cover come from the file's tags; if the file has no cover or lyrics, the
// iTunes Search API (artwork) and LRCLIB (time-synced lyrics) are asked.
// Nothing is downloaded except that metadata.
import { parseSongFile, normalise, decodeText } from './songloader.js'
import { assignFingering } from './fingering.js'
import { arrange, cleanCoverNotes, DIFFICULTIES } from './arranger.js'
import { MAX_NOTES, MIN_DUR, MAX_SECONDS as MAX_NOTE_SECONDS } from './editor-model.js'
import { lyricFields, sanitizeLyrics } from './lyrics-model.js'
import { inflateRaw, InflateError } from './inflate.js'

const MODEL_URL = 'models/basic-pitch/model.json'
const MODEL_RATE = 22050

let transcriber = null      // lazily imported: the bundle is 2 MB
async function loadTranscriber() {
  if (!transcriber) {
    const mod = await import('./vendor/transcribe.js')
    // loaded before any tensor scope opens, so the weights are never freed by one
    const model = await mod.tf.loadGraphModel(MODEL_URL)
    transcriber = { mod, model }
  }
  return transcriber
}

// ---------- audio → notes ----------

// Mono, 22.05 kHz: what the model was trained on.
async function toModelRate(audioBuffer) {
  const length = Math.ceil(audioBuffer.duration * MODEL_RATE)
  const off = new OfflineAudioContext(1, length, MODEL_RATE)
  const src = off.createBufferSource()
  src.buffer = audioBuffer
  src.connect(off.destination)
  src.start()
  const rendered = await off.startRendering()
  return rendered.getChannelData(0)
}

// Raw model output is dense: harmonics, re-onsets of held notes and very short
// blips. Keep notes a player can actually see and play.
export function cleanNotes(raw, { minDur = 0.1, minAmp = 0.35 } = {}) {
  const notes = raw
    .filter((n) => n.durationSeconds >= minDur && n.amplitude >= minAmp)
    .map((n) => ({ pitch: n.pitchMidi, start: n.startTimeSeconds, dur: n.durationSeconds, vel: Math.round(40 + n.amplitude * 87) }))
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch)
  // Only a same-pitch note that starts *inside* the previous one is a duplicate.
  // One that starts right as it ends is a real repeated note (C C G G…), so it stays.
  const lastByPitch = new Map()
  const out = []
  for (const n of notes) {
    const prev = lastByPitch.get(n.pitch)
    if (prev && n.start < prev.start + prev.dur - 0.02) { prev.dur = Math.max(prev.dur, n.start + n.dur - prev.start); continue }
    out.push(n)
    lastByPitch.set(n.pitch, n)
  }
  return out
}

// Melody + bass: the top note of each onset cluster in the right hand, and the
// lowest note (at most every quarter second) in the left. Much easier to follow
// than every voice of a full recording.
export function simplifyNotes(notes, split = 55) {
  const groups = []
  for (const n of notes) {
    const g = groups[groups.length - 1]
    if (g && n.start - g.start < 0.06) g.notes.push(n)
    else groups.push({ start: n.start, notes: [n] })
  }
  const out = []
  let lastBass = -Infinity
  for (const g of groups) {
    const top = g.notes.reduce((a, b) => (b.pitch > a.pitch ? b : a))
    if (top.pitch >= split) out.push({ ...top, hand: 'right' })
    const low = g.notes.reduce((a, b) => (b.pitch < a.pitch ? b : a))
    if (low.pitch < split && g.start - lastBass >= 0.25) { out.push({ ...low, hand: 'left' }); lastBass = g.start }
  }
  return out
}

// Beats per minute from the onsets: autocorrelate an onset train (10 ms bins)
// over 60–180 bpm and fold the result into 70–160.
export function estimateTempo(notes) {
  if (notes.length < 8) return 120
  const bin = 0.01
  const end = Math.min(notes[notes.length - 1].start, 120)
  const train = new Float32Array(Math.ceil(end / bin) + 1)
  for (const n of notes) if (n.start <= end) train[Math.round(n.start / bin)] += 1
  let best = 0, bestLag = 50
  for (let lag = Math.round(60 / 180 / bin); lag <= Math.round(60 / 60 / bin); lag++) {
    let s = 0
    for (let i = 0; i + lag < train.length; i++) s += train[i] * (train[i + lag] + 0.5 * (train[i + lag - 1] || 0) + 0.5 * (train[i + lag + 1] || 0))
    if (s > best) { best = s; bestLag = lag }
  }
  let bpm = 60 / (bestLag * bin)
  while (bpm < 70) bpm *= 2
  while (bpm > 160) bpm /= 2
  return Math.round(bpm)
}

const FRAMES_PER_SEC = 22050 / 256
const CHUNK_FRAMES = Math.round(30 * FRAMES_PER_SEC)
const nextTick = () => new Promise((r) => setTimeout(r, 0))

// The model's note picking gets much slower the longer its input (it rescans the
// whole song for every extra note), so run it on 30 s chunks, letting the screen
// update in between, then rejoin notes cut at a chunk boundary.
async function pickNotes(mod, frames, onsets, onProgress) {
  const events = []
  for (let start = 0; start < frames.length; start += CHUNK_FRAMES) {
    const end = Math.min(frames.length, start + CHUNK_FRAMES)
    const part = mod.outputToNotesPoly(frames.slice(start, end), onsets.slice(start, end), 0.5, 0.3, 5)
    for (const e of part) events.push({ ...e, startFrame: e.startFrame + start })
    onProgress(end / frames.length)
    await nextTick()
  }
  events.sort((a, b) => a.startFrame - b.startFrame)
  const open = new Map()
  const out = []
  for (const e of events) {
    const prev = open.get(e.pitchMidi)
    const cut = prev && Math.abs(prev.startFrame + prev.durationFrames - e.startFrame) <= 2 && e.startFrame % CHUNK_FRAMES <= 2
    if (cut) { prev.durationFrames = e.startFrame + e.durationFrames - prev.startFrame; continue }
    out.push(e)
    open.set(e.pitchMidi, e)
  }
  return out
}

export const MAX_SECONDS = 20 * 60

export async function transcribe(audioBuffer, onProgress = () => {}, signal) {
  if (audioBuffer.duration > MAX_SECONDS) throw new Error('Recordings up to 20 minutes can be added')
  const { mod, model } = await waitForImport(loadTranscriber(), signal)
  await waitForImport(mod.tf.ready(), signal)
  console.log('IMPORT transcribing on ' + mod.tf.getBackend() + ' backend')
  const samples = await waitForImport(toModelRate(audioBuffer), signal)
  const frames = [], onsets = [], contours = []
  // every tensor made while evaluating is freed afterwards (results are plain arrays)
  mod.tf.engine().startScope()
  try {
    await new mod.BasicPitch(model).evaluateModel(
      samples,
      (f, o, c) => { frames.push(...f); onsets.push(...o); contours.push(...c) },
      (p) => { signal?.throwIfAborted(); onProgress(0.85 * p) }
    )
  } finally {
    mod.tf.engine().endScope()
  }
  const events = await pickNotes(mod, frames, onsets, (p) => { signal?.throwIfAborted(); onProgress(0.85 + 0.15 * p) })
  signal?.throwIfAborted()
  const raw = mod.noteFramesToTime(mod.addPitchBendsToNoteEvents(contours, events))
  return cleanNotes(raw)
}

// ---------- tags, cover, lyrics ----------

// Cover images may come from a file's tags or the network: only these types are
// ever turned into a data URL, so no file can smuggle markup into the page.
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/
const safeImageType = (t) => (IMAGE_TYPES.test(String(t || '').toLowerCase()) ? String(t).toLowerCase() : 'image/jpeg')
export const isSafeCover = (url) => typeof url === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(url)

// Online lookups give up after a few seconds so an import never waits on a slow server.
const fetchSoon = (url) => fetch(url, { signal: AbortSignal.timeout(6000) })

const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(r.result)
  r.onerror = () => reject(r.error)
  r.readAsDataURL(blob)
})

// "Artist - Title.mp3" is the most common way songs without tags are named.
export function guessFromFilename(name) {
  const base = name.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').trim()
  const m = base.match(/^(.+?)\s+[-–]\s+(.+)$/)
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: base }
}

export async function readTags(file) {
  try {
    const { parseBlob } = await import('./vendor/metadata.js')
    const meta = await parseBlob(file, { duration: false, skipCovers: false })
    const c = meta.common || {}
    let cover = null
    const pic = (c.picture || [])[0]
    if (pic && pic.data) cover = await blobToDataUrl(new Blob([pic.data], { type: safeImageType(pic.format) }))
    let lyrics = null
    const lyr = (c.lyrics || [])[0]
    if (lyr) {
      if (lyr.syncText && lyr.syncText.length) lyrics = { synced: lyr.syncText.map((l) => ({ t: (l.timestamp || 0) / 1000, text: l.text })) }
      else if (lyr.text) lyrics = { plain: lyr.text }
    }
    // the length when the file's header states it (no scan of the whole file), so a too-long recording is refused before decoding
    const length = Number(meta.format && meta.format.duration)
    return { title: c.title || '', artist: c.artist || '', album: c.album || '', cover, lyrics, duration: Number.isFinite(length) && length > 0 ? length : null }
  } catch (e) {
    console.log('IMPORT tags unreadable: ' + e.message)
    return { title: '', artist: '', album: '', cover: null, lyrics: null, duration: null }
  }
}

export async function fetchCover(title, artist) {
  if (!title) return null
  try {
    const q = encodeURIComponent([artist, title].filter(Boolean).join(' '))
    const res = await fetchSoon(`https://itunes.apple.com/search?term=${q}&entity=song&limit=1`)
    const hit = (await res.json()).results?.[0]
    if (!hit || !hit.artworkUrl100) return null
    const img = await fetchSoon(hit.artworkUrl100.replace('100x100bb', '600x600bb'))
    return img.ok ? await blobToDataUrl(new Blob([await img.arrayBuffer()], { type: safeImageType(img.headers.get('content-type')) })) : null
  } catch (e) { console.log('IMPORT cover lookup failed: ' + e.message); return null }
}

// "[01:23.45] words" lines → [{ t: 83.45, text: 'words' }]
export function parseLrc(text) {
  const out = []
  for (const line of String(text).split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)]
    if (!stamps.length) continue
    const words = line.replace(/\[[^\]]*\]/g, '').trim()
    for (const s of stamps) out.push({ t: Number(s[1]) * 60 + Number(s[2]), text: words })
  }
  return out.sort((a, b) => a.t - b.t)
}

export async function fetchLyrics(title, artist, duration) {
  if (!title) return null
  try {
    const params = new URLSearchParams({ track_name: title })
    if (artist) params.set('artist_name', artist)
    if (duration) params.set('duration', String(Math.round(duration)))
    let hit = null
    if (artist) {
      const res = await fetchSoon('https://lrclib.net/api/get?' + params)
      hit = res.ok ? await res.json() : null
    }
    // then search: with the artist first, then by title alone (artist names like
    // "Traditional" or a typo often find nothing)
    const queries = [...new Set([[artist, title].filter(Boolean).join(' '), title])]
    for (const q of queries) {
      if (hit && (hit.syncedLyrics || hit.plainLyrics)) break
      const res = await fetchSoon('https://lrclib.net/api/search?q=' + encodeURIComponent(q))
      const list = res.ok ? await res.json() : []
      // prefer timed lyrics close to the recording's length, then any timed, then plain
      const near = (h) => !duration || !h.duration || Math.abs(h.duration - duration) < 4
      // timed lines from another version of the song would scroll out of step, so
      // without a length match only the words are kept, untimed
      const timed = list.find((h) => h.syncedLyrics && near(h))
      const any = list.find((h) => h.plainLyrics || h.syncedLyrics)
      hit = timed || (any && { plainLyrics: any.plainLyrics || any.syncedLyrics.replace(/\[[^\]]*\]/g, '').trim() }) || null
    }
    if (!hit) return null
    if (hit.syncedLyrics && (!duration || !hit.duration || Math.abs(hit.duration - duration) < 4)) return { synced: parseLrc(hit.syncedLyrics) }
    if (hit.plainLyrics || hit.syncedLyrics) return { plain: hit.plainLyrics || hit.syncedLyrics.replace(/\[[^\]]*\]/g, '').trim() }
    return null
  } catch (e) { console.log('IMPORT lyrics lookup failed: ' + e.message); return null }
}

// ---------- compressed MusicXML (.mxl) ----------

// A zip archive's entries, from its central directory: { names, read(name) -> bytes }.
// Reads 'stored' and 'deflate' entries (deflate through DecompressionStream, or inflate.js where that is missing),
// which is all that MusicXML writers use. No entry may unpack past MAX_ENTRY_BYTES
// (a score is a few MB at most): the directory's size is checked first, and the
// inflated bytes are counted as they arrive, since that size can be forged.
const MAX_ENTRY_BYTES = 50 * 1024 * 1024

// One deflated entry. DecompressionStream is used when the browser has it and knows 'deflate-raw' (older Safari may not);
// otherwise, or if the stream fails, the small inflater in inflate.js does it, with the same size cap.
async function inflateEntry(data, name) {
  const tooLarge = () => Object.assign(new Error(name + ' is too large to open'), { tooLarge: true })
  if (typeof DecompressionStream === 'function') {
    try {
      const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader()
      const chunks = []
      let total = 0
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_ENTRY_BYTES) { await reader.cancel(); throw tooLarge() }
        chunks.push(value)
      }
      const out = new Uint8Array(total)
      let off = 0
      for (const c of chunks) { out.set(c, off); off += c.byteLength }
      return out
    } catch (e) {
      if (e && e.tooLarge) throw e
      // not supported here, or the stream failed: the inflater below gives the answer
    }
  }
  try { return inflateRaw(data, { maxBytes: MAX_ENTRY_BYTES }) } catch (e) {
    if (!(e instanceof InflateError)) throw e
    throw e.tooLarge ? tooLarge() : new Error('The score inside this file is damaged and could not be unpacked')
  }
}
export function unzip(buffer) {
  const dv = new DataView(buffer)
  const size = dv.byteLength
  // the end-of-directory record sits in the last 22 bytes, before an optional comment
  let eocd = -1
  for (let i = size - 22; i >= Math.max(0, size - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('Not a zip file')
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  if (count === 0xffff || p === 0xffffffff) throw new Error('ZIP64 archives are not supported')
  const utf8 = new TextDecoder()
  const entries = new Map()
  for (let k = 0; k < count; k++) {
    if (p + 46 > size || dv.getUint32(p, true) !== 0x02014b50) throw new Error('Broken zip directory')
    const nlen = dv.getUint16(p + 28, true)
    entries.set(utf8.decode(new Uint8Array(buffer, p + 46, Math.min(nlen, size - p - 46))), {
      flags: dv.getUint16(p + 8, true), method: dv.getUint16(p + 10, true),
      csize: dv.getUint32(p + 20, true), usize: dv.getUint32(p + 24, true), local: dv.getUint32(p + 42, true)
    })
    p += 46 + nlen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true)
  }
  const read = async (name) => {
    const e = entries.get(name)
    if (!e) throw new Error('No ' + name + ' in the archive')
    if (e.flags & 1) throw new Error('Encrypted archives are not supported')
    if (e.usize > MAX_ENTRY_BYTES || (e.method === 0 && e.csize > MAX_ENTRY_BYTES)) throw new Error(name + ' is too large to open')
    if (e.local + 30 > size || dv.getUint32(e.local, true) !== 0x04034b50) throw new Error('Broken zip entry ' + name)
    // sizes come from the directory: a local header may leave them to a trailing descriptor
    const at = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true)
    if (at > size) throw new Error('Broken zip entry ' + name)
    const data = new Uint8Array(buffer, at, Math.max(0, Math.min(e.csize, size - at)))
    if (e.method === 0) return data
    if (e.method !== 8) throw new Error('Unsupported zip compression (method ' + e.method + ')')
    return inflateEntry(data, name)
  }
  return { names: [...entries.keys()], read }
}

// The score inside an .mxl: META-INF/container.xml names it (its first MusicXML
// rootfile); without one, the first .xml / .musicxml outside META-INF.
export async function readMxl(buffer) {
  const zip = unzip(buffer)
  let path = ''
  if (zip.names.includes('META-INF/container.xml')) {
    const xml = decodeText(await zip.read('META-INF/container.xml'))
    const attr = (tag, name) => {
      const m = tag.match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')'))
      return m ? (m[1] ?? m[2]).replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&') : ''
    }
    const roots = [...xml.matchAll(/<rootfile\b[^>]*>/g)].map((m) => ({ path: attr(m[0], 'full-path'), type: attr(m[0], 'media-type') }))
    const pick = roots.find((r) => r.path && (!r.type || /musicxml/i.test(r.type))) || roots[0]
    path = pick ? pick.path : ''
  }
  if (!zip.names.includes(path)) path = zip.names.find((n) => !n.startsWith('META-INF/') && /\.(xml|musicxml)$/i.test(n)) || ''
  if (!path) throw new Error('No score found in this .mxl file')
  return decodeText(await zip.read(path))
}

// ---------- whole imports ----------

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|aif|aiff|aifc|caf|flac|ogg|opus|webm)$/i
const VIDEO_EXT = /\.(mp4|m4v|mov)$/i
const SCORE_EXT = /\.(mid|midi|kar|xml|musicxml|mxl)$/i
export const isVideoFile = (f) => VIDEO_EXT.test(f.name) || /^video\/(mp4|quicktime|x-m4v)$/.test(f.type || '')
// a video is read for its sound track: decodeAudioData takes the audio of an mp4 / mov (WebKit, Chromium and Android WebView
// do when their AAC decoder is present; the importer says so in words when one cannot)
export const isAudioFile = (f) => {
  if (/\.webm$/i.test(f.name) && /^video\//.test(f.type || '')) return false
  return AUDIO_EXT.test(f.name) || /^audio\//.test(f.type || '') || isVideoFile(f)
}
export const isScoreFile = (f) => SCORE_EXT.test(f.name)
export const isLyricsFile = (f) => /\.lrc$/i.test(f.name)

export const MAX_KEPT_VIDEO = 60 * 1024 * 1024

// A file is read into memory (and an audio file decoded to raw samples, many times its size), so a very large one is refused first.
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024
export function checkImportSize(file) {
  if (file && Number.isFinite(file.size) && file.size > MAX_IMPORT_BYTES) throw new Error('This file is too large to add. The limit is 100 MB.')
}
// seconds: the length from a file's header (null when it does not say); checked before any decoding
export function checkImportDuration(seconds) {
  if (Number.isFinite(seconds) && seconds > MAX_SECONDS) throw new Error('Recordings up to 20 minutes can be added')
}

// The decoded sound of an audio file, or of a video's audio track. A failure says what to do instead of "Unable to decode".
const DECODE_TIMEOUT_MS = 60_000
let importDecode = null
export async function decodeFileAudio(ctx, file, signal, timeoutMs = DECODE_TIMEOUT_MS) {
  checkImportSize(file)
  // A cancelled import can leave a Chromium decode running. Share one slot across both import paths,
  // with a safety ceiling so a stalled Chromium decodeAudioData never wedges later imports permanently.
  while (importDecode) await waitForImport(importDecode, signal)
  signal?.throwIfAborted()
  let release
  const slot = new Promise((resolve) => { release = resolve })
  importDecode = slot
  try {
    const audio = await withDecodeTimeout(readImportAudio(ctx, file, signal), timeoutMs)
    signal?.throwIfAborted()
    return audio
  } finally {
    if (importDecode === slot) importDecode = null
    release()
  }
}

function withDecodeTimeout(work, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return work
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      console.warn?.('Keylight audio decode timed out after ' + ms + ' ms; releasing the import slot')
      reject(new Error('This audio file took too long to decode. Try another file or convert it to mp3, m4a or wav.'))
    }, ms)
    timer.unref?.()
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

async function readImportAudio(ctx, file, signal) {
  let bytes
  try { bytes = await file.arrayBuffer() } catch { throw new Error('This file could not be read') }
  signal?.throwIfAborted()
  try { return await ctx.decodeAudioData(bytes) } catch (e) {
    const video = isVideoFile(file)
    const why = e && e.message ? ' (' + e.message + ')' : ''
    throw new Error(video
      ? 'The sound of this video could not be read here, or the video has no sound' + why + '. Save just the audio (an m4a or mp3 file) and add that instead.'
      : 'This audio file could not be read' + why + '. Try an mp3, m4a or wav file.')
  }
}

// File and metadata APIs without cancellation can finish in the background, but never hold the import queue open.
async function waitForImport(work, signal) {
  if (!signal) return work
  let abort
  const stopped = new Promise((_, reject) => {
    abort = () => reject(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
  try { return await Promise.race([work, stopped]) }
  finally { signal.removeEventListener('abort', abort) }
}

export function rearrangeCover(record, difficulty, keyRange) {
  if (!record.coverRaw) return record
  const current = record.coverArrangement
  const next = cleanCoverArrangement({ difficulty, keyRange })
  if (!next || (current?.difficulty === difficulty && current.keyRange.lo === keyRange.lo && current.keyRange.hi === keyRange.hi)) return record
  // arrange emits fresh, finger-free notes. normalise assigns fingers for this layout.
  const notes = arrange(record.coverRaw, next)
  if (!notes.length) throw new Error('No notes fit this keyboard')
  const song = normalise(record.title, { notes, tempo: record.tempo, duration: record.duration })
  return { ...record, notes: song.notes, duration: song.duration, coverArrangement: next }
}

// cover: { generate({ signal, onProgress }), difficulty, keyRange() }
export async function importFile(file, opts) {
  const { signal, cover } = opts
  const stage = (label, fraction) => {
    signal?.throwIfAborted()
    opts.onStage?.(label, fraction)
  }
  signal?.throwIfAborted()
  checkImportSize(file)       // before anything reads the file
  if (isScoreFile(file)) {
    stage('Reading notes', 0.2)
    const parsed = await waitForImport(parseSongFile(file), signal)
    const song = normalise(file.name, parsed)
    // the file's own title and composer (MusicXML work / movement title and
    // creator, a MIDI file's sequence name) beat "Artist - Title" in the file name
    const guess = guessFromFilename(file.name)
    const artist = parsed.artist || guess.artist
    song.title = parsed.title || guess.title || song.title
    song.artist = artist || 'Imported'
    if (opts.lookup) {
      stage('Finding cover and lyrics', 0.7)
      ;[song.cover, song.lyrics] = await waitForImport(Promise.all([fetchCover(song.title, artist), fetchLyrics(song.title, artist, song.duration)]), signal)
    }
    song.source = 'score'
    // words written in the file (MIDI lyric events, MusicXML <lyric>) stay with the song; a lookup result does not replace them
    const written = sanitizeLyrics(parsed.lyrics)
    if (written.length) Object.assign(song, lyricFields(written))
    return song
  }
  if (!isAudioFile(file)) throw new Error('Pick a MIDI, MusicXML, audio or video file')

  stage('Reading the file', 0.02)
  const tags = await waitForImport(readTags(file), signal)
  const guess = guessFromFilename(file.name)
  const title = tags.title || guess.title
  const artist = tags.artist || guess.artist
  checkImportDuration(tags.duration)      // from the header: no decoding for a recording that is too long
  let song
  if (cover) {
    const label = 'Making a piano cover'
    stage(label, 0.05)
    const result = await cover.generate({ signal, onProgress: (p) => stage(label, 0.05 + 0.8 * p) })
    signal?.throwIfAborted()
    const input = result?.notes
    if (Array.isArray(input) && input.length > MAX_NOTES) throw new Error('This piano cover has too many notes. Try a shorter recording.')
    if (!Array.isArray(input) || !input.every((n) => validCoverNote(n, Number.MIN_VALUE))) {
      throw new Error('The piano cover contains invalid notes.')
    }
    const raw = cleanCoverNotes(input)
    if (!raw.length) throw new Error('No notes could be heard in this recording')
    checkImportDuration(result.duration)
    song = rearrangeCover({
      title, coverRaw: raw, coverModelDifficulty: cleanCoverModelDifficulty(result.modelDifficulty),
      duration: result.duration || tags.duration, tempo: estimateTempo(raw)
    }, cover.difficulty, cover.keyRange())
  } else {
    const decoded = await waitForImport(decodeFileAudio(opts.ctx, file, signal), signal)
    checkImportDuration(decoded.duration)
    stage('Listening for notes', 0.05)
    let notes = await transcribe(decoded, (p) => stage('Listening for notes', 0.05 + 0.8 * p), signal)
    if (!notes.length) throw new Error('No notes could be heard in this recording')
    if (opts.simplify) notes = simplifyNotes(notes)
    song = normalise(title, { notes, duration: decoded.duration, tempo: estimateTempo(notes) })
  }
  song.title = title
  song.artist = artist
  song.album = tags.album
  song.cover = tags.cover
  song.lyrics = tags.lyrics
  if (opts.lookup && (!song.cover || !song.lyrics)) {
    stage('Finding cover and lyrics', 0.9)
    const [artwork, lyrics] = await waitForImport(Promise.all([
      song.cover ? null : fetchCover(title, artist),
      song.lyrics ? null : fetchLyrics(title, artist, song.duration)
    ]), signal)
    song.cover = song.cover || artwork
    song.lyrics = song.lyrics || lyrics
  }
  song.audio = file           // kept so the recording plays along
  // A video is only kept as the recording when it is small: there is no encoder here to keep just its sound (decoded audio as
  // WAV would be larger still), so a big video is read for its notes and then dropped.
  if (isVideoFile(file) && file.size > MAX_KEPT_VIDEO) {
    song.audio = null
    song.importNotice = 'The notes were taken from the video, but the video itself is too large to keep (over ' + Math.round(MAX_KEPT_VIDEO / 1048576) + ' MB), so it will not play along.'
  }
  song.source = 'audio'
  stage('Done', 1)
  return song
}

// ---------- imported library (IndexedDB: survives restarts, no size cap) ----------

const DB = 'keylight'
const STORE = 'songs'
function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
const tx = async (mode, fn) => {
  const d = await db()
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode)
    let out
    t.oncomplete = () => { d.close(); resolve(out && 'result' in out ? out.result : out) }
    t.onerror = () => { d.close(); reject(t.error) }
    t.onabort = () => { d.close(); reject(t.error || new DOMException('Song transaction aborted', 'AbortError')) }
    try { out = fn(t.objectStore(STORE)) } catch (error) { t.abort(); d.close(); reject(error) }
  })
}

// grid settings of the piano-roll editor: { offset (seconds, 0..60), division (steps a beat, 1..16) } or null
export function cleanGrid(g) {
  if (!g || typeof g !== 'object') return null
  const offset = Number(g.offset), division = g.division
  if (!Number.isFinite(offset) || offset < 0 || offset > 60 || !Number.isInteger(division) || division < 1 || division > 16) return null
  return { offset: Math.round(offset * 1e4) / 1e4, division }
}
function validCoverNote(n, minDuration) {
  return n && typeof n === 'object' &&
    Number.isInteger(n.pitch) && n.pitch >= 0 && n.pitch <= 127 &&
    Number.isFinite(n.start) && n.start >= 0 && n.start <= MAX_NOTE_SECONDS &&
    Number.isFinite(n.dur) && n.dur >= minDuration && n.dur <= MAX_NOTE_SECONDS &&
    (n.vel == null || (Number.isInteger(n.vel) && n.vel >= 0 && n.vel <= 127))
}

// Canonical notes let a cover change difficulty or key range without running the model again.
export function cleanCoverRaw(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_NOTES || !raw.every((n) => validCoverNote(n, MIN_DUR))) return null
  return raw.map(({ pitch, start, dur, vel }) => vel == null ? { pitch, start, dur } : { pitch, start, dur, vel })
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch)
}

export function cleanCoverModelDifficulty(value) {
  return ['beginner', 'intermediate', 'advanced'].includes(value) ? value : null
}

export function coverScoreFile(file, arrangement) {
  if (!arrangement) return file
  const { difficulty, keyRange: { lo, hi } } = arrangement
  return `${file}.cover-v1.${difficulty}.${lo}-${hi}`
}

export function cleanCoverArrangement(arr) {
  if (!arr || typeof arr !== 'object' || Array.isArray(arr)) return null
  if (!DIFFICULTIES.includes(arr.difficulty)) return null
  const r = arr.keyRange
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null
  if (!Number.isInteger(r.lo) || !Number.isInteger(r.hi) || r.lo < 0 || r.hi > 127 || r.lo > r.hi) return null
  return { difficulty: arr.difficulty, keyRange: { lo: r.lo, hi: r.hi } }
}
export function importedRecord(song) {
  const id = song.id || ('imp-' + Date.now().toString(36))
  const coverRaw = cleanCoverRaw(song.coverRaw)
  return {
    id, file: 'imported:' + id, title: song.title, artist: song.artist || '', album: song.album || '',
    notes: song.notes, duration: song.duration, tempo: song.tempo,
    timeSignature: song.timeSignature || null, parts: song.parts || null, bars: song.bars || null, score: song.score || null, grid: cleanGrid(song.grid),
    coverRaw, coverArrangement: coverRaw ? cleanCoverArrangement(song.coverArrangement) : null,     // an arrangement means nothing without its notes
    coverModelDifficulty: coverRaw ? cleanCoverModelDifficulty(song.coverModelDifficulty) : null,
    cover: isSafeCover(song.cover) ? song.cover : null, lyrics: song.lyrics || null, lyricsFromFile: !!song.lyricsFromFile,
    lyricWords: sanitizeLyrics(song.lyricWords).length ? sanitizeLyrics(song.lyricWords) : null,   // syllable timing; songs saved earlier have none
    audio: song.audio || null,     // a File/Blob is stored as is (no copy into memory)
    importNotice: typeof song.importNotice === 'string' && song.importNotice ? song.importNotice.slice(0, 400) : null,   // the importer's note about this song (shown on its card)
    source: song.source, added: song.added || Date.now()
  }
}
export async function saveImported(song) {
  const record = importedRecord(song)
  await tx('readwrite', (store) => store.put(record))
  return record
}
export async function saveImportedBatch(songs) {
  const records = songs.map(importedRecord)
  await tx('readwrite', (store) => { for (const record of records) store.put(record); return records })
  return records
}
export const listImported = () => tx('readonly', (s) => s.getAll())
// songs saved before fingering existed get it on the way out
export async function getImported(id) {
  const rec = await tx('readonly', (s) => s.get(id))
  if (rec && Array.isArray(rec.notes) && rec.notes.some((n) => !n.finger)) assignFingering(rec.notes, { tempo: rec.tempo })
  return rec
}
export const deleteImported = (id) => tx('readwrite', (s) => s.delete(id))
