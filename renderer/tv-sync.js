// Pure logic for the TV page (AirPlay to an Apple TV): the message checks, the song decoder, the clock that
// extrapolates the phone's song position by the TV picture delay, the smoother, and the reducer that turns phone
// messages into the page's model. tv.js draws that model; scripts/test-tv-sync.js and scripts/test-tv-contract.js
// run this same code in Node. No DOM and no imports. Protocol and units: docs/TV-MODE.md.
//
// Units: song positions and note times are seconds. Every time on the wire is wall-clock milliseconds on the
// performance.timeOrigin + performance.now() base: state.at, countInStart, countInUntil, the keys feedback expiry, calib startAt. Accuracy is a
// 0..1 fraction. A value is used exactly as it arrives; nothing here converts or guesses units.
//
// Validators: a malformed required field, or a malformed optional scalar, makes the whole message null.
// Bad entries inside a list (notes, pitches, feedback) are dropped one by one. Nothing here throws.

export const FLASH_MS = 80            // calibration flash length
export const SNAP_S = 0.25            // error (s) above which the displayed position snaps
export const SLEW = 0.15              // share of a smaller error corrected in 1/60 s
export const FEEDBACK_SAME_MS = 5     // a feedback entry the phone repeats (same kind, expiry within this) keeps its object
export const SONG_CHUNK_NOTES = 4096
export const STALE_MS = 2200
// The player can stop 5 ms before a Wait group (see Player.tick).
export const WAIT_STOP_LEAD_S = 0.005

// Both web views are on the same device. Keep wire timestamps on a common epoch without wall-clock adjustments.
export const tvNow = () => performance.timeOrigin + performance.now()
export const MAX_DELAY_MS = 600
export const MAX_BEATS = 64
const EPS = 1e-4                      // s: float slack when comparing positions (player.js uses the same)
const LEAD = 2.0                      // s: lookahead of upcomingNotes (player.js)
const VIEWS = ['CASCADE', 'RAINBOW', 'COLORNOTE', 'CLASSIC']
const HANDS = ['both', 'left', 'right']
const LABELS = ['off', 'names', 'fingers']
const SCREENS = ['idle', 'play', 'results', 'calibrate']
const KIND = /^[a-z]{1,24}$/i

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi
const clip = (s, n) => s.slice(0, n).trim()
function guard(fn) {
  try { return fn() } catch { return null }
}

// A wire time in wall-clock ms: any finite number >= 0, used as is. null for anything else.
export function msTime(v) {
  return isNum(v) && v >= 0 ? v : null
}
// A count-in time: undefined means 0 (none); otherwise a wire time.
function countTime(v) {
  return v === undefined ? 0 : msTime(v)
}
const unitFraction = (v) => (isNum(v) && v >= 0 && v <= 1 ? v : null)
const count = (v) => (isInt(v, 0, 1e9) ? v : null)

// first index whose value is >= x (sorted ascending by key)
function lowerBound(arr, x, key) {
  let lo = 0, hi = arr.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (key(arr[mid]) < x) lo = mid + 1; else hi = mid }
  return lo
}
// first index whose value is > x (sorted ascending by key)
function upperBound(arr, x, key) {
  let lo = 0, hi = arr.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (key(arr[mid]) > x) hi = mid; else lo = mid + 1 }
  return lo
}
const byStart = (n) => n.start

// ---------------------------------------------------------------- song

function decodeNote(e) {
  if (!Array.isArray(e) || e.length < 4) return null
  const [pitch, start, dur, h, finger, vel] = e
  if (!isInt(pitch, 0, 127) || !isNum(start) || start < 0 || !isNum(dur) || dur <= 0 || dur > 3600) return null
  if (h !== 0 && h !== 1) return null
  return {
    pitch, start, dur,
    hand: h === 0 ? 'left' : 'right',
    finger: isInt(finger, 0, 5) ? finger : 0,
    vel: isInt(vel, 0, 127) ? vel : 100
  }
}

