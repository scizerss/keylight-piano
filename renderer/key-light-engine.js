// Key-light engine: light that rises from piano keys, drawn on ONE canvas. Shared by the app's Home (renderer/home-light.js)
// and the website hero (site-next/, copied from here by scripts/sync-key-light-engine.js; a drift test keeps the two identical).
//
// Rules it keeps: no ctx.shadowBlur and no CSS blur (a plume is a pre-rendered gradient sprite), dpr <= 2, one rAF loop that
// sleeps 600ms after the last input and when off-screen or hidden, a still lit chord when calm, and a 60-frame cost watch.
// Presentation only: it never decides what a press means. The caller owns pointers, sound and haptics.
//
//   const rail = createKeyLight(canvas, { whites: 8, baseH: 64, inset: 0, rise: 0.4, cap: 0.35, calm: () => false })
//   rail.sweep()                       // one run of light along the keys (480ms), then the loop sleeps
//   rail.light(i, { hand: 'r' })       // a plume from key i (index into rail.keys), decays on its own
//   rail.press(i) / rail.release(i)    // a held key (live MIDI): lit while held, decays after
//   rail.keyAt(x, y)                   // the key under a point in canvas CSS pixels (y optional)
//   rail.setHands(fn | null)           // fn(key) -> 'l' | 'r'; the default is cobalt on the left half, amber on the right
//   rail.configure({ whites, baseH, inset })   // reshape after a rotation
//   rail.refresh() / rail.clear()      repaint once without a loop / drop every plume and redraw the dim keys
//   rail.destroy()
//
// Split rail API:
//   createKeyLight(canvas, { layers: 'split', firstSemi: 60, observe: false, clock: () => time })
//   rail.setHands(new Map([[60, 'left'], [61, 'right']])) // note (key.semi) to cobalt or amber
//   rail.press(note, gain = 1) / rail.release(note)     // note is key.semi in split mode, key.i in the legacy mode
//   rail.tick(now)                                       // with observe:false, the caller owns visibility and rAF
// Tick timestamps and clock() use the same milliseconds time base (performance.now() by default).
// light(), hover() and showChord() still take key indices. Draw falling notes in a separate pass.

const WHITE_SEMI = [0, 2, 4, 5, 7, 9, 11]
const BLACK_AFTER = [0, 1, 3, 4, 5]          // the white keys (C, D, F, G, A) that have a black key to their right
const BLACK_SEMI = [1, 3, 6, 8, 10]
export const HAND_RGB = { l: '134,182,255', r: '255,138,61' }   // cobalt (left hand), amber (right hand)
const SOLID = { l: '#86b6ff', r: '#ff8a3d' }
const PRESS_PX = 2, PRESS_MS = 45, RELEASE_MS = 220, SPLIT_DECAY_MS = 260

function pressEase(x) {
  if (x <= 0) return 0
  if (x >= 1) return 1
  // Solve x(t) for cubic-bezier(.22, 1, .36, 1) before evaluating y(t).
  let lo = 0, hi = 1
  for (let i = 0; i < 12; i++) {
    const t = (lo + hi) / 2, u = 1 - t
    if (3 * u * t * (.22 * u + .36 * t) + t ** 3 < x) lo = t
    else hi = t
  }
  return 1 - (1 - (lo + hi) / 2) ** 3
}

// the engine's defaults; every one can be overridden in createKeyLight(canvas, options)
const DEFAULTS = {
  whites: 8,            // white keys on the rail: 8 is one octave C to C, 15 is two
  firstSemi: 0,         // semitone of the first white key (0 = a C)
  baseH: 64,            // height of the drawn keyboard base at the bottom of the canvas; 0 draws no base (the page has real keys)
  inset: 0,             // space left and right of the keys, CSS px
  rise: 0.4,            // tallest plume as a share of the canvas height
  riseMin: 0.55,        // a new plume starts this share of its full height and grows 140px/s to it
  cap: 1,               // the strongest alpha a plume is drawn with (the app caps it behind text)
  decay: 520,           // ms: a plume's exponential decay
  maxDpr: 2,
  calm: () => false,    // true: draw one still frame, no loop (reduced motion, Lite effects, screenshots)
  paused: () => false,  // true: do not draw (hidden window, another screen)
  onSlow: null          // called once when 60 frames average more than 8ms of drawing
}

