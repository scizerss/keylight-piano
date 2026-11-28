// Illuminated Studio (docs/DESIGN-ILLUMINATED-STUDIO.md) on iPhone/iPad: no mint, the palette tokens, three stars from the saved 0 to 5,
// iOS-only copy helpers, the key-light bar, and the motion rules in ios.css. Run: node scripts/test-ios-studio.js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')
const root = path.join(__dirname, '..', 'renderer')
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')

// the engine against a stub canvas and rAF: no DOM needed
async function runEngine() {
  let clears = 0
  const ctx = new Proxy({}, { get: (t, k) => (k === 'createLinearGradient' ? () => ({ addColorStop() {} }) : k === 'clearRect' ? () => { clears++ } : typeof k === 'string' ? (() => {}) : undefined), set: () => true })
  const mkCanvas = (w, h) => ({ width: w, height: h, clientWidth: w, clientHeight: h, getContext: () => ctx })
  globalThis.document = { createElement: () => mkCanvas(64, 256) }
  globalThis.devicePixelRatio = 3
  let queued = []                      // every rAF asked for since the last reset (a count the sections below read)
  let nextId = 0
  const pending = new Set()            // rAF ids that are queued and not cancelled: the loops that really run
  globalThis.requestAnimationFrame = (f) => { queued.push(f); pending.add(++nextId); return nextId }
  globalThis.cancelAnimationFrame = (id) => { pending.delete(id) }
  const { createKeyLight } = await import(pathToFileURL(path.join(root, 'key-light-engine.js')).href)
  const out = {}
  const r8 = createKeyLight(mkCanvas(400, 300), { whites: 8, baseH: 64 })
  out.whites8 = r8.keys.filter((k) => k.kind === 'w').length; out.keys8 = r8.keyCount
  out.keyAtFirst = r8.keyAt(2).i; out.keyAtLast = r8.keyAt(398).w === 7 ? 12 : -1; out.keyAtOutside = r8.keyAt(-5)
  const blk = r8.keyAt(r8.keys.find((k) => k.kind === 'b').mid, 300 - 64 + 10)
  out.blackAt = blk ? blk.i : -1; out.blackKind = blk && blk.kind
  out.handLeft = r8.keys[0].cx < .5 ? 'l' : 'r'; out.handRight = r8.keys[r8.keys.length - 1].cx < .5 ? 'l' : 'r'
  out.keys15 = createKeyLight(mkCanvas(800, 300), { whites: 15, baseH: 84 }).keyCount
  queued = []
  const calm = createKeyLight(mkCanvas(400, 300), { whites: 8, baseH: 64, calm: () => true })
  out.stillSweepMs = calm.sweep(); calm.light(2); out.calmFrames = queued.length
  queued = []
  const live = createKeyLight(mkCanvas(400, 300), { whites: 8, baseH: 64 })
  out.sweepMs = live.sweep(); out.activeFrames = queued.length
  // a refresh that sees a resized box under a running loop repaints once and never starts a second loop
  live.destroy(); calm.destroy(); r8.destroy()                // their loops end here, so only the busy rail's frames are pending below
  const box = mkCanvas(400, 300)
  const busy = createKeyLight(box, { whites: 8, baseH: 64 })
  busy.light(2)
  out.loopsAfterOne = pending.size
  const clearsBefore = clears
  box.clientWidth = 420; busy.refresh()
  out.loops = pending.size - out.loopsAfterOne
  out.repaints = clears - clearsBefore
  out.backingWidth = box.width
  busy.destroy()
  delete globalThis.document; delete globalThis.devicePixelRatio; delete globalThis.requestAnimationFrame; delete globalThis.cancelAnimationFrame
  return out
}