// `song` message -> {id, title, artist, duration, tempo, keyCount, windowStart, bars, notes}, notes sorted by
// start (upcomingNotes relies on that order). Null for a message without id, duration or notes, and for the
// clear message (isClearSong).
export function decodeSong(msg) {
  return guard(() => {
    if (!isObj(msg) || msg.t !== 'song' || !Array.isArray(msg.notes)) return null
    const id = typeof msg.id === 'string' ? clip(msg.id, 200) : isNum(msg.id) ? String(msg.id) : ''
    if (!id) return null
    if (!isNum(msg.duration) || msg.duration <= 0 || msg.duration > 86400) return null
    const notes = []
    for (const entry of msg.notes) {
      const n = decodeNote(entry)
      if (n) notes.push(n)
    }
    notes.sort((a, b) => a.start - b.start)
    return {
      id,
      title: typeof msg.title === 'string' ? clip(msg.title, 200) : 'Untitled',
      artist: typeof msg.artist === 'string' ? clip(msg.artist, 200) : '',
      duration: msg.duration,
      tempo: isNum(msg.tempo) && msg.tempo >= 20 && msg.tempo <= 400 ? msg.tempo : 120,
      keyCount: isInt(msg.keyCount, 12, 120) ? msg.keyCount : 24,
      windowStart: isInt(msg.windowStart, 0, 127) ? msg.windowStart : 60,
      bars: Array.isArray(msg.bars) ? msg.bars.filter(isNum).slice(0, 10000) : null,
      notes
    }
  })
}

// `{t:"song", id:null}`: the phone has no song loaded (the Playground); the TV drops its song.
export function isClearSong(msg) {
  return isObj(msg) && msg.t === 'song' && msg.id === null
}

// The notes of the wait group the phone stopped at, for the keys it still needs (drawScene colours them by hand).
// `position` is the group's start time (the phone's waitAt).
export function waitGroupNotes(notes, position, needPitches) {
  if (!Array.isArray(notes) || !isNum(position)) return []
  const want = new Set(needPitches || [])
  const ms = Math.round(position * 1000)
  return notes.filter((n) => Math.round(n.start * 1000) === ms && want.has(n.pitch))
}

// ---------------------------------------------------------------- clock

// The most the picture may show this frame, in song seconds (TV-MODE.md "Stop points"): the wait point the phone
// reported (waitAt), the B of an A/B loop until the phone wraps, and the end of the song or the section (never past
// the duration). Never below the phone's own position, so a stop the phone is already at holds there.
export function stopLimit(st) {
  const pos = st.position
  let limit = Infinity
  if (isNum(st.waitAt)) limit = Math.min(limit, Math.max(pos, st.waitAt))
  if (st.loop && pos <= st.loop.b) limit = Math.min(limit, st.loop.b)
  const end = Math.min(isNum(st.end) ? st.end : Infinity, isNum(st.duration) ? st.duration : Infinity)
  if (end < Infinity) limit = Math.min(limit, Math.max(pos, end))
  return limit
}

// The clock for one frame drawn at wall time nowMs (TV-MODE.md "Clock"). The picture is drawn delayMs ahead: a frame
// drawn at nowMs shows the song at the phone's time nowMs + delayMs. The phone's position is what it hears at `at`,
// and it advances only after `anchor` (the later of `at` and the end of a count-in). Returns:
//   picture  the wall time the frame is for (nowMs + delayMs)
//   anchor   the wall time the phone's clock started from
//   moving   the phone's clock is running at this picture time
//   rate     song seconds per second
//   target   the extrapolated position, held inside [position, stopLimit]
export function frameClock(st, nowMs) {
  const pos = st.position
  const delay = isNum(st.delayMs) ? st.delayMs : 0
  const stale = !!st.playing && !st.waiting && nowMs - st.receivedAt >= STALE_MS
  const sample = stale ? st.receivedAt + STALE_MS : nowMs
  const picture = sample + delay
  const anchor = Math.max(st.at, st.countInUntilMs || 0)
  const moving = !!st.playing && !st.waiting && picture >= anchor
  const raw = moving ? pos + ((picture - anchor) / 1000) * st.rate : pos
  let limit = stopLimit(st)
  let target = Math.max(pos, Math.min(raw, limit))
  let iteration = st.loopIteration
  const loop = st.loop
  if (moving && iteration != null && loop && pos <= loop.b && limit === loop.b &&
      !(isNum(st.waitAt) && st.waitAt <= loop.b + WAIT_STOP_LEAD_S) && raw >= loop.b) {
    // Predict at most one wrap from this sample. The next authoritative iteration keeps the same smoother key.
    iteration++
    limit = stopLimit({ ...st, position: loop.a, waitAt: st.loopWaitAt })
    target = Math.min(loop.a + (raw - loop.b), limit)
  }
  return { picture, anchor, moving, rate: st.rate, target, limit, iteration, stale, sample }
}

