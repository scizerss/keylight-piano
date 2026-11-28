// The compact (phone) speed chip in the player HUD: node scripts/test-player-hud.js
// With a custom rate (0.6, 0.8) none of the four buttons is selected; the chip must still show the rate and open the list.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

async function main() {
  const root = path.join(__dirname, '..', 'renderer')
  const hud = await import(pathToFileURL(path.join(root, 'player-hud.js')).href)
  const { formatWaitNotes } = await import(pathToFileURL(path.join(root, 'views.js')).href)
  let n = 0
  const check = (label, fn) => { fn(); n++; process.stdout.write('ok ' + label + '\n') }

  check('Wait notes are spoken in pitch order and grouped by hand', () => {
    assert.equal(formatWaitNotes([]), '')
    assert.equal(formatWaitNotes([{ pitch: 60, hand: 'right' }]), 'Next: C, right hand')
    assert.equal(formatWaitNotes([55, 48, 52].map((pitch) => ({ pitch, hand: 'left' }))), 'Next: C E G, left hand')
    assert.equal(formatWaitNotes([{ pitch: 61 }, { pitch: 43, hand: 'left' }]), 'Next: G, left hand; C sharp, right hand')
    assert.equal(formatWaitNotes([73, 61, 61].map((pitch) => ({ pitch, hand: 'right' }))), 'Next: C sharp 4 C sharp 5, right hand')
  })

  check('the chip names the current rate, custom ones included', () => {
    assert.equal(hud.speedChipLabel(0.6), '0.6x')
    assert.equal(hud.speedChipLabel(0.8), '0.8x')
    assert.equal(hud.speedChipLabel(0.5), '0.5x')
    assert.equal(hud.speedChipLabel(0.75), '0.75x')
    assert.equal(hud.speedChipLabel(1), 'Full speed')
    assert.equal(hud.speedChipLabel(0.333333), '0.33x')
    assert.equal(hud.speedChipLabel(NaN), 'Speed')
  })
  check('a tap on the closed chip opens the list, whether or not a button was hit (no button is selected for a custom rate)', () => {
    assert.equal(hud.compactSpeedClick({ compact: true, open: false, onButton: false }), 'open')
    assert.equal(hud.compactSpeedClick({ compact: true, open: false, onButton: true }), 'open')
  })
  check('an open list takes a choice from a button and ignores its padding; the wide layout is untouched', () => {
    assert.equal(hud.compactSpeedClick({ compact: true, open: true, onButton: true }), 'choose')
    assert.equal(hud.compactSpeedClick({ compact: true, open: true, onButton: false }), 'ignore')
    assert.equal(hud.compactSpeedClick({ compact: false, open: false, onButton: true }), 'pass')
  })
  check('the page feeds the chip: app.js sets data-rate and the compact CSS shows it when no button is selected', () => {
    const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8')
    assert.match(app, /speedTrack'\)\.dataset\.rate = speedChipLabel\(/)
    const css = fs.readFileSync(path.join(root, 'player.css'), 'utf8')
    assert.match(css, /\.speed-track\.compact:not\(:has\(button\.on\)\)::before \{ content: attr\(data-rate\)/)
  })
  // ---- the real mount, on a small fake DOM: custom rate 0.6 selects no button ----
  const mkEl = (extra = {}) => {
    const classes = new Set(), listeners = {}, attrs = {}
    const el = {
      listeners, attrs, dataset: {}, style: {}, children: [], hidden: false, parent: null,
      classList: { add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)), contains: (c) => classes.has(c), toggle(c, on) { (on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c) } },
      addEventListener(t, f, cap) { (listeners[t] ||= []).push({ f, cap: !!cap }) },
      setAttribute(k, v) { attrs[k] = String(v) }, getAttribute: (k) => (k in attrs ? attrs[k] : null), removeAttribute(k) { delete attrs[k] },
      closest(sel) { return sel === 'button' && el.tag === 'button' ? el : null },
      contains(o) { return o === el || el.children.includes(o) },
      matches(sel) { return sel === '.compact' && classes.has('compact') },
      querySelector(sel) { return sel === 'button.on' ? el.children.find((c) => c.classList.contains('on')) || null : sel === 'button' ? el.children[0] || null : null },
      focus() {}, ...extra
    }
    return el
  }
  const ids = {}
  for (const id of ['btnPlay', 'viewMenu', 'results', 'hudMore', 'hudMoreClose', 'hudScrim', 'hudActions', 'progress', 'progressFill', 'hudLineFill', 'hudTicks']) ids[id] = mkEl({ id })
  ids.viewMenu.classList.add('hidden'); ids.results.classList.add('hidden')
  ids.hudActions.querySelector = () => null
  const track = ids.speedTrack = mkEl({ id: 'speedTrack' })
  const chosen = []
  for (const r of ['wait', '0.5', '0.75', '1']) { const b = mkEl({ tag: 'button' }); b.dataset.speed = r; b.onclick = () => chosen.push(b.dataset.speed); b.parent = track; track.children.push(b) }
  const body = mkEl({ dataset: { screen: 'play' } })
  const observers = []
  Object.assign(globalThis, {
    document: { getElementById: (id) => ids[id], body, querySelector: () => null, addEventListener() {}, activeElement: null },
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    MutationObserver: class { constructor(f) { observers.push(f) } observe() {} },
    setInterval: () => 0, requestAnimationFrame: () => 0, performance: { now: () => 0 }
  })
  const click = (target) => {                       // capture listeners on the track first, then the target's own handler
    let stopped = false
    const e = { target, preventDefault() {}, stopPropagation() { stopped = true } }
    for (const l of track.listeners.click || []) if (l.cap) l.f(e)
    if (!stopped && target.onclick) target.onclick(e)
  }
  const seeks = []
  hud.mountPlayerHud({ seekFraction: (x) => seeks.push(x) })
  check('scrubbing follows one pointer and stops when capture is lost', () => {
    const captured = []
    const bar = ids.progress
    bar.setPointerCapture = (id) => captured.push(id)
    const pointer = (type, pointerId, clientX) => {
      for (const l of bar.listeners[type]) l.f({ pointerId, clientX, button: 0 })
    }
    pointer('pointerdown', 1, 5)
    pointer('pointerdown', 2, 10)
    pointer('pointermove', 2, 15)
    pointer('pointercancel', 2, 20)
    pointer('pointermove', 1, 25)
    assert.ok(body.classList.contains('hud-scrubbing'))
    pointer('lostpointercapture', 1, 30)
    pointer('pointermove', 1, 35)
    assert.ok(!body.classList.contains('hud-scrubbing'))
    pointer('pointerdown', 2, 40)
    pointer('pointerup', 2, 45)
    pointer('pointermove', 2, 50)
    assert.deepEqual(seeks, [5, 25, 40])
    assert.deepEqual(captured, [1, 2])
  })
  check('compact chip at rate 0.6: it shows "0.6x", is reachable, a tap opens the list and choosing a rate applies it', () => {
    track.dataset.rate = hud.speedChipLabel(0.6)       // what app.js does when it syncs the buttons
    assert.equal(track.dataset.rate, '0.6x')
    assert.ok(track.classList.contains('compact'), 'phone layout')
    assert.equal(track.children.some((b) => b.classList.contains('on')), false, 'no button is selected for a custom rate')
    for (const f of observers) f()
    assert.equal(track.tabIndex, 0, 'the chip itself is focusable'); assert.equal(track.attrs.role, 'button')
    click(track)                                        // a tap on the chip (not on a button)
    assert.ok(track.classList.contains('open'), 'the list opened')
    click(track)                                        // padding of the open list: nothing happens
    assert.ok(track.classList.contains('open'))
    click(track.children[1])                            // 0.5x
    assert.deepEqual(chosen, ['0.5'], 'the rate was applied')
    assert.equal(track.classList.contains('open'), false, 'and the list closed')
  })

  process.stdout.write(`\ntest-player-hud: ${n} checks passed\n`)
}
main().catch((e) => { console.error(e); process.exit(1) })