export function createKeyLight(canvas, options = {}) {
  const o = { ...DEFAULTS, ...options }
  const split = o.layers === 'split'
  const automatic = o.observe !== false
  const clock = o.clock || (() => performance.now())
  const ctx = canvas.getContext('2d')
  const keys = []                 // whites and blacks, left to right
  const plumes = []
  const held = new Set()
  const depressions = split ? new Map() : null
  let handFn = null, handMap = null
  let W = 0, H = 0, dpr = 1, kw = 0, x0 = 0, baseTop = 0, maxH = 0
  let frame = 0, last = -Infinity, visible = true, dead = false
  let costSum = 0, costN = 0, slow = false
  let baseCanvas = null, stillOn = false, hover = -1, chordSet = [0, 2, 4, 7]
  let faces = null, edgeFade = null

  // ---------- sprites: pre-rendered once, so a plume is one drawImage ----------
  const sprites = {}
  function makeSprite(rgb) {
    const c = document.createElement('canvas'); c.width = 64; c.height = 256
    const g = c.getContext('2d')
    const v = g.createLinearGradient(0, 0, 0, 256)
    v.addColorStop(0, `rgba(${rgb},0)`); v.addColorStop(.5, `rgba(${rgb},.4)`); v.addColorStop(1, `rgba(${rgb},1)`)
    g.fillStyle = v; g.fillRect(0, 0, 64, 256)
    g.globalCompositeOperation = 'destination-in'
    const h = g.createLinearGradient(0, 0, 64, 0)
    h.addColorStop(0, 'rgba(0,0,0,0)'); h.addColorStop(.5, 'rgba(0,0,0,1)'); h.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = h; g.fillRect(0, 0, 64, 256)
    return c
  }
  sprites.l = makeSprite(HAND_RGB.l); sprites.r = makeSprite(HAND_RGB.r)

  // ---------- geometry ----------
  function build() {
    keys.length = 0
    const n = o.whites
    for (let w = 0; w < n; w++) {
      const d = w % 7, oct = Math.floor(w / 7)
      keys.push({ kind: 'w', w, pc: ((oct * 12 + WHITE_SEMI[d] + o.firstSemi) % 12 + 12) % 12, semi: oct * 12 + WHITE_SEMI[d] + o.firstSemi, cx: (w + .5) / n, wd: 1 / n })
      if (BLACK_AFTER.includes(d) && w + 1 < n) {
        const bi = BLACK_AFTER.indexOf(d), semi = oct * 12 + BLACK_SEMI[bi] + o.firstSemi
        keys.push({ kind: 'b', w, pc: ((semi % 12) + 12) % 12, semi, cx: (w + 1) / n, wd: .6 / n })
      }
    }
    keys.forEach((k, i) => { k.i = i })
  }
  function handOf(k) {
    const hand = handMap?.get(k.semi)
    return (hand === 'left' ? 'l' : hand === 'right' ? 'r' : handFn && handFn(k)) || (k.cx < .5 ? 'l' : 'r')
  }

  function layout() {
    dpr = Math.min(globalThis.devicePixelRatio || 1, o.maxDpr)
    const hidden = !canvas.clientWidth || !canvas.clientHeight       // display: none: keep the canvas and its size, only refresh the key geometry
    if (!hidden) {
      W = canvas.clientWidth; H = canvas.clientHeight
      canvas.width = Math.max(1, Math.round(W * dpr)); canvas.height = Math.max(1, Math.round(H * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    if (!W) return false                                                // never had a size yet: nothing to lay out
    x0 = o.inset
    kw = (W - 2 * o.inset) / o.whites
    baseTop = H - o.baseH
    maxH = H * o.rise
    const span = W - 2 * o.inset
    for (const k of keys) { k.w_px = k.wd * span; k.mid = x0 + k.cx * span; k.x = k.mid - k.w_px / 2 }
    if (split) buildSplitBase()
    else drawBase()
    return !hidden
  }

  // the keyboard base: drawn once into an offscreen canvas, blitted each frame
  function drawBase() {
    baseCanvas = null
    if (!o.baseH || !W) return
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(W * dpr)); c.height = Math.max(1, Math.round(o.baseH * dpr))
    const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0)
    const bh = o.baseH, gap = 1.5
    for (const k of keys) {
      if (k.kind !== 'w') continue
      const x = k.x + gap / 2, w = k.w_px - gap
      const v = g.createLinearGradient(0, 0, 0, bh); v.addColorStop(0, 'rgba(242,239,232,.15)'); v.addColorStop(1, 'rgba(242,239,232,.06)')
      g.fillStyle = v
      g.beginPath(); g.roundRect(x, 0, w, bh, [0, 0, 6, 6]); g.fill()
    }
    g.fillStyle = 'rgba(242,239,232,.16)'; g.fillRect(x0, 0, W - 2 * o.inset, 1)
    for (const k of keys) {
      if (k.kind !== 'b') continue
      g.fillStyle = 'rgba(8,9,12,.94)'
      g.beginPath(); g.roundRect(k.x, 0, k.w_px, bh * .6, [0, 0, 4, 4]); g.fill()
      g.fillStyle = 'rgba(242,239,232,.10)'; g.fillRect(k.x + 2, bh * .6 - 2, k.w_px - 4, 1)
    }
    baseCanvas = c
  }

  function keyRect(k) {   // the pressed face of a key, in canvas CSS px
    return k.kind === 'w' ? [k.x + .75, baseTop, k.w_px - 1.5, o.baseH] : [k.x, baseTop, k.w_px, o.baseH * .6]
  }

  function buildSplitBase() {
    const end = W - x0
    const fade = Math.min(24, (end - x0) / 2)
    edgeFade = ctx.createLinearGradient(x0, 0, end, 0)
    edgeFade.addColorStop(0, 'transparent')
    edgeFade.addColorStop(fade / (end - x0), '#000')
    edgeFade.addColorStop(1 - fade / (end - x0), '#000')
    edgeFade.addColorStop(1, 'transparent')
    faces = o.baseH ? {
      w: makeFaces(kw - 1.5, o.baseH, 6, true),
      b: makeFaces(kw * .6, o.baseH * .6, 4, false)
    } : null
  }

  // One sprite sheet per layer: base face, cobalt highlight, amber highlight.
  function makeFaces(w, h, radius, white) {
    if (w <= 0 || h <= 0) return null
    const c = document.createElement('canvas')
    const sw = Math.ceil(w * dpr), sh = Math.ceil(h * dpr)
    c.width = sw; c.height = 3 * sh
    const g = c.getContext('2d')
    g.setTransform(sw / w, 0, 0, sh / h, 0, 0)
    const base = g.createLinearGradient(0, 0, 0, h)
    base.addColorStop(0, white ? '#d2cbbd' : '#222329')
    base.addColorStop(.2, white ? '#e8e3d9' : '#14151b')
    base.addColorStop(1, white ? '#f2efe8' : '#0a0b0f')
    g.fillStyle = base
    const shape = (y) => {
      g.beginPath(); g.roundRect(0, y, w, h, [0, 0, radius, radius])
    }
    shape(0); g.fill()
    for (const [row, rgb] of [[1, HAND_RGB.l], [2, HAND_RGB.r]]) {
      const y = row * h
      g.save()
      shape(y); g.clip()
      const bloom = g.createLinearGradient(0, y + h * (white ? .4 : .18), 0, y + h)
      bloom.addColorStop(0, `rgba(${rgb},0)`)
      bloom.addColorStop(.82, `rgba(${rgb},${white ? .52 : .63})`)
      bloom.addColorStop(1, white ? 'rgba(255,243,224,.7)' : `rgba(${rgb},.72)`)
      g.fillStyle = bloom
      g.fillRect(0, y, w, h)
      if (!white) {
        g.fillStyle = 'rgba(255,243,224,.65)'
        g.fillRect(2, y + h - 2, Math.max(0, w - 4), 1)
      }
      g.restore()
    }
    return { c, sw, sh }
  }

  function keyOffset(i, now) {
    const move = depressions.get(i)
    if (!move) return 0
    const to = held.has(i) ? PRESS_PX : 0
    const duration = to ? PRESS_MS : RELEASE_MS
    return move.from + (to - move.from) * pressEase((now - move.start) / duration)
  }

  function drawFace(k, row, alpha, offset) {
    const face = faces[k.kind]
    if (!face) return
    const [x, y, w, h] = keyRect(k)
    if (offset > 0) {
      ctx.save()
      ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip()
    }
    ctx.globalAlpha = Math.min(1, alpha)
    ctx.drawImage(face.c, 0, row * face.sh, face.sw, face.sh, x, y + offset, w, h)
    if (offset > 0) ctx.restore()
  }

  function paintSplitBase(strengths, now) {
    if (faces) {
      for (const kind of ['w', 'b']) {
        for (const k of keys) if (k.kind === kind) drawFace(k, 0, 1, now == null ? 0 : keyOffset(k.i, now))
        for (const [i, alpha] of strengths) {
          const k = keys[i]
          if (k.kind === kind) drawFace(k, handOf(k) === 'l' ? 1 : 2, alpha, now == null ? 0 : keyOffset(i, now))
        }
      }
    }
    ctx.globalAlpha = 1
    if (edgeFade) {
      ctx.save()
      ctx.globalCompositeOperation = 'destination-in'
      ctx.fillStyle = edgeFade
      ctx.fillRect(0, 0, W, H)
      ctx.restore()
    }
  }

  // ---------- drawing ----------
  function plumeAlpha(p, now) {
    const t = now - p.t0
    if (t < 0) return 0
    if (p.held) return p.gain * (.62 + .38 * Math.exp(-t / 140))
    if (split) return (p.rel == null ? p.gain : p.relA) * Math.max(0, 1 - (now - (p.rel ?? p.t0)) / SPLIT_DECAY_MS)
    if (p.rel != null) return p.relA * Math.exp(-(now - p.rel) / (p.decay || o.decay))
    return p.gain * Math.exp(-t / (p.decay || o.decay))
  }
  function drawPlume(k, alpha, h) {
    const wide = k.w_px * (k.kind === 'b' ? 1.9 : 1.6)
    ctx.globalAlpha = Math.min(o.cap, alpha)
    ctx.drawImage(sprites[handOf(k)], k.mid - wide / 2, baseTop - h, wide, h)
  }
  function tint(k, alpha) {
    if (!o.baseH || alpha <= .01) return
    const [x, y, w, h] = keyRect(k)
    const r = [0, 0, k.kind === 'w' ? 6 : 4, k.kind === 'w' ? 6 : 4]
    ctx.globalAlpha = Math.min(1, alpha)
    ctx.fillStyle = SOLID[handOf(k)]
    ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill()
    ctx.globalAlpha = Math.min(1, alpha) * .5       // the lit edge: the light comes from the top of the key
    ctx.fillStyle = '#fff3e0'
    ctx.beginPath(); ctx.roundRect(x, y, w, Math.min(h, 4), [0, 0, 2, 2]); ctx.fill()
  }
  function paint(now) {
    if (!W) return                                  // never laid out (hidden at creation): nothing to draw yet
    ctx.clearRect(0, 0, W, H)
    if (split) {
      const strengths = new Map()
      for (const p of plumes) {
        const alpha = plumeAlpha(p, now)
        if (alpha > (strengths.get(p.i)?.alpha ?? 0)) strengths.set(p.i, { alpha, t: now - p.t0 })
      }
      const lights = new Map()
      for (const [i, { alpha, t }] of strengths) {
        drawPlume(keys[i], alpha, Math.min(maxH, maxH * o.riseMin + 140 * t / 1000))
        lights.set(i, alpha)
      }
      paintSplitBase(lights, now)
      return
    }
    for (const p of plumes) {
      const a = plumeAlpha(p, now)
      if (a <= .004) continue
      const k = keys[p.i], t = now - p.t0
      drawPlume(k, a, Math.min(maxH, maxH * o.riseMin + 140 * t / 1000))
    }
    if (baseCanvas) { ctx.globalAlpha = 1; ctx.drawImage(baseCanvas, 0, baseTop, W, o.baseH) }
    for (const p of plumes) { const a = plumeAlpha(p, now); if (a > .004) tint(keys[p.i], a) }
    ctx.globalAlpha = 1
  }
  // calm: one frame, a lit chord plus whatever is held or under a finger, no motion
  function paintStill() {
    if (!W) return
    ctx.clearRect(0, 0, W, H)
    const on = new Set(stillOn ? chordSet : [])
    for (const i of held) on.add(i)
    if (hover >= 0) on.add(hover)
    for (const i of on) if (keys[i]) drawPlume(keys[i], held.has(i) || i === hover ? .9 : .5, maxH * .8)
    if (split) {
      paintSplitBase(new Map([...on].filter((i) => keys[i]).map((i) => [i, held.has(i) || i === hover ? .9 : .5])), null)
      return
    }
    if (baseCanvas) { ctx.globalAlpha = 1; ctx.drawImage(baseCanvas, 0, baseTop, W, o.baseH) }
    for (const i of on) if (keys[i]) tint(keys[i], held.has(i) || i === hover ? .9 : .5)
    ctx.globalAlpha = 1
  }

  // ---------- the loop ----------
  const calm = () => !!o.calm()
  function active(now) {
    return plumes.length > 0 || held.size > 0 || now - last < 600
  }
  function tick(now = clock()) {
    frame = 0
    if (dead || !visible || o.paused()) return
    if (calm()) { paintStill(); return }
    const t0 = performance.now()
    for (let i = plumes.length - 1; i >= 0; i--) {
      const p = plumes[i]
      if (split) {
        if (!p.held && now - (p.rel ?? p.t0) >= SPLIT_DECAY_MS) plumes.splice(i, 1)
      }
      else if (p.rel != null) { if (now - p.rel > 1600) plumes.splice(i, 1) }     // a released key decays 1.6s from its release, however long it was held
      else if (!p.held && now - p.t0 > 2000) plumes.splice(i, 1)
    }
    if (split) for (const [i, move] of depressions) {
      if (!held.has(i) && now - move.start >= RELEASE_MS) depressions.delete(i)
    }
    paint(now)
    const cost = performance.now() - t0
    costSum += cost; costN++
    if (costN >= 60) {
      if (!slow && costSum / costN > 8 && o.onSlow) { slow = true; o.onSlow(costSum / costN) }
      costSum = 0; costN = 0
    }
    if (automatic && active(now)) frame = requestAnimationFrame(tick)
  }
  function wake() {
    if (dead) return
    last = clock()
    if (calm()) { if (visible && !o.paused()) paintStill(); return }
    if (automatic && !frame && visible && W && !o.paused()) { frame = requestAnimationFrame(tick) }
  }
  function stop() { if (frame) { cancelAnimationFrame(frame); frame = 0 } }
  // repaint once without starting the loop (a class change, coming back on screen): an idle rail never spins for 600ms
  function refresh() {
    if (dead || !visible || o.paused()) return
    if (!canvas.clientWidth || !canvas.clientHeight) return                  // hidden: nothing to paint
    const resized = canvas.clientWidth !== W || canvas.clientHeight !== H
    if (resized) layout()                                                     // the box changed while it was hidden
    if (!W) return
    if (calm()) { paintStill(); return }
    if (frame && !resized) return                                             // the running loop repaints; a resize cleared the canvas, so paint now
    paint(clock())
    if (!automatic) return
    if (!frame && (plumes.length > 0 || held.size > 0)) frame = requestAnimationFrame(tick)     // plumes still decaying keep going (tick prunes them); never a second loop; an idle rail does not start one
  }
  // drop every plume and held key at once and redraw the dim keyboard (Results: a tap skips the sweep)
  function clear() {
    plumes.length = 0; held.clear(); depressions?.clear(); hover = -1; last = -Infinity
    stop()
    if (!dead && visible && !o.paused()) { if (calm()) paintStill(); else paint(clock()) }
  }

  // ---------- the public side ----------
  function push(p) {
    if (!split && plumes.length > 32) plumes.shift()
    plumes.push(p)
    wake()
  }
  function light(i, opt = {}) {
    const k = keys[i]
    if (!k || calm()) return
    const now = clock()
    push({ i, gain: opt.gain ?? .9, t0: now + (opt.delay || 0), decay: opt.decay })
  }
  function press(note, gain = 1) {
    const k = split ? keys.find((k) => k.semi === note) : keys[note]
    if (!k) return
    const i = k.i
    if (split && held.has(i)) return
    if (split) {
      const now = clock()
      const from = calm() ? 0 : keyOffset(i, now)
      depressions.set(i, { from, start: now })
    }
    held.add(i)
    if (calm()) { wake(); return }
    for (const p of plumes) if (p.i === i && p.held) return
    push({ i, gain, t0: clock(), held: true })
  }
  function release(note) {
    const i = split ? keys.find((k) => k.semi === note)?.i : note
    if (split) {
      if (!held.has(i)) return
      const now = clock()
      const from = calm() ? 0 : keyOffset(i, now)
      depressions.set(i, { from, start: now })
    }
    held.delete(i)
    if (calm()) { wake(); return }
    const now = clock()
    for (const p of plumes) if (p.i === i && p.held) { p.relA = plumeAlpha(p, now); p.held = false; p.rel = now }
    wake()
  }
  function releaseAll() { for (const i of [...held]) release(split ? keys[i].semi : i); const had = hover >= 0; hover = -1; if (had && calm()) refresh() }
  // one run of light along the keys; the loop sleeps when it is over
  function sweep(opt = {}) {
    const ms = opt.ms ?? 480, step = opt.stagger ?? 14
    const order = keys.map((k, i) => i)
    if (calm()) { stillOn = true; wake(); return 0 }
    const decay = Math.max(160, ms - (order.length - 1) * step)
    const gain = opt.gain ?? .6
    order.forEach((i, n) => push({ i, gain: keys[i].kind === 'b' ? gain * .75 : gain, t0: clock() + n * step, decay: decay * .6 }))
    return ms
  }
  // the key under a point; y is optional (without it only the white keys answer, so a drag crosses one key at a time)
  function keyAt(x, y) {
    const f = (x - x0) / Math.max(1, W - 2 * o.inset)
    if (f < 0 || f > 1) return null
    if (y != null && y >= baseTop && y < baseTop + o.baseH * .6) for (const k of keys) if (k.kind === 'b' && Math.abs(f - k.cx) < k.wd / 2) return k
    return keys.find((k) => k.kind === 'w' && f >= k.cx - k.wd / 2 && f < k.cx + k.wd / 2) || keys.filter((k) => k.kind === 'w').pop()
  }
  function setHover(i) { const next = i == null ? -1 : i; if (next === hover) return; hover = next; if (calm()) refresh() }     // hover only draws in calm mode: it never wakes the loop
  function showChord(on = true, set) { stillOn = on; if (set) chordSet = set; refresh() }
  function resize() {
    if (dead) return
    if (!layout()) return                                     // a hidden canvas is not painted
    if (!visible || o.paused()) return
    if (calm()) paintStill()
    else {
      paint(clock())
      if (!automatic) return
      if (!frame && (plumes.length > 0 || held.size > 0)) frame = requestAnimationFrame(tick)     // a reshape never starts an idle loop
    }
  }
  // change the rail's shape (a rotation, a wider window) without making a new canvas
  function configure(next) {
    Object.assign(o, next)
    plumes.length = 0; held.clear(); depressions?.clear(); hover = -1
    build(); resize()
  }
  function setVisible(v) { visible = v; if (v) refresh(); else stop() }
  function destroy() { dead = true; stop(); plumes.length = 0; held.clear(); depressions?.clear(); if (ro) ro.disconnect(); if (io) io.disconnect() }

  let ro = null, io = null
  if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(() => resize()); ro.observe(canvas) }
  if (automatic && typeof IntersectionObserver !== 'undefined') { io = new IntersectionObserver((entries) => setVisible(entries[entries.length - 1].isIntersecting)); io.observe(canvas) }

  build()
  layout()
  return {
    keys, light, press, release, releaseAll, sweep, keyAt, resize, configure, wake, stop, refresh, clear, destroy, setVisible,
    hover: setHover, showChord, drawStill: paintStill,
    tick: automatic ? undefined : tick,
    setHands(map) {
      handFn = typeof map === 'function' ? map : null
      handMap = map instanceof Map ? map : null
      if (calm()) wake()
    },
    get keyCount() { return keys.length },
    get slow() { return slow },
    get geometry() { return { W, H, baseTop, kw, x0, maxH } }
  }
}
