// The Home key-light rail (iPhone/iPad, Illuminated Studio A1). One canvas fills the Home hero; only the keyboard base is drawn in
// its bottom strip, and light rises from the keys behind the title and the ivory button. The drawing is renderer/key-light-engine.js
// (the same engine the website hero uses); this file is the app side: what colours the keys, what a touch or a MIDI key does.
//
//   launch / keyboard connects: ONE sweep (480ms), then nothing moves; no idle plumes
//   drag across the strip:      a silent light trail and one haptic tick per key crossed (60ms floor)
//   tap:                        a bloom, plus one note only when the app's sound is on (through the app's own audio path)
//   live MIDI keys:             they light the rail while Home is on screen; they never navigate
//   calm (reduced motion, Lite, screenshot mode): a still lit chord, no loop
//
// Presentation only: the canvas and the touch strip are aria-hidden; the hero's own buttons keep every id and class.
import { createKeyLight } from './key-light-engine.js'
import { haptic } from './haptics.js'

const root = document.documentElement
const SLOP = 8                       // px: a finger that moves less than this is a tap; vertical travel beyond it is a scroll
const TICK_FLOOR = 60                // ms between two haptic ticks
const isCalm = () => root.classList.contains('shot') || root.classList.contains('fx-lite') || root.classList.contains('reduce-motion') ||
  (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)

// pitch class -> 'l' | 'r' from a song's opening notes ([pitch, start, length, hand], hand 1 = left): the right hand wins an overlap
export function handsFromNotes(notes) {
  const map = new Map()
  for (const n of notes || []) {
    const pc = ((n[0] % 12) + 12) % 12
    const hand = n[3] === 1 ? 'l' : 'r'
    if (map.get(pc) !== 'r') map.set(pc, hand)
  }
  return map
}

