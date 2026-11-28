// The Results screen's one choreography on iPhone/iPad (Illuminated Studio v3 P2). Over in 1.04s, in one breath:
//   0ms    the light of the last struck key rises from the rail (RISE_MS, and a sweep on a new best or the first three stars)
//   200ms  the score counts up and the ring fills (COUNT_MS, ease-out-expo) while the stars land 120ms apart (CSS, ios.css)
//   800ms  the stats and the buttons fade in (STATS_MS)
// One success haptic when the last earned star lands. A tap, Space, Enter or the "Skip animation" button jumps to the end.
// The live region hears the final lead line and stars once, never the count-up. A no-op off iOS (the desktop keeps its results).
import { IS_IOS } from './platform.js'
import { createKeyLight } from './key-light-engine.js'
import { haptic } from './haptics.js'

const root = document.documentElement
export const STAR_STEP = 120          // ms between two stars
export const STAR_MS = 220            // one star's pop
export const COUNT_MS = 600           // score count-up and ring, started RISE_MS in
export const SWEEP_MS = 420           // the keyboard sweep
export const RISE_MS = 200            // the last struck key's light rises into the result, then the count starts
export const STATS_MS = 220           // the stats and the buttons fade in at RISE_MS + COUNT_MS (800ms)
export const TOTAL_MS = RISE_MS + COUNT_MS + STATS_MS   // 1020ms, the budget is 1200
const lite = () => root.classList.contains('fx-lite')     // Lite effects: the app hides the Results rail (ios.css), so it never draws or loops
const calm = () => root.classList.contains('shot') || root.classList.contains('reduce-motion') || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)

let rail = null
const railShape = (host) => ({ whites: host.clientWidth >= 600 ? 15 : 8, baseH: parseFloat(getComputedStyle(host).getPropertyValue('--res-rail-h')) || 48 })
function ensureRail(host) {
  const shape = railShape(host)
  if (rail && rail.canvas.isConnected) {
    // a rotation or a wider window since the last time: the same canvas takes the new shape
    if (rail.shape.whites !== shape.whites || rail.shape.baseH !== shape.baseH) { rail.r.configure(shape); rail.shape = shape }
    return rail
  }
  const canvas = document.createElement('canvas')
  canvas.className = 'results-rail'
  canvas.setAttribute('aria-hidden', 'true')
  host.prepend(canvas)
  const r = createKeyLight(canvas, { ...shape, rise: 0.34, cap: 0.6, calm, paused: () => document.hidden || lite() || root.classList.contains('mo-idle') || host.classList.contains('hidden'), onSlow: () => root.classList.add('fx-lite') })
  rail = { canvas, r, shape }
  return rail
}

