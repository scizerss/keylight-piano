// The iPhone back swipe (ios-motion.js, v3 P5): the stepper maths, the commit rule, and how app.js and the Course wire it.
// Run: node scripts/test-back-swipe.js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const root = path.join(__dirname, '..', 'renderer')
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')

;(async () => {
  globalThis.location = { search: '' }
  globalThis.navigator = { userAgent: 'node', platform: 'Linux' }
  globalThis.document = { documentElement: { classList: { add() {}, contains: () => false, toggle() {} } }, addEventListener() {} }
  const m = await import(pathToFileURL(path.join(root, 'ios-motion.js')).href)

  // a critically damped spring: starts where it is, ends on target, never overshoots, and carries the finger's velocity
  const at = (t, v0 = 0) => m.springAt(0, v0, 100, t)
  assert.equal(at(0).x, 0); assert.ok(Math.abs(at(2).x - 100) < 0.01, 'it settles')
  let prev = -1
  for (let t = 0; t <= 1.5; t += 0.02) { const x = at(t).x; assert.ok(x <= 100.0001, 'no overshoot'); assert.ok(x >= prev - 1e-9, 'monotonic'); prev = x }
  assert.ok(at(0.02, 1500).x > at(0.02, 0).x, 'a flick starts faster than a drop')
  assert.ok(at(m.RESPONSE).x > 60, 'response .34s reaches most of the way')
  assert.equal(m.RESPONSE, 0.34)

  // commit or cancel: the projected resting point must pass the middle
  assert.equal(m.decideBack({ dx: 100, vx: 0, width: 390 }), false, 'a slow drag short of the middle cancels')
  assert.equal(m.decideBack({ dx: 230, vx: 0, width: 390 }), true, 'a slow drag past the middle commits')
  assert.equal(m.decideBack({ dx: 60, vx: 900, width: 390 }), true, 'a short fast flick commits')
  assert.equal(m.decideBack({ dx: 230, vx: -900, width: 390 }), false, 'dragging back hard cancels')
  assert.ok(m.project(1000) > 400 && m.project(0) === 0)

  // velocity from a trail of [ms, x] samples
  assert.equal(m.trailVelocity([]), 0)
  assert.ok(Math.abs(m.trailVelocity([[0, 0], [20, 10], [40, 20], [60, 30]]) - 500) < 1, '0.5px per ms is 500px/s')
  // the screen below slides in from 28% to the left
  assert.ok(Math.abs(m.parallax(0, 400) + 112) < 1e-6); assert.equal(m.parallax(400, 400) + 0, 0); assert.equal(m.parallax(900, 400) + 0, 0)

  // the wiring: the swipe is only on iPhone drill-ins, never the Player, sheets or Results; a cancel never re-renders
  const app = read('app.js'), mo = read('ios-motion.js'), cu = read('course/course-ui.js'), css = read('ios.css')
  assert.match(app, /const SWIPE_DRILLS = \['exercise', 'quiz', 'achievements', 'toolbox', 'games'\]/)
  assert.match(app, /if \(!IS_IOS \|\| screen === 'play' \|\| swipeBlocked\(\) \|\| !nav\.canGoBack\(\)\) return null/, 'disabled in the Player and under overlays')
  assert.match(app, /#results:not\(\.hidden\)[^']*dialog\[open\]|dialog\[open\][^']*#results:not\(\.hidden\)/, 'disabled while Results or a dialog is open')
  assert.match(app, /commit\(\) \{ course\.holdRender\(false\); course\.back\(\) \}/, 'Course: the same step the Back button takes, once')
  assert.match(app, /commit\(\) \{ \$\('back'\)\.click\(\) \}/, 'drill-ins: the real Back button, once')
  assert.match(cu, /if \(swiping\) \{ renderLater = true; return \}/, 'the page is not wiped mid-gesture')
  assert.match(cu, /peekBack\(\)/); assert.match(cu, /mapMemo\.restore/, 'Back restores the map scroll and the row you opened')
  assert.match(mo, /strip\.id = 'swipeEdge'/); assert.match(mo, /EDGE_PX = 24/); assert.match(mo, /Math\.abs\(e\.clientY - st\.y0\) > 12/, 'a vertical scroll is not a back swipe')
  assert.match(mo, /if \(calm\(\) \|\| !g\.layers\) \{ finish\(\); return \}/, 'reduced motion lands at once, no tracking')
  assert.match(mo, /if \(go\) \{ skipOnce = !calm\(\)/, 'the screen does not slide twice')
  assert.match(css, /html\.ios #swipeEdge \{[^}]*width: 24px/)
  assert.match(css, /html\.ios\.sheet-open #screen > \.screen:not\(\.hidden\):not\(#screen-play\) \{\s*transform: scale\(calc\(1 - \.05 \* var\(--sheet-depth, 1\)\)\)[^}]*border-radius: calc\(16px \* var\(--sheet-depth, 1\)\)/, 'sheet depth: the active screen to .95 with 16px corners')
  assert.ok(!/#app\s*\{[^}]*scale\(/.test(css), 'sheet depth never scales #app')
  assert.match(css, /transition: transform 220ms var\(--ease-sheet\), opacity 120ms linear;\s*\/\* translateX only/, 'the segment thumb animates translateX only')
  assert.ok(!/scaleX/.test(mo + css.slice(css.indexOf('.seg-thumb'), css.indexOf('.seg-thumb') + 800)), 'no scaleX on the thumb')
  assert.match(css, /html\.ios #nav button\.on \{ background: none; box-shadow: none;/, 'the active tab has no border box')
  assert.ok(!/[–—]/.test(mo), 'no dashes in ios-motion.js')
  if (fs.existsSync(path.join(root, '../ios/Keylight/WebViewController.swift'))) {
    assert.match(read('../ios/Keylight/WebViewController.swift'), /allowsBackForwardNavigationGestures = false/, 'the native back gesture never fights the page')
  }
  console.log('back swipe: ok')
})().catch((e) => { console.error(e); process.exit(1) })
