// Phone side of TV mode. Encodes player state for the TV page and sends it through the native bridge.
// Only createTVLink holds state; the encoders are plain functions. Wire format and units: docs/TV-MODE.md.

import { summarize } from './scoring.js'
import { SONG_CHUNK_NOTES, WAIT_STOP_LEAD_S, tvNow } from './tv-sync.js'

export const SCORE_INTERVAL_MS = 100
export const STATE_INTERVAL_MS = 1000
export const DEFAULT_DELAY_MS = 160
// The views the TV page draws. The phone's Sheet view has no TV version, so the TV shows Cascade for it.
const TV_VIEWS = ['CASCADE', 'RAINBOW', 'COLORNOTE', 'CLASSIC']
const SONG_ACK_MS = 2000
const SONG_ATTEMPTS = 3
const NONE = {}   // "no score object sent yet": never equal to a player's score

// Round seconds to whole milliseconds.
export function r3(x) {
  return Math.round(x * 1000) / 1000
}

export function encodeSong(player, meta) {
  if (!Array.isArray(player.speedNotes)) return null
  const song = player.song || {}
  const m = meta || {}
  return {
    t: 'song',
    id: String(m.id ?? ''),
    title: String(m.title ?? song.title ?? '').slice(0, 200),
    artist: String(m.artist ?? song.artist ?? '').slice(0, 200),
    duration: r3(song.duration || 0),
    tempo: song.tempo || 120,
    keyCount: m.keyCount ?? 0,
    windowStart: player.windowStart ?? 0,
    bars: Array.isArray(song.bars) ? song.bars.slice(0, 10000).map(r3) : null,
    notes: player.speedNotes.map((n) => [
      n.pitch, r3(n.start), r3(n.dur), n.hand === 'left' ? 0 : 1,
      n.finger || 0, n.vel ?? 100
    ])
  }
}

// No song on the phone (the Playground): the TV drops the song it holds.
export function encodeSongClear() {
  return { t: 'song', id: null }
}

// snap: the player's snapshot (audio-context seconds). ctx: wallMs (tvNow() sampled with the snapshot), at (wall ms
// the position is valid from, see audibleAt), delayMs, view, noteLabels, waitMode, rev, waitAt (song seconds or null),
// end (song seconds).
export function encodeState(snap, ctx) {
  const c = ctx || {}
  // audio-context seconds -> wall-clock ms, with the wall clock sampled together with the snapshot
  const latencyMs = c.latencyMs ?? 0
  const wallOf = (t) => c.wallMs + (t - snap.now) * 1000 + latencyMs
  const beats = snap.countInBeats || c.countInRunBeats || 0
  const counting = snap.playing && !snap.waiting && beats > 0 &&
    snap.countInUntil > snap.countInStart && snap.countInUntil + latencyMs / 1000 > snap.now
  const loop = snap.loop && snap.loop.on && snap.loop.a != null && snap.loop.b != null
    ? { a: snap.loop.a, b: snap.loop.b }
    : null
  return {
    t: 'state',
    at: Number.isFinite(c.at) ? c.at : c.wallMs,
    position: snap.position ?? 0,
    rate: snap.rate ?? 1,
    playing: !!snap.playing,
    waiting: !!snap.waiting,
    needPitches: [...(snap.needPitches || [])],
    rev: c.rev ?? 0,
    waitAt: Number.isFinite(c.waitAt) ? c.waitAt : null,
    end: Number.isFinite(c.end) ? c.end : null,
    countInStart: counting ? wallOf(snap.countInStart) : 0,
    countInUntil: counting ? wallOf(snap.countInUntil) : 0,
    countInBeats: counting ? beats : 0,
    ...(Number.isInteger(snap.loopIteration) ? { loopIteration: snap.loopIteration } : {}),
    ...(c.loopWaitAt != null ? { loopWaitAt: c.loopWaitAt } : {}),
    ...(c.songGen != null ? { songGen: c.songGen } : {}),
    loop,
    handFilter: snap.handFilter ?? null,
    view: TV_VIEWS.includes(c.view) ? c.view : 'CASCADE',
    noteLabels: c.noteLabels ?? null,
    windowStart: snap.windowStart ?? 0,
    waitMode: !!c.waitMode,
    delayMs: c.delayMs ?? DEFAULT_DELAY_MS
  }
}

