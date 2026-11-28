// Library discovery and the daily goal: pure helpers, no DOM and no storage, so the self-test can check them.

/** Daily practice goals offered in Settings, in minutes. */
export const GOAL_CHOICES = [5, 10, 15, 20, 30]
export const DEFAULT_GOAL = 10

/** A goal read from settings: one of the choices, or the default. */
export function cleanGoal(v) { return GOAL_CHOICES.includes(Number(v)) ? Number(v) : DEFAULT_GOAL }

/** Today's progress: whole minutes played, the goal, how full the ring is (0 to 1) and what is left. */
export function goalProgress(seconds, goalMin) {
  const goal = cleanGoal(goalMin)
  const secs = Math.max(0, Number(seconds) || 0)
  const mins = Math.floor(secs / 60)
  const frac = Math.min(1, secs / (goal * 60))
  return { mins, goal, frac, done: secs >= goal * 60, left: Math.max(0, goal - mins) }
}

/** True when this second of practice carried today past the goal (it was short of it a second ago). */
export function crossedGoal(secondsBefore, secondsAfter, goalMin) {
  const need = cleanGoal(goalMin) * 60
  return secondsBefore < need && secondsAfter >= need
}

// Names that are not people: they are not offered as composers
const NOT_COMPOSERS = new Set(['Exercise', 'Imported', 'Recording', ''])

/** The levels that songs actually have, easiest first (levelOrder is the app's own ordering). */
export function levelsPresent(songs, levelOrder) {
  const have = new Set(songs.map((s) => s.level).filter(Boolean))
  return levelOrder.filter((l) => have.has(l))
}

/** Composers (the song's artist) with their song counts: most songs first, then A to Z. */
export function composersOf(songs) {
  const n = new Map()
  for (const s of songs) { const a = s.artist; if (a && !NOT_COMPOSERS.has(a)) n.set(a, (n.get(a) || 0) + 1) }
  return [...n].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/** Eras and moods a song can carry (the library's own vocabulary; songs without them are still fine). */
export const ERAS = ['Traditional', 'Baroque', 'Classical', 'Romantic', 'Impressionist', 'Ragtime', 'Modern']
export const MOODS = ['Calm', 'Bright', 'Dramatic', 'Playful', 'Melancholy', 'Tender', 'Grand']
/** Length buckets by seconds: short under 2 minutes, medium 2 to 5 minutes, long over 5. */
export const LENGTHS = [
  { id: 'short', label: 'Short', hint: 'Under 2 min' },
  { id: 'medium', label: 'Medium', hint: '2 to 5 min' },
  { id: 'long', label: 'Long', hint: 'Over 5 min' }
]
export const LENGTH_IDS = LENGTHS.map((l) => l.id)
export function lengthBucket(seconds) {
  const s = Number(seconds)
  if (!(s > 0)) return ''
  return s < 120 ? 'short' : s <= 300 ? 'medium' : 'long'
}

const moodsOfSong = (s) => (Array.isArray(s && s.moods) ? s.moods.filter((m) => typeof m === 'string') : [])

/** Era values the library has, in the vocabulary's order (unknown ones last, A to Z). */
export function erasPresent(songs) {
  const have = new Set(songs.map((s) => s.era).filter((e) => typeof e === 'string' && e))
  return [...ERAS.filter((e) => have.has(e)), ...[...have].filter((e) => !ERAS.includes(e)).sort()]
}
/** Moods the library has, in the vocabulary's order. */
export function moodsPresent(songs) {
  const have = new Set(songs.flatMap(moodsOfSong))
  return [...MOODS.filter((m) => have.has(m)), ...[...have].filter((m) => !MOODS.includes(m)).sort()]
}
/** Length buckets worth offering: only when every song in `songs` has a known duration (secondsOf), else none. */
export function lengthsPresent(songs, secondsOf) {
  if (!songs.length || !songs.every((s) => secondsOf(s) > 0)) return []
  const have = new Set(songs.map((s) => lengthBucket(secondsOf(s))))
  return LENGTHS.filter((l) => have.has(l.id))
}

const str = (v) => (typeof v === 'string' ? v : '')
/**
 * A saved filter made safe: each field is a value the library has, else ''. Old saved filters had only level and
 * composer; anything unknown, missing or of the wrong type is dropped. `have` may list the values on offer
 * ({ eras, moods, lengths }); without it the built-in vocabularies decide.
 */
export function cleanFilter(f, levels, composers, have = {}) {
  const o = f && typeof f === 'object' ? f : {}
  const eras = have.eras || ERAS, moods = have.moods || MOODS, lengths = have.lengths || LENGTH_IDS
  return {
    level: levels.includes(o.level) ? o.level : '',
    composer: composers.some((c) => c.name === o.composer) ? o.composer : '',
    era: eras.includes(o.era) ? o.era : '',
    mood: moods.includes(o.mood) ? o.mood : '',
    length: lengths.includes(o.length) ? o.length : ''
  }
}

/** How many filters are on. */
export function filterCount(f) { return f ? ['level', 'composer', 'era', 'mood', 'length'].filter((k) => str(f[k])).length : 0 }

/** The filter as it is stored: level and composer always (the older shape), the newer fields only when set. */
export function storableFilter(f) {
  const o = { level: str(f && f.level), composer: str(f && f.composer) }
  for (const k of ['era', 'mood', 'length']) if (str(f && f[k])) o[k] = f[k]
  return o
}

/** Keep the songs that pass every filter ('' or missing means any). secondsOf(song) is needed only for the length filter. */
export function applyFilter(songs, f, secondsOf) {
  const g = f || {}
  return songs.filter((s) =>
    (!g.level || s.level === g.level) && (!g.composer || s.artist === g.composer) && (!g.era || s.era === g.era) &&
    (!g.mood || moodsOfSong(s).includes(g.mood)) && (!g.length || (secondsOf ? lengthBucket(secondsOf(s)) === g.length : false)))
}

/** Lower case, accents and punctuation removed: "Dvořák" and "dvorak", "Für Elise" and "fur elise" are the same. */
export function fold(text) {
  return String(text == null ? '' : text).toLowerCase()
    .replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ø/g, 'o').replace(/ł/g, 'l').replace(/đ/g, 'd').replace(/ð/g, 'd').replace(/þ/g, 'th')
    .normalize('NFD').replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}
