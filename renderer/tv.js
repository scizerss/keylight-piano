// TV page: draws what the phone tells it, over AirPlay to an Apple TV. The logic (messages, clock, smoother) is in
// tv-sync.js, which the Node tests run too; the falling notes and keys are views.js drawScene. Protocol and look:
// docs/TV-MODE.md. This page never creates an AudioContext and has no input: it only receives messages through
// globalThis.__keylightTVReceive.
import {
  createTVModel, applyTVMessage, frameClock, createSmoother, countInOf, waitNotesOf, activeNotes, upcomingNotes,
  flashOn, sweepPos, receiveSongPacket, tvNow, STALE_MS
} from './tv-sync.js'
import { drawScene, setKeyCount, noteName } from './views.js'

// The scene is laid out for the title-safe box (the 5% margin of tv.css .tv-safe) and clipped to it. Its top starts
// SCENE_TOP_CUT CSS px above the box: views.js draws its own 13 px waiting chip at scene y 14 to 44, which then
// falls outside the clip, and the TV's "Waiting for" chip (inside the box) is the only one shown.
const SCENE_TOP_CUT = 50
const STAGE = '#0a0b0f'

const $ = (id) => document.getElementById(id)
const root = $('tvRoot')
const canvas = $('tvCanvas')
const ctx = canvas.getContext('2d', { alpha: false })
const el = {
  title: $('tvTitle'),
  composer: $('tvComposer'),
  acc: $('tvAcc'),
  streak: $('tvStreak'),
  progress: $('tvProgressFill'),
  wait: $('tvWait'),
  waitText: $('tvWaitText'),
  waitDot: $('tvWaitDot'),
  idleCard: $('tvIdleCard'),
  idleTitle: $('tvIdleTitle'),
  idleTagline: $('tvIdleTagline'),
  idleArtist: $('tvIdleArtist'),
  resTitle: $('tvResTitle'),
  resArtist: $('tvResArtist'),
  resStars: Array.from(document.querySelectorAll('#tvStars .tv-star')),
  resAcc: $('tvResAcc'),
  resStreak: $('tvResStreak'),
  resCounts: $('tvResCounts'),
  best: $('tvBest'),
  sweepDot: $('tvSweepDot'),
  sweepMark: $('tvSweepMark')
}

// Reduced motion: the score does not bump and the end-of-song bloom is a still glow (tv.css).
const reduceMotion = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
function bump(node) {
  if (reduceMotion && reduceMotion.matches) return
  node.classList.remove('bump')
  void node.offsetWidth
  node.classList.add('bump')
}

const model = createTVModel()
const smoother = createSmoother()
let view = 'idle'          // what is on screen; 'idle' while no song has arrived
// values derived from the current state, rebuilt when the phone sends a new one
let derived = { state: null, needSet: new Set(), waitList: [] }

// ---------------------------------------------------------------- canvas

let cssW = 1, cssH = 1, dpr = 1
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  cssW = window.innerWidth || 1
  cssH = window.innerHeight || 1
  canvas.width = Math.max(1, Math.round(cssW * dpr))
  canvas.height = Math.max(1, Math.round(cssH * dpr))
}
resize()
window.addEventListener('resize', resize)

// DOM writes only when the value changes
function setText(node, text) { if (node.textContent !== text) node.textContent = text }
function setHidden(node, hidden) { if (node.hidden !== hidden) node.hidden = hidden }
function setOn(node, cls, on) { if (node.classList.contains(cls) !== on) node.classList.toggle(cls, on) }

// ---------------------------------------------------------------- messages from the phone

function receive(msg) {
  try {
    const clock = { wallMs: tvNow(), perfMs: performance.now() }
    let type
    if (msg?.t === 'songChunk' || (msg?.t === 'song' && msg.songGen != null)) {
      const previous = model.song
      const ack = receiveSongPacket(model, msg)
      if (!ack) return
      postTV(ack)
      if (model.song !== previous) type = 'song'
    } else if (msg?.t === 'screen' && msg.name === 'premium') {
      model.screen = { name: 'premium', song: null, results: null }
      type = 'screen'
    } else {
      type = applyTVMessage(model, msg, clock)
    }
    if (type === 'song' && model.song) setKeyCount(model.song.keyCount)
    if (type === 'song' || type === 'state' || type === 'score' || type === 'screen') refresh()
  } catch {
    // a bad message never breaks the page
  }
}
globalThis.__keylightTVReceive = receive

// The state object decides the derived values; a new state (or a new song) rebuilds them once.
function deriveFor(st) {
  if (derived.state !== st) {
    derived = {
      state: st,
      needSet: new Set(st ? st.needPitches : []),
      waitList: waitNotesOf(model)
    }
  }
  return derived
}

