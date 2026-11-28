// First-lesson spotlight tour: a few coach marks over the live player (not a carousel). Each stop dims the page, cuts a rounded
// hole around one control and shows a small card beside it. Skippable at any time; shown once (settings.tourDone), and replayable
// from Help. app.js supplies the few things this file must not reach for itself (settings, save, the player hold, lights).
// Styles: tour.css. The card placement is a pure function (placeCard) so scripts/test-tour.js can check it without a page.

let deps = null
let live = null   // the tour that is on screen, if any

// What the stops say. "target" is a selector, an element, or a function that returns an element or a {left, top, width, height}
// box; a stop whose target is missing or has no size is dropped. "when" can veto a stop (the lights stop needs lit keys).
const stageBox = (part) => () => {
  const el = document.getElementById('stage')
  const r = el && el.getBoundingClientRect()
  if (!r || r.width < 4 || r.height < 4) return null
  // the keyboard sits at the bottom of the stage; the lane is everything above it
  const keys = Math.max(52, Math.min(r.height * 0.26, 120))
  if (part === 'keys') return { left: r.left, top: r.bottom - keys, width: r.width, height: keys }
  return { left: r.left, top: r.top, width: r.width, height: Math.max(40, r.height - keys) }
}

export function defaultStops(d = deps) {
  return [
    { id: 'lane', target: stageBox('lane'), title: 'Notes fall toward the keys', body: 'Play each note as it reaches the keyboard. Blue is your left hand, orange is your right.' },
    { id: 'speed', target: '#speedTrack', title: 'Wait or play along', body: 'Wait pauses until you play the right key. The speeds keep time and score you.' },
    { id: 'play', target: '#btnPlay', title: 'Start and pause', body: 'In Wait mode you can also just play the first key.' },
    {
      id: 'lights',
      // the chip itself is hidden while a song plays, so the lit keyboard strip is what we point at
      target: () => { const chip = document.getElementById('kbStatus'); return boxOf(chip) ? chip : stageBox('keys')() },
      when: () => !!(d && d.hasLights && d.hasLights()),
      title: 'Your keys light up', body: 'Lit keys show what to play next. Change the light style in Settings.'
    }
  ]
}