/** The words of a typed search, folded. */
export function searchWords(query) { const q = fold(query); return q ? q.split(' ') : [] }

// Each song's folded text is built once and kept until a field that feeds it changes
const searchCache = new WeakMap()
function searchEntry(s, levelName) {
  const parts = [s.composer, s.artist, s.era, ...moodsOfSong(s), s.genre, s.level, levelName ? levelName(s.level) : '']
  const sig = [s.title, ...parts].join('\u0001')
  const hit = searchCache.get(s)
  if (hit && hit.sig === sig) return hit
  const e = { sig, title: fold(s.title), other: fold(parts.join(' ')) }
  e.all = e.title + ' ' + e.other
  searchCache.set(s, e)
  return e
}

/**
 * Rank of a song for a search: 0 no match (every word must be found), 3 the title starts with what was typed,
 * 2 every word is in the title, 1 the words are found across title, composer, era, mood, genre and level.
 */
export function searchRank(s, words, levelName) {
  if (!words.length) return 1
  const e = searchEntry(s, levelName)
  for (const w of words) if (!e.all.includes(w)) return 0
  if (e.title.startsWith(words.join(' '))) return 3
  return words.every((w) => e.title.includes(w)) ? 2 : 1
}

/** The songs matching a search, best first (ties keep their incoming order). An empty search returns the songs as they are. */
export function searchSongs(songs, query, levelName) {
  const words = searchWords(query)
  if (!words.length) return songs
  const ranked = []
  for (const s of songs) { const r = searchRank(s, words, levelName); if (r) ranked.push([r, s]) }
  return ranked.sort((a, b) => b[0] - a[0]).map((x) => x[1])
}

/** The composers to show as quick picks: the n with most pieces. */
export function topComposers(songs, n = 8) { return composersOf(songs).slice(0, n) }

/** "42 songs", "1 song", "No songs". */
export function countLabel(n) { return n === 0 ? 'No songs' : n === 1 ? '1 song' : n + ' songs' }
