// The first-lesson tour: node scripts/test-tour.js
// Card placement: the card must stay inside the safe areas on an iPhone in portrait and in landscape (about 375px tall),
// whatever it points at. Closing: a pending start is dropped, and markDone/resume are honoured (setup opens over it).
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// Just enough DOM for run(): elements, body, documentElement and the window listeners the tour adds.
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}
    this.style = {}; this.dataset = {}; this.className = ''; this.textContent = ''
    this.offsetWidth = 0; this.offsetHeight = 0; this.parent = null
  }
  get classList() {
    const self = this
    const set = () => new Set(self.className.split(/\s+/).filter(Boolean))
    return {
      add: (...c) => { const s = set(); c.forEach((x) => s.add(x)); self.className = [...s].join(' ') },
      remove: (...c) => { const s = set(); c.forEach((x) => s.delete(x)); self.className = [...s].join(' ') },
      contains: (c) => set().has(c),
      toggle(c, on) { const s = set(); (on ?? !s.has(c)) ? s.add(c) : s.delete(c); self.className = [...s].join(' ') }
    }
  }
  append(...kids) { for (const k of kids) if (k && typeof k === 'object') { k.parent = this; this.children.push(k) } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f) }
  removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f) }
  focus() {}
}
function fakePage() {
  const doc = { createElement: (tag) => new El(tag), addEventListener() {}, removeEventListener() {} }
  doc.body = new El('body')
  doc.body.dataset.screen = 'play'
  doc.documentElement = new El('html')
  const win = { innerWidth: 390, innerHeight: 844, addEventListener() {}, removeEventListener() {} }
  Object.assign(globalThis, {
    document: doc, window: win,
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ top: '0px', right: '0px', bottom: '0px', left: '0px' })
  })
  return doc
}

async function main() {
  const page = fakePage()   // before the import: the module may install window listeners at load
  const { placeCard, boxOf, startTour, closeTour, tourIsOpen, mountTour } = await import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'tour.js')).href)
  let n = 0
  const check = (label, fn) => { fn(); n++; process.stdout.write('ok ' + label + '\n') }
  const checkAsync = async (label, fn) => { await fn(); n++; process.stdout.write('ok ' + label + '\n') }
  const card = { width: 320, height: 150 }
  const inside = (p, view, safe) => p.left >= (safe.left || 0) && p.top >= (safe.top || 0) &&
    p.left + card.width <= view.width - (safe.right || 0) && p.top + card.height <= view.height - (safe.bottom || 0)

  const portrait = { view: { width: 390, height: 844 }, safe: { top: 47, bottom: 34, left: 0, right: 0 } }
  const landscape = { view: { width: 844, height: 390 }, safe: { top: 0, bottom: 21, left: 47, right: 47 } }
  const targets = {
    speed: { left: 150, top: 56, width: 92, height: 44 },
    play: { left: 16, top: 330, width: 44, height: 44 },
    lane: { left: 0, top: 0, width: 844, height: 280 },
    keys: { left: 47, top: 300, width: 750, height: 70 }
  }
  for (const [name, env] of [['portrait', portrait], ['landscape', landscape]]) {
    for (const [t, box] of Object.entries(targets)) {
      const b = name === 'portrait' ? { ...box, left: Math.min(box.left, 300), width: Math.min(box.width, 300) } : box
      check(`${name}: card for ${t} stays inside the safe box`, () => {
        const p = placeCard(b, card, env.view, env.safe)
        assert.ok(inside(p, env.view, env.safe), JSON.stringify(p))
      })
    }
  }
  check('a control near the top gets the card below it', () => {
    assert.equal(placeCard(targets.speed, card, portrait.view, portrait.safe).side, 'below')
  })
  check('a control at the bottom gets the card above it', () => {
    assert.equal(placeCard({ left: 160, top: 760, width: 60, height: 60 }, card, portrait.view, portrait.safe).side, 'above')
  })
  check('a target that fills the screen gets the card inside it', () => {
    assert.equal(placeCard(targets.lane, card, landscape.view, landscape.safe).side, 'inside')
  })
  check('boxOf drops missing and empty targets', () => {
    assert.equal(boxOf(null), null)
    assert.equal(boxOf({ left: 0, top: 0, width: 0, height: 10 }), null)
    assert.deepEqual(boxOf({ left: 1, top: 2, width: 30, height: 40 }), { left: 1, top: 2, width: 30, height: 40 })
  })

  // ---- closing ----
  const stop ={ target: { left: 10, top: 40, width: 100, height: 44 }, title: 'Here', body: 'Body' }
  const settings = { tourDone: false }
  const calls = { saves: 0, holds: 0, resumes: 0 }
  mountTour({ settings, save: () => { calls.saves++ }, hold: () => { calls.holds++; return () => { calls.resumes++ } } })

  await checkAsync('closeTour cancels a start that is still inside its delay', async () => {
    const created = page.createElement
    page.createElement = () => { throw new Error('the tour mounted after closeTour') }   // the wait must be dropped before any DOM work
    try {
      const pending = startTour({ delay: 25 })
      assert.equal(closeTour({ markDone: false, resume: false }), false, 'nothing was on screen to close')
      assert.equal(await pending, null, 'the waiting start returned without a tour')
      assert.equal(tourIsOpen(), false)
    } finally { page.createElement = created }
  })

  await checkAsync('closeTour({ markDone: false, resume: false }) leaves the tour unseen and the player paused', async () => {
    const ctl = await startTour({ stops: [stop] })
    assert.ok(ctl && tourIsOpen(), 'the tour is on screen')
    assert.equal(calls.holds, 1, 'the player was held once')
    assert.equal(closeTour({ markDone: false, resume: false }), true)
    assert.equal(tourIsOpen(), false, 'the tour is gone')
    assert.equal(settings.tourDone, false, 'markDone: false does not count it as seen')
    assert.equal(calls.saves, 0, 'and saves nothing')
    assert.equal(calls.resumes, 0, 'resume: false leaves the player paused')
  })

  await checkAsync('closeTour() marks the tour done and resumes playback', async () => {
    await startTour({ stops: [stop] })
    assert.equal(closeTour(), true)
    assert.equal(settings.tourDone, true, 'a plain close is a Skip and counts as seen')
    assert.equal(calls.saves, 1)
    assert.equal(calls.resumes, 1, 'and playback comes back')
  })

  process.stdout.write(`\ntest-tour: ${n} checks passed\n`)
}
main().catch((e) => { console.error(e); process.exit(1) })