// The box of a target (an element or a plain box), or null when it is missing or has no size.
export function boxOf(t) {
  if (!t) return null
  const r = typeof t.getBoundingClientRect === 'function' ? t.getBoundingClientRect() : t
  if (!r || !(r.width > 2) || !(r.height > 2)) return null
  if (typeof t.getBoundingClientRect === 'function') {
    const cs = getComputedStyle(t)
    if (cs.display === 'none' || cs.visibility === 'hidden') return null
  }
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

const resolveTarget = (t) => {
  try {
    const v = typeof t === 'function' ? t() : t
    return typeof v === 'string' ? document.querySelector(v) : v
  } catch { return null }
}

// The stops that can be shown right now: a stop with no target, no size or a "when" that says no is skipped.
export function visibleStops(stops) {
  const out = []
  for (const s of stops) {
    try { if (s.when && !s.when()) continue } catch { continue }
    if (boxOf(resolveTarget(s.target))) out.push(s)
  }
  return out
}

// Where the card goes: below the target, then above, then to the right, then to the left; if none fits (a big target such as the
// note lane) it sits inside the target, centred. Always kept inside the safe box. All numbers are CSS pixels.
export function placeCard(box, card, view, safe = {}, gap = 14) {
  const pad = 8
  const L = (safe.left || 0) + pad, T = (safe.top || 0) + pad
  const R = view.width - (safe.right || 0) - pad, B = view.height - (safe.bottom || 0) - pad
  const clampX = (x) => Math.max(L, Math.min(x, R - card.width))
  const clampY = (y) => Math.max(T, Math.min(y, B - card.height))
  const cx = box.left + box.width / 2, cy = box.top + box.height / 2
  const yBelow = box.top + box.height + gap, yAbove = box.top - gap - card.height
  const xRight = box.left + box.width + gap, xLeft = box.left - gap - card.width
  const fits = {
    below: yBelow >= T && yBelow + card.height <= B,
    above: yAbove >= T && yAbove + card.height <= B,
    right: xRight >= L && xRight + card.width <= R,
    left: xLeft >= L && xLeft + card.width <= R
  }
  if (fits.below) return { side: 'below', left: clampX(cx - card.width / 2), top: box.top + box.height + gap }
  if (fits.above) return { side: 'above', left: clampX(cx - card.width / 2), top: box.top - gap - card.height }
  if (fits.right) return { side: 'right', left: box.left + box.width + gap, top: clampY(cy - card.height / 2) }
  if (fits.left) return { side: 'left', left: box.left - gap - card.width, top: clampY(cy - card.height / 2) }
  return { side: 'inside', left: clampX(cx - card.width / 2), top: clampY(cy - card.height / 2) }
}

const reduced = () => document.documentElement.classList.contains('reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches

function safeInsets() {
  // --sat etc. are env() values on :root; reading them through a probe gives pixels
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;top:var(--sat,0px);right:var(--sar,0px);bottom:var(--sab,0px);left:var(--sal,0px)'
  document.body.append(probe)
  const cs = getComputedStyle(probe)
  const px = (v) => parseFloat(v) || 0
  const out = { top: px(cs.top), right: px(cs.right), bottom: px(cs.bottom), left: px(cs.left) }
  probe.remove()
  return out
}

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

// Runs one tour. opts.stops overrides the stop list (the self-test); without it the tour also ends quietly if the player closes.
async function run(opts = {}) {
  const stops = visibleStops(opts.stops || defaultStops())
  const ctl = { count: stops.length, index: 0, done: false, skip: () => end(true), close: (markDone, leftPlayer) => end(markDone, leftPlayer), next: () => step(1), root: null, stops }
  if (!stops.length) { ctl.done = true; return ctl }   // nothing to point at yet: not counted as seen
  live = ctl

  const release = deps && deps.hold ? deps.hold() : null   // pauses playback; the returned function puts it back
  const returnFocus = document.activeElement
  const root = el('div', 'tour-root')
  const hole = el('div', 'tour-hole')
  const card = el('div', 'tour-card')
  card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true')
  card.setAttribute('aria-labelledby', 'tourTitle'); card.setAttribute('aria-describedby', 'tourBody')
  const text = el('div', 'tour-text'); text.setAttribute('aria-live', 'polite'); text.setAttribute('aria-atomic', 'true')
  const title = el('h3', 'tour-title'); title.id = 'tourTitle'
  const body = el('p', 'tour-body'); body.id = 'tourBody'
  text.append(title, body)
  const foot = el('div', 'tour-foot')
  const count = el('span', 'tour-count')
  const dots = el('span', 'tour-dots'); dots.setAttribute('aria-hidden', 'true')
  for (let i = 0; i < stops.length; i++) dots.append(el('i'))
  const prog = el('div', 'tour-prog'); prog.append(dots, count)
  const skipBtn = el('button', 'tour-skip', 'Skip'); skipBtn.type = 'button'
  const nextBtn = el('button', 'tour-next'); nextBtn.type = 'button'
  const acts = el('div', 'tour-acts'); acts.append(skipBtn, nextBtn)
  foot.append(prog, acts)
  card.append(text, foot)
  root.append(hole, card)
  document.body.append(root)
  ctl.root = root
  if (reduced()) root.classList.add('still')

  let timer = 0, closed = false
  const place = () => {
    const stop = stops[ctl.index]
    const box = boxOf(resolveTarget(stop.target))
    if (!box) { if (ctl.index < stops.length - 1) step(1); else end(false); return }   // a target that vanished mid-resize is not the user finishing
    const grow = 6   // a little air around the control
    const h = { left: box.left - grow, top: box.top - grow, width: box.width + grow * 2, height: box.height + grow * 2 }
    Object.assign(hole.style, { left: h.left + 'px', top: h.top + 'px', width: h.width + 'px', height: h.height + 'px' })
    hole.style.borderRadius = Math.min(18, Math.min(h.width, h.height) / 2) + 'px'
    const view = { width: window.innerWidth, height: window.innerHeight }
    // the card is measured at its real size: the width cap comes from CSS
    const cw = Math.min(card.offsetWidth || 320, view.width), ch = card.offsetHeight || 150
    const p = placeCard(h, { width: cw, height: ch }, view, safeInsets())
    card.dataset.side = p.side
    card.style.left = Math.round(p.left) + 'px'
    card.style.top = Math.round(p.top) + 'px'
  }
  const show = () => {
    const stop = stops[ctl.index], last = ctl.index === stops.length - 1
    title.textContent = stop.title
    body.textContent = stop.body
    count.textContent = (ctl.index + 1) + ' of ' + stops.length
    ;[...dots.children].forEach((d, i) => d.classList.toggle('on', i === ctl.index))
    nextBtn.textContent = last ? 'Start' : 'Next'
    place()
    nextBtn.focus({ preventScroll: true })
  }
  function step(d) {
    const n = ctl.index + d
    if (n < 0) return
    if (n >= stops.length) return end(true)
    ctl.index = n
    show()
  }
  function end(markDone, leftPlayer) {
    if (closed) return
    closed = true
    ctl.done = true
    clearTimeout(timer)
    window.removeEventListener('resize', onResize)
    window.removeEventListener('orientationchange', onResize)
    window.visualViewport && window.visualViewport.removeEventListener('resize', onResize)
    document.removeEventListener('keydown', onKey, true)
    if (mo) mo.disconnect()
    root.remove()
    if (live === ctl) live = null
    if (markDone) finish()
    if (returnFocus && returnFocus.isConnected && returnFocus !== document.body) { try { returnFocus.focus({ preventScroll: true }) } catch { /* gone */ } }
    if (release && !leftPlayer) { try { release() } catch { /* the player closed meanwhile */ } }
  }
  // the page moves around while the phone turns: measure again after it settles
  function onResize() { clearTimeout(timer); timer = setTimeout(place, 80); place() }
  function onKey(e) {
    if (e.key === 'Tab') {
      const items = [skipBtn, nextBtn]
      const i = items.indexOf(document.activeElement)
      e.preventDefault()
      items[(i + (e.shiftKey ? items.length - 1 : 1)) % items.length].focus()
      e.stopImmediatePropagation()
      return
    }
    const onButton = !!(e.target && e.target.closest && e.target.closest('.tour-card button'))
    if (e.key === 'Escape') { e.preventDefault(); end(true) }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1) }
    else if (e.key === 'Enter' && !onButton) { e.preventDefault(); step(1) }
    else if ((e.key === 'Enter' || e.key === ' ') && onButton) { /* the focused button handles its own press */ }
    else if (e.key === ' ') e.preventDefault()
    // nothing else reaches the player (Space would start the song under the tour)
    e.stopImmediatePropagation()
  }
  skipBtn.onclick = () => end(true)
  nextBtn.onclick = () => step(1)
  // a tap on the dimmed page does nothing: it must not reach the controls underneath
  root.addEventListener('pointerdown', (e) => { if (!card.contains(e.target)) e.preventDefault() })
  window.addEventListener('resize', onResize)
  window.addEventListener('orientationchange', onResize)
  window.visualViewport && window.visualViewport.addEventListener('resize', onResize)
  document.addEventListener('keydown', onKey, true)
  let mo = null
  if (!opts.stops) {
    // leaving the player (back, a notification, an incoming file) closes the tour without counting it as seen
    mo = new MutationObserver(() => { if (document.body.dataset.screen !== 'play') end(false, true) })
    mo.observe(document.body, { attributes: true, attributeFilter: ['data-screen'] })
  }
  show()
  return ctl
}

