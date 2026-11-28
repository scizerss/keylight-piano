// Piano-roll note editor: a canvas (time across, pitch up) with a key gutter, bar and beat grid,
// notes coloured by hand, touch and mouse gestures, a floating toolbar and a playhead.
//
//   mountRoll({ getSong, saveSong, notice, audio, getTime?, transport?, pushOverlay?, root? }) -> { open, close, isOpen }
//     The same shape as mountEditor in editor.js: open() reads the song, shows the full-screen editor,
//     Done builds one checked song and hands it to saveSong(song) (the app stores it and reopens it).
//   mountRollEditor(host, options) -> controller     the editor alone, for a harness or your own page
//
// Injected so the module stays testable and knows nothing about the app:
//   audio: { noteOn(pitch, velocity), noteOff(pitch) }   sounds a note (tap, move, playback)
//   getTime(): seconds   current playback time, for the playhead (default: its own clock)
//   transport: { play(fromSeconds), pause(), isPlaying() }   to drive the app's player instead of the built-in
//     preview player. Note: the app's player plays the SAVED song, not the notes being edited, so leave
//     this out (the default) to hear your edits.
// The model (selection, every operation, undo) is in roll-model.js; the maths in roll-geometry.js.
import { RollModel, GRID_DIVISIONS, isBlackKey, pitchLabel } from './roll-model.js'
import { Viewport, hitTest, visibleNotes, notesInRect, noteRect, pinchFactors, longest } from './roll-geometry.js'

const H = (tag, props = {}, kids = []) => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v
    else if (k === 'text') el.textContent = v
    else if (k.startsWith('aria-') || k === 'role' || k === 'title' || k === 'type' || k === 'min' || k === 'max' || k === 'step' || k === 'inputmode') el.setAttribute(k, v)
    else el[k] = v
  }
  for (const c of [].concat(kids)) if (c != null) el.append(c)
  return el
}
const RULER = 24
const KEYS_W = 46
const LONG_PRESS_MS = 450

