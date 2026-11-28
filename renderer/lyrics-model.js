// Lyrics as data: no DOM, no app state. Used by the parsers' song model, the "paste lyrics and tap along" editor and the
// on-screen view (lyrics-view.js).
//
// The lyrics array is [{ t, text, cont?, nl?, line? }] in seconds, sorted by t:
//   - word / syllable level (MIDI lyric events, MusicXML <lyric>): one item per syllable; cont = true means the word goes
//     on in the next item (no space between them); nl = true starts a new line.
//   - line level (hand-timed, LRC): one item per line, line = true (items with spaces and no cont/nl count as lines too).
// A song stores it as song.lyricWords. For the existing two-line display and backups it also carries the plain line form
// song.lyrics = { synced: [{ t, text }] } with lyricsFromFile = true (lyricFields() builds all three).

export const MAX_LYRIC_ITEMS = 20000
export const MAX_LYRIC_TEXT = 300
const MAX_SECONDS = 4 * 60 * 60
const GAP = 2                 // seconds between two syllable starts that ends a line
const SENTENCE_END = /[.!?;:]["')\]]*$/
const WEAK_END = /,["')\]]*$/

const round = (n) => Math.round(n * 1000) / 1000

/** Cleans stored or parsed lyrics: finite times, text trimmed, size capped, sorted. Anything unusable is dropped. */
export function sanitizeLyrics(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (out.length >= MAX_LYRIC_ITEMS) break
    if (!item || typeof item !== 'object') continue
    const t = item.t, text = typeof item.text === 'string' ? item.text.replace(/\s+/g, ' ').trim().slice(0, MAX_LYRIC_TEXT) : ''
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > MAX_SECONDS || !text) continue
    const clean = { t: round(t), text }
    if (item.cont === true) clean.cont = true
    if (item.nl === true) clean.nl = true
    if (item.line === true) clean.line = true
    out.push(clean)
  }
  return out.sort((a, b) => a.t - b.t)
}

const isLineLevel = (items) => items.some((i) => i.line === true) ||
  (items.length > 0 && !items.some((i) => i.cont || i.nl) && items.filter((i) => /\s/.test(i.text)).length * 2 >= items.length)

/**
 * Groups lyrics into lines: [{ t, end, text, timed, parts: [{ t, text, space }] }].
 * parts are the highlight units (syllables); space tells whether a space follows. timed is false for line-level lyrics
 * (parts then split the text into words without times, so nothing can be highlighted word by word).
 */
export function groupLyricLines(input) {
  const items = sanitizeLyrics(input)
  if (!items.length) return []
  const lines = []
  if (isLineLevel(items)) {
    items.forEach((item, i) => {
      const words = item.text.split(' ')
      lines.push({
        t: item.t, end: i + 1 < items.length ? items[i + 1].t : item.t + 4, text: item.text, timed: false,
        parts: words.map((text, k) => ({ t: null, text, space: k < words.length - 1 }))
      })
    })
    return lines
  }
  let current = null, words = 0, prev = null
  for (const item of items) {
    const prevEnds = prev && !prev.cont
    const breaks = !current || item.nl ||
      (prevEnds && (item.t - prev.t >= GAP || SENTENCE_END.test(prev.text) || (WEAK_END.test(prev.text) && words >= 4) || words >= 12))
    if (breaks) {
      current = { t: item.t, end: item.t, text: '', timed: true, parts: [] }
      lines.push(current)
      words = 0
    }
    if (prev && !breaks && !prev.cont) current.parts[current.parts.length - 1].space = true
    if (breaks || !prev.cont) words++     // a syllable that carries on a word is not a new word
    current.parts.push({ t: item.t, text: item.text, space: false })
    current.end = item.t
    prev = item
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    line.text = line.parts.map((p) => p.text + (p.space ? ' ' : '')).join('').trim()
    line.end = i + 1 < lines.length ? Math.min(lines[i + 1].t, line.end + 4) : line.end + 4
  }
  return lines
}

/** The fields to merge into a song for these lyrics (empty lyrics clear them). */
export function lyricFields(items) {
  const list = sanitizeLyrics(items)
  if (!list.length) return { lyricWords: null, lyrics: null, lyricsFromFile: false }
  const lines = groupLyricLines(list)
  return {
    lyricWords: list,
    lyrics: { synced: lines.map((l) => ({ t: l.t, text: l.text })) },
    lyricsFromFile: true
  }
}

/** The lyrics a song has, at the finest level it knows: lyricWords, else the synced lines, else nothing. */
export function lyricsOfSong(song) {
  if (!song) return []
  const words = sanitizeLyrics(song.lyricWords)
  if (words.length) return words
  const synced = song.lyrics && Array.isArray(song.lyrics.synced) ? song.lyrics.synced : []
  return sanitizeLyrics(synced.map((l) => ({ t: l && l.t, text: l && l.text, line: true })))
}

