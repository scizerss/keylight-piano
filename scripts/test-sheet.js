// Sheet positions, due noteheads and strip updates. node scripts/test-sheet.js
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

;(async () => {
  const { playedTimeline, timelineX, dueSheetHeads, SheetStrip } = await import(pathToFileURL(path.join(__dirname, '..', 'renderer/sheet.js')).href)
  const { COLORS } = await import(pathToFileURL(path.join(__dirname, '..', 'renderer/theme.js')).href)
  const sustained = { pitch: 60, quarters: 3, head: 'sustained' }
  const rows = [
    { measure: 0, quarters: 2, x: 30, notes: [sustained] },
    { measure: 0, quarters: 0, x: 10 },
    { measure: 1, quarters: 0, x: 50 },
    { measure: 3, quarters: 0, x: 100 }
  ]
  const score = { order: [0, 1, 0, 2, 3], starts: [0, 4, 8, 12, 16], tempo: [{ beat: 0, bpm: 60 }, { beat: 4, bpm: 120 }] }

  // Written positions are sorted within each played bar. Note ends use the tempo map too.
  const timeline = playedTimeline(rows, score)
  assert.deepEqual(timeline.map((row) => row.t), [0, 2, 4, 6, 7, 10])
  assert.deepEqual(timeline.map((row) => row.x), [10, 30, 50, 10, 30, 100])
  assert.deepEqual(timeline.map((row) => row.jump), [false, false, false, true, false, true],
    'a forward jump stays pending through a measure with no drawn positions')
  assert.deepEqual(timeline[1].notes, [{ ...sustained, end: 4.5 }], 'a note can span a tempo change')
  assert.deepEqual(timeline[4].notes, [{ ...sustained, end: 8.5 }], 'a replay shares the written head with a new end time')
  assert.deepEqual(rows.map((row) => row.x), [30, 10, 50, 100])
  assert.equal(sustained.end, undefined)

  const positions = [0, 0.5, 1, 1.5, 2, 3, 4, 5].map((pos) => timelineX(timeline, pos))
  assert.ok(positions.every((x, i) => i === 0 || x >= positions[i - 1]))
  assert.deepEqual(positions, [10, 15, 20, 25, 30, 40, 50, 50])
  assert.equal(timelineX(timeline, -1), 10)
  assert.equal(timelineX(timeline, 5.99), 50, 'hold before the repeat')
  assert.equal(timelineX(timeline, 6), 10, 'jump at the repeated bar')
  assert.equal(timelineX(timeline, 6.5), 20, 'interpolation resumes after the repeat')
  assert.equal(timelineX(timeline, 9), 30, 'hold before the forward jump')
  assert.equal(timelineX(timeline, 10), 100)
  assert.equal(timelineX(timeline, 99), 100)
  assert.equal(timelineX([{ t: 2, x: 10 }], 4), 10)
  assert.deepEqual(playedTimeline([], score), [])
  assert.deepEqual(playedTimeline(rows, { ...score, order: [], starts: [] }), [])
  assert.equal(timelineX([], 0), 0)

  const rightC = { pitch: 60, hand: 'right' }
  const leftE = { pitch: 64, hand: 'left' }
  assert.deepEqual(dueSheetHeads(timeline, 2, [rightC]), new Map([['sustained', 'right']]))
  assert.deepEqual(dueSheetHeads(timeline, 6, [rightC]), new Map(), 'the first play has ended and the replay has yet to reach the note')
  assert.deepEqual(dueSheetHeads(timeline, 7, [rightC]), new Map([['sustained', 'right']]))
  const dueRows = [
    { measure: 0, quarters: 0, x: 10, notes: [{ pitch: 60, quarters: 1, head: 'expired' }] },
    { measure: 0, quarters: 1, x: 20, notes: [
      { pitch: 60, quarters: 1, head: 'c' },
      { pitch: 64, quarters: 0.5, head: 'e' },
      { pitch: 67, quarters: 1, head: 'g' }
    ] },
    { measure: 0, quarters: 1.03125, x: 21, notes: [{ pitch: 65, quarters: 0.5, head: 'near' }] },
    { measure: 0, quarters: 1.0625, x: 22, notes: [{ pitch: 65, quarters: 0.5, head: 'later' }] },
    { measure: 0, quarters: 2, x: 30, notes: [{ pitch: 60, quarters: 1, head: 'tie' }] }
  ]
  const oneBar = { order: [0], starts: [0], tempo: [{ beat: 0, bpm: 60 }] }
  const dueTimeline = playedTimeline(dueRows, oneBar)
  assert.deepEqual(dueSheetHeads(dueTimeline, 1, [rightC, leftE]), new Map([['c', 'right'], ['e', 'left']]),
    'the expired C and the G absent from the player are excluded')
  assert.deepEqual(dueSheetHeads(dueTimeline, 1, [{ pitch: 65, hand: 'right' }]), new Map([['near', 'right']]),
    'only the onset within 40 ms is included')
  assert.deepEqual(dueSheetHeads(dueTimeline, 1.5, [rightC, leftE]), new Map([['c', 'right']]))
  assert.deepEqual(dueSheetHeads(dueTimeline, 2.25, [rightC]), new Map([['tie', 'right']]))
  assert.deepEqual(dueSheetHeads(dueTimeline, 3, [rightC]), new Map())
  assert.deepEqual(dueSheetHeads(dueTimeline, 1, []), new Map())
  assert.deepEqual(dueSheetHeads([], 1, [rightC]), new Map())

  // BUG?: Two hands playing the same pitch lose one hand color. The pitch map makes both
  // written heads use the last hand in the player's due list, even on separate staves.
  // const unison = playedTimeline([{ measure: 0, quarters: 0, x: 10, notes: [
  //   { pitch: 60, quarters: 1, head: 'bass' }, { pitch: 60, quarters: 1, head: 'treble' }
  // ] }], oneBar)
  // assert.deepEqual([...dueSheetHeads(unison, 0.5, [{ pitch: 60, hand: 'left' }, rightC]).values()].sort(), ['left', 'right'])

  // Exercise placement, frame updates and cleanup with minimal elements. show() needs OSMD and a browser DOM.
  const element = () => {
    const classes = new Set()
    const styles = new Map()
    return {
      dataset: {},
      classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
      style: { setProperty: (name, value) => styles.set(name, value), removeProperty: (name) => styles.delete(name), getPropertyValue: (name) => styles.get(name) }
    }
  }
  const box = { ...element(), clientWidth: 250 }
  const transforms = []
  const music = { style: { set transform(value) { transforms.push(value) } } }
  const head = element()
  const strip = new SheetStrip(box, music)
  strip.place()
  assert.equal(box.style.getPropertyValue('--sheet-head'), '70px')
  strip.update(0, [rightC])
  assert.deepEqual(transforms, [])
  strip.timeline = playedTimeline([
    { measure: 0, quarters: 0, x: 10, notes: [{ pitch: 60, quarters: 1, head }] },
    { measure: 0, quarters: 1, x: 30 }
  ], oneBar)
  strip.update(0.5, [rightC])
  assert.deepEqual(transforms, ['translate3d(50px,0,0)'])
  assert.ok(head.classList.contains('sheet-due'))
  assert.equal(head.dataset.sheetHand, 'right')
  assert.equal(head.style.getPropertyValue('--sheet-note-color'), COLORS.hand.right)
  strip.update(0.5, [{ pitch: 60, hand: 'left' }])
  assert.equal(transforms.length, 1, 'changing the highlight alone does not rewrite the transform')
  assert.equal(head.dataset.sheetHand, 'left')
  assert.equal(head.style.getPropertyValue('--sheet-note-color'), COLORS.hand.left)
  strip.cancel()
  assert.ok(!head.classList.contains('sheet-due'))
  assert.equal(head.dataset.sheetHand, undefined)
  assert.equal(head.style.getPropertyValue('--sheet-note-color'), undefined)

  // The combined view fits the music box below the HUD. Sheet only fits the centred score to the strip.
  box.clientHeight = 216
  music.clientHeight = 152
  strip.baseHeight = 200
  strip.score = oneBar
  strip.osmd = {
    zoom: 1,
    set Zoom(value) { this.zoom = value },
    render() {},
    GraphicSheet: { VerticalGraphicalStaffEntryContainers: [] }
  }
  strip.fit()
  assert.equal(strip.osmd.zoom, (152 - 4) / 200)
  box.classList.add('sheet-only')
  box.clientHeight = 500
  strip.fit()
  assert.equal(strip.osmd.zoom, (500 - 28) / 200)

  console.log('test-sheet: ok')
})().catch((e) => { console.error(e); process.exit(1) })
