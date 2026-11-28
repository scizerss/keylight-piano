// Coordinate maths and hit testing for the piano roll (pure, no DOM). The viewport maps seconds to
// x and pitches to y; `keysW` is the width of the piano-key gutter on the left, `top` the height of
// anything above the roll area (the ruler). All pixel values are CSS pixels.
export const MIN_PITCH = 21, MAX_PITCH = 108          // the 88 keys shown (notes outside still draw)

export class Viewport {
  constructor({ width = 800, height = 400, keysW = 44, top = 0, pxPerSec = 120, pxPerSemi = 18 } = {}) {
    this.width = width; this.height = height; this.keysW = keysW; this.top = top
    this.pxPerSec = pxPerSec; this.pxPerSemi = pxPerSemi
    this.padBottom = 0            // px at the bottom a floating toolbar covers: the keyboard can scroll up past it
    this.t0 = 0                   // time at the left edge of the roll area (just right of the gutter)
    this.pTop = 84                // pitch (may be fractional) at the top edge of the roll area
    this.limits = { minPxPerSec: 8, maxPxPerSec: 1200, minPxPerSemi: 8, maxPxPerSemi: 60, maxTime: 30, hardMax: 4 * 60 * 60 }   // maxTime follows the song's end; hardMax is the editor's longest song
  }
  get rollW() { return Math.max(1, this.width - this.keysW) }
  get rollH() { return Math.max(1, this.height - this.top) }
  timeToX(t) { return this.keysW + (t - this.t0) * this.pxPerSec }
  xToTime(x) { return this.t0 + (x - this.keysW) / this.pxPerSec }
  // y of the TOP edge of pitch p's row
  pitchToY(p) { return this.top + (this.pTop - p - 0.5) * this.pxPerSemi }
  yToPitch(y) { return Math.round(this.pTop - (y - this.top) / this.pxPerSemi) }
  get t1() { return this.t0 + this.rollW / this.pxPerSec }
  get pBottom() { return this.pTop - this.rollH / this.pxPerSemi }
  visibleTime() { return [this.t0, this.t1] }
  visiblePitches() { return [Math.max(0, Math.floor(this.pBottom)), Math.min(127, Math.ceil(this.pTop))] }
  clampScroll() {
    const L = this.limits
    // scroll up to one screenful past the end of the music (room to add more), never past the longest song
    const span = this.rollW / this.pxPerSec
    this.t0 = Math.min(Math.max(-0.5, this.t0), Math.max(0, Math.min(L.hardMax, L.maxTime + span) - span * 0.25))
    const vspan = this.rollH / this.pxPerSemi
    const hi = MAX_PITCH + 3, lo = MIN_PITCH - 3 - this.padBottom / this.pxPerSemi
    if (vspan >= hi - lo) this.pTop = lo + vspan          // whole keyboard fits: pin to the bottom
    else this.pTop = Math.min(hi, Math.max(lo + vspan, this.pTop))
  }
  setSize(width, height) { this.width = width; this.height = height; this.clampScroll() }
  setMaxTime(t) { this.limits.maxTime = Math.max(10, t + 8); this.clampScroll() }
  panBy(dx, dy) { this.t0 -= dx / this.pxPerSec; this.pTop += dy / this.pxPerSemi; this.clampScroll() }
  // zoom around the screen point (ax, ay): the time and pitch under it stay put
  zoomAt(ax, ay, fx, fy = 1) {
    const L = this.limits
    const t = this.xToTime(ax), p = this.pTop - (ay - this.top) / this.pxPerSemi
    this.pxPerSec = Math.min(L.maxPxPerSec, Math.max(L.minPxPerSec, this.pxPerSec * fx))
    this.pxPerSemi = Math.min(L.maxPxPerSemi, Math.max(L.minPxPerSemi, this.pxPerSemi * fy))
    this.t0 = t - (ax - this.keysW) / this.pxPerSec
    this.pTop = p + (ay - this.top) / this.pxPerSemi
    this.clampScroll()
  }
  // scroll horizontally so time `t` is visible with a margin (used by the playhead follow)
  reveal(t, marginFrac = 0.2) {
    const w = this.rollW / this.pxPerSec
    if (t < this.t0 || t > this.t0 + w * (1 - marginFrac)) { this.t0 = t - w * marginFrac; this.clampScroll() }
  }
  // fit the notes in view
  fit(notes) {
    if (!notes.length) return
    let t1 = 0, lo = 127, hi = 0
    for (const n of notes) { t1 = Math.max(t1, n.start + n.dur); lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch) }
    this.t0 = 0
    this.pxPerSec = Math.min(this.limits.maxPxPerSec, Math.max(this.limits.minPxPerSec, this.rollW / Math.max(4, Math.min(t1, 12))))
    const span = Math.max(24, hi - lo + 6), usable = Math.max(40, this.rollH - this.padBottom)
    this.pxPerSemi = Math.min(this.limits.maxPxPerSemi, Math.max(this.limits.minPxPerSemi, usable / span))
    this.pTop = (hi + lo) / 2 + usable / this.pxPerSemi / 2
    this.clampScroll()
  }
}