export function mountHomeLight(hero, deps = {}) {
  if (!hero) return null
  if (hero._homeLight) return hero._homeLight
  const canvas = document.createElement('canvas')
  canvas.className = 'key-light-canvas'
  canvas.setAttribute('aria-hidden', 'true')
  const hit = document.createElement('div')
  hit.className = 'key-light-hit'
  hit.setAttribute('aria-hidden', 'true')
  hero.prepend(hit)
  hero.prepend(canvas)

  const onHome = () => (deps.isHome ? deps.isHome() : true)
  const slowCallback = (ms) => { root.classList.add('fx-lite'); console.log('HOME-LIGHT slow (' + ms.toFixed(1) + 'ms per frame): Lite effects on') }
  const rail = createKeyLight(canvas, { layers: 'split', whites: 8, baseH: 64, rise: 0.3, cap: 0.5, calm: isCalm, paused: () => document.hidden || root.classList.contains('mo-idle') || !onHome(), onSlow: slowCallback })

  const down = new Map()   // live MIDI pitch -> note on the rail

  // ---------- shape: one octave on a phone, two on an iPad; the base is 64px (phone), 56px (landscape phone), 84px (iPad) ----------
  function fit() {
    const w = hero.clientWidth
    if (!w) return                                  // Home is hidden: no 0px reshape
    const base = parseFloat(getComputedStyle(hero).getPropertyValue('--rail-h')) || 64
    const rect = hero.getBoundingClientRect()
    const inset = Math.max(0, 16 - rect.left, 16 - (innerWidth - rect.right))   // at least 16px from each screen edge
    const whites = w >= 600 ? 15 : 8
    if (whites !== rail.keys.filter((k) => k.kind === 'w').length) { leave(); rail.configure({ whites, baseH: base, inset }); if (isCalm()) showStill() }
    else if (base !== rail.geometry.H - rail.geometry.baseTop || inset !== rail.geometry.x0) { leave(); rail.configure({ baseH: base, inset }) }
  }
  const heroObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { fit(); applyHands(); }) : null
  if (heroObserver) heroObserver.observe(hero)

  // ---------- colours: placed from the next lesson or song ----------
  let hands = null
  function applyHands() {
    if (!hands?.size) { rail.setHands(null); return }
    const byNote = new Map()
    for (const key of rail.keys) {
      const hand = hands.get(key.pc)
      if (hand) byNote.set(key.semi, hand === 'l' ? 'left' : 'right')
    }
    rail.setHands(byNote)
  }
  function setPiece(map) { hands = map; applyHands(); if (isCalm()) showStill() }
  function showStill() {
    const idx = rail.keys.filter((k) => k.kind === 'w' && [0, 4, 7].includes(k.pc)).map((k) => k.i)
    const top = rail.keys.filter((k) => k.kind === 'w' && k.pc === 0).pop()
    rail.showChord(true, top ? [...idx, top.i] : idx)
  }

  // ---------- the one sweep ----------
  let swept = false
  function sweep() {
    if (isCalm()) { showStill(); return }
    if (document.hidden || !onHome()) return
    rail.sweep({ ms: 480, stagger: 14 })
  }
  let launching = false
  function launch() {
    if (swept || launching || document.hidden || !onHome()) return      // behind the setup or a dialog it waits; closeSetup, a closing dialog and the screen switch call it again
    launching = true
    requestAnimationFrame(() => {
      launching = false
      if (swept || document.hidden || !onHome()) return       // the setup handed over to another screen, or a dialog opened: the sweep is not used up
      swept = true
      console.log('HOME-LIGHT launch calm=' + isCalm() + ' reducedMotionQuery=' + (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) + ' classes=' + root.className)   // debug aid for simulator checks
      if (isCalm() || deps.shot) showStill(); else sweep()
    })
  }

  // ---------- touch: a trail, a bloom ----------
  let ptr = null           // { id, x0, y0, state: 'wait' | 'drag' | 'scroll', key }
  let tickAt = 0
  const local = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] }
  function releaseIfUnused(note) {
    if (ptr?.key?.semi === note || [...down.values()].includes(note)) return
    rail.release(note)
  }
  function holdPointer(key, gain) {
    const old = ptr.key
    if (old === key) return
    ptr.key = key
    if (old) releaseIfUnused(old.semi)
    if (key) rail.press(key.semi, gain)
  }
  hit.addEventListener('pointerdown', (e) => {
    if (ptr || (e.pointerType === 'mouse' && e.button !== 0)) return     // a second finger does not take over the first one's touch
    clearTimeout(bloomTimer)
    rail.hover(null)
    const [x, y] = local(e)
    ptr = { id: e.pointerId, x0: x, y0: y, state: 'wait', key: null }
    if (!isCalm()) holdPointer(rail.keyAt(x, y), 1)
  })
  hit.addEventListener('pointermove', (e) => {
    if (!ptr || e.pointerId !== ptr.id || ptr.state === 'scroll') return
    const [x, y] = local(e)
    const dx = x - ptr.x0, dy = y - ptr.y0
    const starting = ptr.state === 'wait'
    if (starting) {
      if (Math.abs(dy) > SLOP && Math.abs(dy) > Math.abs(dx)) { ptr.state = 'scroll'; holdPointer(null); return }
      if (Math.abs(dx) <= SLOP) return
      ptr.state = 'drag'
      try { hit.setPointerCapture(e.pointerId) } catch (_e) { /* the pointer is already gone */ }   // a trail that leaves the strip still ends cleanly
    }
    const k = rail.keyAt(x)
    if (!k || (!starting && k === ptr.key)) return
    holdPointer(k, 0.8)
    const now = performance.now()
    if (now - tickAt >= TICK_FLOOR) { tickAt = now; haptic('select', TICK_FLOOR) }
  })
  const end = (e) => {
    if (!ptr || e.pointerId !== ptr.id) return
    const was = ptr
    let bloomed = false
    if (e.type === 'pointerup' && was.state === 'wait') {
      const [x, y] = local(e)
      const k = Math.abs(x - was.x0) < SLOP && Math.abs(y - was.y0) < SLOP ? rail.keyAt(x, y) : null   // a flick that never moved is not a tap
      if (k) { holdPointer(k, 1); bloom(k); bloomed = true }
    }
    holdPointer(null)
    ptr = null
    if (!bloomed) rail.hover(null)      // calm mode clears the bloom itself, after 220ms
  }
  // up and cancel are heard on the window: a mouse or trackpad pointer released outside the strip must not leave the touch open
  addEventListener('pointerup', end)
  addEventListener('pointercancel', end)
  hit.addEventListener('lostpointercapture', end)
  let bloomTimer = 0
  function bloom(k) {
    if (isCalm()) { rail.hover(k.i); clearTimeout(bloomTimer); bloomTimer = setTimeout(() => rail.hover(null), 220) }
    haptic('select')
    if (deps.playNote && deps.soundOn && deps.soundOn()) deps.playNote(60 + k.semi)
  }

  // ---------- live MIDI: a key on the keyboard lights the same key on the rail ----------
  function railKeyFor(pitch) {
    const span = 12 * Math.floor(rail.keys.filter((k) => k.kind === 'w').length / 7)
    const semi = ((pitch % span) + span) % span
    return rail.keys.find((k) => k.semi === semi) || null
  }
  function noteOn(pitch) {
    if (!onHome() || document.hidden) return
    const k = railKeyFor(pitch)
    if (!k) return
    down.set(pitch, k.semi)
    rail.press(k.semi, 0.95)
  }
  function noteOff(pitch) {
    const note = down.get(pitch)
    if (note == null) return
    down.delete(pitch)
    releaseIfUnused(note)
  }

  // ---------- lifecycle ----------
  const leave = () => { ptr = null; down.clear(); clearTimeout(bloomTimer); rail.releaseAll() }
  const releaseAll = () => {
    const notes = new Set(down.values())
    down.clear()
    for (const note of notes) releaseIfUnused(note)
  }
  // the effects mode can change while Home is open (Lite effects, Reduce motion): the rail settles to its still chord, or back to a quiet rest
  const modeChanged = () => { if (isCalm()) showStill(); else { rail.showChord(false); rail.refresh() } }
  const screenObserver = new MutationObserver(() => {
    if (onHome()) { fit(); rail.refresh(); launch() } else { leave(); rail.stop() }
  })
  screenObserver.observe(document.body, { attributes: true, attributeFilter: ['data-screen'] })
  const classObserver = new MutationObserver(modeChanged)
  classObserver.observe(root, { attributes: true, attributeFilter: ['class'] })
  const onVisibility = () => { if (document.hidden) { leave(); rail.stop() } else { rail.refresh(); launch() } }     // coming back runs a launch sweep that a hidden start skipped
  document.addEventListener('visibilitychange', onVisibility)
  const motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
  motionQuery?.addEventListener?.('change', modeChanged)
  addEventListener('blur', leave)
  // a dialog that closes over Home (the beta notice, a sheet) hands the rail back: repaint it, and run the launch sweep it was waiting for
  const resume = () => { if (onHome()) { modeChanged(); launch() } }       // after a dialog or the setup closes over Home
  const onDialogClose = (e) => { if (e.target && e.target.tagName === 'DIALOG') setTimeout(resume, 0) }     // after the dialog's own close listeners (one may open the next dialog)
  document.addEventListener('close', onDialogClose, true)
  fit()

  const api = {
    rail, canvas, hit, setPiece, sweep, launch, resume, noteOn, noteOff, releaseAll, fit, still: showStill,
    destroy() {
      heroObserver?.disconnect(); screenObserver.disconnect(); classObserver.disconnect()
      document.removeEventListener('visibilitychange', onVisibility); motionQuery?.removeEventListener?.('change', modeChanged); removeEventListener('blur', leave); removeEventListener('pointerup', end); removeEventListener('pointercancel', end); document.removeEventListener('close', onDialogClose, true)
      clearTimeout(bloomTimer); rail.destroy(); canvas.remove(); hit.remove(); delete hero._homeLight
    }
  }
  hero._homeLight = api
  return api
}