// Target position for a frame at nowMs (the target part of frameClock).
export function targetPosition(st, nowMs) {
  return st ? frameClock(st, nowMs).target : 0
}

// The displayed position. It keeps its own clock. While the phone's clock runs, the picture advances by the real time
// since the last frame times the rate; only when the clock starts (it was not running at the last frame: a count-in
// ending, a resumed wait, a play) does the advance start at the anchor. The residual error to the target is corrected
// by an elapsed-time fraction of that error, inside that advance while playing. An error over SNAP_S snaps.
// A new resetKey or loop iteration snaps at once. The stop limit applies last.
export function createSmoother() {
  let shown = null
  let key = null
  let lastPicture = 0
  let lastSample = 0
  let iteration = null
  let wasMoving = false
  return {
    update(frame, resetKey) {
      if (!frame || !isNum(frame.target)) return shown
      if (shown === null || resetKey !== key || (!frame.stale && iteration !== frame.iteration)) {
        key = resetKey
        iteration = frame.iteration
        shown = frame.target
        lastPicture = frame.picture
        lastSample = frame.sample
        wasMoving = frame.moving
        return shown
      }
      if (frame.stale) return shown
      const elapsed = Math.max(0, frame.sample - lastSample)
      const slew = 1 - Math.pow(1 - SLEW, elapsed * 60 / 1000)
      let next
      if (frame.moving) {
        const from = wasMoving ? lastPicture : Math.max(lastPicture, frame.anchor)
        const advance = (Math.max(0, frame.picture - from) / 1000) * frame.rate
        const err = frame.target - (shown + advance)
        if (Math.abs(err) > SNAP_S) next = frame.target
        else next = shown + Math.max(0, advance + err * slew)
      } else {
        const err = frame.target - shown
        next = Math.abs(err) > SNAP_S ? frame.target : shown + err * slew
      }
      if (next > frame.limit) next = frame.limit
      shown = next
      lastPicture = frame.picture
      lastSample = frame.sample
      wasMoving = frame.moving
      return shown
    },
    value() { return shown },
    reset() { shown = null; key = null; wasMoving = false }
  }
}

// Notes sounding at `pos`, in song order (player.js activeNotes). `notes` must be sorted by start.
const durCache = new WeakMap()
function maxDurOf(notes) {
  const hit = durCache.get(notes)
  if (hit && hit.len === notes.length) return hit.maxDur
  let maxDur = 0
  for (const n of notes) if (n.dur > maxDur) maxDur = n.dur
  durCache.set(notes, { len: notes.length, maxDur })
  return maxDur
}
export function activeNotes(notes, pos) {
  if (!Array.isArray(notes) || !isNum(pos)) return []
  const maxDur = maxDurOf(notes)
  const out = []
  // a note sounds only if it started after pos - maxDur, so the scan can start there (a long note may
  // have begun well before pos)
  for (let i = lowerBound(notes, pos - maxDur - EPS, byStart); i < notes.length; i++) {
    const n = notes[i]
    if (n.start > pos + EPS) break
    if (pos >= n.start - EPS && pos < n.start + n.dur) out.push(n)
  }
  return out
}