// Marks the tour as seen.
function finish() {
  if (!deps || !deps.settings) return
  deps.settings.tourDone = true
  if (deps.save) deps.save()
}

export function mountTour(d) { deps = d }

// Starts the tour whatever the flag says (Help > Quick tour). Waits a moment for the player's layout to settle first.
// A newer start replaces one still waiting (so a double tap or a replay on top of the automatic start opens one tour), and
// opts.guard is asked again after the wait, because playback may have started or the player closed meanwhile.
let waiting = 0
export async function startTour(opts = {}) {
  if (live) return live
  const mine = ++waiting
  if (!opts.stops) {
    await new Promise((r) => setTimeout(r, opts.delay ?? 450))
    if (mine !== waiting) return live
    if (document.body.dataset.screen !== 'play') return null
  }
  // asked again right before mounting: playback, the setup or a newer start may have come in during the wait
  if (opts.guard && !opts.guard()) return null
  if (live) return live
  return run(opts)
}

// Starts it the first time only, and never while a song is playing.
export async function maybeStartTour(opts = {}) {
  if (!deps || deps.settings.tourDone || live) return null
  if (deps.canStart && !deps.canStart()) return null
  return startTour({ ...opts, guard: () => !deps.settings.tourDone && (!deps.canStart || deps.canStart()) })
}

// Closes the tour (the Android Back button, the setup opening, a screen leaving). Defaults are a Skip: it counts as
// seen and playback comes back. markDone: false closes it without marking it seen; resume: false leaves the player
// paused. Either way a start still inside its delay is cancelled, and a guarded start will not mount after it.
export function closeTour({ markDone = true, resume = true } = {}) {
  waiting++      // the same counter startTour's delay checks: a pending start is dropped
  if (!live) return false
  live.close(markDone, !resume)
  return true
}
export const tourIsOpen = () => !!live
