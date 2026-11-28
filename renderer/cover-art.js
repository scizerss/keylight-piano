// Generated song covers. A cover is drawn from the song itself: its first 16 notes as a light ribbon on ebony (right hand
// amber, left hand cobalt), placed by pitch (up is higher) and by time (left to right), over a faint 10% tonal wash taken
// from the composer's family colour and the key. Lesson art keeps its own bright gradient and ring motif.
// No pictures, no text, no canvas: one small inline SVG per cover, deterministic, memoised.
//
//   fingerprintOf(song)            -> the compact fingerprint (see below); cover-prints.js holds one per built-in song
//   coverArt(item, { size, ratio }) -> { bg, svg }  bg: CSS background for the .cover box, svg: markup for inside it
//   composerPalette(item)          -> the colours the cover uses (also handy for tests)
//
// fingerprint: { t: tempo bpm, k: key tonic 0-11, m: 1 if minor, n: note count, s: seconds,
//                o: up to 40 opening notes [pitch, start, length, hand] (start/length in quarter beats x4, hand 1 = left) }

const OPENING = 40
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const f1 = (v) => Math.round(v * 10) / 10

// ---- fingerprint -------------------------------------------------------------------------------------------
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
function guessKey(notes) {
  const h = new Array(12).fill(0)
  for (let i = 0; i < notes.length && i < 800; i++) h[((notes[i].pitch % 12) + 12) % 12] += Math.min(2, notes[i].dur || 0.25)
  const corr = (prof, r) => {
    let sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0
    for (let i = 0; i < 12; i++) { const x = h[(i + r) % 12], y = prof[i]; sx += x; sy += y; sxy += x * y; sxx += x * x; syy += y * y }
    const d = Math.sqrt((12 * sxx - sx * sx) * (12 * syy - sy * sy))
    return d ? (12 * sxy - sx * sy) / d : 0
  }
  let best = { r: 0, m: 0, c: -2 }
  for (let r = 0; r < 12; r++) for (const m of [0, 1]) { const c = corr(m ? MINOR : MAJOR, r); if (c > best.c) best = { r, m, c } }
  return best
}

export function fingerprintOf(song) {
  const all = ((song && song.notes) || []).filter((n) => n && Number.isFinite(n.pitch) && Number.isFinite(n.start))
  const tempo = clamp(Number(song && song.tempo) || 100, 30, 300)
  if (!all.length) return { t: Math.round(tempo), k: 0, m: 0, n: 0, s: 0, o: [] }
  // only the opening is needed: a partial selection of the earliest notes, not a sort of thousands
  let sorted = all
  for (let i = 1; i < all.length; i++) if (all[i].start < all[i - 1].start) { sorted = all.slice().sort((a, b) => a.start - b.start); break }
  const first = sorted.slice(0, OPENING)
  const t0 = first[0].start, q = tempo / 60 * 4
  const key = guessKey(sorted)
  let end = 0
  for (const n of sorted) end = Math.max(end, n.start + (n.dur || 0))
  return {
    t: Math.round(tempo), k: key.r, m: key.m, n: all.length, s: Math.round(song.duration || end),
    o: first.map((n) => [Math.round(n.pitch), Math.round((n.start - t0) * q), clamp(Math.round((n.dur || 0.25) * q), 1, 32), n.hand === 'left' ? 1 : 0])
  }
}