// The next note group (at most LEAD seconds ahead) after `pos` (player.js upcomingNotes).
export function upcomingNotes(notes, pos) {
  const out = []
  if (!Array.isArray(notes) || !isNum(pos)) return out
  let i = upperBound(notes, pos + EPS, byStart)
  if (i >= notes.length) return out
  const t = notes[i].start
  for (; i < notes.length; i++) {
    const n = notes[i]
    if (n.start > t + 1e-3) break
    if (n.start - pos <= LEAD) out.push(n)
  }
  return out
}

// The count-in as drawScene reads it, on the same clock as its `now` (wall seconds). `beats` is the phone's own count.
export function countInOf(st, pictureMs) {
  if (pictureMs < st.countInStartMs || pictureMs >= st.countInUntilMs) return null
  return {
    startS: st.countInStartMs / 1000,
    untilS: st.countInUntilMs / 1000,
    seconds: (st.countInUntilMs - st.countInStartMs) / 1000,
    beats: st.countInBeats
  }
}

// ---------------------------------------------------------------- keys and feedback

// [pitch, kind, untilWallMs] list -> Map(pitch -> {kind, until, wall}). `until` is performance.now() ms: the flash keeps
// the time it has left when it arrives (untilWallMs - wallNowMs) and is not delayed further; drawScene compares it with
// performance.now(). An entry the phone repeats (same kind, wall expiry within FEEDBACK_SAME_MS) keeps its object and
// `prev` is the previous map, so drawScene does not spawn its word again.
export function feedbackUntil(list, wallNowMs, perfNowMs, prev) {
  const out = new Map()
  if (!Array.isArray(list)) return out
  for (const e of list) {
    if (!Array.isArray(e)) continue
    const [pitch, kind, wall] = e
    if (!isInt(pitch, 0, 127) || typeof kind !== 'string' || !isNum(wall)) continue
    const remaining = wall - wallNowMs
    if (!(remaining > 0)) continue
    const until = perfNowMs + remaining
    const was = prev && prev.get(pitch)
    if (was && was.kind === kind && Math.abs(was.wall - wall) <= FEEDBACK_SAME_MS) {
      was.until = until
      was.wall = wall
      out.set(pitch, was)
    } else {
      out.set(pitch, { kind, until, wall })
    }
  }
  return out
}

// Calibration: flash k is on for FLASH_MS from startAt + k * periodMs, k = 0..count-1. The flash is drawn at the
// moment it is due, with no delay compensation.
export function flashOn(calib, nowMs) {
  if (!calib || !isNum(nowMs) || !isNum(calib.startAt) || !isNum(calib.periodMs) || !(calib.periodMs > 0)) return false
  const dt = nowMs - calib.startAt
  if (dt < 0) return false
  const k = Math.floor(dt / calib.periodMs)
  if (!(k < calib.count)) return false
  return dt - k * calib.periodMs < FLASH_MS
}

// Calm calibration: a dot glides left to right once per period and crosses the centre mark exactly at
// startAt + k * periodMs (the moment the old flash started), so the phone's tap maths is unchanged. Returns null when
// nothing should show, else { x } with x in 0..1 (0.5 = on the mark) and `fade` (0..1, low near the ends so the
// wrap back to the left never pops).
export function sweepPos(calib, nowMs) {
  if (!calib || !isNum(nowMs) || !isNum(calib.startAt) || !isNum(calib.periodMs) || !(calib.periodMs > 0) || !(calib.count > 0)) return null
  const period = calib.periodMs
  const dt = nowMs - calib.startAt + period / 2
  if (dt < 0 || dt >= calib.count * period) return null
  const x = (dt % period) / period
  return { x, fade: Math.min(1, Math.min(x, 1 - x) / 0.12) }
}

// ---------------------------------------------------------------- validators

// a list of distinct integer pitches or keys; bad items dropped, at most `max` kept
function pitchList(v, max) {
  const out = []
  if (!Array.isArray(v)) return out
  for (const p of v) if (isInt(p, 0, 127) && out.length < max && !out.includes(p)) out.push(p)
  return out
}

