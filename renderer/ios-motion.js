// Navigation motion for the iPhone/iPad app (Illuminated Studio A3, v3 P5). Presentation only; a no-op everywhere else.
//   drill in (Course to a lesson, Practice to an exercise, a song to the player): the incoming screen slides 24px and fades in, 280ms
//   back:  it slides in from -16px, 220ms; the iOS curve cubic-bezier(.32, .72, 0, 1) for both
//   tabs:  a 120ms opacity fade, no slide
//   reduced motion / reduced transparency stays calm: a 100ms fade
// One Web Animation per screen, transform and opacity only (compositor), cancelled by the next one, so nothing stacks. The legacy
// mScreenIn / mNavPop animations and the --sx tab slide are switched off under html.ios (ios.css, motion.js).
//
// P5, native-feeling navigation (all of it is a small hand-written stepper, no library):
//   installBackSwipe(host)  an interactive back swipe from the left 24px edge on a phone. The current screen follows the finger 1:1,
//                           the screen below stays mounted and slides in with parallax, and on release the velocity projection picks
//                           commit or cancel; a critically damped spring (response .34s) finishes it. The back navigation runs once,
//                           on release. A cancel changes nothing: the screen is never re-rendered, so scroll and focus are kept.
//   sheet depth             while a sheet is open the ACTIVE screen (never #app, so #nav and #ambient stay put) scales to .95 with
//                           16px corners (340ms), and follows a sheet being dragged down (sheet-drag.js sets the sheet's transform).
//   segmented controls      one thumb, equal-width segments, translateX only, and it can be scrubbed by dragging.
import { IS_IOS } from './platform.js'

const root = document.documentElement
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'
const calm = () => root.classList.contains('reduce-motion') || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
const still = () => root.classList.contains('shot') || document.hidden
const running = new WeakMap()
let skipOnce = false          // a back swipe already moved the screen: the next enterScreen must not play its slide again

export function enterScreen(el, kind = 'tab') {
  if (!IS_IOS || !el || typeof el.animate !== 'function' || still()) return null
  if (skipOnce) { skipOnce = false; running.get(el)?.cancel(); return null }
  running.get(el)?.cancel()
  let frames, duration, easing = EASE
  if (calm()) { frames = [{ opacity: 0 }, { opacity: 1 }]; duration = 100; easing = 'linear' }
  else if (kind === 'forward') { frames = [{ opacity: 0, transform: 'translateX(24px)' }, { opacity: 1, transform: 'none' }]; duration = 280 }
  else if (kind === 'back') { frames = [{ opacity: 0, transform: 'translateX(-16px)' }, { opacity: 1, transform: 'none' }]; duration = 220 }
  else { frames = [{ opacity: 0 }, { opacity: 1 }]; duration = 120; easing = 'linear' }
  const a = el.animate(frames, { duration, easing })
  running.set(el, a)
  a.onfinish = a.oncancel = () => { if (running.get(el) === a) running.delete(el) }
  return a
}

/* ---------------------------------------------------------------- the stepper (pure maths, tested in scripts/test-back-swipe.js) */
export const RESPONSE = 0.34          // seconds: how fast a spring reaches its target (not a duration)
export const EDGE_PX = 24             // the back swipe starts this close to the left edge
export const DECEL = 0.998            // scroll-like deceleration for the momentum projection

/** A critically damped spring (damping ratio 1): position and velocity at time t (s), from x0 with velocity v0 (px/s) towards `to`. */
export function springAt(x0, v0, to, t, response = RESPONSE) {
  const w = (2 * Math.PI) / response
  const a = x0 - to, b = v0 + w * a
  const e = Math.exp(-w * t)
  return { x: to + (a + b * t) * e, v: (b - w * (a + b * t)) * e }
}
/** Where a release at velocity v (px/s) would come to rest, like scroll deceleration. */
export const project = (v, rate = DECEL) => ((v / 1000) * rate) / (1 - rate)
/** Commit or cancel: the projected resting point must pass the middle of the screen. */
export const decideBack = ({ dx, vx, width }) => dx + project(vx) > width * 0.5
/** The pointer's velocity (px/s) from a short trail of [time ms, x px] samples. */
export function trailVelocity(trail) {
  if (trail.length < 2) return 0
  const [t1, x1] = trail[trail.length - 1]
  let i = trail.length - 2
  while (i > 0 && t1 - trail[i][0] < 60) i--      // about the last 60ms
  const [t0, x0] = trail[i]
  return t1 > t0 ? ((x1 - x0) / (t1 - t0)) * 1000 : 0
}
/** The screen below slides in from 28% to the left as the top screen leaves (parallax). */
export const parallax = (dx, width) => -width * 0.28 * (1 - Math.max(0, Math.min(1, dx / (width || 1))))

