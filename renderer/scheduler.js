// Audio-clock scheduler for everything the app plays by itself: the song in
// Watch mode, the accompaniment (the other hand, and notes beyond the 24 keys)
// in Play/Practise, the generated band, the metronome and the count-in.
//
// Each pump queues events that fall inside the next LOOKAHEAD seconds of audio
// time, at their exact audio-clock start. Screen refresh only decides how often
// we look ahead, never when a note sounds. Any transport change (player.epoch)
// silences the queue and starts again from the new position.
import { scheduleNote, cancelScheduled, click, playBass, playHat } from './audio.js'

const LOOKAHEAD = 0.2

const AUDIO = { note: scheduleNote, cancel: cancelScheduled, click, bass: playBass, hat: playHat }

const MAX_CLICKS = 50000

/**
 * The metronome's clicks for a song: [{ t, accent }] in song seconds, sorted. With bar lines from the score (song.bars)
 * the clicks follow them: the accent on each bar's first beat (a song with a pickup or a tempo change stays on the bar),
 * a pickup bar counted back from the first full bar line without an accent, and a bar that is not a whole number of
 * beats (3/8) clicked in eighths. Without bar lines: a steady grid from 0 with the accent every barBeats (4 if unknown).
 */
export function metronomeBeats(song, barBeats = 0) {
  const beatLen = 60 / (song && song.tempo > 0 ? song.tempo : 120)
  const meter = barBeats > 0 ? barBeats : 4
  const end = Math.max(0, Number(song && song.duration) || 0)
  const out = []
  const bars = song && song.bars
  if (!Array.isArray(bars) || bars.length < 2 || !bars.every((b) => typeof b === 'number' && Number.isFinite(b) && b >= 0)) {
    for (let k = 0; k * beatLen <= end + 1e-6 && out.length < MAX_CLICKS; k++) out.push({ t: k * beatLen, accent: k % meter === 0 })
    return out
  }
  // quarter notes in a bar from the time signature (3/8 = 1.5); else measured at the song's tempo
  const ts = song.timeSignature
  const perBar = ts && ts.beats > 0 && ts.beatType > 0 ? (ts.beats * 4) / ts.beatType : 0
  // clicks in a bar: whole beats when the bar holds a whole number of them, else eighths (3/8 = 3 clicks)
  const clicksFor = (q) => Math.max(1, Math.min(16, Math.abs(q - Math.round(q)) <= 0.15 ? Math.round(q) : Math.round(2 * q)))
  const clicksIn = (len) => clicksFor(perBar || len / beatLen)
  const starts = bars.slice().sort((a, b) => a - b)
  const full = starts.length > 2 ? starts[2] - starts[1] : (perBar || meter) * beatLen
  // a pickup is short in beats (not only in seconds: a slower next bar is no reason), and shorter than a full bar
  const isPickup = (len) => len / beatLen < (perBar || full / beatLen) - 0.25 && len < full - beatLen * 0.25
  // past the last bar line: whole bars as long as the last one (a full bar when the only bar is a pickup), to the end
  let tail = starts.length > 2 || !isPickup(starts[1] - starts[0]) ? starts[starts.length - 1] - starts[starts.length - 2] : full
  if (!(tail > 1e-6)) tail = full > 1e-6 ? full : meter * beatLen
  for (let last = starts[starts.length - 1]; last + tail <= end + 1e-6 && starts.length < MAX_CLICKS; ) { last += tail; starts.push(last) }
  for (let i = 0; i < starts.length && out.length < MAX_CLICKS; i++) {
    const b0 = starts[i]
    if (b0 > end + 1e-6 && end > 0) break
    const b1 = i + 1 < starts.length ? starts[i + 1] : b0 + tail
    const len = b1 - b0
    if (!(len > 1e-6)) continue
    if (i === 0 && isPickup(len)) {
      // the first full bar's beats, counted back from its bar line, none of them a downbeat
      const step = full / clicksIn(full)
      for (let t = b1 - step; t >= b0 - 1e-6; t -= step) if (!(end > 0 && t > end + 1e-6)) out.push({ t: Math.max(b0, t), accent: false })
      continue
    }
    const n = clicksIn(len), step = len / n
    for (let j = 0; j < n; j++) {
      if (end > 0 && b0 + j * step > end + 1e-6) break
      out.push({ t: b0 + j * step, accent: j === 0 })
    }
  }
  return out.sort((a, b) => a.t - b.t)
}