// Wall time of the audible position, using the same latency as Player.currentPosition().
export function audibleAt(p, snap, wallMs, latencyMs) {
  if (!snap.playing || snap.waiting || !Number.isFinite(p._anchorAt)) return wallMs
  const latency = latencyMs == null ? p.outputLatency?.() : latencyMs / 1000
  const start = p._anchorAt + (Number.isFinite(latency) ? latency : 0)
  return wallMs + Math.max(0, start - snap.now) * 1000
}

// The start time of the next group the player stops for: the first group from its playhead that still has a note to
// play, which is the stop the player's own tick makes. Null unless the player is in wait mode.
export function waitAtOf(p) {
  if (!p || p.mode !== 'PRACTISE' || p.advancement === 'continuous') return null
  const groups = p._groups
  if (!Array.isArray(groups) || typeof p._isHit !== 'function' || !p.score) return null
  for (let i = Math.max(0, p._groupIndex || 0); i < groups.length; i++) {
    const g = groups[i]
    if (g && Array.isArray(g.notes) && g.notes.some((n) => !p._isHit(n))) return g.time
  }
  return null
}

// The player's effective end (a lesson section or the song's end), or null.
function endOf(p) {
  try {
    return typeof p.end === 'number' && Number.isFinite(p.end) ? p.end : null
  } catch {
    return null
  }
}

export function encodeKeys(held, feedback, perfMs, wallMs) {
  const out = []
  if (feedback && typeof feedback.forEach === 'function') {
    feedback.forEach((e, pitch) => {
      if (!e || !e.kind || !(e.until > perfMs)) return
      // the entry's expiry in performance time, as wall-clock ms
      out.push([pitch, e.kind, wallMs + (e.until - perfMs)])
    })
  }
  return { t: 'keys', held: [...(held || [])], feedback: out }
}

export function encodeScore(stats) {
  return {
    t: 'score',
    accuracy: stats.accuracy ?? 0,
    streak: stats.streak ?? 0,
    hits: stats.hits ?? 0,
    misses: stats.misses ?? 0
  }
}

export function encodeScreen(info) {
  const src = info || {}
  const msg = { t: 'screen', name: src.name ?? 'idle' }
  if (src.song) {
    msg.song = { title: src.song.title ?? '', artist: src.song.artist ?? '' }
  }
  if (src.results) {
    const r = src.results
    msg.results = {
      stars: r.stars ?? 0, accuracy: r.accuracy ?? 0,
      longestStreak: r.longestStreak ?? 0, hits: r.hits ?? 0,
      misses: r.misses ?? 0, best: !!r.best
    }
  }
  return msg
}

export function encodeCalib(s) {
  return { t: 'calib', startAt: s.startAt ?? 0, periodMs: s.periodMs ?? 0, count: s.count ?? 0 }
}

// What the TV's wait display depends on. Any change in it is sent as a state at once.
function waitSignature(p, rev, waitAt) {
  return [rev, !!p.playing, !!p.waiting, [...(p.needPitches || [])].join(','), waitAt].join('|')
}