// run(opts): opts.host (#results), opts.earned (stars lit, 0 to 3), opts.celebrate (sweep + count-up), opts.final (the value text),
// opts.setBig(text) writes the score, opts.ring (the SVG circle) with opts.offset, opts.announce(text) fills the live region.
// Returns { skip(), done: Promise-less flag }.
export function playResults(opts) {
  const { host, earned, celebrate, target, setBig, ring, offset, announce, bigEl, lastPc } = opts
  if (!IS_IOS || !host) return { skip() {}, cancel() {}, finished: true }
  const timers = []
  let raf = 0, ringRaf = 0, done = false, buzzed = false
  let keyRail = null
  if (!lite() && !host.classList.contains('hidden') && host.clientWidth > 0) keyRail = ensureRail(host)
  const restKey = keyRail && Number.isInteger(lastPc) ? keyRail.r.keys.findIndex((key) => key.pc === lastPc) : -1
  const final = () => { setBig(target + '%'); ring.style.strokeDashoffset = String(offset); bigEl?.removeAttribute('aria-hidden') }
  const buzz = () => { if (buzzed || !earned || document.hidden || root.classList.contains('shot')) return; buzzed = true; haptic('success') }
  const finish = () => {
    if (done) return
    done = true
    timers.forEach(clearTimeout); cancelAnimationFrame(raf); cancelAnimationFrame(ringRaf)
    host.classList.remove('playing'); host.classList.add('played')
    if (keyRail && calm()) keyRail.r.showChord(restKey >= 0, restKey >= 0 ? [restKey] : [])   // a settled or shot frame keeps the last key softly lit
    final()
    announce?.()
  }
  // a tap: everything lands where it was going, at once (no ring, field or sweep left running)
  const skip = () => {
    if (done) return
    host.classList.add('skipped')
    ring.style.setProperty('transition', 'none')
    rail?.r.clear()
    buzz(); finish()
  }
  // the screen went away or was replaced: stop quietly, no haptic, no announcement
  const cancel = () => {
    rail?.r.clear()     // sweep plumes outlive the 0.6s choreography: dropping the screen always clears them
    if (done) return
    done = true
    timers.forEach(clearTimeout); cancelAnimationFrame(raf); cancelAnimationFrame(ringRaf)
    host.classList.remove('playing', 'skipped'); ring.style.removeProperty('transition'); bigEl?.removeAttribute('aria-hidden')
  }

  const still = calm()
  host.classList.remove('played', 'skipped')
  if (still || document.hidden) {
    buzz()
    finish()
    return { skip, cancel, get finished() { return done } }
  }
  void host.offsetWidth                          // the field and the stars start from their resting state, so their transitions run
  host.classList.add('playing')
  bigEl?.setAttribute('aria-hidden', 'true')    // the live region hears the final values only
  // the ring and the number run together; the number counts only when something was earned worth a moment
  if (celebrate) {
    const t0 = performance.now() + RISE_MS
    const step = (t) => {
      const k = Math.max(0, Math.min(1, (t - t0) / COUNT_MS))   // a rAF stamp can be a hair older than t0
      setBig(Math.round(target * (k >= 1 ? 1 : 1 - Math.pow(2, -10 * k))) + '%')   // ease-out-expo
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    ring.style.setProperty('transition', 'stroke-dashoffset ' + COUNT_MS + 'ms cubic-bezier(.16, 1, .3, 1) ' + RISE_MS + 'ms')
    ringRaf = requestAnimationFrame(() => { ring.style.strokeDashoffset = String(offset) })
  } else {
    setBig(target + '%')
    ring.style.setProperty('transition', 'stroke-dashoffset 360ms cubic-bezier(.16, 1, .3, 1) ' + RISE_MS + 'ms')
    ringRaf = requestAnimationFrame(() => { ring.style.strokeDashoffset = String(offset) })
  }
  const lastStar = RISE_MS + (earned > 0 ? (earned - 1) * STAR_STEP + Math.round(STAR_MS * 0.6) : 0)
  if (earned) timers.push(setTimeout(buzz, lastStar))
  if (keyRail) {
    keyRail.r.setVisible(true)
    // the last struck key's own light rises first; a new best or the first three stars sweep the whole rail after it
    keyRail.r.showChord(false)
    if (restKey >= 0) keyRail.r.light(restKey)
    if (celebrate) keyRail.r.sweep({ ms: SWEEP_MS, stagger: 14, gain: 0.7 })
  }
  const total = RISE_MS + COUNT_MS + STATS_MS   // 1020ms: the stats and buttons fade in as the count lands (ios.css), then it is over
  timers.push(setTimeout(finish, total + 20))
  return { skip, cancel, get finished() { return done } }
}

// the dim keyboard that rests at the foot of Results (drawn once; the sweep, when there is one, runs on it)
export function mountResultsRail(host) {
  if (!IS_IOS || !host || lite() || host.classList.contains('hidden') || !host.clientWidth) return null
  const k = ensureRail(host)
  k.r.setVisible(true)     // a reshape (ensureRail) lays out and paints; setVisible repaints once and never loops
  return k.r
}

// Results is open and the app comes back (foreground, Lite or idle state changed): the rail repaints, or is made if Lite hid it the first time
if (IS_IOS) {
  const revive = () => {
    const host = document.getElementById('results')
    if (!host || host.classList.contains('hidden') || document.hidden || lite() || root.classList.contains('mo-idle')) return
    mountResultsRail(host)
  }
  document.addEventListener('visibilitychange', revive)
  new MutationObserver(revive).observe(root, { attributes: true, attributeFilter: ['class'] })
}
