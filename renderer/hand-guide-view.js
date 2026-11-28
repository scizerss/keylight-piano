// The on-screen card for hand placement (hand-guide.js holds the logic): a big finger number, a simple hand
// with that finger lit, one line of instruction, a gentle hint, Skip. Two looks:
//  - 'intro': the course's "Meet your fingers" item, a centred card over a dim page, with a small drawn keyboard
//    whose keys show the same cues as the lit keys and can be tapped (on-screen keys have no other keys here).
//  - 'song': "Place your hands" before a song, a small card at the top of the player; the player's own keys show the cues.
// No app state: app.js calls show(view) whenever something changed and gets taps back through the callbacks.

const BLACK = new Set([1, 3, 6, 8, 10])
const isBlack = (pitch) => BLACK.has(((pitch % 12) + 12) % 12)
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// A right hand seen from above, palm down: thumb (1) on the left, little finger (5) on the right; the left hand is its
// mirror image. Drawn as one hand: every part is painted twice, first with a thick outline stroke, then filled on top
// without one, so only the outer silhouette and thin lines between the fingers show (no seams where parts overlap).
// Fingers fan out a little and sit under the palm, so they grow out of it. Coordinates in a 120 x 130 box.
const FINGERS = [
  { n: 1, cx: 43, base: 97, len: 44, w: 16.5, rot: -38 },   // the thumb, its root buried in the thumb mound
  { n: 2, cx: 47.5, base: 62, len: 52, w: 15, rot: -7 },
  { n: 3, cx: 63.5, base: 60, len: 58, w: 15.5, rot: -1 },
  { n: 4, cx: 79, base: 62, len: 53, w: 14.5, rot: 5 },
  { n: 5, cx: 93, base: 68, len: 44, w: 12.5, rot: 10 }
]
const PALM = 'M40 60 Q41 53 49 53 L79 54 Q98 56 101 67 L98 99 Q94 119 75 120 L58 120 Q41 119 39 102 Z'   // knuckles slope down to the little finger
const THENAR = '<ellipse cx="48" cy="95" rx="13" ry="16" transform="rotate(-22 48 95)"/>'   // the mound at the thumb's root
const rot = (x, y, f) => {   // a point of finger f, turned with it about its base
  const a = f.rot * Math.PI / 180, dx = x - f.cx, dy = y - f.base
  return [f.cx + dx * Math.cos(a) - dy * Math.sin(a), f.base + dx * Math.sin(a) + dy * Math.cos(a)]
}
const r1 = (v) => Math.round(v * 10) / 10

/** The hand drawing; finger 1..5 is lit (0 or null: none, 'all': every number shown). */
export function handSvg(hand = 'right', finger = null) {
  const left = hand === 'left'
  const fingerShape = (f) => `<rect x="${f.cx - f.w / 2}" y="${f.base - f.len}" width="${f.w}" height="${f.len}" rx="${f.w / 2}" transform="rotate(${f.rot} ${f.cx} ${f.base})"/>`
  const shapes = FINGERS.map(fingerShape).join('') + THENAR + `<path d="${PALM}"/>`
  // fingers under the palm, the lit one in its hand colour; a nail near each tip
  const fingers = FINGERS.map((f) => {
    const on = finger === f.n
    const nail = `<rect class="hg-nail" x="${f.cx - f.w * 0.3}" y="${f.base - f.len + 2.5}" width="${f.w * 0.6}" height="${Math.min(8, f.w * 0.48)}" rx="${f.w * 0.24}" transform="rotate(${f.rot} ${f.cx} ${f.base})"/>`
    return `<g class="hg-f${on ? ' on' : ''}">${fingerShape(f)}${nail}</g>`
  }).join('')
  // numbers stay upright and unmirrored: placed at the mirrored tip
  const labels = FINGERS.filter((f) => finger === 'all' || finger === f.n).map((f) => {
    const [x, y] = rot(f.cx, f.base - f.len + f.w * 0.5 + 12.5, f)
    return `<text class="hg-n${finger === f.n ? ' on' : ''}" x="${r1(left ? 120 - x : x)}" y="${r1(y)}">${f.n}</text>`
  }).join('')
  const flip = left ? ' transform="matrix(-1 0 0 1 120 0)"' : ''
  // where the palm covers the lit finger's root, its edge is drawn over the colour (clipped to that finger only)
  const lit = FINGERS.find((f) => f.n === finger)
  const id = 'hg-clip-' + (++clipId)
  const edge = lit ? `<clipPath id="${id}">${fingerShape(lit)}</clipPath><g class="hg-sil" clip-path="url(#${id})">${THENAR}<path d="${PALM}"/></g>` : ''
  return `<svg class="hg-hand-svg ${left ? 'left' : 'right'}" viewBox="0 -4 120 130" aria-hidden="true" focusable="false">` +
    `<g${flip}><g class="hg-sil">${shapes}</g>${fingers}${edge}<g class="hg-body">${THENAR}<path d="${PALM}"/></g></g>${labels}</svg>`
}
let clipId = 0

/**
 * A small keyboard from `start` for `count` keys. marks: Map pitch -> { kind: 'pulse'|'placed', hand, finger }.
 * Keys are buttons (data-pitch) so the on-screen keys can play the guide.
 */