// `state` -> normalised state. Wire times in ms: at, countInStartMs, countInUntilMs (0 = none); delayMs clamped
// 0..600; countInBeats an integer; rev an integer; waitAt and end song seconds or null.
export function validateState(msg) {
  return guard(() => {
    if (!isObj(msg) || msg.t !== 'state') return null
    const at = msTime(msg.at)
    if (at == null || !isNum(msg.position) || msg.position < 0) return null
    if (typeof msg.playing !== 'boolean' || typeof msg.waiting !== 'boolean') return null
    const rate = msg.rate === undefined ? 1 : msg.rate
    if (!isNum(rate) || rate <= 0 || rate > 4) return null
    const delayMs = msg.delayMs === undefined ? 0 : msg.delayMs
    if (!isNum(delayMs)) return null
    const countInStartMs = countTime(msg.countInStart)
    const countInUntilMs = countTime(msg.countInUntil)
    if (countInStartMs == null || countInUntilMs == null) return null
    const countInBeats = msg.countInBeats === undefined ? 0 : msg.countInBeats
    if (!isInt(countInBeats, 0, MAX_BEATS)) return null
    const rev = msg.rev === undefined ? 0 : msg.rev
    if (!isInt(rev, 0, Number.MAX_SAFE_INTEGER)) return null
    const loopIteration = msg.loopIteration ?? null
    if (loopIteration !== null && !isInt(loopIteration, 0, rev)) return null
    const loopWaitAt = msg.loopWaitAt ?? null
    if (loopWaitAt !== null && (!isNum(loopWaitAt) || loopWaitAt < 0)) return null
    const waitAt = msg.waitAt === undefined || msg.waitAt === null ? null : msg.waitAt
    if (waitAt !== null && (!isNum(waitAt) || waitAt < 0)) return null
    const end = msg.end === undefined || msg.end === null ? null : msg.end
    if (end !== null && (!isNum(end) || end < 0)) return null
    let loop = null
    if (msg.loop !== undefined && msg.loop !== null && !(isObj(msg.loop) && msg.loop.on === false)) {
      if (!isObj(msg.loop) || !isNum(msg.loop.a) || !isNum(msg.loop.b) || msg.loop.a < 0 || msg.loop.b <= msg.loop.a) return null
      loop = { a: msg.loop.a, b: msg.loop.b }
    }
    const handFilter = msg.handFilter === undefined ? 'both' : msg.handFilter
    const view = msg.view === undefined ? 'CASCADE' : msg.view
    const noteLabels = msg.noteLabels === undefined ? 'off' : msg.noteLabels
    if (!HANDS.includes(handFilter) || !VIEWS.includes(view) || !LABELS.includes(noteLabels)) return null
    const windowStart = msg.windowStart === undefined ? 60 : msg.windowStart
    if (!isInt(windowStart, 0, 127)) return null
    const waitMode = msg.waitMode === undefined ? false : msg.waitMode
    if (typeof waitMode !== 'boolean') return null
    return {
      at,
      position: msg.position,
      rate,
      playing: msg.playing,
      waiting: msg.waiting,
      needPitches: pitchList(msg.needPitches, 32),
      countInStartMs,
      countInUntilMs,
      countInBeats,
      rev,
      loopIteration,
      loopWaitAt,
      waitAt,
      end,
      loop,
      handFilter,
      view,
      noteLabels,
      windowStart,
      delayMs: Math.min(MAX_DELAY_MS, Math.max(0, delayMs)),
      waitMode
    }
  })
}

// `keys` -> {held: [pitch], feedback: [[pitch, kind, untilWallMs]]}
export function validateKeys(msg) {
  return guard(() => {
    if (!isObj(msg) || msg.t !== 'keys' || !Array.isArray(msg.held)) return null
    const feedback = []
    if (msg.feedback !== undefined) {
      if (!Array.isArray(msg.feedback)) return null
      for (const e of msg.feedback.slice(0, 64)) {
        if (!Array.isArray(e) || !isInt(e[0], 0, 127) || typeof e[1] !== 'string' || !KIND.test(e[1])) continue
        const wall = msTime(e[2])
        if (wall == null) continue
        feedback.push([e[0], e[1], wall])
      }
    }
    return { held: pitchList(msg.held, 128), feedback }
  })
}