function runSpring({ from, to, velocity = 0, response = RESPONSE, update, done }) {
  const t0 = performance.now()
  let raf = 0, dead = false
  const step = (now) => {
    if (dead) return
    const t = Math.min((now - t0) / 1000, 2)
    const s = springAt(from, velocity, to, t, response)
    const settled = (Math.abs(s.x - to) < 0.4 && Math.abs(s.v) < 12) || t >= 2
    update(settled ? to : s.x)
    if (settled) { dead = true; done?.(); return }
    raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
  return { cancel() { dead = true; cancelAnimationFrame(raf) } }
}

/* ---------------------------------------------------------------- the interactive back swipe */
// host.target() answers, for the screen on show, whether a back swipe may start and with what:
//   { cur: Element,                                the screen that follows the finger
//     prepare(): { under: Element, cleanup() },    makes the screen below visible (kept mounted: visibility, not display:none)
//     commit() }                                   the real back navigation, run once on release
// or null (the Player, a sheet or dialog open, Results, the tab roots, anything that is not a drill-in).
export function installBackSwipe(host) {
  if (!IS_IOS || typeof document === 'undefined') return { refresh() {}, get active() { return false } }
  const strip = document.createElement('div')
  strip.id = 'swipeEdge'
  strip.setAttribute('aria-hidden', 'true')
  document.body.appendChild(strip)
  const phone = () => typeof matchMedia === 'function' && matchMedia('(max-width: 699px)').matches
  let st = null            // the gesture: { id, x0, y0, dx, trail, t, layers, locked, anim, W }
  let anim = null

  function refresh() {
    if (st) return
    let ok = false
    try { ok = phone() && !!host.target() } catch { ok = false }
    if (ok) {
      const top = document.getElementById('screen')?.getBoundingClientRect().top || 0
      const nav = document.getElementById('nav')?.getBoundingClientRect()
      strip.style.setProperty('--edge-top', Math.round(top) + 'px')
      strip.style.setProperty('--edge-bottom', (nav && nav.top > 0 && nav.top < innerHeight ? Math.round(innerHeight - nav.top) : 0) + 'px')
    }
    strip.classList.toggle('on', ok)
  }
  let queued = 0
  const soon = () => { if (queued) return; queued = requestAnimationFrame(() => { queued = 0; refresh() }) }
  new MutationObserver(soon).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class', 'open', 'data-view', 'data-screen', 'hidden'] })
  addEventListener('resize', soon); addEventListener('orientationchange', soon)
  document.addEventListener('visibilitychange', soon)

  const clear = (cur, under) => {
    for (const el of [cur, under]) if (el) { el.style.removeProperty('transform'); el.style.removeProperty('z-index'); el.style.removeProperty('will-change'); el.style.removeProperty('box-shadow') }
    root.classList.remove('back-swiping')
  }
  const frame = (cur, under, dx, W) => {
    cur.style.transform = 'translate3d(' + dx.toFixed(1) + 'px,0,0)'
    if (under) under.style.transform = 'translate3d(' + parallax(dx, W).toFixed(1) + 'px,0,0)'
  }

  strip.addEventListener('pointerdown', (e) => {
    if (!strip.classList.contains('on') || !e.isPrimary || e.button > 0) return
    const t = host.target()
    if (!t) return
    // a grab in the middle of the settle: take over from where the screen is now
    let grabbed = 0
    if (anim) { anim.cancel(); anim = null; grabbed = st ? st.dx : 0 }
    const prev = st
    st = { id: e.pointerId, x0: e.clientX - grabbed, y0: e.clientY, dx: grabbed, trail: [[e.timeStamp, e.clientX]], t, layers: prev ? prev.layers : null, locked: !!prev, W: t.cur.offsetWidth || innerWidth }
    try { strip.setPointerCapture(e.pointerId) } catch { /* the pointer is already gone */ }
    e.preventDefault()
  })
  strip.addEventListener('pointermove', (e) => {
    if (!st || st.id !== e.pointerId) return
    const dx = e.clientX - st.x0
    if (!st.locked) {
      if (Math.abs(e.clientY - st.y0) > 12 && Math.abs(e.clientY - st.y0) > Math.abs(dx)) { st = null; return }   // it is a vertical scroll, not a back swipe
      if (dx < 8) return
      st.locked = true
      if (!calm()) {
        st.layers = st.t.prepare()
        root.classList.add('back-swiping')
        st.t.cur.style.willChange = 'transform'
        st.t.cur.style.zIndex = '3'
        st.t.cur.style.boxShadow = '-14px 0 32px rgba(0, 0, 0, .5)'
        if (st.layers?.under) { st.layers.under.style.zIndex = '2'; st.layers.under.style.willChange = 'transform' }
      }
    }
    st.dx = Math.max(0, dx)
    st.trail.push([e.timeStamp, e.clientX]); if (st.trail.length > 8) st.trail.shift()
    if (!calm() && st.layers) frame(st.t.cur, st.layers.under, st.dx, st.W)
  })
  const release = (e, cancelled) => {
    if (!st || st.id !== e.pointerId) return
    const g = st
    try { strip.releasePointerCapture(e.pointerId) } catch { /* released already */ }
    if (!g.locked) { st = null; return }
    const vx = trailVelocity(g.trail)
    const go = !cancelled && decideBack({ dx: g.dx, vx, width: g.W })
    const { cur } = g.t, under = g.layers?.under
    const finish = () => {
      anim = null
      if (go) { skipOnce = !calm(); setTimeout(() => { skipOnce = false }, 60); g.t.commit() }
      clear(cur, under)
      g.layers?.cleanup?.()
      st = null
      soon()
    }
    if (calm() || !g.layers) { finish(); return }        // reduced motion: no tracking, the result lands at once
    anim = runSpring({ from: g.dx, to: go ? g.W : 0, velocity: vx, update: (x) => { g.dx = x; frame(cur, under, x, g.W) }, done: finish })
  }
  strip.addEventListener('pointerup', (e) => release(e, false))
  strip.addEventListener('pointercancel', (e) => release(e, true))
  strip.addEventListener('lostpointercapture', (e) => { if (st && st.id === e.pointerId && !anim && st.locked) release(e, true) })
  refresh()
  return { refresh, get active() { return !!st } }
}

/* ---------------------------------------------------------------- sheet depth */
const SHEETS = 'dialog[open]:not(.confirm-dialog), #importSheet:not(.hidden), body.filters-open #filterBar, .guided:not(.hidden) .guided-panel, .cr-sheet'
function installSheetDepth() {
  let queued = 0
  const sync = () => {
    queued = 0
    const open = document.body.dataset.screen !== 'play' && !!document.querySelector(SHEETS)
    root.classList.toggle('sheet-open', open)
    if (!open) root.style.removeProperty('--sheet-depth')
  }
  const soon = () => { if (!queued) queued = requestAnimationFrame(sync) }
  new MutationObserver(soon).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['open', 'class', 'data-screen'] })
  // dragging a sheet down: sheet-drag.js moves the panel with translateY; the screen behind follows (1 = fully open, 0 = gone)
  let raf = 0
  const follow = () => {
    raf = 0
    const panel = document.querySelector('.sheet-dragging')
    if (!panel) { root.classList.remove('sheet-tracking'); root.style.removeProperty('--sheet-depth'); return }
    const m = /translateY\(([\d.]+)px\)/.exec(panel.style.transform || '')
    const dy = m ? Number(m[1]) : 0
    root.classList.add('sheet-tracking')
    root.style.setProperty('--sheet-depth', String(Math.max(0, 1 - dy / Math.max(1, panel.offsetHeight))))
    raf = requestAnimationFrame(follow)
  }
  document.addEventListener('pointermove', () => { if (!raf && root.classList.contains('sheet-open') && document.querySelector('.sheet-dragging')) raf = requestAnimationFrame(follow) }, true)
  const stop = () => { if (!raf) raf = requestAnimationFrame(follow) }
  document.addEventListener('pointerup', stop, true); document.addEventListener('pointercancel', stop, true)
  sync()
}

