const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { resolve } = require('node:path')
const { pathToFileURL } = require('node:url')

// Draw-call hash from the renderer before Wave 1, recorded at DPR 2.
const LEGACY_TRACE = '5c7b67d6c136f98440cba9abe4e94ed8373732ed1f171bbf18e6e4f3f5ac6228'

function harness() {
  const trace = []
  let now = 0, canvasId = 0, frameId = 0, intersections = 0
  const frames = new Map()

  function makeCanvas(clientWidth, clientHeight, id = ++canvasId) {
    const calls = []
    const record = (op, ...args) => {
      calls.push([op, ...args])
      trace.push([id, op, ...args])
    }
    const ctx = {
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
      createLinearGradient(...args) {
        const gradient = { args, stops: [] }
        record('gradient', gradient)
        return Object.assign(gradient, { addColorStop: (...stop) => gradient.stops.push(stop) })
      },
      drawImage(sprite, ...args) { record('drawImage', sprite.id, this.globalAlpha, ...args) },
      fill(...args) { record('fill', this.fillStyle, this.globalAlpha, ...args) },
      fillRect(...args) { record('fillRect', this.fillStyle, this.globalAlpha, this.globalCompositeOperation, ...args) }
    }
    let stack = []
    ctx.save = () => { stack.push({ ...ctx }); record('save') }
    ctx.restore = () => { Object.assign(ctx, stack.pop()); record('restore') }
    for (const op of ['setTransform', 'clearRect', 'beginPath', 'roundRect', 'rect', 'clip']) {
      ctx[op] = (...args) => record(op, ...args)
    }
    return { id, calls, clientWidth, clientHeight, getContext: () => ctx }
  }

  Object.assign(globalThis, {
    document: { createElement: () => makeCanvas(0, 0) },
    devicePixelRatio: 2,
    performance: { now: () => now },
    requestAnimationFrame: (cb) => { frames.set(++frameId, cb); return frameId },
    cancelAnimationFrame: (id) => frames.delete(id),
    IntersectionObserver: class {
      constructor() { intersections++ }
      observe() {}
      disconnect() {}
    }
  })

  return {
    canvas: makeCanvas(400, 280, 'rail'), trace, frames,
    get intersections() { return intersections },
    get now() { return now },
    step(time) {
      now = time
      const queued = [...frames.values()]
      frames.clear()
      for (const cb of queued) cb(now)
    }
  }
}

function legacyTrace(createKeyLight) {
  const h = harness()
  let calm = false
  const rail = createKeyLight(h.canvas, { inset: 16, calm: () => calm })
  rail.refresh()
  rail.light(4)
  rail.press(1)
  h.step(25)
  rail.release(1)
  for (const ms of [40, 160, 900, 1700, 2030]) h.step(ms)
  rail.setHands(() => 'r')
  rail.sweep()
  for (const ms of [2031, 2260, 2400, 4035]) h.step(ms)
  rail.configure({ whites: 15, baseH: 84 })
  calm = true
  rail.showChord()
  rail.hover(1)
  rail.press(8)
  rail.releaseAll()
  rail.clear()
  rail.destroy()
  return createHash('sha256').update(JSON.stringify(h.trace)).digest('hex')
}

