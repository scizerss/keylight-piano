// The piano-roll editor's DOM behaviour, on a tiny fake DOM with a virtual clock: node scripts/test-roll-editor.js
// A save that is pending freezes the draft; Back and the discard question stay in step; destroy() leaves nothing alive.
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const load = (f) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', f)).href)

class El {
  constructor(tag, doc) {
    Object.assign(this, { tagName: tag.toUpperCase(), ownerDocument: doc, children: [], attrs: {}, listeners: {}, style: {}, dataset: {}, className: '',
      disabled: false, hidden: false, textContent: '', innerHTML: '', captured: new Set(), width: 0, height: 0, offsetHeight: 40, parent: null })
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
  replaceChildren(...kids) { this.children = []; this.append(...kids) }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null }
  removeAttribute(k) { delete this.attrs[k] }
  addEventListener(type, f, opts) { (this.listeners[type] ||= []).push({ f, signal: opts && opts.signal }) }
  removeEventListener(type, f) { this.listeners[type] = (this.listeners[type] || []).filter((l) => l.f !== f) }
  dispatch(type, event = {}) {
    const e = { preventDefault() {}, stopPropagation() {}, target: this, ...event }
    for (const l of [...(this.listeners[type] || [])]) if (!(l.signal && l.signal.aborted)) l.f(e)
  }
  all() { return this.children.flatMap((c) => [c, ...c.all()]) }
  querySelectorAll(sel) { const tags = sel.split(',').map((s) => s.trim().toUpperCase()); return this.all().filter((c) => tags.includes(c.tagName)) }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null }
  focus() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 500 } }
  getContext() { return new Proxy({}, { get: (t, k) => (k === 'measureText' ? () => ({ width: 10 }) : k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true } }) }
  setPointerCapture(id) { this.captured.add(id) }
  releasePointerCapture(id) { this.captured.delete(id) }
}
function makeWorld() {
  let now = 0, id = 0
  const timers = new Map()
  const doc = { createElement: (tag) => new El(tag, doc) }
  const win = {
    document: doc, devicePixelRatio: 1, navigator: {}, performance: { now: () => now },
    setTimeout: (f, ms) => { timers.set(++id, { f, at: now + ms, every: 0 }); return id },
    setInterval: (f, ms) => { timers.set(++id, { f, at: now + ms, every: ms }); return id },
    requestAnimationFrame: (f) => { timers.set(++id, { f, at: now + 16, every: 0 }); return id },
    clearTimeout: (i) => timers.delete(i), clearInterval: (i) => timers.delete(i), cancelAnimationFrame: (i) => timers.delete(i),
    getComputedStyle: () => ({ getPropertyValue: () => '', position: 'static' }),
    addEventListener() {}, removeEventListener() {},
    advance(ms) {
      const until = now + ms
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        const [i, t] = due
        now = t.at
        if (t.every) t.at += t.every; else timers.delete(i)
        t.f()
      }
      now = until
    },
    pending: () => timers.size
  }
  doc.defaultView = win
  Object.assign(globalThis, { document: doc, HTMLInputElement: class {}, window: win })
  return { win, doc, body: new El('body', doc) }
}
const notesOf = () => [
  { pitch: 60, start: 1, dur: 0.5, vel: 90, hand: 'right' }, { pitch: 64, start: 1.5, dur: 0.5, vel: 90, hand: 'right' },
  { pitch: 48, start: 2, dur: 1, vel: 80, hand: 'left' }
]
const songOf = (extra = {}) => ({ title: 'T', importedId: 'imp-1', source: 'audio', tempo: 120, duration: 20, bars: [0, 2], notes: notesOf(), ...extra })
const byLabel = (host, label) => host.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === label)
const byText = (host, text) => host.querySelectorAll('button').find((b) => b.textContent === text)
const tick = () => new Promise((r) => setImmediate(r))
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