/* ---------------------------------------------------------------- segmented controls: one thumb, equal-width segments, translateX only */
const SEGMENTS = '.song-segments, .seg:not(#tbType), .kl-seg'   // #tbType is a wrapping row of pill chips on a phone: it keeps its own look
const selected = (box) => box.querySelector('button.on, button[aria-selected="true"]')
const segButtons = (box) => [...box.querySelectorAll(':scope > button')]
function place(box, jump) {
  const thumb = box._thumb
  const b = selected(box)
  if (!thumb || !b || !b.offsetWidth) { if (thumb) thumb.style.opacity = '0'; return }
  if (jump) thumb.classList.add('jump')
  thumb.style.setProperty('--x', b.offsetLeft + 'px')
  thumb.style.setProperty('--w', b.offsetWidth + 'px')       // equal-width segments: the same for every one, so only translateX ever animates
  thumb.style.setProperty('--h', b.offsetHeight + 'px')
  thumb.style.setProperty('--y', b.offsetTop + 'px')
  thumb.style.opacity = '1'
  if (jump) { void thumb.offsetWidth; thumb.classList.remove('jump') }
}
// drag the thumb along the segments; the nearest one is chosen on release, and the click that follows a drag is swallowed
function scrub(box) {
  let g = null
  box.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || e.button > 0 || !e.target.closest('button') || !box._thumb) return
    const bs = segButtons(box), sel = selected(box)
    if (bs.length < 2 || !sel) return
    g = { id: e.pointerId, x0: e.clientX, from: sel.offsetLeft, bs, moved: false }
  })
  box.addEventListener('pointermove', (e) => {
    if (!g || g.id !== e.pointerId) return
    const dx = e.clientX - g.x0
    if (!g.moved) {
      if (Math.abs(dx) < 8) return
      g.moved = true
      try { box.setPointerCapture(e.pointerId) } catch { /* gone */ }
      box._thumb.classList.add('jump')
    }
    const first = g.bs[0].offsetLeft, last = g.bs[g.bs.length - 1].offsetLeft
    box._thumb.style.setProperty('--x', Math.max(first, Math.min(last, g.from + dx)) + 'px')
  })
  const end = (e, cancelled) => {
    if (!g || g.id !== e.pointerId) return
    const s = g; g = null
    if (!s.moved) return
    try { box.releasePointerCapture(e.pointerId) } catch { /* released */ }
    box._thumb.classList.remove('jump')
    const x = parseFloat(box._thumb.style.getPropertyValue('--x')) || s.from
    const pick = cancelled ? selected(box) : s.bs.reduce((a, b) => (Math.abs(b.offsetLeft - x) < Math.abs(a.offsetLeft - x) ? b : a))
    // apply the choice first; only then swallow the click the browser sends after the drag
    if (pick && pick !== selected(box) && !cancelled) pick.click()
    const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault() }
    box.addEventListener('click', swallow, { capture: true, once: true })
    setTimeout(() => box.removeEventListener('click', swallow, true), 0)
    place(box, false)
  }
  box.addEventListener('pointerup', (e) => end(e, false))
  box.addEventListener('pointercancel', (e) => end(e, true))
}
function attach(box) {
  if (box._thumb) return
  const thumb = document.createElement('span')
  thumb.className = 'seg-thumb'
  thumb.setAttribute('aria-hidden', 'true')
  box.prepend(thumb)
  box._thumb = thumb
  box.classList.add('has-thumb')
  new MutationObserver((recs) => { if (!recs.every((r) => r.target === thumb)) place(box, false) }).observe(box, { attributes: true, attributeFilter: ['class', 'aria-selected'], subtree: true })
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => place(box, true)).observe(box)
  scrub(box)
  place(box, true)
}
export function scanSegments(scope = document) {
  if (!IS_IOS) return
  for (const box of scope.querySelectorAll(SEGMENTS)) attach(box)
}

if (IS_IOS) {
  scanSegments()
  // a screen that mounts its segments later is picked up when it is shown
  new MutationObserver(() => { scanSegments(); for (const box of document.querySelectorAll('.has-thumb')) if (box.offsetWidth) place(box, true) })
    .observe(document.body, { attributes: true, attributeFilter: ['data-screen'] })
  installSheetDepth()
}