export class SongScheduler {
  // `out` lets the self-test record what would be played instead of playing it.
  constructor(out = AUDIO) {
    this.out = out
    this.epoch = -1
    this.cursor = 0          // song position up to which events are queued
    this.countInBeat = 0     // next count-in beat to queue
    this.sources = null
    this.fresh = true        // the first pump since a transport change
  }

  reset() {
    this.out.cancel()
    this.epoch = -1
  }

  // opts: { ctx, accompany, watchSynth, band (array of {time, pitch, accent}) | null }
  pump(player, opts) {
    const ctx = opts.ctx
    if (!player || !player.song || !ctx) return
    if (player.epoch !== this.epoch) {
      this.out.cancel()
      this.epoch = player.epoch
      // mid-play (e.g. a recording became ready) start from what is rendering now,
      // never from a stale anchor, so nothing already heard is played again
      this.cursor = player.clockRunning ? player.renderPosition() : player.position
      this.countInBeat = 0
      this.fresh = true
      this.sources = player.mode === 'WATCH'
        ? (opts.watchSynth === false ? [] : player.song.notes)   // a recording plays the song instead
        : (opts.accompany ? player.accompanimentNotes() : [])
    }
    if (!player.clockRunning) return

    const now = ctx.currentTime
    const until = now + LOOKAHEAD

    // count-in clicks run on their own beat grid before the song clock starts: the
    // count-in's own length, which follows the speed (tempo x rate) it was started at
    if (player._countInUntil > now - LOOKAHEAD) {
      const nBeats = player._countInRunBeats || player.countIn
      const beat = (player._countInUntil - player._countInStart) / Math.max(1, nBeats)
      while (this.countInBeat < nBeats) {
        const at = player._countInStart + this.countInBeat * beat
        if (at > until) break
        if (at >= now - 0.01) this.out.click(this.countInBeat === nBeats - 1, at)
        this.countInBeat++
      }
    }

    // song positions covered by [cursor, horizon)
    let horizon = player._anchorPos + Math.max(0, until - player._anchorAt) * player.rate
    horizon = Math.min(horizon, player.nextWaitTime(), player.end + 0.001)
    if (player.loop.on && player.loop.b != null) horizon = Math.min(horizon, player.loop.b)
    if (horizon <= this.cursor) return
    // Each pump queues [from, horizon), and the next one starts where it stopped, so an
    // event right on the boundary is queued once, by the pump that reached past it (a
    // horizon a float hair past a note used to queue it twice: a chord 6 dB too loud).
    // Only a fresh start also takes what sits a hair under its position.
    const from = this.cursor
    const lo = this.fresh ? from - 1e-6 : from
    this.fresh = false

    for (const n of this.sources) {
      if (n.start < lo) continue
      if (n.start >= horizon) break
      this.out.note(n.pitch, n.vel, player.timeAt(n.start), n.dur / player.rate)
    }

    if (opts.band) {
      for (const ev of opts.band) {
        if (ev.time < lo || ev.time >= horizon) continue
        const at = player.timeAt(ev.time)
        if (ev.pitch) this.out.bass(ev.pitch, 0.3 / player.rate, at)
        this.out.hat(ev.accent, at)
      }
    }

    if (player.metronome.on) {
      const song = player.song
      const ts = song.timeSignature
      const key = song.tempo + '|' + song.duration + '|' + (ts ? ts.beats + '/' + ts.beatType : '-') + '|' + player.barBeats
      if (this.clickSong !== song || this.clickBars !== song.bars || this.clickKey !== key) {
        this.clickSong = song; this.clickBars = song.bars; this.clickKey = key
        this.clicks = metronomeBeats(song, player.barBeats)
      }
      const clicks = this.clicks
      let i = 0, hi = clicks.length
      while (i < hi) { const mid = (i + hi) >> 1; if (clicks[mid].t < lo) i = mid + 1; else hi = mid }
      for (; i < clicks.length && clicks[i].t < horizon; i++) this.out.click(clicks[i].accent, player.timeAt(clicks[i].t))
    }

    this.cursor = horizon
  }
}
