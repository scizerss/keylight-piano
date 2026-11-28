// Wave 2 App-A (plan P6 covers, P8 TV screen): node scripts/test-covers-tv-v3.js
// Covers are a ribbon of the song's first 16 notes over a 10% tonal wash; the TV page and html.ios score "Perfect" in ivory,
// never teal; the TV has a score bump, an end-of-song bloom and a serif idle title, all still under reduced motion.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const root = path.join(__dirname, '..')
const read = (f) => fs.readFileSync(path.join(root, 'renderer', f), 'utf8')

;(async () => {
  const art = await import(pathToFileURL(path.join(root, 'renderer/cover-art.js')).href)
  const views = await import(pathToFileURL(path.join(root, 'renderer/views.js')).href)
  const { coverArt } = art

  // ---- P6: covers come from the song's own notes
  const mk = (pitches, hands = []) => pitches.map((pitch, i) => ({ pitch, start: i * 0.5, dur: 0.4, hand: hands[i] || 'right' }))
  const songA = { id: 'a', title: 'Ode', artist: 'Beethoven', tempo: 100, notes: mk([64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 64, 62, 62, 64, 66, 68], [0, 0, 0, 0, 0, 0, 0, 0, 'left', 'left'].map((h) => h || 'right')) }
  const songB = { id: 'b', title: 'Study', artist: 'Beethoven', tempo: 100, notes: mk([48, 52, 55, 60, 55, 52, 48, 43, 48, 52, 55, 60, 64, 67, 72, 76]) }
  const a1 = coverArt(songA), a2 = coverArt({ ...songA, notes: songA.notes.map((n) => ({ ...n })) }), b1 = coverArt(songB)
  assert.deepEqual(a1, a2, 'the same song makes the same cover')
  assert.notEqual(a1.svg, b1.svg, 'two different songs make different covers')

  const crisp = (svg) => svg.match(/<g fill="none" stroke-linecap="round" stroke-width="3\.8">(.*?)<\/g>/)[1]
  const bars = (svg) => (crisp(svg).match(/M[\d.]+ [\d.]+h/g) || []).length
  assert.equal(bars(a1.svg), 16, 'only the first 16 of 18 notes are drawn')
  assert.equal(bars(coverArt({ ...songA, id: 'short', notes: songA.notes.slice(0, 5) }).svg), 5, 'a short song draws what it has')
  assert.ok(a1.svg.includes('#ff8a3d') && a1.svg.includes('#86b6ff'), 'amber for the right hand, cobalt for the left')
  assert.ok(!/<path d="M[^"]*A[\d.]+ [\d.]+ 0 [01] 1/.test(a1.svg.replace(/<path d="M7 3\.5[^>]*>/, '')), 'no arcs: the ring generator is gone from songs')
  // up is higher, left to right is time: a rising line has its first bar lower than its last
  const rise = coverArt({ id: 'rise', title: 'Rise', artist: 'Bach', tempo: 100, notes: mk([48, 50, 52, 54, 56, 58, 60, 62, 64, 66, 68, 70, 72, 74, 76, 78]) })
  const ys = [...crisp(rise.svg).matchAll(/M([\d.]+) ([\d.]+)h/g)].map((m) => [+m[1], +m[2]])
  assert.ok(ys[0][0] < ys[15][0] && ys[0][1] > ys[15][1], 'a rising melody climbs to the right')
  // the wash: the composer's colour at 10% (alpha 1a) over ebony
  assert.match(a1.bg, /rgba?\(|#[0-9a-f]{6}1a/i)
  assert.ok(/1a,? transparent/.test(a1.bg) && /#111218/.test(a1.bg), 'a 10% wash over ebony')
  assert.notEqual(coverArt({ ...songA, artist: 'Joplin' }).bg, a1.bg, 'the wash follows the composer')
  const minor = coverArt({ id: 'm', title: 'M', artist: 'Chopin', tempo: 90, notes: mk([57, 60, 64, 60, 57, 60, 64, 69, 68, 64, 60, 56, 57, 60, 64, 60]) })
  assert.ok(/at \d+% 58%/.test(minor.bg) || /at \d+% 42%/.test(minor.bg), 'the key sets where the wash sits')
  assert.ok(!/<(text|image|script|foreignObject)\b/i.test(a1.svg + b1.svg), 'no text or pictures')
  // lessons keep their own bright art
  assert.notEqual(coverArt(songA, { lesson: true }).bg, a1.bg)

  // ---- P8: scoringColor is ivory on the TV page and under html.ios, desktop unchanged
  const desktop = views.scoringColor('perfect')
  assert.match(desktop, /^#a3ffeb$/i, 'desktop keeps its own Perfect colour')
  const withDoc = (doc, fn) => { globalThis.document = doc; try { return fn() } finally { delete globalThis.document } }
  const ios = withDoc({ documentElement: { classList: { contains: (c) => c === 'ios' } } }, () => views.scoringColor('perfect'))
  const tv = withDoc({ documentElement: { classList: { contains: () => false } }, getElementById: (id) => (id === 'tvRoot' ? {} : null) }, () => views.scoringColor('perfect'))
  const plain = withDoc({ documentElement: { classList: { contains: () => false } }, getElementById: () => null }, () => views.scoringColor('perfect'))
  assert.equal(ios, tv, 'iOS and the TV page share one Perfect colour')
  assert.equal(plain, desktop, 'a plain desktop page is unchanged')
  const hex = ios.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
  assert.ok(r >= 240 && g >= 225 && b >= 190 && r >= g && g >= b, `ivory with a trace of amber, got ${ios}`)
  assert.ok(!(g > r && b > r), 'not teal')
  withDoc({ documentElement: { classList: { contains: (c) => c === 'ios' } } }, () => {
    for (const k of ['good', 'early', 'late', 'missed']) assert.equal(views.scoringColor(k), views.scoringColor(k), k)
    assert.notEqual(views.scoringColor('good'), ios, 'only Perfect changes')
  })

  // ---- P8: the TV page
  const html = read('tv.html'), css = read('tv.css'), js = read('tv.js'), vw = read('views.js')
  for (const f of [html, css, js]) assert.ok(!/a3ffeb|7cf0c6|124, ?240, ?198|#2fc3a0/i.test(f), 'no teal or mint on the TV page')
  for (const f of [html, css, js]) assert.ok(!/[–—]/.test(f), 'no en or em dashes')
  assert.match(js, /glow: 1\.7/, 'the TV asks views.js for the stronger key glow')
  assert.match(vw, /glowGain/, 'views.js throws more light up the lane when asked')
  assert.match(vw, /fb && glowGain > 1/, 'a hit flares at its key')
  // score bump 180ms, reduced motion has none
  assert.match(css, /\.tv-acc\.bump \{ animation: tv-bump 180ms/)
  assert.match(js, /function bump\(node\)/)
  assert.match(js, /prefers-reduced-motion: reduce/)
  assert.match(js, /reduceMotion && reduceMotion\.matches\) return/, 'no bump under reduced motion')
  const rm = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
  assert.match(rm, /\.tv-acc\.bump,\s*\.tv-bloom i \{ animation: none; \}/, 'no bump or bloom animation under reduced motion')
  assert.match(css, /\.tv-bloom i \{[^}]*opacity: 0\.28;[^}]*animation: tv-bloom/, 'the bloom settles at 0.28')
  assert.match(css, /@keyframes tv-bloom \{\s*from \{ opacity: 0; \}\s*to \{ opacity: 0\.28; \}/, 'opacity only')
  assert.match(html, /<section class="tv-screen tv-results">\s*<div class="tv-bloom"/, 'the bloom sits behind the results')
  assert.ok(!/@keyframes[^{]*\{[^@]*(width|height|left|top|filter|box-shadow)\s*:/.test(css), 'keyframes move opacity and transform only')
  // idle: ambient key glow, current song in New York
  assert.match(html, /class="tv-ambient"/)
  assert.match(css, /\.tv-card-title \{[^}]*font-family: var\(--serif\)/s, 'the idle song title is serif')
  assert.match(js, /root\.dataset\.song/, 'idle knows when a song is waiting')
  console.log('covers + tv v3: ok')
})().catch((e) => { console.error('covers + tv v3 FAIL:', e); process.exit(1) })