export function createTVLink(opts) {
  const o = opts || {}
  const send = typeof o.send === 'function' ? o.send : (op) => {
    try { globalThis.KeylightNative.postMessage(JSON.stringify(op)) } catch (e) { /* no bridge */ }
  }
  const now = typeof o.now === 'function' ? o.now : tvNow
  const perfNow = typeof o.perfNow === 'function' ? o.perfNow
    : () => performance.now()
  const getPlayer = typeof o.getPlayer === 'function' ? o.getPlayer : () => null
  const getSong = typeof o.getSong === 'function' ? o.getSong : () => null
  const getScreen = typeof o.getScreen === 'function' ? o.getScreen : () => ({ name: 'idle' })
  const getSettings = typeof o.getSettings === 'function' ? o.getSettings : () => ({})
  const getKeys = typeof o.getKeys === 'function' ? o.getKeys : () => ({ held: null, feedback: null })
  const enabled = !!o.enabled
  const onEvent = typeof o.onEvent === 'function' ? o.onEvent : () => {}

  let connected = false
  let ready = false
  let allowed = o.allowed !== false
  // Avoid reusing a generation after a phone page reload. The TV treats generations as IDs.
  let songGen = Math.floor(now() * 1000)
  let lastSong        // the latest requested speedNotes array
  let pendingSong = null
  let pendingScreen = false
  let transferFailed = false
  let scoreRef = NONE        // the player's score object the TV was sent
  let lastStateAt = -Infinity
  let lastScoreAt = -Infinity
  let pendingScore = null
  let lastScoreKey = null    // the score values the TV was last sent (see scoreKey)
  let lastSig = null         // waitSignature at the last state sent
  let revPlayer = null       // rev: the player the counter follows; each Player counts from 0, so the link offsets it
  let revBase = 0
  let lastRev = 0
  let soundRoute = null
  let lastSound = null
  let latencyPlayer = null

  function live() {
    return enabled && connected && ready && allowed
  }

  function tvSend(msg) {
    send({ op: 'tvSend', msg })
  }

  // rev grows whenever the player's transport jumps (seek, loop wrap, restart, speed, hand and window changes, a new
  // song). It stays monotonic across players: a new player starts above the last rev sent.
  function revOf(p) {
    if (p !== revPlayer) {
      revPlayer = p
      revBase = lastRev + 1
    }
    lastRev = revBase + (Number.isInteger(p.rev) ? p.rev : 0)
    return lastRev
  }

  function sigOf(p) {
    const waitAt = waitAtOf(p)
    return waitSignature(p, revOf(p), waitAt)
  }

  function sendSongPacket(packet, next) {
    Object.assign(pendingSong, { packet, next, attempts: 1, retryAt: now() + SONG_ACK_MS })
    tvSend(packet)
  }

  // Hold state until the TV confirms the current note array. A new array supersedes any pending transfer.
  function ensureSong() {
    const p = getPlayer()
    const meta = p ? getSong() : null
    const notes = meta && Array.isArray(p.speedNotes) ? p.speedNotes : null
    if (notes === lastSong) return !!notes && !pendingSong && !transferFailed

    lastSong = notes
    const msg = { ...(notes ? encodeSong(p, meta) : encodeSongClear()), songGen: ++songGen }
    const total = msg.notes?.length ?? 0
    pendingSong = { notes: total > SONG_CHUNK_NOTES ? msg.notes : null }
    scoreRef = NONE
    pendingScore = null
    if (pendingSong.notes) sendSongPacket({ ...msg, notes: [], total }, 0)
    else sendSongPacket(msg, total)
    return false
  }

  function onSongAck(ev) {
    if (!pendingSong || ev.songGen !== songGen || ev.next !== pendingSong.next) return
    const notes = pendingSong.notes
    if (notes && ev.next < notes.length) {
      const batch = notes.slice(ev.next, ev.next + SONG_CHUNK_NOTES)
      sendSongPacket({ t: 'songChunk', songGen, offset: ev.next, notes: batch }, ev.next + batch.length)
      return
    }
    pendingSong = null
    ensureSong()
    if (pendingSong) return   // the player changed again before the ack arrived
    const recovered = transferFailed
    transferFailed = false
    sendState()
    if (pendingScreen) sendScreen()
    if (scoreRef === NONE) sendSnapshots(getPlayer())
    if (recovered) emit({ type: 'tv', event: 'songRecovered' })
  }

  // The score as the TV shows it, built from the player's score (null without one).
  function scoreMessage(p) {
    if (!p || !p.score) return null
    const sum = summarize(p.score, p.mode)
    return encodeScore({
      accuracy: sum.overallAccuracy,
      streak: p.score.streak,
      hits: sum.totalNotesHit,
      misses: sum.missed
    })
  }
  const scoreKey = (m) => [m.accuracy, m.streak, m.hits, m.misses].join('|')

  // A seek or a wrap changes the player's score in place (the same object), so the values are compared. Whatever was
  // queued is older than the player's score now, so it is dropped.
  function sendScoreIfChanged(p) {
    const msg = scoreMessage(p)
    if (!msg) return
    pendingScore = null
    const key = scoreKey(msg)
    if (key === lastScoreKey) return
    tvSend(msg)
    lastScoreKey = key
    lastScoreAt = now()
  }

  // The authoritative score and keys, sent at once (not throttled): on ready and when the player's score object is new.
  function sendSnapshots(p) {
    scoreRef = p ? p.score : null
    const msg = scoreMessage(p)
    pendingScore = null
    lastScoreKey = msg ? scoreKey(msg) : null
    if (msg) {
      tvSend(msg)
      lastScoreAt = now()
    }
    const k = getKeys() || {}
    tvSend(encodeKeys(k.held, k.feedback, perfNow(), now()))
  }

  function syncPlayerLatency(p) {
    const nativeRoute = soundRoute === 'phone' ? 'phone' : 'tv'
    const ms = lastSound?.latencyMs
    const useNative = connected && allowed && soundRoute !== 'muted' && lastSound?.route === nativeRoute &&
      Number.isFinite(ms) && ms >= 0
    const next = useNative ? p : null
    if (latencyPlayer && latencyPlayer !== next) latencyPlayer.tvOutputLatency = null
    if (next) next.tvOutputLatency = ms / 1000
    latencyPlayer = next
  }

  function sendState() {
    const p = getPlayer()
    syncPlayerLatency(p)
    if (!live() || !ensureSong()) return
    if (!p || typeof p.snapshot !== 'function') return
    if (p.score !== scoreRef) sendSnapshots(p)
    else sendScoreIfChanged(p)
    const snap = p.snapshot()
    const wallMs = now()
    const s = getSettings() || {}
    const rev = revOf(p)
    const waitAt = waitAtOf(p)
    const waitMode = p.mode === 'PRACTISE' && p.advancement !== 'continuous'
    const loop = snap.loop
    const loopWaitAt = waitMode && loop?.on && loop.a != null && loop.b != null && !snap.waiting &&
      (waitAt == null || waitAt > loop.b + WAIT_STOP_LEAD_S)
      ? p._groups?.[p._firstGroupAtOrAfter?.(loop.a)]?.time
      : null
    const latencyMs = (p.outputLatency?.() ?? 0) * 1000
    tvSend(encodeState(snap, {
      wallMs,
      at: audibleAt(p, snap, wallMs, latencyMs),
      latencyMs,
      countInRunBeats: p._countInRunBeats,
      songGen,
      delayMs: s.delayMs ?? DEFAULT_DELAY_MS,
      view: s.view ?? null,
      noteLabels: s.noteLabels ?? null,
      waitMode,
      loopWaitAt,
      rev,
      waitAt,
      end: endOf(p)
    }))
    lastStateAt = wallMs
    lastSig = waitSignature(p, rev, waitAt)
  }

  function sendKeys(held, feedback) {
    if (!live()) return
    // a key that completes a partial chord changes what the phone waits for: the TV hears it before the keys
    const p = getPlayer()
    if (p && typeof p.snapshot === 'function' && sigOf(p) !== lastSig) sendState()
    if (!pendingSong && !transferFailed) tvSend(encodeKeys(held, feedback, perfNow(), now()))
  }

  function sendScore() {
    if (!live() || pendingSong || transferFailed) return
    const p = getPlayer()
    if (!p || !p.score) return
    if (p.score !== scoreRef) { sendState(); return }
    const msg = scoreMessage(p)
    const t = now()
    if (t - lastScoreAt >= SCORE_INTERVAL_MS) {
      tvSend(msg)
      lastScoreAt = t
      lastScoreKey = scoreKey(msg)
      pendingScore = null
    } else {
      // Too soon: keep only the latest score and let tick() flush it.
      pendingScore = msg
    }
  }

  function sendScreen() {
    if (!live()) return
    const screen = getScreen()
    // Calibration uses its own clock and has no dependency on the song transfer.
    if (screen.name === 'calibrate') {
      pendingScreen = false
      tvSend(encodeScreen(screen))
      return
    }
    ensureSong()
    pendingScreen = !!pendingSong
    if (!pendingScreen) tvSend(encodeScreen(screen))
  }

  function sendCalib(schedule) {
    if (!live()) return
    tvSend(encodeCalib(schedule))
  }

  function sendSoundRoute() {
    send({ op: 'tvSound', route: allowed && soundRoute === 'phone' ? 'phone' : 'tv' })
  }

  function setSoundRoute(route) {
    if (!enabled || !['phone', 'tv', 'muted'].includes(route)) return
    soundRoute = route
    sendSoundRoute()
    resnapshot()
  }

  function resetTV() {
    lastSong = undefined
    pendingSong = null
    pendingScreen = false
    transferFailed = false
    scoreRef = NONE
    lastScoreKey = null
    pendingScore = null
    lastSig = null
    lastStateAt = -Infinity
  }

  function showCurrentAccess() {
    if (!ready) return
    if (allowed) resnapshot()
    else tvSend(encodeScreen({ name: 'premium' }))
  }

  function setAllowed(next) {
    if (!enabled || allowed === next) return
    allowed = next
    resetTV()
    syncPlayerLatency(getPlayer())
    if (soundRoute) sendSoundRoute()
    showCurrentAccess()
    emit({ type: 'tv', event: 'accessChanged' })
  }

  // Resample the audio-to-wire clock and snap the TV smoother to it after a route change or foregrounding.
  function resnapshot(retryFailed = false) {
    if (!live()) {
      syncPlayerLatency(getPlayer())
      return
    }
    if (retryFailed && transferFailed) lastSong = undefined
    revPlayer = null
    scoreRef = NONE
    sendState()
    sendScreen()
    if (!pendingSong && !transferFailed && scoreRef === NONE) sendSnapshots(getPlayer())
  }

  function tick() {
    if (!live()) return
    const t = now()
    ensureSong()
    if (pendingSong && t >= pendingSong.retryAt) {
      if (pendingSong.attempts >= SONG_ATTEMPTS) {
        pendingSong = null
        transferFailed = true
        emit({ type: 'tv', event: 'songFailed' })
      } else {
        pendingSong.attempts++
        pendingSong.retryAt = t + SONG_ACK_MS
        tvSend(pendingSong.packet)
      }
    }
    if (pendingSong || transferFailed) return
    if (pendingScore && t - lastScoreAt >= SCORE_INTERVAL_MS) {
      tvSend(pendingScore)
      lastScoreAt = t
      lastScoreKey = scoreKey(pendingScore)
      pendingScore = null
    }
    const p = getPlayer()
    if (!p || typeof p.snapshot !== 'function') return
    if (p.score !== scoreRef || sigOf(p) !== lastSig) { sendState(); return }
    if (p.playing && !p.waiting && t - lastStateAt >= STATE_INTERVAL_MS) sendState()
  }

  function emit(ev) {
    try {
      onEvent(ev)
    } catch {
      // A UI listener error must not break the link.
    }
  }

  function onNative(ev) {
    if (!enabled || !ev || ev.type !== 'tv') return
    switch (ev.event) {
      case 'connected':
        connected = true; ready = false; resetTV()
        lastSound = null
        syncPlayerLatency(getPlayer())
        if (allowed && soundRoute) sendSoundRoute()
        break
      case 'resized':
        break
      case 'ready':
        connected = true; ready = true; resetTV()
        showCurrentAccess()
        break
      case 'notReady':
        ready = false; resetTV()
        break
      case 'failed':
      case 'disconnected':
        connected = false; ready = false; resetTV()
        syncPlayerLatency(getPlayer())
        break
      case 'songAck':
        if (live()) onSongAck(ev)
        return
      case 'sound': {
        const previous = lastSound
        lastSound = { route: ev.route, outputs: ev.outputs, portTypes: ev.portTypes, latencyMs: ev.latencyMs }
        if (previous?.route !== ev.route || previous?.latencyMs !== ev.latencyMs ||
            previous?.portTypes?.join() !== ev.portTypes?.join()) resnapshot()
        break
      }
    }
    emit(ev)
  }

  return {
    enabled,
    isConnected: () => connected,
    isReady: () => live() && !transferFailed,
    setAllowed,
    resnapshot,
    sound: () => lastSound,
    onNative,
    setSoundRoute,
    sendState,
    sendKeys,
    sendScore,
    sendScreen,
    sendCalib,
    tick
  }
}