function splitFrames(createKeyLight) {
  const h = harness()
  let calm = false
  const rail = createKeyLight(h.canvas, {
    layers: 'split', observe: false, clock: () => h.now, firstSemi: 60, inset: 16, calm: () => calm
  })
  const [c, sharp, d] = rail.keys
  rail.setHands(new Map([[60, 'right'], [61, 'left']]))
  assert.equal(h.intersections, 0)

  const frames = []
  function paint(now) {
    h.step(now)
    h.canvas.calls.length = 0
    rail.tick(now)
    assert.equal(h.frames.size, 0, 'an externally driven rail never requests a frame')
    const calls = [...h.canvas.calls]
    const images = calls.filter(([op]) => op === 'drawImage')
    const fade = calls.find(([op]) => op === 'fillRect')
    assert.equal(fade[3], 'destination-in')
    assert.deepEqual(fade[1].args, [16, 0, 384, 0])
    assert.deepEqual(fade[1].stops.map(([p]) => p), [0, 24 / 368, 1 - 24 / 368, 1])
    frames.push(images)
    return calls
  }
  const face = (calls, k, lit = false) => calls.find((call) =>
    call[0] === 'drawImage' && (call[4] > 0) === lit && Math.abs(call[7] - (k.x + (k.kind === 'w' ? .75 : 0))) < 1e-6)
  const top = rail.geometry.baseTop

  const idle = paint(0)
  const whiteSheet = face(idle, c)[1], blackSheet = face(idle, sharp)[1]
  assert.notEqual(whiteSheet, blackSheet)
  rail.press(c.semi)
  const start = paint(0)
  assert.equal(face(start, c, true)[4], face(start, c)[6] * 2, 'right hand uses the amber row')
  assert.equal(face(start, c)[8], top)

  paint(10)
  rail.press(sharp.semi)
  const halfPress = paint(22.5)
  assert.ok(Math.abs(face(halfPress, c)[8] - top - 1.9227) < .001, 'the downstroke follows the specified Bézier')
  assert.equal(face(halfPress, sharp, true)[4], face(halfPress, sharp)[6], 'left hand uses the cobalt row')
  assert.ok(face(paint(44), c)[8] < top + 2)
  const depressed = paint(45)
  const white = face(depressed, c)
  assert.equal(white[8], top + 2)
  const at = depressed.indexOf(white)
  assert.deepEqual(depressed.slice(at - 4, at + 2).map(([op]) => op),
    ['save', 'beginPath', 'rect', 'clip', 'drawImage', 'restore'])
  assert.deepEqual(depressed[at - 2], ['rect', c.x + .75, top, c.w_px - 1.5, 64])
  assert.equal(face(depressed, c, true)[8], top + 2, 'the light moves with the face')
  assert.equal(face(depressed, d)[8], top, 'neighbouring keys stay put')
  const pressedSharp = paint(55)
  const black = face(pressedSharp, sharp)
  assert.equal(black[8], top + 2, 'sharps depress by 2px too')
  assert.deepEqual(pressedSharp[pressedSharp.indexOf(black) - 2], ['rect', sharp.x, top, sharp.w_px, 64 * .6])

  paint(70)
  rail.release(c.semi)
  const release = paint(70)
  const strength = face(release, c, true)[2]
  rail.press(d.semi)
  assert.equal(face(release, c)[8], top + 2, 'release starts at the current offset')
  assert.ok(Math.abs(face(paint(180), c)[8] - top - .0773) < .001, 'the return follows the specified Bézier')
  assert.equal(face(paint(200), c, true)[2], strength / 2, 'light decays independently of the key offset')
  assert.ok(face(paint(289), c)[8] > top)
  assert.equal(face(paint(290), c)[8], top, 'return finishes at 220ms')
  assert.ok(face(paint(329), c, true))
  const expired = paint(330)
  assert.equal(face(expired, c, true), undefined, 'the released light expires at 260ms')
  assert.ok(face(expired, d, true) && face(expired, sharp, true), 'held notes stay lit')

  calm = true
  rail.showChord(true, [c.i])
  const still = paint(400)
  assert.equal(face(still, sharp)[8], top, 'reduced motion draws a still held note with no depression')
  assert.ok(face(still, c, true), 'reduced motion preserves the still chord')
  assert.ok(face(still, d, true), 'reduced motion shows held notes')
  rail.destroy()

  const layers = new Map([[whiteSheet, 1], [blackSheet, 3]])
  for (const images of frames) {
    const order = images.map(([, sheet, , , row]) => (layers.get(sheet) ?? 0) + (row > 0 ? 1 : 0))
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'plumes, white faces, white bloom, black faces, black highlights')
  }
  console.log(`split draw order across ${frames.length} frames, clipped 45/220ms travel, 260ms independent decay, and reduced motion`)
}

;(async () => {
  const source = resolve(__dirname, '../renderer/key-light-engine.js')
  const { createKeyLight } = await import(pathToFileURL(source).href)
  const trace = legacyTrace(createKeyLight)
  assert.equal(trace, LEGACY_TRACE, 'default-path canvas calls match the pre-change engine')
  console.log('legacy draw trace matches ' + trace)
  splitFrames(createKeyLight)
})().catch((err) => { console.error(err); process.exitCode = 1 })
