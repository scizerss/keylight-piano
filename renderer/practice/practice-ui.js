// The Practice hub: a card per activity, and the metronome panel. DOM is built with createElement and
// textContent only. Everything that touches the app is injected through `deps`:
//   deps.activities            the registry list (default: ACTIVITIES)
//   deps.getStats() / deps.setStats(stats)   read and write the practice stats (lumi.practice)
//   deps.launch(activity, level)             start an activity: an exercise at a level, or a screen (level is 0)
//   deps.now()                               ms for stats timestamps (default Date.now)
//   deps.audio: { init(), now(), click(accent, when), cancelClicks() }   the audio clock and the click sound
//   deps.createClock, deps.setTimer, deps.clearTimer, deps.tapNow   (optional) for tests
// mountPractice(root, deps) -> { refresh(), stopMetronome(), metronomeRunning(), metronome(), destroy() }
import { ACTIVITIES, suggestLevel, bestAt, parseStats, recordUse, tempoFromTaps, isExercise, HARDER_AT } from './registry.js'
import { createClock } from '../jam/clock.js'
import { dot } from '../studio-copy.js'

const BAR_SIZES = [2, 3, 4, 6]
const pct = (x) => Math.round(x * 100) + '%'

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') e.className = v
    else if (k === 'text') e.textContent = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else e.setAttribute(k, v === true ? '' : v)
  }
  for (const kid of kids) if (kid) e.append(kid)
  return e
}

const SVGNS = 'http://www.w3.org/2000/svg'
// 24x24 line icons, one list of path strings each (built with createElementNS, no markup strings)
const ICONS = {
  playground: ['M4 17V8l5 3 3-6 3 6 5-3v9', 'M4 20h16'],
  jam: ['M4 12a8 8 0 0 1 14-5.3', 'M20 12a8 8 0 0 1-14 5.3', 'M18 3v4h-4', 'M6 21v-4h4'],
  ear: ['M7 9a5 5 0 0 1 10 0c0 3-3 3.5-3 6.5a2.5 2.5 0 0 1-5 0', 'M12 9a1.5 1.5 0 0 1 1.5 1.5'],
  echo: ['M4 12h3l3-6v12l-3-6', 'M14 9a4 4 0 0 1 0 6', 'M17 6.5a8 8 0 0 1 0 11'],
  rhythm: ['M8 3h8l2 18H6z', 'M12 17 16 7', 'M9.5 12h5'],
  sight: ['M3 7h18M3 11h18M3 15h18M3 19h18', 'M9 3v18'],
  toolbox: ['M3 5h18v14H3z', 'M8 5v14M13 5v14M18 5v14', 'M6 5v8M11 5v8M16 5v8'],
  games: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M12 12h.01'],
  metronome: ['M9 3h6l3 18H6z', 'M12 17 15 8', 'M10 13h4']
}
function icon(id, cls = 'pr-ic') {
  const svg = document.createElementNS(SVGNS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', cls); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false')
  for (const d of ICONS[id] || ICONS.games) { const path = document.createElementNS(SVGNS, 'path'); path.setAttribute('d', d); svg.append(path) }
  return svg
}
// Hub sections, in screen order. Cards stay in registry order in the page (the order screen readers and tests see);
// the layout places them by `order` in the grid.
const GROUPS = [
  { name: 'Create', ids: ['jam', 'playground'], note: 'Make something, no score' },
  { name: 'Ear', ids: ['ear', 'echo'], note: 'Listen, then answer or play it back' },
  { name: 'Rhythm', ids: ['rhythm'] },
  { name: 'Reading', ids: ['sight'] },
  { name: 'Technique', ids: ['toolbox'] },
  { name: 'Games', ids: ['games'] },
  { name: 'Tools', ids: ['metronome'] }
]
const FEATURED = ['jam', 'playground']