/** Which line is current at time t, which comes next, and which syllable of the current line has started. */
export function locateLine(lines, t) {
  let lo = 0, hi = lines.length - 1, index = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].t <= t) { index = mid; lo = mid + 1 } else hi = mid - 1
  }
  const next = index + 1 < lines.length ? index + 1 : -1
  let part = -1
  if (index >= 0 && lines[index].timed) {
    const parts = lines[index].parts
    for (let i = 0; i < parts.length && parts[i].t <= t; i++) part = i
  }
  // past the end of the last line (and any gap before the next one is long): nothing is current
  const over = index >= 0 && next < 0 && t > lines[index].end + 2
  return { index: over ? -1 : index, next: over ? -1 : next, part }
}

// ---------- paste lyrics, then tap along ----------

/**
 * Lines of pasted text, each to be timed by a tap while the song plays. tap(time) times the next untimed line;
 * retime, nudge and clear change one line without disturbing the order (a line stays between its neighbours).
 */
export class LyricsTapper {
  constructor(lines) {
    this.lines = lines.map((text) => ({ text, t: null }))
    this.cursor = 0
  }

  static fromText(text) {
    const lines = String(text == null ? '' : text).split(/\r\n|\r|\n/).map((s) => s.replace(/\s+/g, ' ').trim().slice(0, MAX_LYRIC_TEXT)).filter(Boolean)
    if (!lines.length) throw new Error('Paste some lyrics first')
    if (lines.length > 2000) throw new Error('Lyrics can have up to 2000 lines')
    return new LyricsTapper(lines)
  }

  /** Starts from lyrics a song already has (grouped into lines when they are word by word). */
  static fromLyrics(items) {
    const lines = groupLyricLines(items)
    const tapper = new LyricsTapper(lines.map((l) => l.text))
    lines.forEach((l, i) => { tapper.lines[i].t = round(l.t) })
    tapper.cursor = lines.length
    return tapper
  }

  get count() { return this.lines.length }
  get timedCount() { return this.lines.filter((l) => l.t != null).length }
  get complete() { return this.timedCount === this.lines.length }
  /** The next line waiting for a tap, or null. */
  get next() { return this.cursor < this.lines.length ? this.cursor : null }

  // a line's time must stay between the nearest timed lines before and after it
  bounds(index) {
    let lo = 0, hi = MAX_SECONDS
    for (let i = index - 1; i >= 0; i--) if (this.lines[i].t != null) { lo = this.lines[i].t; break }
    for (let i = index + 1; i < this.lines.length; i++) if (this.lines[i].t != null) { hi = this.lines[i].t; break }
    return [lo, hi]
  }
  place(index, time) {
    if (!Number.isFinite(time)) return false
    const [lo, hi] = this.bounds(index)
    this.lines[index].t = round(Math.min(hi, Math.max(lo, time)))
    return true
  }

  /** The song's current time was tapped: it starts the next untimed line. Returns that line's index, or -1 when none is left. */
  tap(time) {
    while (this.cursor < this.lines.length && this.lines[this.cursor].t != null) this.cursor++
    if (this.cursor >= this.lines.length || !this.place(this.cursor, time)) return -1
    return this.cursor++
  }
  /** Takes back the last tap. Returns the line index, or -1. */
  untap() {
    let i = Math.min(this.cursor, this.lines.length) - 1
    while (i >= 0 && this.lines[i].t == null) i--
    if (i < 0) return -1
    this.lines[i].t = null
    this.cursor = i
    return i
  }
  retime(index, time) {
    if (!this.lines[index]) return false
    return this.place(index, time)
  }
  /** Moves a timed line by delta seconds (0.1 for the nudge buttons). */
  nudge(index, delta) {
    const line = this.lines[index]
    if (!line || line.t == null || !Number.isFinite(delta)) return false
    return this.place(index, line.t + delta)
  }
  /** Removes one line's time; the next tap goes to the earliest untimed line. */
  clear(index) {
    if (!this.lines[index]) return false
    this.lines[index].t = null
    this.cursor = Math.min(this.cursor, index)
    return true
  }
  clearAll() {
    for (const line of this.lines) line.t = null
    this.cursor = 0
  }
  /** Tapping carries on from this line. */
  seek(index) { if (this.lines[index]) this.cursor = index }

  /** The timed lines as lyrics: [{ t, text, line: true }]. Untimed lines are left out (see count and timedCount). */
  toLyrics() {
    return this.lines.filter((l) => l.t != null).map((l) => ({ t: l.t, text: l.text, line: true }))
  }
}