async function main() {
  const { win, doc, body } = makeWorld()
  const { mountRollEditor, mountRoll } = await load('roll-editor.js')
  const { createNav } = await load('nav.js')
  let n = 0
  const check = async (label, fn) => { await fn(); n++; process.stdout.write('ok ' + label + '\n') }
  const mount = (options) => {
    const host = doc.createElement('div')
    const calls = { on: [], off: [], notices: [] }
    const audio = { noteOn: (p) => calls.on.push(p), noteOff: (p) => calls.off.push(p) }
    const controller = mountRollEditor(host, { song: songOf(), audio, saveSong: async () => {}, notice: (m) => calls.notices.push(m), confirmDiscard: () => true, ...options })
    return { host, controller, calls, canvas: host.querySelector('canvas') }
  }
  const press = (canvas, x, y, extra = {}) => canvas.dispatch('pointerdown', { pointerId: 1, pointerType: 'touch', button: 0, clientX: x, clientY: y, ...extra })

  await check('a bundled song (no importedId) says Save as my copy and saves a copy, never the original', async () => {
    const saved = []
    const { host, controller } = mount({ song: songOf({ importedId: undefined, file: 'twinkle.xml', source: 'score' }), saveSong: async (s) => { saved.push(s) } })
    assert.ok(byText(host, 'Save as my copy'), 'the primary button names the copy')
    assert.ok(!byText(host, 'Done'), 'no plain Done for a bundled song')
    controller.model.transpose(1)
    await controller.done(); await tick()
    assert.equal(saved.length, 1)
    assert.equal(saved[0].id, undefined, 'no id: the library makes a new record, the bundled file is untouched')
    assert.equal(saved[0].importedId, undefined)
    assert.equal(saved[0].file, undefined)
    assert.match(saved[0].title, /\(my copy\)$/)
    const unchanged = []
    const bare = mount({ song: songOf({ importedId: undefined, file: 'twinkle.xml', source: 'score' }), saveSong: async (s) => { unchanged.push(s) } })
    await bare.controller.done(); await tick()
    assert.equal(unchanged.length, 1, 'Save as my copy with no edits still saves the copy')
    const mine = mount({ song: songOf() })
    assert.ok(byText(mine.host, 'Done') && !byText(mine.host, 'Save as my copy'), 'an imported song keeps Done')
    mine.controller.destroy()
  })

  await check('destroy() clears a pending long press: no note is added or sounded in a destroyed editor, and no timer survives', async () => {
    const { host, controller, calls, canvas } = mount()
    const before = controller.model.notes.length
    press(canvas, 700, 60)                                   // empty space: a long press would add a note here
    assert.ok(controller.state.gesture && controller.state.gesture.timer, 'a long press is pending')
    assert.ok(canvas.captured.has(1))
    controller.destroy()
    assert.equal(canvas.captured.size, 0, 'pointer capture released')
    assert.equal(win.pending(), 0, 'no gesture, status, audition or frame timer is left')
    win.advance(2000)
    assert.equal(controller.model.notes.length, before, 'no note was added late')
    assert.deepEqual(calls.on, [], 'nothing sounded')
    canvas.dispatch('pointermove', { pointerId: 1, clientX: 600, clientY: 90 })    // late events are no-ops too
    canvas.dispatch('pointerup', { pointerId: 1, clientX: 600, clientY: 90 })
    host.dispatch('keydown', { key: 'z', metaKey: true, target: canvas })
    assert.equal(controller.model.notes.length, before)
    assert.equal(host.children.length, 0)
  })

  await check('destroy() silences sounding preview notes and stops playback', async () => {
    const { controller, calls, canvas } = mount()
    press(canvas, 20, 200)                                   // the key gutter plays that key
    assert.equal(calls.on.length, 1)
    controller.play(); win.advance(100)
    controller.destroy()
    assert.equal(win.pending(), 0)
    assert.ok(calls.off.length >= 1, 'the held note was released')
  })

  await check('while a save is pending nothing can change the draft; a failed save re-enables everything and shows the error', async () => {
    const save = deferred()
    let saved = null
    const { host, controller, canvas, calls } = mount({ saveSong: (s) => { saved = s; return save.promise } })
    const m = controller.model
    m.select([m.notes[0].key]); m.setVelocity(null, 33)       // a real edit, so Done has something to save
    const done = controller.done()
    await tick()
    assert.equal(controller.state.saving, true)
    assert.ok(host.classList.contains('rl-busy'), 'visible busy state')
    assert.equal(host.getAttribute('aria-busy'), 'true')
    const buttons = host.querySelectorAll('button')
    assert.ok(buttons.length > 8 && buttons.every((b) => b.disabled), 'every control is disabled')
    assert.equal(byText(host, 'Saving') != null, true, 'Done says it is saving')
    const shape = () => JSON.stringify(m.notes.map((x) => [x.pitch, x.start, x.dur, x.vel, x.hand])) + m.canUndo + m.selection.size
    const frozen = shape()
    for (const b of buttons) b.dispatch('click')              // even a click that got through must do nothing
    press(canvas, 100, 100); canvas.dispatch('pointerup', { pointerId: 1, clientX: 100, clientY: 100 })
    for (const key of ['Delete', 'ArrowRight', 'ArrowUp', 'a', 'z']) canvas.dispatch('keydown', { key, metaKey: key === 'a' || key === 'z' })
    host.dispatch('keydown', { key: 'Escape', target: host })
    win.advance(1000)
    assert.equal(shape(), frozen, 'toolbar, canvas gestures and shortcuts changed nothing')
    assert.equal(controller.state.destroyed, false)
    save.reject(new Error('disk full'))
    await done
    assert.equal(controller.state.saving, false)
    assert.equal(controller.state.destroyed, false, 'the editor stays open')
    assert.ok(!host.classList.contains('rl-busy')); assert.equal(host.getAttribute('aria-busy'), null)
    assert.match(host.querySelector('p').textContent + host.all().map((c) => c.textContent).join('|'), /Could not save: disk full/)
    assert.ok(calls.notices.some((t) => /disk full/.test(t)))
    win.advance(10000)
    assert.match(host.all().map((c) => c.textContent).join('|'), /Could not save: disk full/, 'the error stays until the next action')
    assert.equal(byLabel(host, 'Undo').disabled, false, 'undo is available again (the velocity edit)')
    assert.equal(byText(host, 'Done').disabled, false)
    controller.model.setVelocity(null, 44)                    // editing works again, and a retry saves the newer draft
    saved = null
    const second = controller.done(); await tick()
    assert.equal(saved.notes.find((x) => x.pitch === 60).vel, 44)
    save.resolve(); await second.catch(() => {})
  })

  await check('Back keeps the editor registered when the user declines to discard; accepting closes it for real', async () => {
    const nav = createNav({ root: 'home' })
    let discards = 0, answer = false
    globalThis.confirm = () => { discards++; return answer }
    const roll = mountRoll({ getSong: async () => songOf(), saveSong: async () => {}, pushOverlay: nav.pushOverlay, root: body })
    await roll.open()
    assert.equal(roll.isOpen(), true); assert.equal(nav.canGoBack(), true, 'the open editor is a Back target')
    const m = roll.controller.model
    m.select([m.notes[0].key]); m.setVelocity(null, 20)
    assert.equal(nav.back(), true); assert.equal(discards, 1)
    assert.equal(roll.isOpen(), true, 'declined: still open')
    assert.equal(nav.canGoBack(), true, 'and still registered, so Back does not navigate underneath it')
    assert.equal(nav.back(), true); assert.equal(discards, 2, 'the next Back asks again instead of leaving the screen')
    assert.equal(roll.isOpen(), true)
    answer = true
    assert.equal(nav.back(), true); assert.equal(discards, 3)
    assert.equal(roll.isOpen(), false, 'closed')
    assert.equal(nav.canGoBack(), false, 'the overlay is gone from the stack')
    assert.equal(body.children.length, 0)
    delete globalThis.confirm
  })

  await check('Back during a save keeps the editor registered too', async () => {
    const nav = createNav({ root: 'home' })
    const save = deferred()
    const roll = mountRoll({ getSong: async () => songOf(), saveSong: () => save.promise, pushOverlay: nav.pushOverlay, root: body })
    await roll.open()
    const m = roll.controller.model
    m.select([m.notes[0].key]); m.setVelocity(null, 20)
    const done = roll.controller.done(); await tick()
    nav.back()
    assert.equal(roll.isOpen(), true); assert.equal(nav.canGoBack(), true)
    save.resolve(); await done
    assert.equal(roll.isOpen(), false); assert.equal(nav.canGoBack(), false)
  })

  await check('Trim silence and Change speed ask before detaching a recording, and do nothing when declined', async () => {
    const asked = []
    const { host, controller } = mount({ song: songOf({ audio: { rec: true }, lyrics: { synced: [{ t: 1, text: 'hi' }] } }), confirmDetach: (text) => { asked.push(text); return false } })
    const before = JSON.stringify(controller.model.notes)
    byLabel(host, 'More actions').dispatch('click')
    byText(host, 'Trim silence').dispatch('click')
    assert.equal(asked.length, 1); assert.match(asked[0], /no longer line up/)
    assert.equal(JSON.stringify(controller.model.notes), before, 'declined: the notes did not move')
    const bpm = host.querySelectorAll('input').find((i) => i.getAttribute('aria-label') === 'Beats per minute')
    bpm.value = '90'                                          // a real tempo change, so the confirmation must be asked
    byLabel(host, 'Change the tempo and stretch the notes').dispatch('click')
    assert.equal(asked.length, 2, 'a real tempo change asks'); assert.equal(controller.model.tempo, 120, 'declined: tempo unchanged')
    assert.equal(JSON.stringify(controller.model.notes), before)
    controller.destroy()
  })

  await check('accepting the warning applies the speed change, detaches the recording and sets the length from the notes', async () => {
    const { host, controller } = mount({ song: songOf({ audio: { rec: true }, duration: 20 }), confirmDetach: () => true })
    byLabel(host, 'More actions').dispatch('click')
    host.querySelectorAll('input').find((i) => i.getAttribute('aria-label') === 'Beats per minute').value = '60'
    byLabel(host, 'Change the tempo and stretch the notes').dispatch('click')
    assert.equal(controller.model.tempo, 60)
    const out = controller.model.build().song
    assert.equal(out.audio, null)
    assert.ok(Math.abs(out.duration - controller.model.end()) < 1e-9, 'duration ' + out.duration + ' follows the notes, not the old 20 s recording')
    controller.destroy()
  })

  await check('Done during a drag keeps the dragged change and its undo step when the save fails', async () => {
    const save = deferred()
    const { host, controller, canvas } = mount({ saveSong: () => save.promise })
    const m = controller.model, vp = controller.viewport
    const note = m.notes.find((x) => x.pitch === 60), start0 = note.start
    const x = vp.timeToX(note.start + note.dur / 2), y = vp.pitchToY(60) + 5
    press(canvas, x, y)
    canvas.dispatch('pointermove', { pointerId: 1, clientX: x + 120, clientY: y })
    const moved = m.byKey(note.key).start
    assert.ok(moved > start0, 'the note is being dragged')
    const done = controller.done(); await tick()
    save.reject(new Error('offline')); await done
    assert.equal(controller.state.destroyed, false)
    assert.equal(m.byKey(note.key).start, moved, 'the dragged position is still in the draft')
    assert.equal(m.canUndo, true, 'with its undo step')
    assert.equal(m.dirty, true)
    assert.ok(m.undo()); assert.equal(m.byKey(note.key).start, start0)
    controller.destroy()
  })

  process.stdout.write(`\ntest-roll-editor: ${n} checks passed\n`)
}
main().catch((e) => { console.error(e); process.exit(1) })
