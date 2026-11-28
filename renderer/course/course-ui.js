// The course screens: level map, lesson page, level exam page and the quiz card, plus the
// Home card. Presentation and progress only. Playing an item (the player, the keyboard, the
// results dialog) is app.js's job: it hands in runItem(item, { ownerId, levelNum }) and calls
// record() when a run ends. Progress lives in localStorage under 'lumi.course'; the Course order
// setting ('guided' or 'open') under 'lumi.courseOrder'. A later lesson, level or exam is 'ahead',
// and Guided order offers the recommended one first. The app supplies access for paid levels.
import {
  COURSE, courseSummary, levelSummary, lessonStatus, isLessonDone, lessonItemStates, isItemDone,
  nextStep, examStatus, examScore, isLevelUnlocked, unlockLevel, recordItemResult, recordExamResult,
  parseProgress, serializeProgress, emptyProgress, ownGet, placedAt, PROGRESS_VERSION
} from './index.js'
import { IS_IOS } from '../platform.js'
import { caps, dot, up } from '../studio-copy.js'
import { playableCourse, isRunnable, findOwner, TYPE_LABEL, passText } from './runners.js'
import {
  placementLevels, nextPlacementLevel, startPlacement, skipPlacement, stopPlacement, afterPlacementExam,
  placementStart, withPlacement, placementCard, placementMessage
} from './placement.js'

// What a level is, in words that name no exam board (the iPhone/iPad app shows these instead of the grade text)
export function levelStage(number) {
  return number <= 2 ? 'Beginner' : number <= 4 ? 'Early elementary' : number <= 6 ? 'Elementary' : number <= 8 ? 'Intermediate' : number === 9 ? 'Upper intermediate' : 'Advanced'
}
export const levelTag = (level, neutral = IS_IOS) => (neutral ? levelStage(level.number) : level.grade)

export const COURSE_KEY = 'lumi.course'
export const ORDER_KEY = 'lumi.courseOrder'
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const pct = (x) => Math.round(x * 100)