export function mountPractice(root, deps) {
  const activities = deps.activities || ACTIVITIES
  const nowMs = deps.now || (() => Date.now())
  const audio = deps.audio
  const mkClock = deps.createClock || createClock
  const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer || ((id) => clearTimeout(id))
  const tapNow = deps.tapNow || (() => performance.now())
  const stats = () => parseStats(deps.getStats())
  const picks = new Map()                  // activity id -> its level picker, the best-result line and the Start button

  /* ----- the metronome ----- */
  const metro = { bpm: 80, bpb: 4, accent: true, running: false, beat: -1, clock: null, off: null, timers: new Set(), taps: [] }
  let ui = null                            // the metronome's controls, set by buildMetronome

  function paintBeat() {
    if (!ui) return
    ui.dots.forEach((d, i) => {
      d.classList.toggle('now', metro.running && i === metro.beat)
      d.classList.toggle('first', i === 0)
    })
    ui.beatText.textContent = metro.running && metro.beat >= 0 ? `Beat ${metro.beat + 1} of ${metro.bpb}` : 'Stopped'
  }
  function paintMetro() {
    if (!ui) return
    ui.tempo.value = String(metro.bpm)
    ui.slider.value = String(metro.bpm)
    ui.slider.setAttribute('aria-valuetext', metro.bpm + ' beats per minute')
    for (const b of ui.bars) b.setAttribute('aria-pressed', String(Number(b.dataset.n) === metro.bpb))
    ui.accent.checked = metro.accent
    ui.toggle.textContent = metro.running ? 'Stop' : 'Start'
    ui.toggle.setAttribute('aria-label', metro.running ? 'Stop the metronome' : 'Start the metronome')
    ui.toggle.classList.toggle('primary', !metro.running)
    ui.toggle.classList.toggle('ghost', metro.running)
    ui.panel.classList.toggle('running', metro.running)
    paintBeat()
  }
  function buildDots() {
    ui.dotRow.replaceChildren(...Array.from({ length: metro.bpb }, () => el('span', { class: 'pr-dot' })))
    ui.dots = [...ui.dotRow.children]
  }
  function onWindow({ fromBeat, toBeat, timeOfBeat }) {
    for (let b = Math.ceil(fromBeat - 1e-9); b < toBeat - 1e-9; b++) {
      const when = timeOfBeat(b)
      const inBar = ((b % metro.bpb) + metro.bpb) % metro.bpb
      audio.click(metro.accent && inBar === 0, when)
      const id = setTimer(() => { metro.timers.delete(id); metro.beat = inBar; paintBeat() }, Math.max(0, (when - audio.now()) * 1000))
      metro.timers.add(id)
    }
  }
  function startMetro() {
    if (metro.running) return
    audio.init()
    metro.clock = mkClock({ now: () => audio.now(), bpm: metro.bpm, beatsPerBar: metro.bpb })
    metro.off = metro.clock.onWindow(onWindow)
    metro.clock.start()
    metro.running = true
    metro.beat = -1
    deps.setStats(recordUse(stats(), 'metronome', nowMs()))
    paintMetro()
  }
  function stopMetro() {
    if (!metro.running && !metro.clock) return
    if (metro.off) metro.off()
    if (metro.clock) metro.clock.stop()
    metro.off = null; metro.clock = null
    for (const id of metro.timers) clearTimer(id)
    metro.timers.clear()
    try { audio.cancelClicks() } catch { /* no audio yet */ }
    metro.running = false
    metro.beat = -1
    paintMetro()
  }
  function setTempo(v) {
    const n = Math.min(220, Math.max(40, Math.round(Number(v)) || metro.bpm))
    metro.bpm = n
    if (metro.clock) metro.clock.setBpm(n)
    paintMetro()
  }
  function setBar(n) {
    if (!BAR_SIZES.includes(n) || n === metro.bpb) return
    const was = metro.running
    stopMetro()
    metro.bpb = n
    buildDots()
    paintMetro()
    if (was) startMetro()
  }
  function tap() {
    const t = tapNow()
    metro.taps = metro.taps.filter((x) => t - x <= 2000)
    metro.taps.push(t)
    const bpm = tempoFromTaps(metro.taps)
    if (bpm) setTempo(bpm)
  }

  function buildMetronome(activity) {
    const tempo = el('input', { type: 'number', id: 'prTempo', min: 40, max: 220, step: 1, inputmode: 'numeric', class: 'pr-num' })
    const slider = el('input', { type: 'range', min: 40, max: 220, step: 1, class: 'pr-slider', 'aria-label': 'Tempo slider, 40 to 220 beats per minute' })
    const bars = BAR_SIZES.map((n) => el('button', { type: 'button', class: 'pr-seg', 'data-n': n, 'aria-pressed': 'false', 'aria-label': `${n} beats per bar`, text: String(n), onclick: () => setBar(n) }))
    const accent = el('input', { type: 'checkbox', id: 'prAccent', checked: true })
    const toggle = el('button', { type: 'button', class: 'ghost pr-start', onclick: () => (metro.running ? stopMetro() : startMetro()), text: 'Start' })
    const dotRow = el('div', { class: 'pr-dots', 'aria-hidden': 'true' })
    const beatText = el('span', { class: 'pr-beattext', text: 'Stopped' })
    const step = (d, label, glyph) => el('button', { type: 'button', class: 'pr-step', 'aria-label': label, text: glyph, onclick: () => setTempo(metro.bpm + d) })
    const panel = el('div', { class: 'pr-metro', role: 'group', 'aria-label': 'Metronome controls' },
      el('div', { class: 'pr-tempo' },
        el('label', { for: 'prTempo', class: 'pr-lab', text: 'Tempo (beats per minute)' }),
        el('div', { class: 'pr-dial' }, step(-1, 'Slower by one beat per minute', '\u2212'), tempo, step(1, 'Faster by one beat per minute', '+')),
        el('span', { class: 'pr-unit', 'aria-hidden': 'true', text: 'BPM' }),
        el('button', { type: 'button', class: 'ghost pr-tap', text: 'Tap tempo', 'aria-label': 'Tap tempo: tap along with the beat', onclick: tap })),
      slider,
      el('div', { class: 'pr-dots-wrap' }, dotRow, beatText),
      el('div', { class: 'pr-opts' },
        el('div', { class: 'pr-row' }, el('span', { class: 'pr-lab', id: 'prBarsLab', text: 'Beats per bar' }), el('div', { class: 'pr-segs', role: 'group', 'aria-labelledby': 'prBarsLab' }, ...bars)),
        el('label', { class: 'pr-check' }, accent, el('span', { text: 'Accent on beat one' }))),
      el('div', { class: 'pr-acts' }, toggle))
    tempo.addEventListener('change', () => setTempo(tempo.value))
    slider.addEventListener('input', () => setTempo(slider.value))
    accent.addEventListener('change', () => { metro.accent = accent.checked })
    ui = { panel, tempo, slider, bars, accent, toggle, dotRow, beatText, dots: [] }
    buildDots()
    paintMetro()
    return panel
  }

  /* ----- the hub ----- */
  const meters = new Map()                 // activity id -> the best-result bar
  function bestLine(a, level) {
    const best = bestAt(stats(), a.id, level)
    return best === null ? 'Not played at this level yet' : `Best at this level: ${pct(best)}`
  }
  function paintBest(a, level) {
    const p = picks.get(a.id)
    if (!p) return
    p.best.textContent = bestLine(a, level)
    const best = bestAt(stats(), a.id, level)
    const bar = meters.get(a.id)
    if (bar) { bar.firstChild.style.width = best === null ? '0%' : pct(best); bar.classList.toggle('done', best !== null && best >= HARDER_AT) }
  }
  const head = (a) => el('div', { class: 'pr-head' },
    el('span', { class: 'pr-tile', 'aria-hidden': 'true' }, icon(a.id)),
    el('div', { class: 'pr-headtext' }, el('h3', { class: 'pr-title', text: a.title }), el('p', { class: 'pr-blurb', text: a.blurb })))
  function card(a) {
    const feature = FEATURED.includes(a.id)
    const cls = `pr-card${feature ? ' pr-feature' : ''}`
    if (a.panel === 'metronome') return el('article', { class: 'pr-card pr-wide', 'data-id': a.id }, head(a), buildMetronome(a))
    if (!isExercise(a)) {
      const go = el('button', { type: 'button', class: 'ghost pr-go', 'data-act': 'start', 'aria-label': `Open ${a.title}`, text: 'Open', onclick: (e) => { e.stopPropagation(); launch(a, 0) } })
      const art = el('article', { class: cls, 'data-id': a.id, onclick: () => launch(a, 0) }, head(a), el('div', { class: 'pr-acts' }, go))
      return art
    }
    const selId = `prLevel-${a.id}`
    const select = el('select', { id: selId, class: 'pr-select', 'data-act': 'level' })
    for (let l = 1; l <= a.levels; l++) select.append(el('option', { value: String(l), text: `Level ${l}` }))
    const best = el('p', { class: 'pr-best' })
    const meter = el('div', { class: 'pr-meter', 'aria-hidden': 'true' }, el('i'))
    meters.set(a.id, meter)
    const go = el('button', { type: 'button', class: 'ghost pr-go', 'data-act': 'start', 'aria-label': `Start ${a.title}`, text: 'Start', onclick: () => launch(a, Number(select.value)) })
    select.addEventListener('change', () => { paintBest(a, Number(select.value)); paintReco() })
    picks.set(a.id, { select, best, activity: a })
    return el('article', { class: cls, 'data-id': a.id }, head(a),
      el('div', { class: 'pr-pick' }, el('label', { for: selId, class: 'pr-lab', text: 'Level' }), select, go),
      el('div', { class: 'pr-bestwrap' }, best, meter))
  }
  const launch = (a, level) => deps.launch(a, level)

  /* the recommended card: the exercise played least (registry order breaks ties), else the one not played for longest */
  function recommend() {
    const s = stats()
    const list = activities.filter(isExercise)
    if (!list.length) return null
    const plays = (a) => (s.items[a.id] ? s.items[a.id].plays : 0)
    const at = (a) => (s.items[a.id] ? s.items[a.id].lastAt : 0)
    return list.reduce((best, a) => (plays(a) < plays(best) || (plays(a) === plays(best) && plays(a) > 0 && at(a) < at(best)) ? a : best), list[0])
  }
  const reco = { box: el('section', { class: 'pr-reco', 'aria-label': 'Recommended next' }), a: null }
  function paintReco() {
    const a = recommend()
    reco.box.hidden = !a
    if (!a) return
    reco.a = a
    const level = suggestLevel(stats(), a.id)
    const played = (stats().items[a.id] || {}).plays > 0
    const go = el('button', { type: 'button', class: 'primary btn-l pr-reco-go', 'data-act': 'reco', 'aria-label': `Start ${a.title}, level ${level}`, text: 'Start', onclick: () => launch(a, suggestLevel(stats(), a.id)) })
    reco.box.replaceChildren(
      el('span', { class: 'pr-tile pr-tile-l', 'aria-hidden': 'true' }, icon(a.id)),
      el('div', { class: 'pr-reco-text' },
        el('span', { class: 'kl-caption pr-reco-cap', text: played ? 'Up next' : 'Try this first' }),
        el('h2', { class: 'pr-reco-title', text: a.title }),
        el('p', { class: 'pr-reco-sub', text: `Level ${level}${dot()}about 5 minutes` })),
      go)
  }

  /** Repaint the suggested levels and best results from the stored stats (the metronome keeps running and keeps its settings). */
  function refresh() {
    const s = stats()
    for (const [id, p] of picks) {
      const suggested = suggestLevel(s, id)
      for (const o of p.select.options) { const is = Number(o.value) === suggested; o.textContent = is ? `Level ${o.value} ★` : `Level ${o.value}`; o.setAttribute('aria-label', is ? `Level ${o.value}, suggested` : `Level ${o.value}`) }   // short enough for a phone's select
      p.select.value = String(suggested)
      paintBest(p.activity, suggested)
    }
    paintReco()
  }

  const cards = activities.map(card)
  // place sections: each card and each section heading gets a grid `order`
  const grid = el('div', { class: 'pr-grid' })
  const placed = new Set()
  GROUPS.forEach((g, gi) => {
    const mine = cards.filter((c) => g.ids.includes(c.dataset.id))
    if (!mine.length) return
    const hd = el('h2', { class: 'pr-sec', text: g.name }, g.note ? el('span', { class: 'pr-sec-note', text: g.note }) : null)
    hd.style.order = String(gi * 10)
    grid.append(hd)
    mine.forEach((c) => { c.style.order = String(gi * 10 + 1 + g.ids.indexOf(c.dataset.id)); placed.add(c) })
  })
  cards.forEach((c) => { if (!placed.has(c)) c.style.order = '900' })
  // registry order in the DOM: cards first as built, headings are separate nodes
  cards.forEach((c) => grid.append(c))
  root.replaceChildren(el('div', { class: 'pr-page' },
    el('p', { class: 'pr-lead', text: 'Practice never changes your course progress, and every minute counts toward today\u2019s goal.' }),
    reco.box, grid))
  refresh()

  return {
    refresh,
    stopMetronome: stopMetro,
    metronomeRunning: () => metro.running,
    metronome: () => ({ running: metro.running, bpm: metro.bpm, beatsPerBar: metro.bpb, accent: metro.accent, beat: metro.beat }),
    destroy() { stopMetro(); root.replaceChildren() }
  }
}