export function miniKeysHtml(start, count, marks = new Map()) {
  const whites = []
  for (let p = start; p < start + count; p++) if (!isBlack(p)) whites.push(p)
  if (!whites.length) return ''
  const ww = 100 / whites.length, bw = ww * 0.62
  const key = (p, left, width, black) => {
    const m = marks.get(p)
    const cls = ['hg-key', black ? 'b' : 'w', m ? m.kind : '', m && m.hand ? m.hand : ''].filter(Boolean).join(' ')
    const label = m && m.kind === 'placed' && m.finger ? m.finger : !black && p % 12 === 0 ? 'C' : ''
    return `<button type="button" class="${cls}" data-pitch="${p}" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%" tabindex="-1" aria-hidden="true"><span>${label}</span></button>`
  }
  let html = '', wi = 0
  for (let p = start; p < start + count; p++) if (!isBlack(p)) html += key(p, wi++ * ww, ww, false)
  wi = 0
  for (let p = start; p < start + count; p++) {
    if (!isBlack(p)) { wi++; continue }
    if (wi === 0) continue   // a black key before the first white one has nowhere to sit
    html += key(p, wi * ww - bw / 2, bw, true)
  }
  return html
}

/**
 * view: { mode: 'intro'|'song', kicker, title, finger (1..5 | 0 | 'all'), hand, line, hint, tone ('', 'ok', 'warn'),
 *         keys: { start, count, marks } | null, next: label | null, skip: label | null }
 */
export function mountHandGuideView({ onSkip = () => {}, onNext = () => {}, onKey = () => {}, doc = globalThis.document } = {}) {
  let root = null, last = '', open = false, returnFocus = null
  function build() {
    root = doc.createElement('div')
    root.id = 'handGuide'
    root.className = 'hg hidden'
    root.innerHTML = '<section class="hg-card" role="dialog" aria-labelledby="hgTitle" aria-describedby="hgLine">' +
      '<div class="hg-top"><span class="hg-kicker"></span><button type="button" class="hg-skip">Skip</button></div>' +
      '<div class="hg-main"><div class="hg-finger" aria-hidden="true"><b></b><small>finger</small></div><div class="hg-hand"></div></div>' +
      '<h2 class="hg-title" id="hgTitle" tabindex="-1"></h2><p class="hg-line" id="hgLine"></p>' +
      '<p class="hg-hint" role="status" aria-live="polite"></p><div class="hg-keys"></div>' +
      '<button type="button" class="primary hg-next hidden"></button></section>'
    root.querySelector('.hg-skip').onclick = () => onSkip()
    root.querySelector('.hg-next').onclick = () => onNext()
    root.querySelector('.hg-keys').addEventListener('pointerdown', (e) => {
      const b = e.target.closest('[data-pitch]')
      if (!b) return
      e.preventDefault()
      onKey(Number(b.dataset.pitch))
    })
    doc.body.appendChild(root)
  }
  function show(view) {
    if (!root) build()
    const sig = JSON.stringify({ ...view, keys: view.keys ? { ...view.keys, marks: [...(view.keys.marks || new Map())] } : null })
    if (!open) { returnFocus = doc.activeElement; open = true }
    root.classList.remove('hidden')
    if (sig === last) return
    last = sig
    const intro = view.mode === 'intro'
    root.dataset.mode = intro ? 'intro' : 'song'
    root.querySelector('.hg-card').setAttribute('aria-modal', intro ? 'true' : 'false')
    root.querySelector('.hg-kicker').textContent = view.kicker || ''
    const finger = view.finger
    const f = root.querySelector('.hg-finger')
    f.classList.toggle('hidden', !(finger >= 1 && finger <= 5))
    f.dataset.hand = view.hand || 'right'
    f.querySelector('b').textContent = finger >= 1 && finger <= 5 ? String(finger) : ''
    root.querySelector('.hg-hand').innerHTML = finger === 0 || finger == null ? '' : handSvg(view.hand, finger)
    root.querySelector('.hg-main').classList.toggle('hidden', finger === 0 || finger == null)
    const title = root.querySelector('.hg-title')
    const newTitle = title.textContent !== (view.title || '')
    title.textContent = view.title || ''
    root.querySelector('.hg-line').textContent = view.line || ''
    const hint = root.querySelector('.hg-hint')
    hint.textContent = view.hint || ''
    hint.dataset.tone = view.tone || ''
    const keys = root.querySelector('.hg-keys')
    keys.classList.toggle('hidden', !view.keys)
    if (view.keys) keys.innerHTML = miniKeysHtml(view.keys.start, view.keys.count, view.keys.marks)
    const next = root.querySelector('.hg-next')
    next.classList.toggle('hidden', !view.next)
    if (view.next) next.textContent = view.next
    const skip = root.querySelector('.hg-skip')
    skip.classList.toggle('hidden', !view.skip)
    if (view.skip) skip.textContent = view.skip
    if (intro && newTitle) (view.next ? next : title).focus({ preventScroll: true })
  }
  function hide() {
    if (!root || !open) return
    open = false
    last = ''
    root.classList.add('hidden')
    const back = returnFocus
    returnFocus = null
    if (back && back.isConnected && back !== doc.body && typeof back.focus === 'function') back.focus({ preventScroll: true })
  }
  return { show, hide, isOpen: () => open, element: () => root }
}