// ---------------------------------------------------------------- screens and overlay text

function refresh() {
  updateSongText()
  updateScore()
  renderScreen()
}

function renderScreen() {
  const name = model.screen.name === 'play' && !model.song ? 'idle' : model.screen.name
  if (name !== view) {
    view = name
    smoother.reset()
  }
  if (root.dataset.screen !== name) root.dataset.screen = name
  setHidden(canvas, name !== 'play')
  updateResults()
  const stale = view === 'play' && model.state ? frameClock(model.state, tvNow()).stale : false
  el.wait.dataset.stale = String(stale)
  updateWait(stale)
}

function updateSongText() {
  const s = model.song
  setText(el.title, s ? s.title : '')
  setText(el.composer, s ? s.artist : '')
  setHidden(el.composer, !(s && s.artist))
  setText(el.idleTitle, s ? s.title : '')
  setText(el.idleArtist, s ? s.artist : '')
  setHidden(el.idleCard, !s)
  if (root.dataset.song !== (s ? '1' : '0')) root.dataset.song = s ? '1' : '0'
  setText(el.idleTagline, s ? 'Press play on your iPhone or iPad' : 'Pick a song on your iPhone or iPad')
}

function updateScore() {
  const s = model.score
  const pct = Math.round((s ? s.accuracy : 0) * 100) + '%'
  if (el.acc.textContent !== pct) {
    const had = el.acc.dataset.seen === '1'
    setText(el.acc, pct)
    el.acc.dataset.seen = '1'
    if (had && view === 'play') bump(el.acc)
  }
  setText(el.streak, 'Streak ' + (s ? s.streak : 0))
}

function joinNames(names) {
  if (names.length <= 3) {
    return names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0]
  }
  return names.slice(0, 3).join(', ') + ' and ' + (names.length - 3) + ' more'
}

function updateWait(stale = false) {
  const st = model.state
  const d = deriveFor(st)
  const on = view === 'play' && !!st && st.waiting && d.needSet.size > 0
  const names = on ? Array.from(d.needSet).sort((a, b) => a - b).map((p) => noteName(p)) : []
  setHidden(el.wait, !on && !stale)
  setText(el.waitText, stale ? 'Waiting for the phone' : names.length ? 'Waiting for ' + joinNames(names) : '')
  const hand = !stale && on && d.waitList.length ? d.waitList[0].hand : ''
  if (el.waitDot.dataset.hand !== hand) el.waitDot.dataset.hand = hand
}

function updateResults() {
  const r = model.screen.results || { stars: 0, accuracy: 0, longestStreak: 0, hits: 0, misses: 0, best: false }
  const s = model.screen.song
  const title = (s && s.title) || (model.song ? model.song.title : '')
  const artist = (s && s.artist) || (model.song ? model.song.artist : '')
  setText(el.resTitle, title)
  setText(el.resArtist, artist)
  setHidden(el.resArtist, !artist)
  el.resStars.forEach((node, i) => setOn(node, 'on', i < Math.ceil(r.stars * 3 / 5)))   // the phone sends 0 to 5; the app shows 3 stars
  setText(el.resAcc, Math.round(r.accuracy * 100) + '%')
  setText(el.resStreak, 'Longest streak ' + r.longestStreak)
  setText(el.resCounts, r.hits + ' hit, ' + r.misses + ' missed')
  setHidden(el.best, !r.best)
}

function updateProgress(pos) {
  const dur = model.song ? model.song.duration : 0
  const f = dur > 0 ? Math.min(1, Math.max(0, pos / dur)) : 0
  el.progress.style.transform = 'scaleX(' + f.toFixed(5) + ')'
}

// ---------------------------------------------------------------- drawing