;(async () => {
  const css = read('ios.css')
  const block = css.slice(css.indexOf('html.ios {'), css.indexOf('\n}', css.indexOf('html.ios {')))
  const tok = (name) => (block.match(new RegExp('--' + name + ':\\s*([^;]+);')) || [])[1]
  // palette
  assert.equal(tok('ebony'), '#0a0b0f'); assert.equal(tok('chassis'), '#14161d'); assert.equal(tok('raised'), '#1e212b'); assert.equal(tok('ivory'), '#f2efe8')
  assert.equal(tok('accent'), 'var(--ivory)', 'the accent is ivory, not mint')
  assert.equal(tok('ok'), '#3ec982'); assert.equal(tok('felt'), '#d94f57')
  assert.ok(!/7cf0c6|124, ?240, ?198/i.test(css), 'ios.css has no mint literal')
  // the sheen, the grain and the ambient light field
  assert.match(css, /linear-gradient\(180deg, #101219 0%, #0a0b0f 48%, #07080b 100%\)/)
  assert.match(css, /radial-gradient\(120% 38% at 50% -10%, rgba\(242, 239, 232, \.055\), rgba\(242, 239, 232, \.015\) 45%, transparent 72%\)/)
  assert.match(css, /--key-grain: url\("data:image\/png;base64,/)
  assert.match(css, /html\.ios #ambient \{[^}]*height: 62vh/, 'Home has one fixed light field')
  assert.ok(!/mix-blend-mode/.test(css), 'no blend modes'); assert.ok(!/filter:\s*blur\(/.test(css), 'no CSS filter blur')
  assert.ok(!/[–—]/.test(css), 'no en or em dashes in ios.css')
  // lit keys use the hand colours, never mint
  // v3 P7: the lesson and exercise keys are studio ivory and bevelled ebony; a target key is lit by an amber glow overlay at its front edge (never a flat mint, orange or navy slab)
  assert.match(css, /html\.ios \.dk-w \{ fill: #E8E3D9;/, 'white lesson keys are studio ivory')
  assert.match(css, /html\.ios \.dk-b \{ fill: url\(#klEbony\);/, 'black lesson keys are bevelled ebony')
  assert.match(css, /:is\(\.dk-w\.hl, \.dk-w\.ex-key\.lit, \.dk-w\.ex-key\.down\) \+ \.dk-glow,[\s\S]*?\{ opacity: 1; \}/, 'a lit key turns its glow overlay on')
  const defs = read('index.html')
  assert.match(defs, /id="klGlowW"[^>]*>\s*<stop offset="0" stop-color="#ff8a3d"/); assert.match(defs, /id="klGlowB"[^>]*>\s*<stop offset="0" stop-color="#ff8a3d"/)
  assert.ok(!/7cf0c6/i.test(defs.slice(defs.indexOf('id="klEbony"'), defs.indexOf('id="klGlowBadW"'))), 'the key gradients have no mint')
  // motion (v2): sheets 340ms / 220ms, press 90ms, flick-to-close; no stacked screen animations, no loops
  assert.match(css, /--sheet-in: 340ms cubic-bezier\(\.32, \.72, 0, 1\)/); assert.match(css, /--sheet-out: 220ms cubic-bezier\(\.4, 0, 1, 1\)/)
  assert.match(css, /--press: 90ms cubic-bezier\(\.2, 0, 0, 1\)/)
  assert.match(read('sheet-drag.js'), /const FLICK = 0\.45/)
  assert.ok(!/ios-drift|ios-key-light|\.key-light\.sweep|ios-screen-in/.test(css), 'the v1 drift loop, key-light bar and screen-in are gone')
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(!/@property/.test(code), 'no @property gradient repaint')
  assert.ok(!/animation:[^;]*infinite/.test(code), 'nothing in ios.css loops')
  assert.match(code, /\.cr-level\.cur \.cr-node::before \{[^}]*animation: cr-bloom 600ms cubic-bezier\(\.22, 1, \.36, 1\) both;/, 'v3 P4: the next course node blooms once for 600ms, then holds a steady amber halo')
  assert.ok(!fs.existsSync(path.join(root, 'key-light.js')), 'renderer/key-light.js is deleted')
  assert.match(css, /#ambient i \{[^}]*transition: opacity 500ms cubic-bezier\(\.22, 1, \.36, 1\)/, 'the ambient crossfade is opacity, 500ms')
  assert.match(css, /html\.ios #results\.playing \.rstar\.on \{ animation: ios-star-in 220ms cubic-bezier\(\.34, 1\.56, \.64, 1\) calc\(200ms \+ var\(--d, 0ms\)\)/)
  assert.match(css, /html\.ios #results::after \{[^}]*transition: opacity 600ms/, 'Results warms to its tone over 600ms')
  assert.match(css, /#onboarding\.intro \.ob-keys i::before \{ animation: ob-run 360ms/); assert.match(css, /#onboarding \.ob-rain \{ display: none; \}/)
  assert.match(css, /--rail-h: 64px/); assert.match(css, /--rail-h: 84px/); assert.match(css, /--rail-h: 56px/)
  assert.match(css, /touch-action: pan-y/, 'the rail strip scrolls vertically')

  // the shared key-light engine: one source, a copy for the website, no blur, no idle loop
  const sync = require('./sync-key-light-engine.js')
  assert.ok(sync.inSync(), 'site-next/key-light-engine.js is the same file as renderer/key-light-engine.js (node scripts/sync-key-light-engine.js)')
  const eng = read('key-light-engine.js')
  assert.ok(!/shadowBlur/.test(eng.replace(/\/\/.*$/gm, '')), 'no ctx.shadowBlur in the engine')
  assert.ok(!/filter\s*=|blur\(/.test(eng.replace(/\/\/.*$/gm, '')), 'no filter blur in the engine')
  assert.match(eng, /Math\.min\(globalThis\.devicePixelRatio \|\| 1, o\.maxDpr\)/); assert.match(eng, /maxDpr: 2/)
  assert.match(eng, /now - last < 600/, 'the loop sleeps 600ms after the last input')
  assert.match(eng, /ms = opt\.ms \?\? 480, step = opt\.stagger \?\? 14/, 'one sweep: 480ms, 14ms stagger')
  const rails = read('home-light.js')
  assert.match(rails, /SLOP = 8/); assert.match(rails, /TICK_FLOOR = 60/); assert.match(rails, /haptic\('select'/)
  assert.match(rails, /deps\.soundOn && deps\.soundOn\(\)/, 'a tap sounds a note only when the app sound is on')
  assert.match(rails, /w >= 600 \? 15 : 8/, 'one octave on a phone, two on an iPad')
  assert.match(rails, /Math\.max\(0, 16 - rect\.left, 16 - \(innerWidth - rect\.right\)\)/, 'the rail keeps 16px from each screen edge')
  assert.match(eng, /if \(p\.rel != null\) \{ if \(now - p\.rel > 1600\) plumes\.splice\(i, 1\) \}/, 'a released key decays 1.6s from its release, however long it was held')
  assert.match(rails, /if \(ptr \|\| /, 'a second finger does not take over the rail touch'); assert.match(rails, /setPointerCapture/); assert.match(rails, /Math\.abs\(x - was\.x0\) < SLOP/)
  assert.match(rails, /releaseAll/, 'the rail lets go of held keys when the keyboard goes away'); assert.match(rails, /document\.removeEventListener\('visibilitychange'/, 'destroy removes its listeners')
  assert.match(read('app.js'), /isHome: \(\) => screen === 'home' && !setup\.open/, 'the rail is idle behind the setup and dialogs')
  assert.match(rails, /launching = false\n\s+if \(swept \|\| document\.hidden \|\| !onHome\(\)\) return[^\n]*\n\s+swept = true/, 'the launch sweep is used up only when it really runs')
  assert.match(rails, /addEventListener\('pointerup', end\)/, 'a touch released outside the strip still ends'); assert.match(rails, /addEventListener\('close', onDialogClose, true\)/)
  const refreshBody = eng.slice(eng.indexOf('function refresh()'), eng.indexOf('function clear()'))
  assert.match(refreshBody, /if \(!frame && \(plumes\.length > 0 \|\| held\.size > 0\)\) frame = requestAnimationFrame\(tick\)/, 'refresh keeps decaying plumes moving, never in a second loop')
  assert.match(read('app.js'), /i < mid \? 'mk-l' : 'mk-r'/, 'the onboarding mark is cobalt, cobalt, amber for any key count')
  assert.match(eng, /let frame = 0, last = -Infinity/, 'a fresh rail has no idle tail'); assert.match(eng, /a reshape never starts an idle loop/)
  assert.match(rails, /if \(!w\) return/, 'a hidden Home is not reshaped to 0px'); assert.match(read('app.js'), /homeLight\?\.resume\(\)/)
  assert.match(eng, /entries\[entries\.length - 1\]\.isIntersecting/, 'the newest intersection entry wins'); assert.match(eng, /display: none: keep the canvas/)
  assert.match(rails, /e\.target\.tagName === 'DIALOG'\) setTimeout\(resume, 0\)/); assert.match(read('app.js'), /closeSetup\(\{ resume: false \}\)/); assert.match(read('app.js'), /!handGuideRun && !tourIsOpen\(\)/)
  assert.match(rails, /else \{ rail\.refresh\(\); launch\(\) \}/, 'a hidden start still gets its launch sweep when the app returns')
  const rm = read('results-motion.js')
  assert.match(rm, /const cancel = \(\) =>\s*\{\s*rail\?\.r\.clear\(\)/, 'dropping a Results screen always clears the sweep'); assert.ok(!/const rail = celebrate/.test(rm), 'no local rail shadows the module one'); assert.match(rm, /if \(!lite\(\) && !host\.classList\.contains\('hidden'\)/, 'no Results rail under Lite effects (the last key\'s light and the sweep both live inside this guard)'); assert.match(rm, /rail\?\.r\.clear\(\)/, 'a skip clears the sweep')
  assert.match(rm, /STAR_STEP = 120/); assert.match(rm, /STAR_MS = 220/); assert.match(rm, /COUNT_MS = 600/); assert.match(rm, /SWEEP_MS = 420/)
  // v3 P2: the last key's light rises (RISE_MS), then the count and the stars run together, then the stats fade in; the whole thing fits 1.2s
  const K = (n) => Number((rm.match(new RegExp('export const ' + n + ' = (\\d+)')) || [])[1])
  assert.deepEqual([K('RISE_MS'), K('COUNT_MS'), K('STATS_MS'), K('STAR_STEP'), K('STAR_MS')], [200, 600, 220, 120, 220])
  assert.ok(K('RISE_MS') + K('COUNT_MS') + K('STATS_MS') + 20 <= 1200, 'the Results choreography is over inside 1.2s')
  assert.ok(K('RISE_MS') + 2 * K('STAR_STEP') + K('STAR_MS') <= K('RISE_MS') + K('COUNT_MS'), 'the three stars land inside the count-up')
  assert.match(css, /html\.ios \{ --perfect: var\(--ivory\); \}/, 'R3-1: Perfect is ivory on iPhone/iPad')
  const nav = read('ios-motion.js')
  assert.match(nav, /translateX\(24px\)/); assert.match(nav, /duration = 280/); assert.match(nav, /translateX\(-16px\)/); assert.match(nav, /duration = 220/); assert.match(nav, /duration = 120/); assert.match(nav, /duration = 100/)
  assert.match(nav, /cubic-bezier\(0\.32, 0\.72, 0, 1\)/)

  // the engine's maths, headless: geometry, the key under a point, hand colours, calm mode, the sweep, the sleep
  const eng2 = await runEngine()
  assert.equal(eng2.whites8, 8); assert.equal(eng2.keys8, 13, '8 white keys carry 5 black ones'); assert.equal(eng2.keys15, 15 + 10)
  assert.equal(eng2.keyAtFirst, 0); assert.equal(eng2.keyAtLast, 12); assert.equal(eng2.keyAtOutside, null)
  assert.equal(eng2.blackAt >= 0 && eng2.blackKind, 'b'); assert.equal(eng2.handLeft, 'l'); assert.equal(eng2.handRight, 'r')
  assert.equal(eng2.calmFrames, 0, 'calm draws a still frame and never starts the loop'); assert.ok(eng2.activeFrames > 0, 'a sweep starts the loop')
  assert.equal(eng2.loopsAfterOne, 1); assert.equal(eng2.loops, 0, 'refresh never adds a second rAF loop')
  assert.equal(eng2.repaints, 1, 'a refresh that sees a resize repaints exactly once'); assert.equal(eng2.backingWidth, 420 * 2, 'and re-lays out the backing store (dpr is capped at 2)')
  assert.equal(eng2.sweepMs, 480); assert.equal(eng2.stillSweepMs, 0)

  // iOS-only copy helpers
  const copy = await import(pathToFileURL(path.join(root, 'studio-copy.js')).href)
  assert.equal(copy.dot(), ' · '); assert.equal(copy.caps('LEVEL 1'), 'LEVEL 1'); assert.equal(copy.up('min'), 'MIN')
  globalThis.document = { documentElement: { classList: { contains: (c) => c === 'ios' } } }
  assert.equal(copy.dot(), ', '); assert.equal(copy.caps('LEVEL 1 EXAM'), 'Level 1 exam'); assert.equal(copy.up('min'), 'min')
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(copy.starsShown), [0, 1, 2, 2, 3, 3]); assert.equal(copy.starSlots(), 3)
  delete globalThis.document
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(copy.starsShown), [0, 1, 2, 3, 4, 5]); assert.equal(copy.starSlots(), 5)

  // three stars from the saved 0 to 5; nothing stored changes
  const src = read('app.js')

  // A6 the TV page, A7 the Jam light colour, A5 the intro: no mint, no Outfit, three stars, no dashes in the new files
  const tvHtml = read('tv.html'), tvCss = read('tv.css')
  assert.equal((tvHtml.match(/class="tv-star"/g) || []).length, 3, 'the TV results show 3 stars')
  assert.ok(!/Outfit/.test(tvCss) && !/7cf0c6|124, ?240, ?198/i.test(tvCss) && !/uppercase/.test(tvCss), 'the TV page has no Outfit, mint or ALL CAPS')
  assert.match(read('tv.js'), /Math\.ceil\(r\.stars \* 3 \/ 5\)/)
  assert.match(read('jam/jam-ui.js'), /classList\.contains\('ios'\) \? '#ff8a3d' : '#7cf0c6'/, 'Jam lock-to-key lights are amber on iOS')
  for (const f of ['key-light-engine.js', 'home-light.js', 'ios-motion.js', 'results-motion.js', 'tv.html', 'tv.css']) assert.ok(!/[\u2013\u2014]/.test(read(f)), 'no en or em dashes in ' + f)
  assert.match(src, /function setupIntro\(first\)/); assert.match(src, /introTimer = setTimeout\(done, 900\)/, 'the setup intro is over inside 1.0s')
  const cut = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i > 0 && j > i, 'slice ' + a); return src.slice(i, j) }
  for (const [IS_IOS, expected] of [[true, [0, 1, 2, 2, 3, 3]], [false, [0, 1, 2, 3, 4, 5]]]) {
    const ctx = vm.createContext({ IS_IOS })
    vm.runInContext(cut('const STAR_SLOTS', 'const starRowHTML') + '\nthis.shown = starsShown; this.slots = STAR_SLOTS; this.offer = starsOffer', ctx)
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(ctx.shown), expected, 'stars shown, IS_IOS=' + IS_IOS)
    assert.equal(ctx.slots, IS_IOS ? 3 : 5)
    assert.equal(ctx.offer(4), IS_IOS ? '3 of 3 stars' : '4 of 5 stars')
  }
  assert.match(src, /store\.set\('lumi\.best\.' \+ file, stars\)/, 'the saved best is still the 0 to 5 rating')
  // cover art: no mint on iOS
  const art = await import(pathToFileURL(path.join(root, 'cover-art.js')).href)
  const imported = { imported: true, title: 'Mine', artist: 'Recording' }
  assert.equal(art.composerPalette(imported).glow, '#7cf0c6', 'desktop keeps the mint graphite')
  globalThis.document = { documentElement: { classList: { contains: (c) => c === 'ios' } } }
  assert.equal(art.composerPalette(imported).glow, '#f2efe8')
  assert.ok(!/7cf0c6/i.test(art.coverArt({ ...imported, id: 'x' }, { fp: { t: 100, k: 0, m: 0, n: 2, s: 5, o: [[60, 0, 4, 0], [48, 0, 4, 1]] } }).svg), 'no mint in an imported cover on iOS')
  const amb = art.ambientColors({ title: 'Ode', artist: 'Beethoven' })
  assert.ok(/^#[0-9a-f]{6}$/i.test(amb.a) && /^#[0-9a-f]{6}$/i.test(amb.b))
  delete globalThis.document
  console.log('ios studio: ok')
})().catch((e) => { console.error(e); process.exit(1) })