// `score` -> {accuracy (0..1 fraction), streak, hits, misses}
export function validateScore(msg) {
  return guard(() => {
    if (!isObj(msg) || msg.t !== 'score') return null
    const accuracy = unitFraction(msg.accuracy)
    const streak = count(msg.streak), hits = count(msg.hits), misses = count(msg.misses)
    if (accuracy == null || streak == null || hits == null || misses == null) return null
    return { accuracy, streak, hits, misses }
  })
}

// `screen` -> {name, song: {title, artist} | null, results: {stars 0..5, accuracy 0..1, longestStreak, hits, misses, best} | null}
export function validateScreen(msg) {
  return guard(() => {
    if (!isObj(msg) || msg.t !== 'screen' || !SCREENS.includes(msg.name)) return null
    let song = null
    if (msg.song !== undefined && msg.song !== null) {
      if (!isObj(msg.song) || typeof msg.song.title !== 'string') return null
      song = { title: clip(msg.song.title, 200), artist: typeof msg.song.artist === 'string' ? clip(msg.song.artist, 200) : '' }
    }
    let results = null
    if (msg.results !== undefined && msg.results !== null) {
      const r = msg.results
      if (!isObj(r)) return null
      const stars = r.stars === undefined ? 0 : r.stars
      const accuracy = r.accuracy === undefined ? 0 : unitFraction(r.accuracy)
      const longestStreak = count(r.longestStreak === undefined ? 0 : r.longestStreak)
      const hits = count(r.hits === undefined ? 0 : r.hits)
      const misses = count(r.misses === undefined ? 0 : r.misses)
      const best = r.best === undefined ? false : r.best
      if (!isInt(stars, 0, 5) || accuracy == null || longestStreak == null || hits == null || misses == null || typeof best !== 'boolean') return null
      results = { stars, accuracy, longestStreak, hits, misses, best }
    }
    return { name: msg.name, song, results }
  })
}

// `calib` -> {startAt (wall ms), periodMs, count}
export function validateCalib(msg) {
  return guard(() => {
    if (!isObj(msg) || msg.t !== 'calib') return null
    const startAt = msTime(msg.startAt)
    if (startAt == null || !isNum(msg.periodMs) || msg.periodMs < 50 || msg.periodMs > 5000 || !isInt(msg.count, 1, 200)) return null
    return { startAt, periodMs: msg.periodMs, count: msg.count }
  })
}

// `prefs` -> {showNames, theme}
export function validatePrefs(msg) {
  return guard(() => {
    if (!isObj(msg) || msg.t !== 'prefs') return null
    const showNames = msg.showNames === undefined ? true : msg.showNames
    const theme = msg.theme === undefined ? 'dark' : msg.theme
    if (typeof showNames !== 'boolean' || typeof theme !== 'string' || theme.length > 32) return null
    return { showNames, theme }
  })
}

// ---------------------------------------------------------------- reducer

// What the TV page knows, updated by applyTVMessage and drawn by tv.js.
//   key: the smoother resets on song generation, non-wrap revisions and loop definition changes.
export function createTVModel() {
  return {
    song: null,
    songTransfer: null,
    state: null,
    key: '',
    held: new Set(),
    feedback: new Map(),
    score: null,
    screen: { name: 'idle', song: null, results: null },
    calib: null,
    prefs: { showNames: true, theme: 'dark' }
  }
}

function modelKey(m) {
  const st = m.state
  const loop = st && st.loop ? st.loop.a + '-' + st.loop.b : ''
  return (m.song ? m.song.songGen ?? m.song.id : '') + '|' + (st ? st.rev - (st.loopIteration ?? 0) : '') + '|' + loop
}

function clearSong(m) {
  m.song = null
  m.state = null
  m.score = null
  m.held = new Set()
  m.feedback = new Map()
  m.key = ''
}