// The scene for this frame at wall time nowMs, with the song at position pos. The scene's clock is the wall clock
// shifted by the picture delay, in seconds; the count-in times are on that same clock; feedback is in performance.now().
function paint(nowMs, pos) {
  const st = model.state
  const song = model.song
  const d = deriveFor(st)
  const pictureMs = nowMs + st.delayMs
  const labels = st.noteLabels === 'names' && !model.prefs.showNames ? 'off' : st.noteLabels
  const cin = countInOf(st, pictureMs)
  const scene = {
    position: pos,
    notes: song.notes,
    activeNotes: activeNotes(song.notes, pos),
    upcomingNotes: upcomingNotes(song.notes, pos),
    view: st.view,
    noteLabels: labels,
    windowStart: st.windowStart,
    waiting: st.waiting,
    needPitches: d.needSet,
    waitNotes: d.waitList,
    playing: st.playing,
    countInStart: cin?.startS ?? 0,
    countInUntil: cin?.untilS ?? 0,
    countInSeconds: cin?.seconds ?? 0,
    countIn: cin?.beats ?? 0,
    tempo: song.tempo,
    now: pictureMs / 1000,
    handFilter: st.handFilter,
    loop: st.loop ? { a: st.loop.a, b: st.loop.b, on: true } : null,
    held: model.held,
    feedback: model.feedback,
    backdrop: null,
    glow: 1.7                  // lit keys throw more light up the lane than on the phone: this is watched from a sofa
  }
  // the title-safe box, in CSS px: 96 x 54 at 1920 x 1080, the same inset as tv.css
  const px = Math.min(cssW / 1920, cssH / 1080)
  const bx = 96 * px, by = 54 * px
  const bw = cssW - 2 * bx, bh = cssH - 2 * by
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = STAGE
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  if (!(bw > 0 && bh > 0)) return
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.beginPath()
  ctx.rect(bx, by, bw, bh)
  ctx.clip()
  // scene x = 0 at the box's left edge; scene y = 0 sits SCENE_TOP_CUT above the box's top edge, so the scene's
  // bottom edge lands on the box's bottom edge
  ctx.setTransform(dpr, 0, 0, dpr, bx * dpr, (by - SCENE_TOP_CUT) * dpr)
  drawScene(ctx, bw, bh + SCENE_TOP_CUT, scene)
  ctx.restore()
}

function frame() {
  requestAnimationFrame(frame)
  const nowMs = tvNow()
  const st = model.state
  if (view === 'play' && st && model.song) {
    // The smoother advances on the picture clock and snaps on a seek, new song or loop iteration.
    const clock = frameClock(st, nowMs)
    const shown = smoother.update(clock, model.key)
    if (el.wait.dataset.stale !== String(clock.stale)) {
      el.wait.dataset.stale = String(clock.stale)
      updateWait(clock.stale)
    }
    updateProgress(shown)
    try {
      paint(clock.stale ? st.receivedAt + STALE_MS : nowMs, shown)
    } catch {
      // a drawing error skips this frame only
    }
  } else {
    smoother.reset()
  }
  if (view === 'calibrate') drawSweep(nowMs)
}

// The calibrate screen: a dot glides across a line and crosses the centre mark on each beat. No full-screen flash.
// Reduced motion: no gliding; the dot appears on the mark for the beat only, and the mark brightens.
function drawSweep(nowMs) {
  const beat = flashOn(model.calib, nowMs)
  const still = !!(reduceMotion && reduceMotion.matches)
  const pos = still ? (beat ? { x: 0.5, fade: 1 } : null) : sweepPos(model.calib, nowMs)
  el.sweepDot.style.opacity = pos ? pos.fade.toFixed(3) : '0'
  if (pos) el.sweepDot.style.transform = 'translate3d(' + (pos.x * sweepWidth()).toFixed(1) + 'px, 0, 0)'
  setOn(el.sweepMark, 'on', beat)
}
// The track's width in CSS px, read again only after a resize (no layout read every frame).
let sweepW = 0
addEventListener('resize', () => { sweepW = 0 })
function sweepWidth() {
  if (!sweepW) sweepW = el.sweepDot.parentElement.clientWidth
  return sweepW
}

// ---------------------------------------------------------------- start

function postTV(message) {
  try {
    window.webkit?.messageHandlers?.keylightTV?.postMessage(message)
  } catch {
    // not running in the app
  }
}

requestAnimationFrame(frame)
postTV({ op: 'ready' })

// Demo (desktop browser only, design work and tests): tv.html?demo=1 feeds a built-in song, a playing state and
// a fake score. ?screen=idle|play|results|calibrate shows one screen; without it the screens cycle.
// ?keys=49 uses the wider keyboard.
const DEMO_BPM = 96
const DEMO_RIGHT = [
  [64, 1], [67, 1], [69, 1], [67, 1],
  [69, 2], [64, 1], [60, 1],
  [65, 1], [69, 1], [65, 1], [64, 1],
  [62, 2], [67, 1], [71, 1],
  [67, 1], [64, 1], [60, 2],
  [64, 1], [67, 1], [69, 2],
  [65, 1], [64, 1], [62, 1], [60, 1],
  [62, 1], [67, 1], [60, 2]
]
// two notes per bar (C3 to B3), on beats 1 and 3
const DEMO_LEFT = [[48, 55], [57, 52], [53, 48], [55, 50], [48, 55], [57, 52], [53, 48], [55, 48]]
const DEMO_TITLE = 'Study in C'
const DEMO_ARTIST = 'Keylight demo'
const DEMO_CALIB = { periodMs: 1400, count: 14, leadMs: 1500 }   // the phone's CALIB values