// ---- hashing ------------------------------------------------------------------------------------------------
function hashStr(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619)
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15
  return h >>> 0
}
function rng(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

// ---- palettes -----------------------------------------------------------------------------------------------
// one family per composer: [field top, field bottom, glow]. Dark and rich, so the mint accent and both hand colours sing on them.
const RH = '#ff8a3d', LH = '#86b6ff'
const FAMILIES = {
  chopin: ['#202a63', '#0b1033', '#5d6cff'],
  beethoven: ['#4a1626', '#1c0a12', '#e0506f'],
  mozart: ['#10403f', '#08201f', '#38c9b3'],
  bach: ['#473013', '#1d1508', '#e0a83a'],
  debussy: ['#0d3b52', '#06192a', '#43b7e6'],
  liszt: ['#391d57', '#170b29', '#b673ff'],
  schubert: ['#1e3d27', '#0c1c13', '#5fcf80'],
  schumann: ['#4a2040', '#1d0d1a', '#f07ab6'],
  brahms: ['#37331a', '#17150b', '#c7bd5c'],
  grieg: ['#27404a', '#0f1e26', '#86c3d6'],
  rachmaninoff: ['#2c3342', '#10131c', '#97a6e6'],
  tchaikovsky: ['#4a2517', '#1e0f0a', '#ff8f5e'],
  mendelssohn: ['#2f4217', '#14200a', '#b9e05a'],
  scriabin: ['#4a1240', '#1b0818', '#ff5cb8'],
  joplin: ['#4f1f12', '#200d09', '#f2b247'],
  traditional: ['#2a3550', '#0f1424', '#8fb0ee'],
  exercise: ['#26302c', '#0d1210', '#7cf0c6'],
  mine: ['#202a2b', '#0a1011', '#7cf0c6']      // imported songs: graphite with the app's mint, and a mint ring round the record
}
// composers without a family get one of these by hash (still dark and related)
const SPARE = ['#3a2f5a,#150f27,#a493ff', '#14414a,#071c22,#4cd0dc', '#4a2b1a,#1f120a,#f0a265', '#2e4a2a,#101e0e,#8fe07a', '#4a1f2f,#1f0b13,#ff7a9a', '#3a3a52,#14141f,#b7b7f0']
const ALIAS = { 'f. f. chopin': 'chopin', 'l. v. beethoven': 'beethoven', 'j. s. bach': 'bach', 'w. a. mozart': 'mozart', 'f. liszt': 'liszt', 'a. scriabin': 'scriabin', 'scott joplin': 'joplin' }

// The iPhone/iPad app has no mint (Illuminated Studio): the graphite families glow ivory there, everything else is unchanged.
const IVORY = '#f2efe8'
const studio = () => typeof document !== 'undefined' && !!document.documentElement && document.documentElement.classList.contains('ios')
export function composerPalette(item) {
  if (item && item.imported) return { key: 'mine', field: FAMILIES.mine.slice(0, 2), glow: studio() ? IVORY : FAMILIES.mine[2], rh: RH, lh: LH }
  const raw = String((item && (item.artist || item.composer)) || '').trim().toLowerCase()
  let key = ALIAS[raw] || raw.split(/[ ,.&]+/).filter(Boolean).pop() || ''
  let f = FAMILIES[key]
  if (!f && /^(traditional|folk|anon)/.test(raw)) { key = 'traditional'; f = FAMILIES.traditional }
  if (!f) {
    const sp = SPARE[hashStr(raw || String(item && item.title)) % SPARE.length].split(',')
    f = sp; key = 'spare-' + sp[2]
  }
  return { key, field: [f[0], f[1]], glow: studio() && f[2] === '#7cf0c6' ? IVORY : f[2], rh: RH, lh: LH }
}

// The two colours the Home light field takes from a song or lesson: its family glow, and the hand colour that leads
// (cobalt for a minor key, amber otherwise), so every piece lights the page a little differently.
export function ambientColors(item, fp = null) {
  // a lesson has no composer: it takes the two hand colours, cobalt left and amber right
  if (item && !item.imported && !item.artist && !item.composer) return { a: LH, b: RH }
  const pal = composerPalette(item)
  const print = fp || (item && item.fp) || (item && item.notes ? fingerprintOf(item) : null)
  return { a: pal.glow, b: print && print.m ? LH : RH }
}

// ---- drawing ------------------------------------------------------------------------------------------------
const EBONY = ['#111218', '#08090c']
const RIBBON_NOTES = 16
// per size: the bar thickness in viewBox units, and whether the soft light under the bars is drawn
const BARS = { thumb: { w: 6.4, glow: 0 }, card: { w: 3.8, glow: 1 }, hero: { w: 3.8, glow: 1 } }

// The ribbon: every note one rounded bar. x is time over the first 16 notes, y is pitch (the 4th to 96th percentile, at
// least an octave tall, so one stray note does not flatten the rest). Right-hand bars are drawn last so they sit on top.
function ribbon(fp, size, cols) {
  const cfg = BARS[size] || BARS.card
  const notes = fp.o.slice(0, RIBBON_NOTES)
  let out = ''
  if (cols.mine) out += `<path d="M7 3.5H93a3.5 3.5 0 0 1 3.5 3.5V93a3.5 3.5 0 0 1-3.5 3.5H7A3.5 3.5 0 0 1 3.5 93V7A3.5 3.5 0 0 1 7 3.5Z" fill="none" stroke="${studio() ? IVORY : '#7cf0c6'}" stroke-opacity=".55" stroke-width=".7"/>`
  if (!notes.length) {
    // nothing to draw yet: one resting line, so the cover still reads as a stave of light
    return out + `<path d="M11 50H89" stroke="#fff" stroke-opacity=".14" stroke-width="${cfg.w}" stroke-linecap="round" fill="none"/>`
  }
  const X0 = 11, XW = 78, Y_TOP = 24, Y_H = 52
  let span = 8
  for (const n of notes) span = Math.max(span, n[1] + n[2])
  const ps = notes.map((n) => n[0]).sort((a, b) => a - b)
  let lo = ps[Math.floor(ps.length * 0.04)], hi = ps[Math.ceil(ps.length * 0.96) - 1]
  if (hi - lo < 12) { const m = (hi + lo) / 2; lo = m - 6; hi = m + 6 }
  const hands = [[], []]
  for (const [p, s, d, h] of notes) {
    const x = X0 + (s / span) * XW
    const len = Math.max(0, Math.min(X0 + XW - x, (d / span) * XW))
    const y = Y_TOP + (1 - clamp((p - lo) / (hi - lo), 0, 1)) * Y_H
    hands[h ? 1 : 0].push(`M${f1(x)} ${f1(y)}h${f1(len)}`)
  }
  const layers = [[hands[1].join(''), cols.lh], [hands[0].join(''), cols.rh]].filter((l) => l[0])
  if (cfg.glow) out += `<g fill="none" stroke-linecap="round" stroke-width="${f1(cfg.w * 2)}" stroke-opacity=".09">${layers.map(([d, c]) => `<path d="${d}" stroke="${c}"/>`).join('')}</g>`
  out += `<g fill="none" stroke-linecap="round" stroke-width="${cfg.w}">${layers.map(([d, c]) => `<path d="${d}" stroke="${c}"/>`).join('')}</g>`
  return out
}

// Lesson art only. Rings: time winds around the centre, pitch is the distance from it. A note is an arc of its length at its
// pitch's ring, so the opening becomes a small woven spiral: a rising line opens outwards, a falling one closes in.
const SIZES = {
  thumb: { cap: 12, tracks: 5, glow: 0 },
  card: { cap: 30, tracks: 9, glow: 1 },
  hero: { cap: OPENING, tracks: 11, glow: 1 }
}

function arcPath(cx, cy, r, a0, a1) {
  const p = (a) => [cx + r * Math.sin(a), cy - r * Math.cos(a)]
  const [x0, y0] = p(a0), [x1, y1] = p(a1)
  return `M${f1(x0)} ${f1(y0)}A${f1(r)} ${f1(r)} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${f1(x1)} ${f1(y1)}`
}

function motif(fp, seed, size, W, H, cols) {
  const RH = cols.rh, LH = cols.lh
  const cfg = SIZES[size] || SIZES.card
  const rand = rng(seed)
  const cx = W / 2, cy = H / 2 - 1
  const R = Math.min(W, H) * 0.43, r0 = R * 0.26
  const K = cfg.tracks
  const gap = (R - r0) / (K - 1)
  const stroke = f1(gap * 0.56)
  const notes = fp.o.slice(0, cfg.cap)
  let out = ''
  if (cols.mine) out += `<circle cx="${cx}" cy="${f1(cy)}" r="${f1(R + gap * 0.95)}" fill="none" stroke="${studio() ? IVORY : '#7cf0c6'}" stroke-opacity=".7" stroke-width=".8"/>`
  // the record's tracks, very faint, so the notes sit on something
  for (let i = 0; i < K; i++) out += `<circle cx="${cx}" cy="${f1(cy)}" r="${f1(r0 + gap * i)}" fill="none" stroke="#fff" stroke-opacity="${size === 'thumb' ? 0.1 : 0.07}" stroke-width=".35"/>`
  if (notes.length < 4) {
    // too few notes to wind: the notes sit alone on the tracks
    notes.forEach((n, i) => {
      const a = rand() * 6.28, r = r0 + gap * (2 + ((i * 3 + (n[0] % 4)) % (K - 3)))
      out += `<path d="${arcPath(cx, cy, r, a, a + 0.9)}" fill="none" stroke="${n[3] ? LH : RH}" stroke-width="${stroke}" stroke-linecap="round"/>`
    })
    out += `<circle cx="${cx}" cy="${f1(cy)}" r="${f1(R * 0.07)}" fill="#fff" fill-opacity=".85"/>`
    return out
  }
  // pitch range by the 5th and 95th note, so one stray note does not squash the rest
  const ps = notes.map((n) => n[0]).sort((a, b) => a - b)
  let lo = ps[Math.floor(ps.length * 0.04)], hi = ps[Math.ceil(ps.length * 0.96) - 1]
  if (hi - lo < K) { const m = (hi + lo) / 2; lo = m - K / 2; hi = m + K / 2 }
  let span = 1
  for (const n of notes) span = Math.max(span, n[1] + n[2])
  // how far round the opening winds: sparse openings turn less so the shape stays open
  const turn = Math.PI * (notes.length < 12 ? 1.5 : 1.88)
  const a0 = rand() * Math.PI * 2
  const rev = rand() < 0.5 ? -1 : 1
  const ang = (t) => a0 + rev * (t / span) * turn
  const track = (p) => Math.round(clamp((p - lo) / (hi - lo), 0, 1) * (K - 1))
  const order = notes.map((n, i) => i).sort((a, b) => (notes[b][3] - notes[a][3]) || (notes[b][2] - notes[a][2]))   // right hand and short notes on top
  const arcs = []
  for (const i of order) {
    const [p, s, d, h] = notes[i]
    const a = ang(s), e = ang(s + Math.max(d, 1) * 0.92)
    let A0 = Math.min(a, e), A1 = Math.max(a, e)
    if (A1 - A0 < 0.2) A1 = A0 + 0.2
    arcs.push([arcPath(cx, cy, r0 + gap * track(p), A0, A1), h])
  }
  if (cfg.glow) out += `<g fill="none" stroke-linecap="round" stroke-width="${f1(gap * 1.5)}" stroke-opacity=".16">${arcs.map(([d, h]) => `<path d="${d}" stroke="${h ? LH : RH}"/>`).join('')}</g>`
  out += `<g fill="none" stroke-linecap="round" stroke-width="${stroke}">${arcs.map(([d, h]) => `<path d="${d}" stroke="${h ? LH : RH}"/>`).join('')}</g>`
  out += `<circle cx="${cx}" cy="${f1(cy)}" r="${f1(R * 0.06)}" fill="#fff" fill-opacity=".9"/>`
  return out
}

// Everything a cover's picture depends on, as one short string: the cover cache keys on it, and the library tiles use it
// to know when a tile is stale (an edit that keeps the note count still changes it).
export function coverSignature(item, fp = null) {
  // the fingerprint is what the drawing uses (opening notes, tempo, the key inferred from the whole song), so it is the signature
  const src = fp || (item && item.fp) || (item && item.notes ? fingerprintOf(item) : null)
  const sig = src ? src.t + ',' + src.k + ',' + src.m + ',' + src.n + ';' + src.o.join(';') : ''
  return `${item && item.imported ? 'm' : ''}|${item && item.title}|${item && (item.artist || item.composer)}|${hashStr(sig)}.${sig.length}`
}

const memo = new Map()
// size: thumb (<= ~64px) | card | hero; ratio: width / height of the box the cover fills (1 = square)
export function coverArt(item, { size = 'card', fp = null, lesson = false, hero = false } = {}) {
  const id = String((item && (item.id || item.file || item.title)) || '')
  const key = `${id}|${size}|${lesson ? 'l' : ''}${hero ? 'h' : ''}|${coverSignature(item, fp)}`
  const hit = memo.get(key)
  if (hit) return hit
  const pal = composerPalette(item)
  const print = fp || (item && item.fp) || fingerprintOf(item)
  const seed = hashStr(id + '|' + (item && item.title))
  const [a] = pal.field
  // The tonal wash: the composer family's glow at 10% over ebony; the tonic nudges where the light falls, a minor key lets it sit lower.
  // A lesson's art is a bright gradient with a white motif, so it never passes for a song's dark cover.
  const gx = 38 + ((print.k * 7) % 12) * 2 + (print.m ? 6 : 0)
  const bg = lesson
    ? `linear-gradient(135deg, ${pal.glow}, ${a})`
    : `radial-gradient(ellipse 85% 75% at ${gx}% ${print.m ? 58 : 42}%, ${pal.glow}1a, transparent 72%), linear-gradient(180deg, ${EBONY[0]}, ${EBONY[1]})`
  // hero: the home card is wide on a Mac or iPad and tall on a phone, its words low and left, so the art sits top right
  const fit = hero ? 'xMaxYMin meet' : 'xMidYMid meet'
  const inner = lesson
    ? motif(print, seed, size, 100, 100, { rh: '#ffffff', lh: 'rgba(255,255,255,.62)' })
    : ribbon(print, size, { rh: RH, lh: LH, mine: pal.key === 'mine' })
  const svg = `<svg class="c-art" viewBox="0 0 100 100" preserveAspectRatio="${fit}" aria-hidden="true" focusable="false">${inner}</svg>`
  const res = { bg, svg }
  if (memo.size > 600) memo.clear()
  memo.set(key, res)
  return res
}