const ICON = {
  undo: '<path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="m15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h3"/>',
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>',
  pause: '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/>',
  select: '<path d="m5 3 14 8-6 2-2 6z"/>',
  draw: '<path d="M4 20l1-5L16 4l4 4L9 19z"/>',
  erase: '<path d="M4 15 13 5l7 7-6 7H8zM9 19h11"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
  snap: '<path d="M5 4v16M12 4v16M19 4v16" stroke-dasharray="2 3"/>',
  quant: '<path d="M4 6h16M4 12h16M4 18h16M8 3v18M16 3v18"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>'
}
const icon = (name) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`

export function mountRollEditor(host, options) {
  const { song, audio = null, saveSong, notice = () => {}, onClose = () => {}, openDetails = null, getTime: injectedTime = null, transport = null,
    confirmDiscard = (text) => (typeof confirm === 'function' ? confirm(text) : true),
    confirmDetach = (text) => (typeof confirm === 'function' ? confirm(text) : true) } = options
  const model = new RollModel(song)
  const gridAtOpen = JSON.stringify(model.gridRecord())
  const vp = new Viewport({ keysW: KEYS_W, top: RULER })
  const win = host.ownerDocument.defaultView || window
  const doc = host.ownerDocument
  const life = new AbortController()               // every listener below ends with the editor
  const own_ = { signal: life.signal }
  const state = {
    tool: 'select', hand: 'right', marquee: false, multi: false, cursor: 0, maxDur: longest(model.notes), flash: null,
    pressedKey: null, dirtyDraw: true, destroyed: false, saving: false, pointers: new Map(), gesture: null, pop: null
  }
  let colors = null
  const readColors = () => {
    const cs = win.getComputedStyle(host)
    const g = (name, fb) => (cs.getPropertyValue(name) || '').trim() || fb
    colors = {
      bg: g('--bg-deep', '#04050d'), surface: g('--surface', '#0e1120'), surface2: g('--surface-2', '#151a2e'), line: g('--line', 'rgba(255,255,255,.08)'),
      lineStrong: g('--line-strong', 'rgba(255,255,255,.16)'), text: g('--text', '#f4f3ee'), muted: g('--muted', 'rgba(244,243,238,.68)'),
      accent: g('--accent', '#7cf0c6'), right: g('--right', '#ff8a3d'), left: g('--left', '#86b6ff'), ink: g('--ink', '#04130d')
    }
  }

  // ---------- DOM ----------
  const canvas = H('canvas', { class: 'rl-canvas', tabIndex: 0, role: 'application', 'aria-label': 'Piano roll. Arrow keys move the selected notes, Delete removes them, Space plays.' })
  const ctx = canvas.getContext('2d')
  const status = H('p', { class: 'rl-status', role: 'status', 'aria-live': 'polite' })
  const summary = H('p', { class: 'rl-summary', id: 'rlSummary' })
  canvas.setAttribute('aria-describedby', 'rlSummary')
  const btn = (label, ic, onClick, cls = '') => {
    const b = H('button', { type: 'button', class: 'rl-btn ' + cls, 'aria-label': label, title: label })
    b.innerHTML = ic ? icon(ic) + `<span class="rl-btn-text">${cls.includes('rl-labelled') ? label : ''}</span>` : label
    b.addEventListener('click', onClick)
    return b
  }
  const textBtn = (label, onClick, aria) => {
    const b = H('button', { type: 'button', class: 'rl-btn rl-text', text: label })
    if (aria) { b.setAttribute('aria-label', aria); b.title = aria }
    b.addEventListener('click', onClick)
    return b
  }
  const el = {}
  el.cancel = textBtn('Cancel', () => cancel(), 'Close without saving')
  // a bundled song is never changed: Done saves an editable copy in the library, and the button says so
  const asCopy = !!(model.draft && model.draft.copy)
  const doneLabel = asCopy ? 'Save as my copy' : 'Done'
  el.done = textBtn(doneLabel, () => done(), asCopy ? 'Save as my copy: the original song stays as it is' : 'Save the edited notes')
  el.done.classList.add('rl-primary')
  el.undo = btn('Undo', 'undo', () => doUndo())
  el.redo = btn('Redo', 'redo', () => doRedo())
  el.play = btn('Play from here', 'play', () => togglePlay())
  el.title = H('h2', { class: 'rl-title', text: song.title || 'Edit notes' })
  const tools = {}
  const toolSeg = H('div', { class: 'rl-seg', role: 'group', 'aria-label': 'Tool' })
  for (const [id, label, ic] of [['select', 'Select', 'select'], ['draw', 'Add notes', 'draw'], ['erase', 'Erase', 'erase']]) {
    const b = btn(label, ic, () => setTool(id))
    b.setAttribute('aria-pressed', 'false'); tools[id] = b; toolSeg.append(b)
  }
  const handSeg = H('div', { class: 'rl-seg', role: 'group', 'aria-label': 'Hand for new notes and the selection' })
  const handBtns = {}
  for (const id of ['left', 'right']) {
    const b = textBtn(id === 'left' ? 'L' : 'R', () => setHand(id), id === 'left' ? 'Left hand' : 'Right hand')
    b.classList.add('rl-hand', 'rl-hand-' + id); b.setAttribute('aria-pressed', 'false'); handBtns[id] = b; handSeg.append(b)
  }
  el.snap = btn('Snap to grid', 'snap', () => { if (blocked()) return; model.snap = !model.snap; syncUi(); say(model.snap ? 'Snap on' : 'Snap off') })
  el.snap.setAttribute('aria-pressed', 'true')
  el.grid = H('select', { class: 'rl-select', 'aria-label': 'Grid size' }, GRID_DIVISIONS.map((d) => H('option', { value: String(d.perBeat), text: d.label })))
  el.grid.value = String(model.division)
  el.grid.addEventListener('change', () => { if (blocked()) return; model.setDivision(Number(el.grid.value)); invalidate() })
  el.quant = btn('Quantise to grid', 'quant', () => {
    if (blocked()) return
    const r = model.quantise({}); afterEdit(r.moved ? `Quantised ${r.moved} ${r.moved === 1 ? 'note' : 'notes'}` : 'Notes already on the grid')
  })
  el.transpose = btn('Transpose', 'up', () => togglePop('transpose'))
  el.del = btn('Delete selected notes', 'trash', () => deleteSelected())
  el.more = btn('More actions', 'more', () => togglePop('more'))
  el.toolbar = H('div', { class: 'rl-toolbar', role: 'toolbar', 'aria-label': 'Note tools' }, [toolSeg, handSeg, el.snap, el.grid, el.quant, el.transpose, el.del, el.more])
  el.pop = H('div', { class: 'rl-pop', hidden: true })
  const top = H('header', { class: 'rl-top' }, [el.cancel, H('div', { class: 'rl-titlebox' }, [el.title, summary]), el.undo, el.redo, el.play, el.done])
  const body = H('div', { class: 'rl-body' }, [canvas, status])
  host.classList.add('rl')
  host.append(top, body, el.toolbar, el.pop)

  // ---------- helpers ----------
  let sayTimer = 0
  const say = (text, sticky = false) => {
    if (state.destroyed) return
    status.textContent = text; win.clearTimeout(sayTimer)
    if (text && !sticky) sayTimer = win.setTimeout(() => { status.textContent = '' }, 4500)
  }
  // A save is running, or the editor is gone: nothing may change the draft (toolbar, canvas gestures, shortcuts all ask this).
  const blocked = () => state.saving || state.destroyed
  const invalidate = () => { state.dirtyDraw = true; schedule() }
  let raf = 0
  const schedule = () => { if (!raf && !state.destroyed) raf = win.requestAnimationFrame(frame) }
  function syncUi() {
    for (const [id, b] of Object.entries(tools)) b.setAttribute('aria-pressed', String(state.tool === id))
    for (const [id, b] of Object.entries(handBtns)) b.setAttribute('aria-pressed', String(state.hand === id))
    el.snap.setAttribute('aria-pressed', String(model.snap))
    if (!state.saving) {                              // while saving every control stays disabled
      el.undo.disabled = !model.canUndo
      el.redo.disabled = !model.canRedo
      el.del.disabled = model.selection.size === 0
    }
    el.play.innerHTML = icon(playing() ? 'pause' : 'play')
    el.play.setAttribute('aria-label', playing() ? 'Pause' : 'Play from here')
    el.play.title = el.play.getAttribute('aria-label')
    summary.textContent = model.summary()
    host.dataset.tool = state.tool
  }
  function afterEdit(message) {
    state.maxDur = longest(model.notes)
    vp.setMaxTime(model.end())
    if (message) say(message)
    syncUi(); invalidate()
  }
  const isTouch = (e) => e && (e.pointerType === 'touch' || e.pointerType === 'pen')
  const slopFor = (e) => (isTouch(e) ? 22 : 3)
  const handleFor = (e) => (isTouch(e) ? 16 : 8)
  const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }

  // ---------- audition ----------
  const sounding = new Map()
  function sound(pitch, vel = 100, ms = 450) {
    if (!audio || !audio.noteOn || state.destroyed) return
    try { if (sounding.has(pitch)) { win.clearTimeout(sounding.get(pitch)); audio.noteOff && audio.noteOff(pitch) } audio.noteOn(pitch, vel) } catch { return }
    sounding.set(pitch, win.setTimeout(() => { sounding.delete(pitch); try { audio.noteOff && audio.noteOff(pitch) } catch { /* ignore */ } }, ms))
  }
  function silence() { for (const [p, t] of sounding) { win.clearTimeout(t); try { audio && audio.noteOff && audio.noteOff(p) } catch { /* ignore */ } } sounding.clear() }

  // ---------- playback (built-in preview of the edited notes unless a transport is injected) ----------
  const own = { on: false, t0: 0, from: 0, timer: 0, cursor: 0, timers: new Set() }
  const playing = () => (transport ? !!transport.isPlaying() : own.on)
  const nowTime = () => {
    if (injectedTime && (transport || !own.on)) { const t = injectedTime(); if (Number.isFinite(t)) return t }
    return own.on ? own.from + (win.performance.now() - own.t0) / 1000 : state.cursor
  }
  function startPlay() {
    const from = model.selection.size ? Math.min(...model.selected().map((n) => n.start)) : state.cursor
    state.cursor = Math.max(0, model.selection.size ? from : state.cursor)
    if (transport) { transport.play(state.cursor); syncUi(); schedule(); return }
    stopPlay(false)
    own.on = true; own.from = state.cursor; own.t0 = win.performance.now(); own.cursor = own.from
    own.timer = win.setInterval(tick, 25)
    syncUi(); schedule()
  }
  function tick() {
    const t = own.from + (win.performance.now() - own.t0) / 1000
    const notes = model.notes
    const look = t + 0.06
    for (const n of notes) {
      if (n.start >= own.cursor && n.start < look) {
        const delay = Math.max(0, (n.start - t) * 1000)
        const id = win.setTimeout(() => { own.timers.delete(id); sound(n.pitch, n.vel, Math.max(60, n.dur * 1000)) }, delay)
        own.timers.add(id)
      }
      if (n.start >= look) break
    }
    own.cursor = look
    if (t > model.end() + 1) stopPlay(true)
  }
  function stopPlay(update = true) {
    if (transport) { transport.pause(); syncUi(); return }
    if (!own.on) return
    own.on = false
    win.clearInterval(own.timer)
    for (const id of own.timers) win.clearTimeout(id)
    own.timers.clear()
    silence()
    if (update) syncUi()
  }
  function togglePlay() { if (playing()) { stopPlay(); invalidate() } else startPlay() }

  // ---------- undo, tools, simple commands ----------
  function doUndo() { if (blocked()) return; if (model.undo()) afterEdit('Undone'); else say('Nothing to undo') }
  function doRedo() { if (blocked()) return; if (model.redo()) afterEdit('Redone'); else say('Nothing to redo') }
  function setTool(id) { state.tool = id; closePop(); syncUi(); say({ select: 'Select tool', draw: 'Add notes tool: tap or drag in the roll', erase: 'Erase tool: tap or sweep over notes' }[id]) }
  function setHand(id) {
    if (blocked()) return
    state.hand = id
    if (model.selection.size) { const n = model.setHand(null, id); if (n) afterEdit(`${n} ${n === 1 ? 'note' : 'notes'} now ${id} hand`) }
    syncUi(); invalidate()
  }
  function deleteSelected() {
    if (blocked()) return
    const n = model.deleteNotes()
    if (n) afterEdit(`${n} ${n === 1 ? 'note' : 'notes'} deleted. Undo brings them back.`)
  }
  function nudge(dt, dp) {
    if (blocked() || !model.selection.size) return
    const r = model.moveNotes(null, dt, dp)
    if (r) { const first = model.selected()[0]; if (first && dp) sound(first.pitch, first.vel); afterEdit() }
  }

  // ---------- popovers ----------
  function closePop() { state.pop = null; el.pop.hidden = true; el.pop.replaceChildren() }
  function togglePop(name) {
    if (blocked()) return
    if (state.pop === name) { closePop(); return }
    state.pop = name
    el.pop.replaceChildren()
    const row = (...kids) => H('div', { class: 'rl-pop-row' }, kids)
    const act = (label, fn, aria) => textBtn(label, () => { if (!blocked()) fn() }, aria)
    if (name === 'transpose') {
      const scope = model.selection.size ? 'selected notes' : 'the whole song'
      el.pop.append(H('p', { class: 'rl-pop-title', text: `Transpose ${scope}` }),
        row(...[[-12, '-8va'], [-1, '-1'], [1, '+1'], [12, '+8va']].map(([n, l]) => act(l, () => {
          const r = model.transpose(n)
          afterEdit(r.error || `Moved ${r.moved} ${r.moved === 1 ? 'note' : 'notes'} ${n > 0 ? 'up' : 'down'}`)
        }, `${n > 0 ? 'Up' : 'Down'} ${Math.abs(n) === 12 ? 'an octave' : Math.abs(n) + ' semitone'}`))))
    } else {
      const bpm = H('input', { type: 'number', class: 'rl-input', min: 20, max: 400, step: 'any', value: String(Math.round(model.tempo * 100) / 100), 'aria-label': 'Beats per minute', inputMode: 'decimal' })
      const split = H('input', { type: 'text', class: 'rl-input', value: 'C4', 'aria-label': 'Split pitch, like C4', size: 4 })
      el.pop.append(
        H('p', { class: 'rl-pop-title', text: 'Selection' }),
        row(act('Select all', () => { model.selectAll(); afterEdit(); closePop() }), act('Duplicate', () => { const k = model.duplicate(); afterEdit(k.length ? `Duplicated ${k.length} notes` : 'Select notes to duplicate'); closePop() }),
          act(state.marquee ? 'Box select: on' : 'Box select', () => { state.marquee = !state.marquee; closePop(); say(state.marquee ? 'Drag on empty space to select a box' : 'Drag on empty space to scroll') }, 'Box select with a finger')),
        row(act('Swap hands', () => { const n = model.swapHands(); afterEdit(`Swapped hands on ${n} notes`); closePop() }),
          act('Velocity -', () => adjustVelocity(-12), 'Softer'), act('Velocity +', () => adjustVelocity(12), 'Louder')),
        H('p', { class: 'rl-pop-title', text: 'Clean up' }),
        row(act('Melody only', () => { const r = model.simplify('melody'); afterEdit(r.removed ? `Removed ${r.removed} notes` : 'Nothing to remove'); closePop() }),
          act('Reduce chords', () => { const r = model.simplify('reduce'); afterEdit(r.removed ? `Removed ${r.removed} notes` : 'Nothing to remove'); closePop() }),
          act('Trim silence', () => { const r = model.trimSilence({ lead: 0, maxGap: 4, confirmDetach }); if (r.cancelled) { say('Nothing changed'); return }
           afterEdit(r.trimmed ? `Removed ${r.trimmed.toFixed(1)} s of silence` : 'No silence to trim'); closePop() })),
        row(H('label', { class: 'rl-lab', text: 'Hands split at' }, [split]), act('Split', () => {
          const p = parseNote(split.value)
          if (p == null) { say('Type a note like C4'); return }
          afterEdit(`Hands split at ${pitchLabel(p)}: ${model.splitHandsAt(p)} notes changed`); closePop()
        })),
        H('p', { class: 'rl-pop-title', text: 'Tempo and grid' }),
        row(H('label', { class: 'rl-lab', text: 'BPM' }, [bpm]),
          act('Change speed', () => { const r = model.changeTempo(bpm.value, { confirmDetach }); if (r.cancelled) { say('Nothing changed'); return }; afterEdit(r.error || `Tempo ${model.tempo} BPM, notes stretched`); if (!r.error) closePop() }, 'Change the tempo and stretch the notes'),
          act('Fit grid', () => { const r = model.setGridTempo(bpm.value); afterEdit(r.error || `Grid now ${model.tempo} BPM, notes unchanged`); if (!r.error) closePop() }, 'Change only the grid tempo')),
        row(act('Grid earlier', () => { model.nudgeGridOffset(-0.01); afterEdit(); say(`Grid offset ${model.gridOffset.toFixed(3)} s`) }), act('Grid later', () => { model.nudgeGridOffset(0.01); afterEdit(); say(`Grid offset ${model.gridOffset.toFixed(3)} s`) }),
          act('Grid to cursor', () => { model.setGridOffset(state.cursor); afterEdit(); say('Grid starts at the cursor') }, 'Put a grid line at the cursor')),
        row(act('Fit view', () => { vp.fit(model.notes); invalidate(); closePop() }),
          ...(openDetails ? [act('Fingers and tempo', () => { closePop(); done(openDetails) }, 'Save, then edit fingers, exact times and the tempo in a list')] : [])))
    }
    el.pop.hidden = false
    const first = el.pop.querySelector('button, input'); if (first && first.focus) first.focus({ preventScroll: true })
  }
  function adjustVelocity(d) {
    const sel = model.selected()
    if (!sel.length) { say('Select notes first'); return }
    const avg = Math.round(sel.reduce((s, n) => s + n.vel, 0) / sel.length)
    model.setVelocity(null, avg + d); afterEdit(`Velocity ${Math.max(1, Math.min(127, avg + d))}`)
  }
  function parseNote(text) {
    const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(String(text).trim())
    if (!m) { const n = Number(text); return Number.isInteger(n) && n >= 0 && n <= 127 ? n : null }
    const steps = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
    const p = (Number(m[3]) + 1) * 12 + steps[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0)
    return p >= 0 && p <= 127 ? p : null
  }

  // ---------- drawing ----------
  function resize() {
    const r = body.getBoundingClientRect()
    const dpr = win.devicePixelRatio || 1
    const w = Math.max(100, Math.floor(r.width)), h = Math.max(100, Math.floor(r.height))
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr)
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px'
    }
    vp.padBottom = win.getComputedStyle(el.toolbar).position === 'absolute' ? el.toolbar.offsetHeight + 14 : 0
    vp.setSize(w, h)
    invalidate()
  }
  function frame() {
    raf = 0
    if (state.destroyed) return
    const live = playing()
    if (live) {
      const t = nowTime()
      if (!state.gesture) vp.reveal(t)
      state.dirtyDraw = true
    }
    if (state.dirtyDraw) { state.dirtyDraw = false; draw(live ? nowTime() : null) }
    if (live) schedule()
  }
  function draw(playTime) {
    if (!colors) readColors()
    const dpr = win.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const W = vp.width, Hh = vp.height
    ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, W, Hh)
    const [t0, t1] = vp.visibleTime()
    const [p0, p1] = vp.visiblePitches()
    // pitch rows
    ctx.save(); ctx.beginPath(); ctx.rect(KEYS_W, RULER, W - KEYS_W, Hh - RULER); ctx.clip()
    for (let p = p0; p <= p1; p++) {
      const y = vp.pitchToY(p)
      if (isBlackKey(p)) { ctx.fillStyle = 'rgba(255,255,255,0.025)'; ctx.fillRect(KEYS_W, y, W - KEYS_W, vp.pxPerSemi) }
      if (p % 12 === 0) { ctx.fillStyle = colors.line; ctx.fillRect(KEYS_W, y + vp.pxPerSemi - 0.5, W - KEYS_W, 1) }
    }
    // grid
    const stepPx = vp.pxPerSec * model.step
    const per = stepPx >= 14 ? model.division : 1
    for (const g of model.gridLines(t0 - 0.01, t1 + 0.01, per)) {
      const x = Math.round(vp.timeToX(g.t)) + 0.5
      ctx.fillStyle = g.bar ? colors.lineStrong : g.beat ? colors.line : 'rgba(255,255,255,0.035)'
      ctx.fillRect(x - (g.bar ? 0.5 : 0), RULER, g.bar ? 1.5 : 1, Hh - RULER)
    }
    // notes (only the visible ones)
    const vis = visibleNotes(model.notes, t0, t1, p0, p1, state.maxDur)
    const sel = model.selection
    const showLabel = vp.pxPerSemi >= 14
    for (const n of vis) {
      const r = noteRect(vp, n)
      ctx.globalAlpha = 0.5 + 0.5 * (n.vel / 127)
      ctx.fillStyle = n.hand === 'left' ? colors.left : colors.right
      roundRect(ctx, r.x, r.y, r.w, r.h, Math.min(4, r.h / 3)); ctx.fill()
      ctx.globalAlpha = 1
      if (sel.has(n.key)) {
        ctx.lineWidth = 2; ctx.strokeStyle = colors.text
        roundRect(ctx, r.x - 1, r.y - 1, r.w + 2, r.h + 2, Math.min(5, r.h / 3 + 1)); ctx.stroke()
        ctx.fillStyle = colors.text                                  // resize grip on the right edge
        roundRect(ctx, r.x + r.w - 5, r.y + r.h * 0.25, 3, r.h * 0.5, 1.5); ctx.fill()
      }
      if (showLabel && r.w > 30) { ctx.fillStyle = colors.ink; ctx.font = '600 10px system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.fillText(pitchLabel(n.pitch), r.x + 4, r.y + r.h / 2 + 0.5) }
    }
    const g = state.gesture
    if (g && g.kind === 'marquee') {
      ctx.fillStyle = colors.accent; ctx.strokeStyle = colors.accent; ctx.lineWidth = 1
      const x = Math.min(g.x0, g.x), y = Math.min(g.y0, g.y), w = Math.abs(g.x - g.x0), h2 = Math.abs(g.y - g.y0)
      ctx.globalAlpha = 0.12; ctx.fillRect(x, y, w, h2); ctx.globalAlpha = 1; ctx.strokeRect(x + 0.5, y + 0.5, w, h2)
    }
    // play position and cursor
    const cx = vp.timeToX(state.cursor)
    if (cx >= KEYS_W && cx <= W) { ctx.fillStyle = colors.accent; ctx.globalAlpha = 0.5; ctx.fillRect(Math.round(cx), RULER, 1, Hh - RULER); ctx.globalAlpha = 1 }
    if (playTime != null) {
      const x = vp.timeToX(playTime)
      if (x >= KEYS_W && x <= W) { ctx.fillStyle = colors.accent; ctx.fillRect(Math.round(x) - 1, RULER, 2, Hh - RULER) }
    }
    ctx.restore()
    // ruler: bar numbers, a tap here moves the cursor
    ctx.fillStyle = colors.surface; ctx.fillRect(KEYS_W, 0, W - KEYS_W, RULER)
    ctx.save(); ctx.beginPath(); ctx.rect(KEYS_W, 0, W - KEYS_W, RULER); ctx.clip()
    ctx.font = '600 11px system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.fillStyle = colors.muted
    for (const gl of model.gridLines(t0 - 0.01, t1 + 0.01, 1)) {
      if (!gl.bar) continue
      const bar = Math.round((gl.t - model.gridOffset) / model.beat / model.beatsPerBar) + 1
      const x = vp.timeToX(gl.t)
      ctx.fillRect(Math.round(x), 6, 1, RULER - 6)
      if (vp.pxPerSec * model.beat * model.beatsPerBar > 34) ctx.fillText(String(bar), x + 4, RULER / 2)
    }
    const rx = vp.timeToX(playTime != null ? playTime : state.cursor)
    ctx.fillStyle = colors.accent
    if (rx >= KEYS_W && rx <= W) { ctx.beginPath(); ctx.moveTo(rx - 6, 0); ctx.lineTo(rx + 6, 0); ctx.lineTo(rx, 11); ctx.closePath(); ctx.fill() }
    ctx.restore()
    // key gutter
    ctx.fillStyle = colors.surface; ctx.fillRect(0, 0, KEYS_W, RULER)
    ctx.save(); ctx.beginPath(); ctx.rect(0, RULER, KEYS_W, Hh - RULER); ctx.clip()
    for (let p = p0; p <= p1; p++) {
      const y = vp.pitchToY(p)
      const black = isBlackKey(p)
      ctx.fillStyle = state.pressedKey === p ? colors.accent : black ? '#10131f' : '#d9d8d2'
      ctx.fillRect(0, y, black ? KEYS_W * 0.62 : KEYS_W, vp.pxPerSemi - 0.5)
      if (p % 12 === 0 && vp.pxPerSemi >= 10) { ctx.fillStyle = '#1a1d2a'; ctx.font = '600 10px system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.fillText(pitchLabel(p), KEYS_W - 24, y + vp.pxPerSemi / 2) }
    }
    ctx.fillStyle = colors.lineStrong; ctx.fillRect(KEYS_W - 1, RULER, 1, Hh - RULER)
    ctx.restore()
  }
  function roundRect(c, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2))
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath()
  }

  // ---------- pointer gestures ----------
  const pointerList = () => [...state.pointers.values()]
  function pitchAt(y) { return Math.max(0, Math.min(127, vp.yToPitch(y))) }
  function startPinch() {
    if (state.gesture) cancelGesture()
    const [a, b] = pointerList()
    state.gesture = { kind: 'pinch', a0: { ...a }, b0: { ...b }, pa: { ...a }, pb: { ...b } }
  }
  function cancelGesture() {
    const g = state.gesture
    if (g && (g.kind === 'move' || g.kind === 'resize')) { model.draft.restoreBase(); model.endGesture(); afterEdit() }
    else if (g && g.kind === 'draw') { model.endGesture(); model.undo(); afterEdit() }       // the added note goes with its undo step
    else if (g && g.kind === 'erase' && g.began) { model.endGesture(); model.undo(); afterEdit() }
    if (g && g.timer) win.clearTimeout(g.timer)
    stopAutoScroll()
    state.gesture = null
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (blocked()) return
    canvas.focus({ preventScroll: true })
    closePopIfOutside()
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return
    const p = local(e)
    state.pointers.set(e.pointerId, { x: p.x, y: p.y, id: e.pointerId })
    try { canvas.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    if (state.pointers.size === 2) { startPinch(); e.preventDefault(); return }
    if (state.pointers.size > 2) return
    if (e.button === 1) { state.gesture = { kind: 'pan', x: p.x, y: p.y }; e.preventDefault(); return }
    const additive = e.shiftKey || e.metaKey || e.ctrlKey || state.multi
    // gutter: play that key; ruler: move the cursor
    if (p.x < KEYS_W && p.y >= RULER) { const pitch = pitchAt(p.y); state.pressedKey = pitch; sound(pitch, 100, 600); state.gesture = { kind: 'keys', pitch }; invalidate(); return }
    if (p.y < RULER) { state.cursor = Math.max(0, vp.xToTime(p.x)); if (playing()) { stopPlay(); } state.gesture = { kind: 'scrub' }; invalidate(); return }
    const hit = hitTest(vp, model.notes, p.x, p.y, { slop: slopFor(e), handle: handleFor(e), selected: model.selection, maxDur: state.maxDur })
    const base = { x0: p.x, y0: p.y, x: p.x, y: p.y, moved: false, touch: isTouch(e), additive }
    if (state.tool === 'erase') {
      state.gesture = { kind: 'erase', ...base, erased: 0 }
      if (hit) { eraseAt(p.x, p.y, e) }
      return
    }
    if (hit) {
      const wasSelected = model.selection.has(hit.key)
      if (!wasSelected) { model.select([hit.key], additive); afterEdit() }
      if (hit.zone === 'end') {
        model.beginGesture()
        const anchor = model.selected().reduce((m, n) => (n.start + n.dur > m.start + m.dur ? n : m))
        state.gesture = { kind: 'resize', ...base, keys: [...model.selection], grabDx: vp.timeToX(anchor.start + anchor.dur) - p.x }
      } else {
        const note = hit.note
        model.beginGesture()
        state.gesture = { kind: 'move', ...base, keys: [...model.selection], key: hit.key, wasSelected, origPitch: note.pitch, lastPitch: note.pitch }
        sound(note.pitch, note.vel)
      }
      return
    }
    // empty space
    if (state.tool === 'draw') { beginDraw(p, base, e); return }
    state.gesture = { kind: e.pointerType === 'mouse' || state.marquee ? 'marquee' : 'panWait', ...base }
    state.gesture.timer = win.setTimeout(() => {   // long press adds a note
      const g = state.gesture
      if (blocked() || !g || g.moved || (g.kind !== 'marquee' && g.kind !== 'panWait') || state.pointers.size !== 1) return
      g.timer = 0
      beginDraw({ x: g.x0, y: g.y0 }, g, e, true)
      if (win.navigator && win.navigator.vibrate && !prefersReducedMotion()) win.navigator.vibrate(8)
    }, LONG_PRESS_MS)
  }, own_)
  const prefersReducedMotion = () => !!(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches)
  function beginDraw(p, base, e, fromLongPress = false) {
    const pitch = pitchAt(p.y)
    const t = model.snap ? model.snapTime(vp.xToTime(p.x)) : Math.max(0, vp.xToTime(p.x))
    model.beginGesture()
    const key = model.addNote(pitch, t, model.snap ? Math.max(model.step, model.beat / 2) : 0.25, state.hand)
    if (key == null) { model.endGesture(); state.gesture = null; return }
    model.select([key]); model.rebaseGesture(); afterEdit()
    const note = model.byKey(key)
    sound(pitch, note.vel)
    state.gesture = { ...base, kind: 'draw', key, startTime: note.start, grabDx: 0, keys: [key], moved: false, lp: fromLongPress }
  }
  function eraseAt(x, y, e) {
    const hit = hitTest(vp, model.notes, x, y, { slop: slopFor(e), handle: 0, maxDur: state.maxDur })
    if (!hit) return
    if (!state.gesture.began) { model.beginGesture(); state.gesture.began = true }
    const note = hit.note
    model.draft.change(() => { model.draft.notes = model.draft.notes.filter((n) => n.key !== note.key) })
    model.selection.delete(note.key)
    state.gesture.erased++
    afterEdit()
  }
  canvas.addEventListener('pointermove', (e) => {
    if (state.destroyed) return
    const tracked = state.pointers.get(e.pointerId)
    if (!tracked) {
      if (e.pointerType === 'mouse' && !state.gesture) {    // hover cursor: resize near the edge of a note
        const p = local(e)
        const hit = hitTest(vp, model.notes, p.x, p.y, { slop: 2, handle: 8, selected: model.selection, maxDur: state.maxDur })
        canvas.style.cursor = !hit ? (state.tool === 'draw' ? 'crosshair' : 'default') : hit.zone === 'end' ? 'ew-resize' : state.tool === 'erase' ? 'not-allowed' : 'grab'
      }
      return
    }
    const p = local(e)
    const prev = { ...tracked }
    tracked.x = p.x; tracked.y = p.y
    const g = state.gesture
    if (!g) return
    e.preventDefault()
    if (g.kind === 'pinch') {
      const [a, b] = pointerList()
      const f = pinchFactors(g.pa, g.pb, a, b)
      const midPrev = { x: (g.pa.x + g.pb.x) / 2, y: (g.pa.y + g.pb.y) / 2 }, mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      vp.zoomAt(midPrev.x, midPrev.y, f.fx, f.fy)
      vp.panBy(mid.x - midPrev.x, mid.y - midPrev.y)
      g.pa = { ...a }; g.pb = { ...b }
      invalidate(); return
    }
    if (g.kind === 'pan') { vp.panBy(p.x - prev.x, p.y - prev.y); invalidate(); return }
    if (g.kind === 'keys') { const pitch = pitchAt(p.y); if (pitch !== g.pitch && p.x < KEYS_W * 1.5) { g.pitch = pitch; state.pressedKey = pitch; sound(pitch, 100, 600); invalidate() } return }
    if (g.kind === 'scrub') { state.cursor = Math.max(0, vp.xToTime(p.x)); invalidate(); return }
    g.x = p.x; g.y = p.y
    const dist = Math.hypot(p.x - g.x0, p.y - g.y0)
    if (!g.moved && dist > (g.touch ? 8 : 4)) { g.moved = true; if (g.timer) { win.clearTimeout(g.timer); g.timer = 0 } }
    if (!g.moved) return
    if (g.kind === 'panWait') { g.kind = 'panning'; g.px = g.x0; g.py = g.y0 }
    if (g.kind === 'panning') { vp.panBy(p.x - g.px, p.y - g.py); g.px = p.x; g.py = p.y; invalidate(); return }
    if (g.kind === 'marquee') { invalidate(); return }
    if (g.kind === 'erase') { eraseAt(p.x, p.y, e); return }
    applyDrag(g, e)
    autoScrollFor(g, p)
  }, own_)
  function applyDrag(g, e) {
    if (g.kind === 'move') {
      const dStart = (g.x - g.x0) / vp.pxPerSec + (g.scrolled || 0)
      const dPitch = pitchAt(g.y) - pitchAt(g.y0)
      const r = model.moveToGrid(g.keys, dStart, dPitch)
      const note = model.byKey(g.key)
      if (note && note.pitch !== g.lastPitch) { g.lastPitch = note.pitch; sound(note.pitch, note.vel) }
      if (r) afterEdit()
    } else if (g.kind === 'resize' || g.kind === 'draw') {
      const endT = vp.xToTime(g.x + (g.grabDx || 0))
      model.resizeToEnd(g.keys, endT)
      afterEdit()
    }
  }
  // scroll sideways while a drag is held near an edge
  let autoTimer = 0, autoDir = 0
  function autoScrollFor(g, p) {
    if (g.kind !== 'move' && g.kind !== 'resize' && g.kind !== 'draw') return
    const dir = p.x > vp.width - 36 ? 1 : p.x < KEYS_W + 28 ? -1 : 0
    autoDir = dir
    if (dir && !autoTimer) autoTimer = win.setInterval(() => {
      const gg = state.gesture
      if (!gg || !autoDir) { stopAutoScroll(); return }
      const dt = autoDir * 260 / vp.pxPerSec / 20
      const before = vp.t0
      vp.t0 = Math.max(-0.5, vp.t0 + dt); vp.clampScroll()
      gg.scrolled = (gg.scrolled || 0) + (vp.t0 - before)
      applyDrag(gg, null)
    }, 50)
    if (!dir) stopAutoScroll()
  }
  function stopAutoScroll() { autoDir = 0; if (autoTimer) { win.clearInterval(autoTimer); autoTimer = 0 } }
  function finish(e) {
    if (state.destroyed) return
    const g = state.gesture
    state.pointers.delete(e.pointerId)
    try { canvas.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
    if (g && g.kind === 'pinch') { if (state.pointers.size < 2) state.gesture = null; return }
    if (state.pointers.size > 0) return
    state.gesture = null
    stopAutoScroll()
    if (!g) return
    if (g.timer) win.clearTimeout(g.timer)
    if (g.kind === 'keys') { state.pressedKey = null; invalidate(); return }
    if (g.kind === 'move') {
      model.endGesture()
      if (!g.moved && g.wasSelected) { if (g.additive) model.toggle(g.key); else if (model.selection.size > 1) model.select([g.key]) }
      afterEdit(g.moved ? `Moved. ${model.summary()}` : undefined)
    } else if (g.kind === 'resize') { model.endGesture(); afterEdit(g.moved ? 'Length changed' : undefined) }
    else if (g.kind === 'draw') { model.endGesture(); afterEdit(`Note added: ${pitchLabel(model.byKey(g.key)?.pitch ?? 0)}`) }
    else if (g.kind === 'erase') { if (g.began) { model.endGesture(); say(`${g.erased} ${g.erased === 1 ? 'note' : 'notes'} erased. Undo brings them back.`) } afterEdit() }
    else if (g.kind === 'marquee') {
      if (g.moved) {
        const keys = notesInRect(vp, model.notes, g.x0, g.y0, g.x, g.y, state.maxDur).map((n) => n.key)
        model.select(keys, g.additive); afterEdit(model.summary())
      } else { if (!g.additive) model.clearSelection(); afterEdit() }
    } else if (g.kind === 'panWait') { if (!g.additive) model.clearSelection(); afterEdit() }
    else invalidate()
  }
  canvas.addEventListener('pointerup', finish, own_)
  canvas.addEventListener('pointercancel', (e) => { if (state.destroyed) return; state.pointers.delete(e.pointerId); cancelGesture(); state.pointers.clear() }, own_)
  canvas.addEventListener('contextmenu', (e) => e.preventDefault(), own_)
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    const p = local(e)
    let dx = e.deltaX, dy = e.deltaY
    if (e.deltaMode === 1) { dx *= 16; dy *= 16 }
    if (e.ctrlKey || e.metaKey) vp.zoomAt(p.x, p.y, Math.exp(-dy * 0.01), 1)
    else if (e.altKey) vp.zoomAt(p.x, p.y, 1, Math.exp(-dy * 0.01))
    else if (e.shiftKey && !dx) vp.panBy(-dy, 0)
    else vp.panBy(-dx, -dy)
    invalidate()
  }, { passive: false, signal: life.signal })
  function closePopIfOutside() { if (state.pop) closePop() }

  // ---------- keyboard ----------
  canvas.addEventListener('keydown', (e) => onKey(e), own_)
  host.addEventListener('keydown', (e) => {
    e.stopPropagation()                              // the player's shortcuts must not fire under the editor
    if (blocked()) { if (e.key !== 'Tab') e.preventDefault(); return }     // a save is running: no shortcut edits the draft
    if (e.target === canvas) return
    const t = e.target
    if (e.key === 'Escape') { if (state.pop) { closePop(); e.preventDefault() } else cancel() }
    if ((e.metaKey || e.ctrlKey) && !(t instanceof HTMLInputElement) && ['z', 'y'].includes(e.key.toLowerCase())) onKey(e)
  }, own_)
  function onKey(e) {
    if (blocked()) { if (e.key !== 'Tab') e.preventDefault(); e.stopPropagation(); return }
    const key = e.key, mod = e.metaKey || e.ctrlKey, k = key.toLowerCase()
    const step = model.snap ? model.step : 0.05
    let handled = true
    if (mod && k === 'z') { if (e.shiftKey) doRedo(); else doUndo() }
    else if (mod && k === 'y') doRedo()
    else if (mod && k === 'a') { model.selectAll(); afterEdit(model.summary()) }
    else if (mod && k === 'd') { const ks = model.duplicate(); afterEdit(ks.length ? `Duplicated ${ks.length} notes` : 'Select notes to duplicate') }
    else if (mod && k === 's') done()
    else if (key === 'Delete' || key === 'Backspace') deleteSelected()
    else if (key === 'ArrowLeft') nudge(-step, 0)
    else if (key === 'ArrowRight') nudge(step, 0)
    else if (key === 'ArrowUp') nudge(0, e.shiftKey ? 12 : 1)
    else if (key === 'ArrowDown') nudge(0, e.shiftKey ? -12 : -1)
    else if (key === ' ') togglePlay()
    else if (key === 'Escape') { if (state.pop) closePop(); else if (model.selection.size) { model.clearSelection(); afterEdit(model.summary()) } else cancel() }
    else if (key === ']' || key === '[') selectNeighbour(key === ']' ? 1 : -1)
    else if (!mod && k === 'v') setTool('select')
    else if (!mod && k === 'p') setTool('draw')
    else if (!mod && k === 'e') setTool('erase')
    else if (key === '+' || key === '=') { vp.zoomAt(vp.width / 2, vp.height / 2, 1.25, 1); invalidate() }
    else if (key === '-') { vp.zoomAt(vp.width / 2, vp.height / 2, 0.8, 1); invalidate() }
    else handled = false
    if (handled) { e.preventDefault(); e.stopPropagation() }
  }
  // keyboard and screen-reader route: [ and ] step through the notes in time order
  function selectNeighbour(dir) {
    const notes = model.notes
    if (!notes.length) return
    const cur = [...model.selection].map((k) => notes.findIndex((n) => n.key === k)).filter((i) => i >= 0)
    let i = cur.length ? (dir > 0 ? Math.max(...cur) + 1 : Math.min(...cur) - 1) : (dir > 0 ? 0 : notes.length - 1)
    i = Math.max(0, Math.min(notes.length - 1, i))
    const n = notes[i]
    model.select([n.key]); sound(n.pitch, n.vel)
    if (vp.timeToX(n.start) < KEYS_W || vp.timeToX(n.start) > vp.width - 40) vp.t0 = Math.max(-0.5, n.start - 0.5)
    vp.pTop = Math.max(vp.pTop, n.pitch + 2); if (n.pitch < vp.pBottom) vp.pTop = n.pitch + vp.rollH / vp.pxPerSemi - 2
    vp.clampScroll()
    afterEdit(`Note ${i + 1} of ${notes.length}: ${pitchLabel(n.pitch)} at ${n.start.toFixed(2)} s`)
  }

  // ---------- finish ----------
  async function done(after = null) {
    if (blocked()) return
    stopPlay()
    commitGesture()                                    // a drag in progress is part of what the user sees: it becomes a normal undo step first
    // nothing changed: just close (but a bundled song's Save as my copy still makes the copy)
    if (!asCopy && !model.dirty && JSON.stringify(model.gridRecord()) === gridAtOpen) { destroy(); if (after) after(); return }
    const { song: out, error } = model.build()
    if (error) { say(error, true); notice(error); return }
    setBusy(true)
    say('Saving', true)
    try { await saveSong(out); destroy(); notice(out.id === undefined ? 'Saved as your own copy' : 'Notes saved'); if (after) after() }
    catch (err) {
      setBusy(false)                                   // the editor stays open with everything as it was, and the error stays on screen
      const message = 'Could not save: ' + (err && err.message ? err.message : String(err))
      say(message, true); notice(message)
    }
  }
  // Finish the gesture in progress as if the pointer had been lifted where it is (the change and its undo step stay in the draft).
  function commitGesture() {
    const g = state.gesture
    if (!g) return
    if (g.timer) win.clearTimeout(g.timer)
    stopAutoScroll()
    if (g.kind === 'move' || g.kind === 'resize' || g.kind === 'draw' || (g.kind === 'erase' && g.began)) { model.endGesture(); afterEdit() }
    for (const id of state.pointers.keys()) { try { canvas.releasePointerCapture(id) } catch { /* ignore */ } }
    state.pointers.clear(); state.gesture = null
    if (g.kind === 'keys') { state.pressedKey = null; invalidate() }
  }
  // While a save is pending the draft must not change (the editor closes when it succeeds, so edits would be lost):
  // every control is disabled and shows the busy look, canvas gestures and shortcuts are refused (blocked()).
  function setBusy(on) {
    if (on) {
      state.saving = true
      cancelGesture(); closePop(); stopPlay(false); silence()
      for (const c of host.querySelectorAll('button, select, input')) { c.dataset.rlWasDisabled = c.disabled ? '1' : ''; c.disabled = true }
      host.classList.add('rl-busy'); host.setAttribute('aria-busy', 'true')
      el.done.textContent = 'Saving'
    } else {
      state.saving = false
      for (const c of host.querySelectorAll('button, select, input')) { c.disabled = c.dataset.rlWasDisabled === '1'; delete c.dataset.rlWasDisabled }
      host.classList.remove('rl-busy'); host.removeAttribute('aria-busy')
      el.done.textContent = doneLabel
      syncUi(); invalidate()
    }
  }
  // Returns true when the editor was really closed (false: saving, or the user kept their changes).
  function cancel() {
    if (state.destroyed) return true
    if (state.saving) return false
    if (model.dirty && !confirmDiscard('Discard your changes to these notes?')) return false
    destroy()
    return true
  }
  let ro = null
  function destroy() {
    if (state.destroyed) return
    state.destroyed = true
    // stop everything that could still fire: gesture and status timers, auto-scroll, playback, sounding notes, frames, listeners
    const g = state.gesture
    if (g && g.timer) win.clearTimeout(g.timer)
    for (const id of state.pointers.keys()) { try { canvas.releasePointerCapture(id) } catch { /* ignore */ } }
    state.pointers.clear(); state.gesture = null
    win.clearTimeout(sayTimer)
    stopPlay(false); silence(); stopAutoScroll()
    life.abort()
    if (ro) ro.disconnect()
    win.removeEventListener('resize', resize)
    if (raf) { win.cancelAnimationFrame(raf); raf = 0 }
    host.classList.remove('rl', 'rl-busy'); host.removeAttribute('aria-busy'); host.replaceChildren()
    onClose()
  }

  // ---------- start ----------
  if (win.ResizeObserver) { ro = new win.ResizeObserver(resize); ro.observe(body) }
  win.addEventListener('resize', resize, own_)
  readColors()
  resize()
  vp.setMaxTime(model.end())
  vp.fit(model.notes)
  syncUi()
  say(`${model.notes.length} notes. Tap a note to select it, drag to move, drag its right edge to resize.`)
  invalidate()
  return {
    model, viewport: vp, destroy, redraw: invalidate, setTool, play: startPlay, stop: stopPlay, done, cancel,
    get state() { return state }
  }
}

// mountRoll: the full-screen overlay version, opened for the song in the player.
export function mountRoll({ getSong, saveSong, notice = () => {}, openDetails = null, audio = null, getTime = null, transport = null, pushOverlay = null, root = document.body, onOpen = () => {}, onClose = () => {} }) {
  let overlay = null, controller = null, popToken = null
  function close() { if (controller) controller.destroy() }
  async function open() {
    if (controller) return
    const song = await getSong()
    if (!song || !Array.isArray(song.notes) || !song.notes.length) { notice('Open a song to edit its notes'); return }
    overlay = H('div', { class: 'rl-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Edit notes' })
    root.append(overlay)
    onOpen()
    controller = mountRollEditor(overlay, {
      song, audio, saveSong, notice, getTime, transport, openDetails,
      onClose: () => { overlay.remove(); overlay = null; controller = null; if (popToken) { popToken(); popToken = null } onClose() }
    })
    // Back closes the top overlay: the navigation stack pops it BEFORE calling us, so if the user keeps their changes (or a save
    // is running) the editor stays open and must be registered again, or the next Back would navigate underneath it.
    const register = () => {
      if (!pushOverlay) return
      popToken = pushOverlay(() => { if (!controller) return; controller.cancel(); if (controller) register() })
    }
    register()
    const canvas = overlay.querySelector('canvas'); if (canvas) canvas.focus({ preventScroll: true })
  }
  return { open, close, isOpen: () => !!controller, get controller() { return controller }, get overlay() { return overlay } }
}