// Receive one packet at a time. Duplicate packets can be acknowledged again without appending them twice.
export function receiveSongPacket(m, msg) {
  const { songGen } = msg
  if (!isInt(songGen, 1, Number.MAX_SAFE_INTEGER)) return null
  let transfer = m.songTransfer
  // Headers arrive in order. A reloaded phone page can start with a lower generation.
  const acceptSong = (message) => {
    const song = isClearSong(message) ? null : decodeSong(message)
    if (!song && message.id !== null) return false
    clearSong(m)
    if (song) {
      m.song = { ...song, songGen }
      m.key = modelKey(m)
    }
    return true
  }
  if (msg.t === 'song' && songGen !== transfer?.songGen) {
    if (!Array.isArray(msg.notes) && msg.id !== null) return null
    if (msg.total !== undefined) {
      if (!isInt(msg.total, SONG_CHUNK_NOTES + 1, Number.MAX_SAFE_INTEGER) || msg.notes?.length !== 0 ||
          !decodeSong(msg)) return null
      clearSong(m)
      transfer = { songGen, header: msg, notes: [], next: 0 }
    } else {
      if ((msg.notes?.length ?? 0) > SONG_CHUNK_NOTES || !acceptSong(msg)) return null
      transfer = { songGen, next: msg.notes?.length ?? 0 }
    }
    m.songTransfer = transfer
  } else if (msg.t === 'songChunk' && songGen === transfer?.songGen && transfer.header) {
    const { offset, notes } = msg
    if (!Array.isArray(notes) || !isInt(offset, 0, transfer.next) ||
        notes.length !== Math.min(SONG_CHUNK_NOTES, transfer.header.total - offset)) return null
    if (offset === transfer.next) {
      transfer.notes.push(...notes)
      transfer.next += notes.length
      if (transfer.next === transfer.header.total) {
        if (!acceptSong({ ...transfer.header, notes: transfer.notes })) return null
        delete transfer.header
        delete transfer.notes
      }
    }
  }
  if (songGen !== transfer?.songGen) return null
  return { op: 'songAck', songGen, next: transfer.next }
}

// Apply one message from the phone to the model. `clock` = { wallMs, perfMs }: tvNow() and performance.now() at
// receipt. Returns the message type it acted on, or null when it dropped the message.
export function applyTVMessage(m, msg, clock) {
  if (!isObj(msg)) return null
  switch (msg.t) {
    case 'song': {
      if (isClearSong(msg)) { clearSong(m); return 'song' }
      const song = decodeSong(msg)
      if (!song) return null
      if (!m.song || m.song.id !== song.id) {
        m.score = null
        m.held = new Set()
        m.feedback = new Map()
        m.state = null
      }
      m.song = song
      if (m.state) m.state.duration = song.duration
      m.key = modelKey(m)
      return 'song'
    }
    case 'state': {
      const st = validateState(msg)
      if (!st || (msg.songGen != null && msg.songGen !== m.song?.songGen)) return null
      st.duration = m.song ? m.song.duration : Infinity
      st.receivedAt = clock.wallMs
      m.state = st
      m.key = modelKey(m)
      return 'state'
    }
    case 'keys': {
      const k = validateKeys(msg)
      if (!k) return null
      m.held = new Set(k.held)
      m.feedback = feedbackUntil(k.feedback, clock.wallMs, clock.perfMs, m.feedback)
      return 'keys'
    }
    case 'score': {
      const s = validateScore(msg)
      if (!s) return null
      m.score = s
      return 'score'
    }
    case 'screen': {
      const s = validateScreen(msg)
      if (!s) return null
      m.screen = s
      return 'screen'
    }
    case 'calib': {
      const c = validateCalib(msg)
      if (!c) return null
      m.calib = c
      return 'calib'
    }
    case 'prefs': {
      const p = validatePrefs(msg)
      if (!p) return null
      m.prefs = p
      return 'prefs'
    }
    default:
      return null
  }
}

// The notes of the wait group the model's state stops at (empty unless the phone is waiting).
export function waitNotesOf(m) {
  const st = m.state
  if (!m.song || !st || !st.waiting) return []
  return waitGroupNotes(m.song.notes, isNum(st.waitAt) ? st.waitAt : st.position, st.needPitches)
}