function demoSong(keyCount) {
  const beat = 60 / DEMO_BPM
  const ms = (s) => Math.round(s * 1000) / 1000
  const notes = []
  let beatAt = 0
  for (const [pitch, beats] of DEMO_RIGHT) {
    notes.push([pitch, ms(beatAt * beat), ms(beats * beat * 0.92), 1, 0, 90])
    beatAt += beats
  }
  DEMO_LEFT.forEach(([a, b], bar) => {
    notes.push([a, ms(bar * 4 * beat), ms(2 * beat * 0.92), 0, 0, 84])
    notes.push([b, ms((bar * 4 + 2) * beat), ms(2 * beat * 0.92), 0, 0, 84])
  })
  return {
    t: 'song', id: 'demo-study-in-c', title: DEMO_TITLE, artist: DEMO_ARTIST, duration: ms(beatAt * beat),
    tempo: DEMO_BPM, keyCount, windowStart: keyCount > 24 ? 36 : 48, bars: null, notes
  }
}

function startDemo() {
  const params = new URLSearchParams(location.search)
  const keyCount = params.get('keys') === '49' ? 49 : 24
  const fixed = params.get('screen')
  const song = demoSong(keyCount)
  receive(song)
  const demoStart = tvNow()
  let rev = 1
  const playingState = (at, position = 0) => ({
    t: 'state', at, position, rate: 1, playing: true, waiting: false, needPitches: [], rev,
    waitAt: null, end: null, countInStart: 0, countInUntil: 0, countInBeats: 0, loop: null, handFilter: 'both',
    view: 'CASCADE', noteLabels: 'off', windowStart: song.windowStart, delayMs: 0, waitMode: false
  })
  receive(playingState(demoStart))
  receive({ t: 'prefs', showNames: true, theme: 'dark' })

  const notes = model.song.notes
  let lastState = demoStart
  let start = demoStart
  let next = 0
  let hits = 0, misses = 0, streak = 0
  let heldKey = ''
  let fb = []

  const sendKeys = (now) => {
    fb = fb.filter((f) => f[2] > now)
    const pos = (now - start) / 1000
    const held = activeNotes(notes, pos).map((n) => n.pitch)
    receive({ t: 'keys', held, feedback: fb })
    heldKey = held.join(',')
  }
  const restart = () => {
    start = tvNow()
    next = 0
    hits = 0
    misses = 0
    streak = 0
    fb = []
    rev += 1
    receive(playingState(start))
    receive({ t: 'score', accuracy: 0, streak: 0, hits: 0, misses: 0 })
  }
  setInterval(() => {
    const now = tvNow()
    if ((now - start) / 1000 > song.duration + 1.5) restart()
    const pos = (now - start) / 1000
    if (now - lastState >= 1000) { receive(playingState(now, pos)); lastState = now }
    let changed = false
    while (next < notes.length && notes[next].start <= pos) {
      const n = notes[next]
      next += 1
      const miss = next % 9 === 0
      if (miss) { misses += 1; streak = 0 } else { hits += 1; streak += 1 }
      fb.push([n.pitch, miss ? 'missed' : 'perfect', now + 260])
      changed = true
    }
    if (changed) {
      receive({ t: 'score', accuracy: hits / Math.max(1, hits + misses), streak, hits, misses })
      sendKeys(now)
    } else {
      const held = activeNotes(notes, pos).map((n) => n.pitch).join(',')
      if (held !== heldKey || fb.length) sendKeys(now)
    }
  }, 40)

  const results = { stars: 4, accuracy: 0.94, longestStreak: 21, hits: 62, misses: 3, best: true }
  const show = (name) => {
    if (name === 'results') {
      receive({ t: 'screen', name, song: { title: DEMO_TITLE, artist: DEMO_ARTIST }, results })
    } else if (name === 'calibrate') {
      receive({ t: 'screen', name })
      receive({ t: 'calib', startAt: tvNow() + DEMO_CALIB.leadMs, periodMs: DEMO_CALIB.periodMs, count: DEMO_CALIB.count })
    } else {
      receive({ t: 'screen', name, song: { title: DEMO_TITLE, artist: DEMO_ARTIST } })
    }
  }
  if (fixed) {
    show(fixed)
  } else {
    const order = ['play', 'results', 'idle', 'calibrate']
    let i = 0
    show(order[0])
    setInterval(() => { i = (i + 1) % order.length; show(order[i]) }, 8000)
  }
}

if (new URLSearchParams(location.search).get('demo') === '1') setTimeout(startDemo, 300)