/* ---------- small icons (24 grid, stroked with currentColor) ---------- */
const ICON = {
  keys: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M7.2 6v12M12 6v12M16.8 6v12"/><path d="M5.6 6v6.5M9.6 6v6.5M14.4 6v6.5M19 6v6.5" stroke-width="2.6"/>',
  tune: '<path d="M9 17.5V6l11-2v11.5"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="15.5" r="2.5"/>',
  game: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
  quiz: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.6a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.2 1-1.2 1.8"/><circle cx="12" cy="16.8" r=".6" fill="currentColor"/>',
  echo: '<path d="M4 12h2M8 8v8M12 5v14M16 8v8M20 12h-2"/>',
  rhythm: '<path d="M9 3h6l3.5 18h-13z"/><path d="m12 15 5-8"/>',
  ear: '<path d="M7 9.5a5 5 0 0 1 10 0c0 3-2.4 3.6-3 5.5-.5 1.6-1.2 3-3 3a3 3 0 0 1-3-3"/><path d="M10 9.5a2 2 0 0 1 4 0"/>',
  sight: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
  chevron: '<path d="m9.5 5 7 7-7 7"/>',
  back: '<path d="m14.5 5-7 7 7 7"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  star: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z"/>',
  flag: '<path d="M6 21V4M6 5h11l-2 4 2 4H6"/>',
  tip: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/>',
  five: '<path d="M4 19v-4M8 19v-7M12 19V9M16 19V6M20 19V4"/>',
  stairs: '<path d="M3 19h4v-4h4v-4h4V7h4"/>',
  arp: '<circle cx="5" cy="17" r="1.7"/><circle cx="10" cy="12.5" r="1.7"/><circle cx="15" cy="8.5" r="1.7"/><circle cx="20" cy="5" r="1.7"/>',
  stack: '<circle cx="12" cy="6" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="12" cy="18" r="2.2"/><path d="M5.5 4v16"/>'
}
const icon = (name, cls = 'cr-ic') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON[name] || ''}</svg>`
const TYPE_ICON = { 'five-finger': 'five', scale: 'stairs', arpeggio: 'arp', chord: 'stack', piece: 'tune', notegame: 'game', theory: 'quiz', echo: 'echo', rhythm: 'rhythm', ear: 'ear', sight: 'sight' }
// one plain line for what a task asks, shown under its name on an exam (the hand comes from the task's own settings)
const HAND_WORD = { right: 'right hand', left: 'left hand', both: 'both hands' }
export function taskLine(item) {
  const p = item.params || {}
  const hand = HAND_WORD[p.hand || p.tb?.hand] || ''
  const lines = {
    'five-finger': `Five notes in a row, one finger each${hand ? ', ' + hand : ''}`,
    scale: `Play the scale up and down${hand ? ', ' + hand : ''}`,
    arpeggio: `Play the broken chord${hand ? ', ' + hand : ''}`,
    chord: `Play the chords${hand ? ', ' + hand : ''}`,
    piece: `Play the tune${hand ? ', ' + hand : ''}${Array.isArray(p.notes) ? ', ' + p.notes.length + ' notes' : ''}`,
    notegame: 'Find the named notes on the keys',
    theory: 'Answer one question',
    rhythm: 'Tap the pattern in time',
    ear: 'Listen, then play it back',
    sight: 'Play what you read',
    echo: 'Play back what you hear'
  }
  return lines[item.type] || (TYPE_LABEL[item.type] || '')
}

/* ---------- diagrams ---------- */
const WHITE_PC = [0, 2, 4, 5, 7, 9, 11]
const LETTER = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const pc = (p) => ((p % 12) + 12) % 12
const isWhite = (p) => WHITE_PC.includes(pc(p))

/** The first bar of a lesson as notes the Home rail can play once: [{ p: midi, at: beats, beats, hand: 'l' | 'r' }], or null when it has none. */
export function firstBar(lesson, maxBeats = 4) {
  for (const it of lesson?.items || []) {
    const q = it.params || {}
    if (Array.isArray(q.notes) && q.notes.length) {
      const hand = q.hand === 'left' ? 'l' : 'r', out = []
      let t = 0
      for (const n of q.notes) { if (t >= maxBeats || !Number.isFinite(n.p)) break; out.push({ p: n.p, at: t, beats: n.beats || 1, hand }); t += n.beats || 1 }
      if (out.length) return out
    }
    if (q.tb && Number.isFinite(q.tb.tonic) && (q.tb.type === 'five' || q.tb.type === 'scale')) {
      const hand = q.tb.hand === 'left' ? 'l' : 'r', base = (hand === 'l' ? 48 : 60) + q.tb.tonic
      return [0, 2, 4, 5].map((o, i) => ({ p: base + o, at: i, beats: 1, hand }))
    }
  }
  return null
}

/** A mini keyboard: d = { range: [lo, hi], highlight?, names?, fingers?: { pitch: 1..5 } }. */
export function keysDiagram(d) {
  const [lo, hi] = d.range
  const hl = new Set(d.highlight || [])
  const fingers = d.fingers || {}
  const W = 38, H = 128, BW = 23, BH = 76
  const whites = []
  for (let p = lo; p <= hi; p++) if (isWhite(p)) whites.push(p)
  const width = whites.length * W
  const idx = new Map(whites.map((p, i) => [p, i]))
  let out = ''
  for (const p of whites) {
    const x = idx.get(p) * W
    out += `<rect x="${x + 1}" y="1" width="${W - 2}" height="${H - 2}" rx="5" class="dk-w${hl.has(p) ? ' hl' : ''}"/><rect x="${x + 1}" y="1" width="${W - 2}" height="${H - 2}" rx="5" class="dk-glow dk-gw"/>`
    if (d.names) out += `<text x="${x + W / 2}" y="${H - 11}" text-anchor="middle" class="dk-name${hl.has(p) ? ' hl' : ''}">${LETTER[pc(p)]}</text>`
    if (fingers[p]) out += `<circle cx="${x + W / 2}" cy="${H - 46}" r="11" class="dk-fing"/><text x="${x + W / 2}" y="${H - 41.5}" text-anchor="middle" class="dk-fnum">${fingers[p]}</text>`
  }
  for (let p = lo; p <= hi; p++) {
    if (isWhite(p)) continue
    const prev = idx.get(p - 1)
    if (prev === undefined) continue
    const x = (prev + 1) * W - BW / 2
    out += `<rect x="${x}" y="1" width="${BW}" height="${BH}" rx="4" class="dk-b${hl.has(p) ? ' hl' : ''}"/><rect x="${x + 2.5}" y="2.5" width="${BW - 5}" height="${BH - 9}" rx="2.5" class="dk-bface"/><rect x="${x}" y="1" width="${BW}" height="${BH}" rx="4" class="dk-glow dk-gb"/>`
    if (d.names && hl.has(p)) out += `<text x="${x + BW / 2}" y="${BH - 9}" text-anchor="middle" class="dk-name bl">${LETTER[pc(p)]}</text>`
    if (fingers[p]) out += `<circle cx="${x + BW / 2}" cy="${BH - 30}" r="9.5" class="dk-fing"/><text x="${x + BW / 2}" y="${BH - 26.5}" text-anchor="middle" class="dk-fnum">${fingers[p]}</text>`
  }
  const names = [...hl].filter((p) => p >= lo && p <= hi).sort((a, b) => a - b).map((p) => LETTER[pc(p)]).join(', ')
  const label = `Keyboard diagram from ${LETTER[pc(lo)]} to ${LETTER[pc(hi)]}${names ? ', marked: ' + names : ''}`
  return `<svg class="dg dg-keys" viewBox="0 0 ${width} ${H}" style="max-width:${Math.max(260, whites.length * 56)}px" role="img" aria-label="${esc(label)}">${out}</svg>`
}

const stepOf = (p) => {
  const c = pc(p), sharp = !WHITE_PC.includes(c), base = sharp ? c - 1 : c
  return { step: Math.floor(p / 12) * 7 + WHITE_PC.indexOf(base), sharp }
}
/** Notes on one or two staves: d = { clef: 'treble'|'bass'|'grand', notes: [{ p, label? }] }. */
export function staffDiagram(d) {
  const gap = 12, left = 56, spacing = 46
  const staves = d.clef === 'grand' ? ['treble', 'bass'] : [d.clef]
  const bottomStep = { treble: stepOf(64).step, bass: stepOf(43).step }
  const top0 = 40
  const staveTop = (i) => top0 + i * (4 * gap + 56)
  const n = d.notes.length
  const width = left + n * spacing + 24
  const height = staveTop(staves.length - 1) + 4 * gap + 48
  let out = ''
  staves.forEach((clef, i) => {
    const top = staveTop(i)
    for (let k = 0; k < 5; k++) out += `<line x1="${left - 36}" x2="${width - 10}" y1="${top + k * gap}" y2="${top + k * gap}" class="dg-line"/>`
    out += clef === 'treble'
      ? `<text x="${left - 32}" y="${top + 4 * gap + 6}" font-size="62" class="dg-clef">𝄞</text>`
      : `<text x="${left - 32}" y="${top + 3 * gap + 4}" font-size="44" class="dg-clef">𝄢</text>`
  })
  d.notes.forEach((nt, k) => {
    const clef = staves.length === 2 ? (nt.p >= 60 ? 'treble' : 'bass') : staves[0]
    const i = staves.indexOf(clef), top = staveTop(i)
    const { step, sharp } = stepOf(nt.p)
    const y = (s) => top + 4 * gap - (s - bottomStep[clef]) * (gap / 2)
    const cx = left + 14 + k * spacing, cy = y(step)
    for (let s = bottomStep[clef] - 2; s >= step; s -= 2) out += `<line x1="${cx - 12}" x2="${cx + 12}" y1="${y(s)}" y2="${y(s)}" class="dg-line"/>`
    for (let s = bottomStep[clef] + 10; s <= step; s += 2) out += `<line x1="${cx - 12}" x2="${cx + 12}" y1="${y(s)}" y2="${y(s)}" class="dg-line"/>`
    const up = step < bottomStep[clef] + 4
    out += `<line x1="${up ? cx + 6.6 : cx - 6.6}" x2="${up ? cx + 6.6 : cx - 6.6}" y1="${cy}" y2="${up ? cy - 30 : cy + 30}" class="dg-stem"/>`
    out += `<ellipse cx="${cx}" cy="${cy}" rx="7.4" ry="5.2" transform="rotate(-20 ${cx} ${cy})" class="dg-head"/>`
    if (sharp) out += `<text x="${cx - 19}" y="${cy + 5}" font-size="15" class="dg-acc">♯</text>`
    if (nt.label) out += `<text x="${cx}" y="${top + 4 * gap + 30}" text-anchor="middle" class="dg-lab">${esc(nt.label)}</text>`
  })
  const words = d.notes.map((x) => LETTER[pc(x.p)]).join(' ')
  return `<svg class="dg dg-staff" viewBox="0 0 ${width} ${height}" style="max-width:${Math.max(300, width * 1.15)}px" role="img" aria-label="${esc(`Notes on the ${d.clef} staff: ${words}`)}">${out}</svg>`
}

/** Finger numbers on a drawn hand: thumb is 1, little finger is 5. */
export function handsDiagram(d) {
  const hand = (kind, ox) => {
    const mirror = kind === 'left'
    const fx = (x) => (mirror ? 140 - x : x)
    const fingers = [[34, 52, 2], [62, 38, 3], [90, 46, 4], [118, 66, 5]]
    let g = ''
    for (const [x, top, n] of fingers) {
      const rx = mirror ? fx(x + 20) : x
      g += `<rect x="${rx}" y="${top}" width="20" height="${96 - top}" rx="10" class="dg-fin"/>`
      if (d.numbers !== false) g += `<text x="${rx + 10}" y="${top + 17}" text-anchor="middle" class="dg-fn">${n}</text>`
    }
    g += `<rect x="24" y="86" width="104" height="66" rx="22" class="dg-palm"/>`
    const tx = mirror ? fx(24) : 24
    g += `<g transform="translate(${tx} 112) rotate(${mirror ? 38 : -38})"><rect x="${mirror ? 0 : -16}" y="-10" width="46" height="20" rx="10" class="dg-fin"/></g>`
    if (d.numbers !== false) g += `<text x="${mirror ? fx(24) + 14 : 16}" y="${mirror ? 98 : 98}" text-anchor="middle" class="dg-fn">1</text>`
    return `<g transform="translate(${ox} 6)">${g}<text x="76" y="176" text-anchor="middle" class="dg-lab">${kind === 'left' ? 'Left hand' : 'Right hand'}</text></g>`
  }
  const hands = d.hand === 'both' ? ['left', 'right'] : [d.hand]
  const W = hands.length * 180 + 10
  const body = hands.map((h, i) => hand(h, 10 + i * 180)).join('')
  const label = `${hands.length === 2 ? 'Both hands' : d.hand + ' hand'} with finger numbers: thumb is 1, little finger is 5`
  return `<svg class="dg dg-hands" viewBox="0 0 ${W} 190" style="max-width:${W * 1.1}px" role="img" aria-label="${esc(label)}">${body}</svg>`
}

export function diagramHtml(d) {
  if (!d) return ''
  try {
    if (d.type === 'keys') return keysDiagram(d)
    if (d.type === 'staff') return staffDiagram(d)
    if (d.type === 'hands') return handsDiagram(d)
  } catch { /* an unknown shape: the lesson reads fine without its picture */ }
  return ''
}

/* ---------- theory questions: options shown in a steady shuffled order ---------- */
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return h >>> 0 }
export function optionOrder(item) {
  const n = item.params.options.length
  const order = [...Array(n).keys()]
  // "All of these" and "Both" only make sense in the place the author put them
  if (item.params.options.some((o) => /^(all|both|none|neither)\b|\b(all|both|none|neither) of\b/i.test(o))) return order
  let s = hash(item.id) || 1
  for (let i = n - 1; i > 0; i--) { s = Math.imul(s ^ (s >>> 15), 2246822519) >>> 0; const j = s % (i + 1);[order[i], order[j]] = [order[j], order[i]] }
  return order
}

/* ================================== the screens ================================== */
// getExperience reads the current setup answer. 'new' and 'experienced' hide the placement card.
export function mountCourse({ host, homeHost, runItem, goto, notice: rawNotice = () => {}, confirm = async () => true, pushOverlay = () => () => {}, usesScreenKeys = () => false, getExperience = () => '', premium = () => true, openPaywall = () => {}, onView = () => {}, storage = globalThis.localStorage }) {
  const eng = playableCourse(COURSE)               // what the engine counts: only items the app can run
  let readFailed = false
  let progress = load()
  let order = loadOrder()                          // 'guided' asks before opening what comes later; 'open' never asks
  const view = { name: 'map', levelNum: 1, ownerId: null, itemId: null, answer: null, expanded: new Set(), seen: false }
  let focusSel = null
  // Back from a lesson or an exam lands where you left: the map's scroll and the row you opened keep their place (P4)
  const mapMemo = { scroll: 0, row: null, restore: false }
  let flip = null                      // the title of the row just opened, so the lesson title can carry in from it (IOS only, 280ms)
  let swiping = false                  // a back swipe is on screen: render() waits so the page under the finger is never wiped mid-gesture
  let renderLater = false

  // The in-memory progress is the truth while a save is pending: a failed save (full storage) leaves `dirty` set,
  // the next save or screen show retries it, and nothing reloads the older stored copy over a newly earned pass.
  let dirty = false
  // while a save is pending, a success message carries the warning so it is never hidden
  const UNSAVED = 'Progress could not be saved: free up space or export a backup'
  const UNREAD = 'Course progress could not be read. Your saved data has not been changed.'
  const notice = (m) => {
    const warning = readFailed ? UNREAD : dirty ? UNSAVED : ''
    rawNotice(warning && m !== warning ? m + dot() + warning : m)
  }
  function load() {
    try {
      const raw = storage.getItem(COURSE_KEY)
      const data = raw == null ? emptyProgress() : JSON.parse(raw)
      if (data?.version !== PROGRESS_VERSION) throw new Error('Unknown course progress format')
      readFailed = false
      return parseProgress(data)
    } catch { readFailed = true; return emptyProgress() }
  }
  function loadOrder() { try { return JSON.parse(storage.getItem(ORDER_KEY)) === 'open' ? 'open' : 'guided' } catch { return 'guided' } }
  function setOrder(value) {
    order = value === 'open' ? 'open' : 'guided'
    try { storage.setItem(ORDER_KEY, JSON.stringify(order)) } catch { notice('The course order could not be saved') }
  }
  function save() {
    if (readFailed) { notice(UNREAD); return false }
    try { storage.setItem(COURSE_KEY, serializeProgress(progress)); dirty = false; return true } catch {
      dirty = true
      notice(UNSAVED)
      return false
    }
  }
  /** Re-reads storage unless an unsaved result is waiting; then tries to write it again (quietly). */
  function sync() {
    if (dirty) {
      try { storage.setItem(COURSE_KEY, serializeProgress(progress)); dirty = false } catch { /* still full: keep the memory copy */ }
      if (dirty) return
    }
    progress = load()
  }

  const started = () => Object.keys(progress.lessons).length > 0 || progress.unlocked.length > 0
  const lessonOf = (id) => { for (const l of COURSE.levels) { const x = l.lessons.find((y) => y.id === id); if (x) return { level: l, lesson: x, index: l.lessons.indexOf(x) } } return null }
  const levelOf = (n) => COURSE.levels.find((l) => l.number === n)
  const unlockedLevel = (n) => isLevelUnlocked(eng, progress, n)
  const records = (ownerId) => ownGet(progress.lessons, ownerId) || {}

  /* ----- results coming in from app.js ----- */
  let activeIntro = null
  function record(ownerId, item, { accuracy, stars, seconds = 0 }) {
    const owner = findOwner(eng, ownerId)
    if (!owner) return { passed: false }
    progress = recordItemResult(progress, ownerId, item.id, { accuracy, stars, seconds })
    const rec = records(ownerId)[item.id]
    const passed = isItemDone(item, rec)
    let lessonDone = false, examDone = null
    if (owner.kind === 'lesson') lessonDone = isLessonDone(eng, progress, owner.lesson)
    else {
      examDone = settleExam(owner)
      if (examDone) advancePlacement(owner, examDone.passed)
    }
    save()
    if (activeIntro?.ownerId === ownerId && activeIntro.itemId === item.id) {
      activeIntro = null
      const next = passed && owner.items[owner.items.findIndex((it) => it.id === item.id) + 1]
      if (next && !isItemDone(next, records(ownerId)[next.id])) startItem(ownerId, next.id)
    }
    return { passed, lessonDone, exam: examDone, accuracy: rec.accuracy }
  }
  /** An exam is scored once every task has a result: the best of each. Doing it before the lessons are done is a placement test. */
  function settleExam({ level, exam }) {
    const recs = records(exam.id)
    if (!exam.items.every((it) => recs[it.id])) return null
    const score = examScore(exam, exam.items.map((it) => recs[it.id].accuracy * 100))
    const placement = nextPlacementLevel(eng, run()) === level.number || level.lessons.some((l) => !isLessonDone(eng, progress, l))
    progress = recordExamResult(progress, level.id, { percent: score.percent, passed: score.passed, placement })
    return { ...score, placement }
  }

  /* ----- "Find my level" (placement.js): a run through the level exams ----- */
  let placementDoneOn = null      // the exam id (or 'map') where the run just ended: shows the result once
  let placementOwnerId = null
  const run = () => ownGet(progress, 'placement') || null
  function advancePlacement(owner, passed) {
    const before = run()
    const after = afterPlacementExam(eng, before, owner.level.number, passed)
    if (after === before) return
    progress = withPlacement(progress, after)
    if (after.state === 'done') finishPlacement(owner.exam.id)
  }
  function finishPlacement(where) {
    placementDoneOn = where
    const start = placementStart(run())
    view.expanded = new Set([start])
    view.seen = true
    notice(start > 1 ? `You start at level ${start}` : 'You start at level 1')
  }
  function findMyLevel() {
    const first = placementLevels(eng)[0]
    if (!first) return
    progress = withPlacement(progress, startPlacement())
    save()
    openPlacementExam(first)
  }
  function openPlacementExam(level) {
    openOwner(levelOf(level).exam.id, { placement: true })
  }
  function continuePlacement() {
    const n = nextPlacementLevel(eng, run())
    if (n) openPlacementExam(n)
  }
  function stopHere() {
    if (run()?.state !== 'running') return
    progress = withPlacement(progress, stopPlacement(run()))
    finishPlacement('map')
    save()
    Object.assign(view, { name: 'map', ownerId: null, itemId: null })
    focusSel = '[data-act="place-go"]'
    if (document.body.dataset.screen !== 'course') goto('course'); else render()
  }
  /** The results-dialog button while a run waits on the next exam or has just ended on this one. */
  function placementAction(ownerId) {
    const owner = findOwner(eng, ownerId)
    const r = run()
    if (!owner || owner.kind !== 'exam' || !r) return null
    if (r.state === 'running' && owner.level.number === r.lastPassed) {
      const n = nextPlacementLevel(eng, r)
      if (n) return { label: `Next test: level ${n} exam`, primary: true, go: continuePlacement }
    }
    if (r.state === 'done' && placementDoneOn === ownerId) return { label: 'See your level', primary: true, go: () => openOwner(ownerId) }
    return null
  }

  function nextPlacementTask(ownerId) {
    const owner = findOwner(eng, ownerId)
    if (owner?.kind !== 'exam' || owner.level.number !== nextPlacementLevel(eng, run())) return null
    const recs = records(ownerId)
    return owner.items.find((item) => !recs[item.id]) || null
  }

  /** The next item to run after one finished: the following undone one in the same lesson or exam. */
  function nextItem(ownerId, afterId) {
    const owner = findOwner(eng, ownerId)
    if (!owner) return null
    const recs = records(ownerId)
    const pending = owner.items.filter((it) => !isItemDone(it, recs[it.id], owner.lesson?.pass.minStars || 0))
    const at = owner.items.findIndex((it) => it.id === afterId)
    return pending.find((it) => owner.items.indexOf(it) > at) || null
  }
  function nextAction(ownerId, itemId, passed) {
    const place = placementAction(ownerId)
    if (place) return place
    const nxt = nextPlacementTask(ownerId) || (passed ? nextItem(ownerId, itemId) : null)
    if (nxt) return { label: 'Next: ' + nxt.title, primary: true, go: () => startItem(ownerId, nxt.id) }
    return { label: findOwner(eng, ownerId)?.kind === 'exam' ? 'Back to the exam' : 'Back to lesson', primary: !!passed, go: () => openOwner(ownerId) }
  }

  /* ----- the "this comes after" sheet ----- */
  /** The recommended next step as { name, go }, or null when nothing is waiting. */
  function recommended() {
    const step = nextStep(eng, progress)
    if (!step) return null
    if (step.kind === 'lesson') return { name: step.lesson.title, go: () => openOwner(step.lesson.id) }
    return { name: step.level.exam.title, go: () => openOwner(step.level.exam.id) }
  }
  let sheet = null
  function closeSheet(focusTrigger = true) {
    if (!sheet) return
    const { back, onKey, trigger, unregister } = sheet
    sheet = null
    unregister()
    document.removeEventListener('keydown', onKey, true)
    back.remove()
    if (focusTrigger && host) { const el = host.querySelector(trigger); if (el) el.focus({ preventScroll: true }) }
  }
  /** Opens target (an ahead lesson, level exam) straight away in Open order or when nothing is recommended; otherwise asks first. */
  function openOrAsk({ trigger, label, start }) {
    const rec = recommended()
    if (order === 'open' || !rec) return start()
    closeSheet(false)
    const back = document.createElement('div')
    back.className = 'cr-sheet-back'
    back.innerHTML = `<div class="cr-sheet" role="dialog" aria-modal="true" aria-labelledby="cr-sheet-t" aria-describedby="cr-sheet-d">
      <h3 class="cr-sheet-t" id="cr-sheet-t">This comes after ${esc(rec.name)}.</h3>
      <p class="cr-sheet-d" id="cr-sheet-d">You can start ${esc(label)} now. Passing it will not mark anything before it as done.</p>
      <div class="cr-sheet-acts"><button class="ghost" data-sheet="start">Start anyway</button><button class="primary" data-sheet="go">Take me to ${esc(rec.name)}</button></div></div>`
    const buttons = [...back.querySelectorAll('button')]
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSheet() }
      else if (e.key === 'Tab') {
        const at = buttons.indexOf(document.activeElement)
        const next = e.shiftKey ? (at <= 0 ? buttons.length - 1 : at - 1) : (at === buttons.length - 1 ? 0 : at + 1)
        e.preventDefault(); buttons[next].focus()
      }
    }
    back.addEventListener('click', (e) => {
      if (e.target === back) return closeSheet()
      const b = e.target.closest('[data-sheet]')
      if (!b) return
      closeSheet(false)
      if (b.dataset.sheet === 'go') rec.go(); else start()
    })
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(back)
    sheet = { back, onKey, trigger, unregister: pushOverlay(() => closeSheet()) }
    buttons[1].focus()
  }

  /* ----- navigation ----- */
  const levelLocked = (level) => level.number > 1 && !premium()
  const isPlacementExam = (owner, placement = false) => owner.kind === 'exam' &&
    (placement || placementOwnerId === owner.exam.id || nextPlacementLevel(eng, run()) === owner.level.number)
  const ownerLocked = (owner, placement) => levelLocked(owner.level) && !isPlacementExam(owner, placement)

  function returnToOwner(ownerId) {
    const owner = findOwner(eng, ownerId)
    if (owner && !ownerLocked(owner)) return openOwner(ownerId)
    Object.assign(view, { name: 'map', ownerId: null, itemId: null })
    goto('course')
  }

  function leavingMap() {
    if (!host || view.name !== 'map' || view.itemId) return
    mapMemo.scroll = host.scrollTop
  }
  function openOwner(ownerId, { placement = false } = {}) {
    const owner = findOwner(eng, ownerId)
    if (!owner) return
    if (ownerLocked(owner, placement)) return openPaywall()
    leavingMap()
    placementOwnerId = isPlacementExam(owner, placement) ? ownerId : null
    activeIntro = null
    Object.assign(view, { name: owner.kind, ownerId, levelNum: owner.level.number, itemId: null, answer: null })
    view.expanded.add(owner.level.number)
    focusSel = '[data-focus="page"]'
    goto('course')
  }
  function startItem(ownerId, itemId) {
    const owner = findOwner(eng, ownerId)
    const item = owner && owner.items.find((it) => it.id === itemId)
    if (!item) return
    if (ownerLocked(owner)) return openPaywall()
    placementOwnerId = isPlacementExam(owner) ? ownerId : null
    activeIntro = item.type === 'hand-intro' ? { ownerId, itemId } : null
    if (item.type === 'theory') {
      Object.assign(view, { name: owner.kind, ownerId, levelNum: owner.level.number, itemId, answer: null })
      focusSel = '[data-focus="page"]'
      if (document.body.dataset.screen !== 'course') goto('course'); else render()
      return
    }
    // the lesson (or exam) page is where Back and Next return to, whichever screen runs the item
    Object.assign(view, { name: owner.kind, ownerId, levelNum: owner.level.number, itemId: null, answer: null })
    runItem(item, { ownerId, levelNum: owner.level.number })
  }
  function openStep() {
    const step = nextStep(eng, progress)
    if (!step) { Object.assign(view, { name: 'map', ownerId: null, itemId: null }); goto('course'); return }
    if (step.kind !== 'lesson') return openOwner(step.level.exam.id)
    if (levelLocked(step.level)) return openPaywall()
    const first = step.lesson.items[0]
    const recs = records(step.lesson.id)
    const attempted = Object.keys(recs).length
    if (!attempted && (first?.type === 'hand-intro' || first?.params.watchFirst)) return startItem(step.lesson.id, first.id)
    const second = step.lesson.items[1]
    if (attempted === 1 && first?.type === 'hand-intro' && isItemDone(first, recs[first.id]) && second?.params.watchFirst) return startItem(step.lesson.id, second.id)
    openOwner(step.lesson.id)
  }

  /* ----- rendering ----- */
  const ring = (percent, inner, cls = '') => {
    const c = 2 * Math.PI * 21
    return `<span class="cr-ring ${cls}" style="--p:${percent}"><svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="21" class="cr-ring-bg"/><circle cx="24" cy="24" r="21" class="cr-ring-fg" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - percent / 100)).toFixed(1)}" transform="rotate(-90 24 24)"/></svg><span class="cr-ring-in">${inner}</span></span>`
  }

  function currentLevelNumber() {
    const step = nextStep(eng, progress)
    return step ? step.level.number : 1
  }

  function renderMap() {
    const sum = courseSummary(eng, progress)
    const step = nextStep(eng, progress)
    let cta = 'Start the course', sub = 'Your first lesson takes about 8 minutes.'
    if (started() && step) {
      cta = step.kind === 'lesson' ? 'Continue' : 'Take the Level ' + step.level.number + ' exam'
      sub = step.kind === 'lesson' ? `Lesson: ${step.lesson.title}` : step.level.exam.title
    } else if (started()) { cta = 'See the course'; sub = 'Everything open so far is done. More lessons are on the way.' }
    if (!view.seen) { view.expanded = new Set([currentLevelNumber()]); view.seen = true }
    const nowStep = started() && step
    const idx = nowStep && step.kind === 'lesson' ? step.level.lessons.indexOf(step.lesson) + 1 : 0
    const heroKicker = nowStep ? (step.kind === 'lesson' ? 'Up next' : `Level ${step.level.number} exam`) : 'Piano course'
    const heroTitle = nowStep ? (step.kind === 'lesson' ? step.lesson.title : step.level.exam.title) : started() ? `${sum.lessonsDone} of ${sum.lessonsTotal} lessons done` : 'Learn piano, one small step at a time'
    const heroSub = nowStep && step.kind === 'lesson' ? `Level ${step.level.number}${dot()}Lesson ${idx} of ${step.level.lessons.length}${dot()}${step.lesson.minutes} min` : nowStep ? 'All the lessons are done. Show what you can do.' : sub
    const summary = started() ? `<p class="cr-summary">Level ${currentLevelNumber()} of ${COURSE.levels.length}<span class="cr-dot"></span>${sum.lessonsDone} of ${sum.lessonsTotal} lessons${sum.minutesPractised ? `<span class="cr-dot"></span>${sum.minutesPractised} min practised` : ''}</p>` : ''
    const hero = `${summary}<section class="cr-hero" aria-label="Your course">
      ${ring(sum.percent, `<b>${sum.percent}</b><i>%</i>`, 'big')}
      <div class="cr-hero-text">
        <div class="kicker">${esc(heroKicker)}</div>
        <h2 class="cr-hero-title">${esc(heroTitle)}</h2>
        <p class="cr-hero-sub">${esc(heroSub)}</p>
      </div>
      <button class="primary btn-l" data-act="continue">${icon('play', 'cr-btn-ic')}${esc(cta)}</button>
    </section>`
    const seg = (value, text) => `<button type="button" class="cr-seg-b" data-act="order" data-value="${value}" aria-pressed="${order === value}">${text}</button>`
    const orderBar = `<div class="cr-order"><span class="cr-order-l" id="cr-order-l">Course order</span>
      <div class="cr-seg" role="group" aria-labelledby="cr-order-l">${seg('guided', 'Guided')}${seg('open', 'Open')}</div>
      <span class="cr-order-h">${order === 'open' ? 'Everything opens straight away. Only the next lesson is marked.' : 'Asks before you start something that comes later.'}</span></div>`
    const cur = currentLevelNumber()
    const cards = COURSE.levels.map((level) => levelCard(level, level.number === cur && !!step)).join('')
    return `${placementBox()}${hero}${orderBar}<ol class="cr-path" aria-label="Levels">${cards}</ol>`
  }

  /** The compact card at the top of the map: the offer for a new learner, a run in progress, or the result once. */
  function placementBox() {
    const box = (title, text, acts, cls = '') => `<section class="cr-place${cls}" aria-labelledby="cr-place-t" ${cls ? 'role="status"' : ''}>
      <div class="cr-place-text"><h3 class="cr-place-t" id="cr-place-t">${esc(title)}</h3><p class="cr-place-s">${esc(text)}</p></div>
      <div class="cr-place-acts">${acts}</div></section>`
    const r = run()
    if (r?.state === 'done' && placementDoneOn) {
      const start = placementStart(r)
      return box('Your level', placementMessage(start), `<button class="ghost" data-act="place-close">Close</button><button class="primary" data-act="place-go">Start level ${start}</button>`, ' result')
    }
    const card = placementLevels(eng).length ? placementCard(eng, progress, getExperience()) : null
    if (card === 'offer') {
      return box('Already play a little?', 'Take the level exams one after another and start where you fit. Stop whenever you like.',
        '<button class="ghost" data-act="place-skip">Start from lesson 1</button><button class="primary" data-act="place-find">Find my level</button>')
    }
    if (card === 'running') {
      const n = nextPlacementLevel(eng, r)
      const done = r.lastPassed ? `Passed so far: up to level ${r.lastPassed}. ` : ''
      return box('Finding your level', n ? `${done}Next: the level ${n} exam.` : `${done}No more tests are available.`,
        `<button class="link" data-act="place-stop">Stop here</button>${n ? '<button class="primary" data-act="place-next">Continue</button>' : ''}`)
    }
    return ''
  }

  // the lessons of one level, inside a wrapper whose height opens and closes in place (grid rows, ios.css / course.css)
  function expandHtml(level, open) {
    const lessons = level.lessons
    return `<div class="cr-expand${open ? ' open' : ''}" data-expand="${level.number}"><div class="cr-expand-in"><ul class="cr-lessons" id="cr-ls-${level.number}">${lessons.map((l, i) => lessonRow(level, l, i)).join('')}${examRow(level)}</ul></div></div>`
  }
  function levelCard(level, current) {
    const s = levelSummary(eng, progress, level.number)
    const lessons = level.lessons
    const mins = lessons.reduce((a, l) => a + l.minutes, 0)
    const passed = !!ownGet(progress.exams, level.id)?.passed
    const state = level.draft ? 'soon' : passed ? 'done' : !s.unlocked ? 'ahead' : 'open'
    const locked = state !== 'soon' && levelLocked(level)
    const stateText = locked ? 'Keylight Premium' : { soon: 'Coming soon', ahead: s.done ? '' : order === 'open' ? 'Not started' : 'Comes later', done: 'Complete', open: '' }[state]   // the open level is the card with the light; no pill and no second Continue (the hero has it)
    const open = view.expanded.has(level.number) && state !== 'soon'
    const node = state === 'soon' ? icon('lock', 'cr-node-ic') : state === 'done' ? icon('check', 'cr-node-ic') : `<b>${level.number}</b>`
    let action = ''
    if (state === 'ahead') {
      const before = levelOf(level.number - 1)
      const canPlace = before && !before.draft && before.exam && unlockedLevel(before.number)
      action = `${canPlace ? `<button class="ghost cr-small" data-act="placement" data-level="${before.number}" aria-label="Placement test for level ${level.number}">Placement</button>` : ''}<button class="ghost cr-small" data-act="skip" data-level="${level.number}" aria-label="Skip ahead to level ${level.number}">Skip ahead</button>`
    }
    const body = open ? expandHtml(level, true) : ''
    const keysHint = state !== 'soon' && level.keys > 24 && usesScreenKeys()
      ? '<span class="cr-lb">The on-screen keys widen for pieces that need more notes. A full-size keyboard gives you more room.</span>'
      : ''
    const meta = state === 'soon' ? 'Outline only for now' : `${lessons.length} lessons<span class="cr-dot"></span>about ${mins} min<span class="cr-keys"><span class="cr-dot"></span>${level.keys} keys</span>${s.done ? `<span class="cr-dot"></span>${s.done} done` : ''}`
    return `<li class="cr-level st-${state}${current ? ' cur' : ''}" id="cr-level-${level.number}">
      <div class="cr-node">${ring(s.percent, node, state === 'done' ? 'done' : '')}</div>
      <div class="cr-card">
        <div class="cr-top">
          <button class="cr-toggle" data-act="toggle" data-level="${level.number}" aria-expanded="${open}" ${state === 'soon' ? 'aria-disabled="true"' : `aria-controls="cr-ls-${level.number}"`}>
            ${icon('chevron', 'cr-tg-ch')}<span class="cr-lk">${caps('LEVEL ' + level.number)}${dot()}${esc(levelTag(level))}</span>
            <span class="cr-lt">${esc(level.title)}</span>
            <span class="cr-lb">${esc(level.blurb)}</span>
            <span class="cr-lm">${meta}</span>
            ${keysHint}
          </button>
          <div class="cr-side">${stateText ? `<span class="cr-chip ${state}">${locked || state === 'soon' ? icon('lock', 'cr-chip-ic') : state === 'done' ? icon('check', 'cr-chip-ic') : ''}${stateText}</span>` : ''}${action}</div>
        </div>
        ${body}
      </div></li>`
  }

  const statusIcon = (st) => st === 'done' ? `<span class="cr-si done">${icon('check', 'cr-si-ic')}</span>` : st === 'open' ? `<span class="cr-si open">${icon('play', 'cr-si-ic')}</span>` : st === 'soon' ? `<span class="cr-si lock">${icon('lock', 'cr-si-ic')}</span>` : '<span class="cr-si ahead"></span>'
  function lessonRow(level, lesson, i) {
    const st = level.draft || lesson.draft ? 'soon' : lessonStatus(eng, progress, lesson.id)
    const locked = st !== 'soon' && levelLocked(level)
    const reviewOnly = st === 'ahead' && level.number < placedAt(progress)   // below the level "Find my level" chose
    const rec = st === 'ahead' && order === 'guided' && !reviewOnly ? recommended() : null
    const word = locked ? 'Keylight Premium' : { soon: 'Coming soon', done: 'Done', open: 'Up next', ahead: rec ? 'Comes later' : reviewOnly ? 'Review' : '' }[st]
    const spoken = st === 'ahead' && !locked ? (rec ? `comes after ${rec.name}` : reviewOnly ? 'review' : '') : word
    const cur = st === 'open' && nextStep(eng, progress)?.lesson?.id === lesson.id
    const label = [`Lesson ${i + 1}`, lesson.title, `${lesson.minutes} minutes`, spoken].filter(Boolean).map(esc).join(', ')
    return `<li><button class="cr-lrow ${st}${cur ? ' cur' : ''}" data-act="lesson" data-id="${lesson.id}" ${st === 'soon' ? 'disabled' : ''} ${cur ? 'aria-current="step"' : ''} aria-label="${label}">
      ${statusIcon(locked ? 'soon' : st)}<span class="cr-ltxt"><span class="cr-ln">${i + 1}. ${esc(lesson.title)}</span><span class="cr-lg">${esc(lesson.goal)}</span></span>
      <span class="cr-lw ${st}">${word}</span>${icon('chevron', 'cr-lch')}</button></li>`
  }
  function examRow(level) {
    if (!level.exam || level.draft) return ''
    const st = examStatus(eng, progress, level.number)
    const rec = ownGet(progress.exams, level.id)
    const word = st === 'done' ? 'Passed' + (rec?.placement ? ' (placement)' : '') : st === 'open' ? 'Ready' : 'After the lessons'
    const after = st === 'ahead' && order === 'guided' ? recommended() : null
    return `<li><button class="cr-lrow exam ${st}" data-act="exam" data-level="${level.number}" aria-label="${esc(`Level ${level.number} exam, ${word}${after ? ', comes after ' + after.name : ''}`)}">
      <span class="cr-si ${st === 'done' ? 'done' : st === 'open' ? 'open' : 'ahead'}">${icon(st === 'done' ? 'check' : 'flag', 'cr-si-ic')}</span>
      <span class="cr-ltxt"><span class="cr-ln">${esc(level.exam.title)}</span><span class="cr-lg">${level.exam.items.length} short tasks${dot()}pass at ${level.exam.passPercent}%${rec ? `${dot()}best ${Math.round(rec.percent)}%` : ''}</span></span>
      <span class="cr-lw ${st}">${word}</span>${icon('chevron', 'cr-lch')}</button></li>`
  }

  /* ----- lesson and exam page ----- */
  function itemRow(owner, item) {
    const full = owner.full.items.find((it) => it.id === item.id) || item
    const rec = records(owner.id)[item.id]
    const done = isItemDone(item, rec, owner.minStars)
    const runnable = isRunnable(item)
    const need = passText(item)
    let stat
    if (!runnable) stat = '<span class="cr-is soon">Coming soon</span>'
    else if (done) stat = `<span class="cr-is done">${icon('check', 'cr-is-ic')}Done${dot()}${pct(rec.accuracy)}%</span>`
    else if (rec) stat = `<span class="cr-is tried">Best ${pct(rec.accuracy)}%${dot()}aim for ${need}</span>`
    else stat = `<span class="cr-is">Aim for ${need}</span>`
    const verb = !runnable ? '' : done ? 'Again' : rec ? 'Try again' : 'Start'
    return `<li class="cr-item${done ? ' done' : ''}${runnable ? '' : ' soon'}">
      <span class="cr-it-ic">${icon(TYPE_ICON[full.type] || 'keys')}</span>
      <span class="cr-it-body"><span class="cr-it-t">${esc(full.title)}</span><span class="cr-it-k">${esc(owner.kind === 'exam' ? taskLine(full) : TYPE_LABEL[full.type] || full.type)}${runnable ? '' : dot() + 'optional for now'}</span></span>
      ${stat}
      ${runnable ? `<button class="${done ? 'ghost' : 'primary'} cr-small" data-act="start" data-item="${item.id}" aria-label="${verb}: ${esc(full.title)}">${verb}</button>` : ''}</li>`
  }
  // the items of an owner as the page shows them: every item of the course, coming-soon ones included
  function ownerView(ownerId) {
    const o = findOwner(eng, ownerId), full = findOwner(COURSE, ownerId)
    if (!o || !full) return null
    return { id: ownerId, kind: o.kind, level: full.level, lesson: full.lesson, exam: full.exam, items: o.items, full, minStars: o.lesson?.pass.minStars || 0 }
  }
  function itemList(ov) {
    const shown = ov.full.items.map((fi) => ov.items.find((it) => it.id === fi.id) || { ...fi, soon: true })
    return `<ul class="cr-items" aria-label="${ov.kind === 'exam' ? 'Exam tasks' : 'Practice items'}">${shown.map((it) => itemRow(ov, it)).join('')}</ul>`
  }
  function followUp() {
    const step = nextStep(eng, progress)
    if (!step) return { label: 'Back to the course', act: 'map' }
    if (step.kind === 'lesson') return { label: 'Next lesson', sub: step.lesson.title, act: 'continue' }
    return { label: 'Take the level exam', sub: step.level.exam.title, act: 'continue' }
  }

  function renderLesson() {
    const ov = ownerView(view.ownerId)
    if (!ov) return renderMap()
    const { level, lesson } = ov
    const elesson = findOwner(eng, ov.id).lesson        // what the engine counts (items that can run today)
    const idx = level.lessons.indexOf(lesson)
    const done = isLessonDone(eng, progress, elesson)
    const states = lessonItemStates(progress, elesson)
    const doneCount = states.filter((s) => s.done).length
    const need = elesson.pass.minItemsDone
    const fu = followUp()
    const banner = done ? `<div class="cr-complete" role="status"><span class="cr-complete-mark">${icon('check', 'cr-complete-ic')}</span>
      <div><div class="cr-complete-t">Lesson complete</div><div class="cr-complete-s">${esc(fu.sub ? 'Up next: ' + fu.sub : 'Nicely done. You can keep practising any item.')}</div></div>
      <button class="primary" data-act="${fu.act}">${esc(fu.label)}</button></div>` : ''
    const teach = lesson.teach.map((t) => `<p>${esc(t)}</p>`).join('')
    const tip = lesson.tip ? `<aside class="cr-tip">${icon('tip', 'cr-tip-ic')}<div><b>Tip</b><p>${esc(lesson.tip)}</p></div></aside>` : ''
    const dia = lesson.diagram ? `<figure class="cr-fig">${diagramHtml(lesson.diagram)}</figure>` : ''
    const hint = need > 0 ? `${Math.min(doneCount, need)} of ${need} needed` : ''
    return `<div class="cr-page" data-focus-root>
      <button class="cr-back" data-act="map">${icon('back', 'cr-back-ic')}<span>Level ${level.number}${dot()}${esc(level.title)}</span></button>
      <header class="cr-lhead">
        <div class="kicker">${caps('LESSON ' + (idx + 1) + ' OF ' + level.lessons.length)}<span class="cr-dot"></span>${lesson.minutes} ${up('min')}</div>
        <h2 class="cr-title" tabindex="-1" data-focus="page">${esc(lesson.title)}</h2>
        <p class="cr-goal">${esc(lesson.goal)}</p>
      </header>
      ${banner}
      <div class="cr-cols">
        <article class="cr-prose">${dia}${teach}${tip}</article>
        <aside class="cr-sidecard" aria-label="Practice checklist">
          <div class="cr-sc-head"><h3>Practice</h3><span class="cr-sc-n">${hint}</span></div>
          <div class="cr-bar" role="img" aria-label="${Math.min(doneCount, need)} of ${need} items needed"><i style="width:${need ? Math.min(100, (doneCount / need) * 100) : 0}%"></i></div>
          ${itemList(ov)}
        </aside>
      </div></div>`
  }

  function renderExam() {
    const ov = ownerView(view.ownerId)
    if (!ov) return renderMap()
    const { level, exam } = ov
    const recs = records(exam.id)
    const eexam = findOwner(eng, exam.id).exam
    const elevel = findOwner(eng, exam.id).level
    const everyDone = eexam.items.every((it) => recs[it.id])
    const score = everyDone ? examScore(eexam, eexam.items.map((it) => recs[it.id].accuracy * 100)) : null
    const lessonsLeft = elevel.lessons.some((l) => !isLessonDone(eng, progress, l))
    const passedAt = ownGet(progress.exams, level.id)
    stopFooter = false
    const placeBox = examPlacementBox(level, exam)
    let result = ''
    if (score) {
      const ok = score.passed || passedAt?.passed
      result = `<div class="cr-complete ${ok ? '' : 'miss'}" role="status"><span class="cr-complete-mark">${icon(ok ? 'check' : 'flag', 'cr-complete-ic')}</span>
        <div><div class="cr-complete-t">${ok ? 'Exam passed' : 'Not quite yet'}: ${Math.round(score.percent)}%</div>
        <div class="cr-complete-s">${ok ? (passedAt?.placement ? 'Passed as a placement test: the next level is open.' : 'The next level is open.') : `You need ${exam.passPercent}%${exam.minTaskPercent ? ` overall and at least ${exam.minTaskPercent}% on each task` : ''}.${placeBox ? '' : ' Try the weaker tasks again: your best result of each counts.'}`}</div></div>
        ${ok && !placeBox ? `<button class="primary" data-act="continue">${nextStep(eng, progress)?.kind === 'lesson' ? 'Next lesson' : 'See the course'}</button>` : ''}</div>`
    }
    const note = placeBox || (lessonsLeft ? '<p class="cr-note">You have lessons left in this level. Taking the exam now counts as a placement test: pass it and the next level opens.</p>' : '')
    return `<div class="cr-page" data-focus-root>
      <button class="cr-back" data-act="map">${icon('back', 'cr-back-ic')}<span>Level ${level.number}${dot()}${esc(level.title)}</span></button>
      <header class="cr-lhead">
        <div class="kicker">${caps('LEVEL ' + level.number + ' EXAM')}<span class="cr-dot"></span>${caps('PASS AT ' + exam.passPercent + '%')}</div>
        <h2 class="cr-title" tabindex="-1" data-focus="page">${esc(exam.title)}</h2>
        <p class="cr-goal">${eexam.items.length} short tasks. Your overall score is the average of the tasks${exam.minTaskPercent ? `, and no task may fall below ${exam.minTaskPercent}%` : ''}.</p>
      </header>
      ${result}${note}
      <div class="cr-cols single"><aside class="cr-sidecard wide" aria-label="Exam tasks"><div class="cr-sc-head"><h3>Tasks</h3><span class="cr-sc-n">${eexam.items.filter((it) => recs[it.id]).length} of ${eexam.items.length} tried</span></div>${itemList(ov)}</aside></div>
      ${stopFooter ? '<footer class="cr-foot"><button class="link" data-act="place-stop">Stop here</button></footer>' : ''}</div>`
  }

  /** On an exam page that is part of a "Find my level" run: where the run stands, and its result once it ends here. */
  let stopFooter = false        // set by examPlacementBox: the page then ends with a quiet "Stop here" (it is not a button beside the task)
  function examPlacementBox(level, exam) {
    const r = run()
    if (!r) return ''
    const total = placementLevels(eng).length
    const box = (title, text, acts, cls = '') => `<div class="cr-place inline${cls}" role="status"><div class="cr-place-text"><h3 class="cr-place-t">${esc(title)}</h3><p class="cr-place-s">${esc(text)}</p></div><div class="cr-place-acts">${acts}</div></div>`
    if (r.state === 'done' && placementDoneOn === exam.id) {
      const start = placementStart(r)
      return box('Your level', placementMessage(start), `<button class="primary" data-act="place-go">Start level ${start}</button>`, ' result')
    }
    if (r.state !== 'running') return ''
    const want = nextPlacementLevel(eng, r)
    if (level.number === want) {
      stopFooter = true
      return box(`Finding your level: test ${want} of ${total}`, 'Do every task. Pass this exam to try the next level. The first exam you do not pass sets where you start.', '')
    }
    if (level.number === r.lastPassed && want) {
      stopFooter = true
      return box('Passed', `Next test: the level ${want} exam.`, '<button class="primary" data-act="place-next">Next test</button>')
    }
    return ''
  }

  function renderTheory() {
    const ov = ownerView(view.ownerId)
    const item = ov && ov.items.find((it) => it.id === view.itemId)
    if (!item) { view.itemId = null; return view.name === 'exam' ? renderExam() : renderLesson() }
    const p = item.params
    const order = optionOrder(item)
    const theory = ov.items.filter((it) => it.type === 'theory')
    const n = theory.indexOf(item) + 1
    const answered = view.answer !== null
    const right = answered && view.answer === p.answer
    const letters = 'ABCDEF'
    const opts = order.map((orig, k) => {
      const chosen = answered && view.answer === orig
      const correct = answered && orig === p.answer
      const cls = correct ? ' right' : chosen ? ' wrong' : ''
      const tag = correct ? '<span class="cr-opt-tag">Correct answer</span>' : chosen ? '<span class="cr-opt-tag">Your answer</span>' : ''
      return `<button class="cr-opt${cls}" data-act="answer" data-i="${orig}" ${answered ? 'aria-disabled="true"' : ''} aria-pressed="${chosen}"><span class="cr-opt-l">${letters[k]}</span><span class="cr-opt-t">${esc(p.options[orig])}</span>${tag}${correct ? icon('check', 'cr-opt-ic') : chosen ? icon('lock', 'cr-opt-ic wrongic') : ''}</button>`
    }).join('')
    const place = answered && placementAction(view.ownerId)
    const placementTask = answered && nextPlacementTask(view.ownerId)
    const nxt = placementTask || (answered && right ? nextItem(view.ownerId, item.id) : null)
    const fb = answered ? `<div class="cr-fb ${right ? 'ok' : 'no'}" role="status"><div class="cr-fb-t">${icon(right ? 'check' : 'tip', 'cr-fb-ic')}${right ? 'Correct' : 'Not quite'}</div><p>${esc(p.why)}</p></div>` : ''
    const backLabel = `Back to ${ov.kind === 'exam' ? 'the exam' : 'lesson'}`
    const primary = place ? `<button class="primary" data-act="place-result-action">${esc(place.label)}</button>`
      : nxt ? `<button class="primary" data-act="theory-next" data-item="${nxt.id}">Next: ${esc(nxt.title)}</button>`
        : right ? `<button class="primary" data-act="back-owner">${backLabel}</button>`
          : '<button class="primary" data-act="theory-retry">Try again</button>'
    const acts = answered ? `<div class="cr-qacts">${primary}${place || nxt || !right ? `<button class="ghost" data-act="back-owner">${backLabel}</button>` : ''}</div>` : ''
    return `<div class="cr-page narrow" data-focus-root>
      <button class="cr-back" data-act="back-owner">${icon('back', 'cr-back-ic')}<span>${esc(ov.lesson ? ov.lesson.title : ov.exam.title)}</span></button>
      <section class="cr-qcard" aria-labelledby="cr-q">
        <div class="kicker">${caps('QUESTION ' + n + ' OF ' + theory.length)}</div>
        <h2 class="cr-q" id="cr-q" tabindex="-1" data-focus="page">${esc(p.q)}</h2>
        <div class="cr-opts" role="group" aria-labelledby="cr-q">${opts}</div>
        ${fb}${acts}
      </section></div>`
  }

  function render() {
    if (!host) return
    if (swiping) { renderLater = true; return }
    const scroll = host.scrollTop
    const html = view.itemId ? renderTheory() : view.name === 'lesson' ? renderLesson() : view.name === 'exam' ? renderExam() : renderMap()
    const prevView = host.dataset.view
    const nextView = view.itemId ? 'theory' : view.name
    host.innerHTML = html
    host.dataset.view = nextView
    if (prevView && prevView !== nextView) onView(host, prevView, nextView)   // a drill in or back: the app slides the screen (iOS)
    const toMap = !view.itemId && view.name === 'map'
    if (!toMap) { if (focusSel) host.scrollTop = 0 }
    else if (mapMemo.restore && prevView && prevView !== 'map') host.scrollTop = mapMemo.scroll   // back from a lesson: the map is where it was
    else host.scrollTop = focusSel && !mapMemo.restore ? 0 : scroll
    mapMemo.restore = false
    if (focusSel) { const el = host.querySelector(focusSel); if (el) el.focus({ preventScroll: true }); focusSel = null }
    if (flip && !toMap) { carryTitle(flip); flip = null } else flip = null
  }
  // the lesson title carries in from the row that was tapped: translate and scale from the row's title to the page title (WAAPI, 280ms)
  function carryTitle(from) {
    const el = host.querySelector('.cr-title')
    if (!from || !el || typeof el.animate !== 'function' || document.documentElement.classList.contains('shot')) return
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return
    if (document.documentElement.classList.contains('reduce-motion') || !document.documentElement.classList.contains('ios')) return
    const to = el.getBoundingClientRect()
    if (!to.width || !from.width) return
    const k = Math.max(0.5, Math.min(1, from.height / to.height))
    el.style.transformOrigin = '0 0'
    const a = el.animate([{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${k})`, opacity: .6 }, { transform: 'none', opacity: 1 }], { duration: 280, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' })
    a.onfinish = a.oncancel = () => el.style.removeProperty('transform-origin')
  }

  /* ----- a level opens and closes in place (grid rows, 320ms on the iOS curve: no overshoot) ----- */
  function toggleInPlace(n, opening, btn) {
    const li = host.querySelector(`#cr-level-${n}`), card = li && li.querySelector('.cr-card'), level = levelOf(n)
    if (!li || !card || !level || typeof requestAnimationFrame !== 'function') return false
    const wrap = card.querySelector(':scope > .cr-expand')
    btn.setAttribute('aria-expanded', String(opening))
    if (opening) {
      if (wrap) { wrap.classList.add('open'); return true }
      const box = document.createElement('div')
      box.innerHTML = expandHtml(level, false)
      const el = box.firstElementChild
      card.appendChild(el)
      void el.offsetHeight
      requestAnimationFrame(() => el.classList.add('open'))
      return true
    }
    if (!wrap) return true
    wrap.classList.remove('open')
    // reopening within the 420ms window reuses this wrap, so only a still-closed wrap is dropped
    const drop = () => { if (!wrap.classList.contains('open')) wrap.remove() }
    wrap.addEventListener('transitionend', drop, { once: true })
    setTimeout(drop, 420)
    return true
  }

  /* ----- clicks ----- */
  function onClick(e) {
    const b = e.target.closest('[data-act]')
    if (!b || !host.contains(b) || b.disabled) return
    const act = b.dataset.act
    if (act === 'continue') return openStep()
    if (act === 'toggle') {
      if (b.getAttribute('aria-disabled') === 'true') return
      const n = Number(b.dataset.level)
      const opening = !view.expanded.has(n)
      if (opening) view.expanded.add(n); else view.expanded.delete(n)
      if (toggleInPlace(n, opening, b)) return
      focusSel = `[data-act="toggle"][data-level="${n}"]`
      return render()
    }
    if (act === 'order') {
      setOrder(b.dataset.value)
      render()
      host.querySelector(`[data-act="order"][data-value="${order}"]`)?.focus({ preventScroll: true })
      return
    }
    if (act === 'lesson') {
      const id = b.dataset.id
      const found = lessonOf(id)
      const row = `[data-act="lesson"][data-id="${id}"]`
      const start = () => { mapMemo.row = row; flip = b.querySelector('.cr-ln')?.getBoundingClientRect() || null; openOwner(id) }
      if (lessonStatus(eng, progress, id) !== 'ahead' || (found && (levelLocked(found.level) || found.level.number < placedAt(progress)))) return start()
      return openOrAsk({ trigger: `[data-act="lesson"][data-id="${id}"]`, label: found ? found.lesson.title : 'this lesson', start })
    }
    if (act === 'exam') {
      const l = levelOf(Number(b.dataset.level))
      const start = () => { mapMemo.row = `[data-act="exam"][data-level="${l.number}"]`; flip = b.querySelector('.cr-ln')?.getBoundingClientRect() || null; openOwner(l.exam.id) }
      if (ownerLocked(findOwner(eng, l.exam.id)) || examStatus(eng, progress, l.number) !== 'ahead') return start()
      return openOrAsk({ trigger: `[data-act="exam"][data-level="${l.number}"]`, label: l.exam.title, start })
    }
    if (act === 'map') { placementOwnerId = null; view.name = 'map'; view.itemId = null; focusSel = mapMemo.row; mapMemo.restore = true; return render() }
    if (act === 'start') return startItem(view.ownerId, b.dataset.item)
    if (act === 'back-owner') { view.itemId = null; view.answer = null; focusSel = '[data-focus="page"]'; return render() }
    if (act === 'answer') return answer(Number(b.dataset.i))
    if (act === 'theory-retry') { view.answer = null; focusSel = '[data-focus="page"]'; return render() }
    if (act === 'theory-next') { view.answer = null; view.itemId = null; return startItem(view.ownerId, b.dataset.item) }
    if (act === 'skip') return skipAhead(Number(b.dataset.level))
    if (act === 'placement') return openPlacementExam(Number(b.dataset.level))
    if (act === 'place-result-action') return placementAction(view.ownerId)?.go()
    if (act === 'place-find') return findMyLevel()
    if (act === 'place-next') return continuePlacement()
    if (act === 'place-stop') return stopHere()
    if (act === 'place-skip') {
      progress = withPlacement(progress, skipPlacement())
      save()
      focusSel = '[data-act="continue"]'
      return render()
    }
    if (act === 'place-close') { placementDoneOn = null; focusSel = '[data-act="continue"]'; return render() }
    if (act === 'place-go') { placementDoneOn = null; return openStep() }
  }
  function answer(i) {
    if (view.answer !== null) return
    const ov = ownerView(view.ownerId)
    const item = ov && ov.items.find((it) => it.id === view.itemId)
    if (!item) return
    if (ownerLocked(ov)) return openPaywall()
    view.answer = i
    const r = record(view.ownerId, item, { accuracy: i === item.params.answer ? 1 : 0, seconds: 8 })
    render()
    const fb = host.querySelector('.cr-fb')
    if (fb) { fb.setAttribute('tabindex', '-1'); fb.focus({ preventScroll: true }) }
    if (r.lessonDone && ov.kind === 'lesson') notice('Lesson complete')
  }
  async function skipAhead(n) {
    const lvl = levelOf(n)
    if (!lvl) return
    if (levelLocked(lvl)) return openPaywall()
    if (!(await confirm(`Skip ahead to level ${n}?`, `${lvl.title} opens now, and so does every level before it. Your progress in the lessons you skip stays empty, and you can still go back to them.`, 'Skip ahead'))) return
    if (levelLocked(lvl)) return openPaywall()
    progress = unlockLevel(progress, n)
    save()
    view.expanded.add(n)
    render()
    notice(`Level ${n} is open`)
  }

  if (host) host.addEventListener('click', onClick)

  /* ----- Home ----- */
  function renderHome() {
    if (!homeHost) return
    const sum = courseSummary(eng, progress)
    const step = nextStep(eng, progress)
    const fresh = !started()
    let kicker, title, sub, label, meta = ''
    if (!step) { kicker = caps('THE COURSE'); title = fresh ? 'Learn piano from the first note' : 'You are up to date'; sub = 'More lessons are on the way.'; label = 'See the course' }
    else if (step.kind === 'exam') { kicker = `${caps('LEVEL ' + step.level.number)}${dot()}${esc(up(step.level.title))}`; title = step.level.exam.title; sub = 'All the lessons are done. Show what you can do.'; label = 'Take the exam' }
    else {
      const i = step.level.lessons.indexOf(step.lesson) + 1
      kicker = fresh ? caps('THE COURSE') : `${caps('LEVEL ' + step.level.number)}${dot()}${esc(up(step.level.title))}`
      title = fresh ? 'Learn piano from the first note' : step.lesson.title
      sub = fresh ? 'Short lessons, tunes with your own keys lighting the way. No experience needed.' : step.lesson.goal
      meta = `<span><svg><use href="#i-clock"/></svg>${step.lesson.minutes} min</span><span>Lesson ${i} of ${step.level.lessons.length}</span>`
      label = fresh ? 'Start the course' : 'Continue'
      if (fresh) meta = `<span><svg><use href="#i-clock"/></svg>${step.lesson.minutes} min first lesson</span><span>${sum.lessonsTotal} lessons</span>`
    }
    homeHost.innerHTML = `<div class="rail-head"><h2>${fresh ? 'The piano course' : 'Your course'}</h2><button class="link" data-act="home-map">See the course<svg><use href="#i-chevron"/></svg></button></div>
      <div class="course-card${fresh ? ' fresh' : ''}">
        ${ring(sum.percent, `<b>${sum.percent}</b><i>%</i>`, 'big')}
        <div class="cc-body">
          <div class="kicker">${kicker}</div>
          <div class="cc-title">${esc(title)}</div>
          <div class="cc-sub">${esc(sub)}</div>
          ${meta ? `<div class="cc-meta">${meta}</div>` : ''}
        </div>
        <button class="primary" data-act="home-continue"><svg><use href="#i-play"/></svg>${esc(label)}</button>
      </div>`
  }
  if (homeHost) homeHost.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]')
    if (!b) return
    if (b.dataset.act === 'home-continue') openStep()
    else if (b.dataset.act === 'home-map') { placementOwnerId = null; view.name = 'map'; view.itemId = null; goto('course') }
  })

  return {
    show() { closeSheet(false); sync(); order = loadOrder(); render(); if (readFailed) notice(UNREAD) },
    render,
    /** What Home leads with: the next lesson (or level exam), or null when the course has nothing waiting. */
    upNext() {
      const step = nextStep(eng, progress)
      if (!step) return null
      if (step.kind === 'exam') return { kind: 'exam', id: step.level.exam.id, title: step.level.exam.title, goal: 'All the lessons are done. Show what you can do.', minutes: 0, fresh: false, bar: null }
      return { kind: 'lesson', id: step.lesson.id, title: step.lesson.title, goal: step.lesson.goal, minutes: step.lesson.minutes, fresh: !started(), bar: firstBar(step.lesson), number: step.level.lessons.indexOf(step.lesson) + 1, count: step.level.lessons.length, level: step.level.number }
    },
    /** What a back swipe reveals: the layer below the page on show ({ html, scroll }), or null on the map (nothing to go back to here). */
    peekBack() {
      if (!host || view.name === 'map' && !view.itemId) return null
      if (view.itemId) return { html: view.name === 'exam' ? renderExam() : renderLesson(), scroll: 0 }
      return { html: renderMap(), scroll: mapMemo.scroll }
    },
    /** The back swipe is on screen (true) or over (false): a render that arrives meanwhile waits for the end. */
    holdRender(on) { swiping = !!on; if (!on && renderLater) { renderLater = false; render() } },
    /** The same step the Back button takes. */
    back() {
      const b = host?.querySelector('.cr-back')
      if (b) b.click()
    },
    refreshHome() { sync(); renderHome() },
    refreshExperience() { if (view.name === 'map') render() },
    record, openOwner, returnToOwner, openStep, nextItem, nextAction, startItem, findMyLevel,
    ownerTitle: (id) => { const o = findOwner(COURSE, id); return o ? (o.lesson || o.exam).title : 'Back' },
    get progress() { return progress },
    get unsaved() { return dirty },
    get view() { return view },
    reset() { closeSheet(false); dirty = false; activeIntro = null; placementDoneOn = null; placementOwnerId = null; progress = emptyProgress(); view.expanded = new Set(); view.seen = false; view.name = 'map'; view.itemId = null; renderHome() }
  }
}