// index of the first note whose start is >= t (notes sorted by start)
export function lowerBound(notes, t) {
  let lo = 0, hi = notes.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (notes[mid].start < t) lo = mid + 1; else hi = mid }
  return lo
}
// notes that touch [t0, t1] and pitch rows [p0, p1]: only these get drawn or tested.
// `maxDur` = longest note in the song (so a long note that began off-screen is still found).
export function visibleNotes(notes, t0, t1, p0, p1, maxDur) {
  const out = []
  for (let i = lowerBound(notes, t0 - maxDur); i < notes.length; i++) {
    const n = notes[i]
    if (n.start > t1) break
    if (n.start + n.dur >= t0 && n.pitch >= p0 && n.pitch <= p1) out.push(n)
  }
  return out
}
export const longest = (notes) => notes.reduce((m, n) => Math.max(m, n.dur), 0)

// Rectangle of a note in screen pixels: { x, y, w, h }; h shrinks by a pixel gap between rows
export function noteRect(vp, n) {
  const x = vp.timeToX(n.start)
  return { x, y: vp.pitchToY(n.pitch) + 1, w: Math.max(3, n.dur * vp.pxPerSec), h: Math.max(3, vp.pxPerSemi - 2) }
}

// Hit test at screen (x, y). Returns { key, zone: 'body' | 'end', note } or null.
// `slop` grows the target (finger size): a note shorter than the touch size is still hittable.
// Selected notes get a resize handle past their right edge (`handle` px wide each side of the edge).
export function hitTest(vp, notes, x, y, { slop = 0, handle = 10, selected = null, maxDur = 10 } = {}) {
  if (x < vp.keysW || y < vp.top) return null
  const reach = slop + Math.max(handle, 16)
  const cand = visibleNotes(notes, vp.xToTime(x - reach), vp.xToTime(x + reach), vp.yToPitch(y + reach + vp.pxPerSemi), vp.yToPitch(y - reach - vp.pxPerSemi), maxDur)
  let best = null, bestScore = Infinity
  for (const n of cand) {
    const r = noteRect(vp, n)
    const isSel = !!selected && selected.has(n.key)
    const cy = r.y + r.h / 2
    // right-edge handle: a selected note's grabs from either side of the edge (finger sized);
    // other notes only from inside their last stretch
    const reach = isSel ? Math.max(handle, 16) + slop * 0.5 : handle
    const inner = Math.min(reach, r.w * 0.4), outer = isSel ? reach : 0   // inside only the last stretch, so a short note can still be dragged by its body
    const edge = r.x + r.w
    const yOk = Math.abs(y - cy) <= Math.max(r.h / 2, isSel ? Math.max(slop, 14) : 0)
    if (yOk && x >= edge - inner && x <= edge + outer) {
      const score = Math.abs(x - edge) * 0.25
      if (score < bestScore) { best = { key: n.key, zone: 'end', note: n }; bestScore = score }
      continue
    }
    const dx = x < r.x ? r.x - x : x > edge ? x - edge : 0
    const dy = y < r.y ? r.y - y : y > r.y + r.h ? y - (r.y + r.h) : 0
    if (dx > slop || dy > slop) continue
    const score = 10 + dx + dy                                   // inside beats near; edge handles beat both
    if (score < bestScore || (score === bestScore && best && n.start >= best.note.start)) { best = { key: n.key, zone: 'body', note: n }; bestScore = score }
  }
  return best
}

// keys of notes whose rectangle intersects the screen rectangle (box select, erase sweep)
export function notesInRect(vp, notes, x0, y0, x1, y1, maxDur = 10) {
  const xa = Math.min(x0, x1), xb = Math.max(x0, x1), ya = Math.min(y0, y1), yb = Math.max(y0, y1)
  const cand = visibleNotes(notes, vp.xToTime(xa), vp.xToTime(xb), vp.yToPitch(yb), vp.yToPitch(ya), maxDur)
  return cand.filter((n) => {
    const r = noteRect(vp, n)
    return r.x < xb && r.x + r.w > xa && r.y < yb && r.y + r.h > ya
  })
}

// Pinch: scale factors per axis from two touch points before and after. An axis whose two points
// are close together (< 40 px apart) follows the overall spread instead, so the zoom stays stable.
export function pinchFactors(a0, b0, a1, b1) {
  const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y), d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y)
  const all = d0 > 1 ? d1 / d0 : 1
  const ax0 = Math.abs(b0.x - a0.x), ax1 = Math.abs(b1.x - a1.x), ay0 = Math.abs(b0.y - a0.y), ay1 = Math.abs(b1.y - a1.y)
  return { fx: ax0 >= 40 ? ax1 / ax0 : all, fy: ay0 >= 40 ? ay1 / ay0 : all }
}
