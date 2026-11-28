const assert = require('node:assert/strict')
const vectors = require('./fixtures/blocks-leds-vectors.json')

const hex = (bytes) => Buffer.from(bytes).toString('hex')
const counter = (packet) => packet[7] | (packet[8] << 7) | ((packet[9] & 3) << 14)

function clock() {
  let now = 0, nextId = 0
  const scheduled = new Map()
  function add(fn, delay, interval) {
    const id = nextId++
    scheduled.set(id, { at: now + delay, fn, interval })
    return id
  }
  const cancel = (id) => scheduled.delete(id)
  return {
    now: () => now,
    timers: {
      setInterval: (fn, delay) => add(fn, delay, delay),
      setTimeout: (fn, delay) => add(fn, delay, 0),
      clearInterval: cancel,
      clearTimeout: cancel
    },
    run(ms) {
      const end = now + ms
      for (;;) {
        const next = [...scheduled.entries()].sort(([, a], [, b]) => a.at - b.at)[0]
        if (!next || next[1].at > end) break
        const [id, task] = next
        now = task.at
        if (task.interval) task.at += task.interval
        else scheduled.delete(id)
        task.fn()
      }
      now = end
    }
  }
}

async function main() {
  const B = await import('../renderer/blocks.js')
  const { KEY_PROGRAM, KeyRenderer, RemoteHeap, LUMI_HEAP_SIZE, LIGHTS_TIMEOUT_MS } = await import('../renderer/blocks-leds.js')
  const { index, initialAck, frames } = vectors
  const serial = 'LKBP14AAAAAAAAAA', peer = 'LKB5KXBBBBBBBBBB', peerIndex = 15
  const firmware = '1.3.5'
  const device = (idx, fields) => {
    const body = B.pack7([[0, 32], ...fields])
    return [...B.ROLI_SYSEX, 0x40 | idx, ...body, B.checksum(body), 0xf7]
  }
  const ack = (idx, value) => device(idx, [[2, 7], [value, 10]])
  const config = (idx) => device(idx, [[0x18, 7], [4, 4], [4, 8], [0, 32], [-4, 32], [4, 32]])
  const versionFields = (idx, fw) => [
    [6, 7], [idx, 7], [fw.length, 7], ...[...fw].map((ch) => [ch.charCodeAt(0), 7])
  ]
  const topology = (master, devices, versions = []) => device(master, [
    [1, 7], [1, 8], [devices.length, 7], [devices.length === 2 ? 1 : 0, 8],
    ...devices.flatMap(([sn, idx]) => [
      ...[...sn].map((ch) => [ch.charCodeAt(0), 7]), [idx, 7], [20, 5], [0, 1]
    ]),
    ...(devices.length === 2 ? [[index, 7], [7, 5], [peerIndex, 7], [0, 5]] : []),
    ...versions.flatMap(([idx, fw]) => versionFields(idx, fw))
  ])
  const programFields = (values) => [[0x28, 7], ...values.map((word) => [word, 32])]
  function readChallenge(packet) {
    const value = packet.slice(6, -2).reduce((bits, byte, i) => bits | (BigInt(byte) << BigInt(i * 7)), 0n)
    assert.equal(Number(value & 127n), 3)
    return [7, 39, 71].map((shift) => Number((value >> BigInt(shift)) & 0xffffffffn))
  }

  assert.equal(KEY_PROGRAM.length, 144)
  assert.equal(hex(KEY_PROGRAM), vectors.program)
  assert.equal(hex(B.programEventPacket(index, ...vectors.challenge)), vectors.challengePacket)

  const heap = new RemoteHeap(LUMI_HEAP_SIZE)
  assert.equal(heap.sendChanges(index, 0), null, 'an empty heap sends nothing')
  assert.equal(heap.handleAck(initialAck), false, 'an initial ACK seeds the device counter')
  heap.setBytes(0, KEY_PROGRAM)
  const first = heap.sendChanges(index, 0)
  const second = heap.sendChanges(index, 0)
  assert.deepEqual([hex(first), hex(second)], vectors.upload)
  assert.deepEqual([counter(first), counter(second)], [1023, 0], '10-bit counter wraps in the 16-bit field')
  assert.equal(heap.sendChanges(index, 0), null, 'in-flight data exhausts the budget')
  assert.equal(heap.getRetransmit(249), null)
  assert.equal(heap.getRetransmit(250), first)
  assert.equal(heap.getRetransmit(499), null)
  assert.equal(heap.handleAck(initialAck), false, 'duplicate ACK does not discard pending writes')
  assert.equal(heap.inFlightCount, 2)
  assert.equal(heap.handleAck(counter(second)), true, 'final ACK confirms all earlier packets')
  assert.equal(heap.inFlightCount, 0)
  assert.equal(heap.isDirty, false)

  for (const { pixels, packets } of frames) {
    heap.setBytes(KEY_PROGRAM.length, Buffer.from(pixels, 'hex'))
    const update = heap.sendChanges(index, 250)
    assert.deepEqual([hex(update)], packets)
    assert.equal(heap.handleAck(counter(update)), true)
    assert.equal(heap.sendChanges(index, 251), null)
  }
  const generation = heap.generation
  assert.equal(heap.handleAck(initialAck), false, 'an unexpected counter invalidates optimistic state')
  assert.equal(heap.generation, generation + 1)
  assert.equal(counter(heap.sendChanges(index, 300)), 1023)

  function rendererRig(overrides = {}) {
    const c = clock(), sent = [], states = []
    const renderer = new KeyRenderer({
      ...c, serial, index, firmware, send: (packet) => sent.push(packet),
      onState: (state, reason) => states.push([state, reason]), ...overrides
    })
    return { c, sent, states, renderer }
  }

  function upload(renderer, c, sent) {
    renderer.onAck(initialAck)
    c.run(66)
    assert.deepEqual(sent.splice(0).map(hex), vectors.upload)
    renderer.onAck(0)
    c.run(33)
    return readChallenge(sent.shift())
  }

  let r = rendererRig()
  r.renderer.start()
  assert.equal(r.renderer.state, 'probing')
  r.c.run(33)
  assert.equal(r.sent.length, 0, 'wait for API ACK before writing the heap')
  assert.equal(r.renderer.setFrame(frames[0].colors, 1), true, 'buffer a frame during upload')
  r.renderer.onProgramEvent(vectors.challenge)
  assert.equal(r.renderer.state, 'probing')
  const challenge = upload(r.renderer, r.c, r.sent)
  assert.deepEqual(challenge.slice(0, 2), vectors.challenge.slice(0, 2))
  r.c.run(264)
  assert.deepEqual(readChallenge(r.sent.shift()), challenge, 'only the current challenge is retried')
  r.renderer.onProgramEvent([challenge[0], challenge[1], challenge[2] + 1])
  assert.equal(r.renderer.state, 'probing')
  r.renderer.onProgramEvent(challenge)
  assert.equal(r.renderer.state, 'ready')
  r.c.run(33)
  assert.deepEqual(r.sent.splice(0).map(hex), frames[0].packets)
  r.renderer.onAck(1)
  assert.equal(r.renderer.setFrame(frames[0].colors, 0.1), true)
  assert.equal(r.renderer.setFrame(frames[1].colors, frames[1].brightness), true)
  assert.equal(r.renderer.setFrame(frames[1].colors.slice(1), 1), false)
  r.c.run(32)
  assert.equal(r.sent.length, 0, 'frames coalesce within the 33 ms interval')
  r.c.run(1)
  assert.deepEqual(r.sent.splice(0).map(hex), frames[1].packets)
  r.renderer.onAck(2)
  r.c.run(400)
  assert.equal(r.sent.length, 0, 'an unchanged, acknowledged frame sends nothing')

  r.renderer.onAck(initialAck)
  assert.equal(r.renderer.state, 'probing', 'counter mismatch restarts the code-only upload')
  r.c.run(66)
  assert.deepEqual(r.sent.splice(0).map(hex), vectors.upload)
  r.renderer.onAck(0)
  r.c.run(33)
  const nextChallenge = readChallenge(r.sent.shift())
  assert.notDeepEqual(nextChallenge, challenge)
  r.renderer.onProgramEvent(challenge)
  assert.equal(r.renderer.state, 'probing', 'an old reply cannot mark a fresh upload ready')
  r.renderer.onProgramEvent(nextChallenge)
  r.c.run(33)
  assert.equal(r.sent.length, 1, 'the newest frame is reapplied after the new challenge')
  r.renderer.reset()
  assert.equal(r.renderer.state, 'idle')
  r.sent.length = 0
  r.c.run(6500)
  assert.deepEqual(r.sent, [], 'reset cancels retries and abandons queued LED data')
  r.renderer.start()
  assert.notDeepEqual(upload(r.renderer, r.c, r.sent), nextChallenge, 'resume uploads and challenges again')

  for (const overrides of [{}, { firmware: '1.2.99' }, { serial: 'RP4XYZ' }]) {
    r = rendererRig(overrides)
    r.renderer.start()
    if (!Object.keys(overrides).length) {
      upload(r.renderer, r.c, r.sent)
      r.c.run(6000)
      assert.deepEqual(r.states.at(-1), ['failed', 'timeout'])
    } else {
      assert.deepEqual(r.states.at(-1), ['failed', 'unsupported'])
      assert.equal(r.sent.length, 0)
    }
  }

  const messages = B.parsePacket(device(index, [
    [0x20, 7], [0, 5], [41, 12],
    [0x13, 7], [0, 32], [0, 32], [0, 2],
    [0x03, 7], [0, 7], [0, 32],
    [0x18, 7], [7, 4], [0x18, 7], [9, 4],
    [2, 7], [1009, 10], ...programFields(challenge)
  ])).messages
  assert.deepEqual(messages, [{ type: 'ack', counter: 1009 }, { type: 'programEvent', values: challenge }])
  assert.deepEqual(B.parsePacket(device(index, [[0x7f, 7], [2, 7], [1, 10]])).messages, [])

  const row = [[serial, index], [peer, peerIndex]]
  const lateVersions = device(index, [...versionFields(index, firmware), ...versionFields(peerIndex, '1.3.0')])
  function linkRig(master = index) {
    const c = clock(), sent = [], states = [], changes = []
    const link = new B.BlocksLink({
      ...c, send: (packet) => sent.push(packet), onChange: (info, why) => changes.push(why),
      onLightsState: (state, detail) => states.push([state, detail])
    })
    link.start()
    link.feed(topology(master, row))
    return { c, sent, link, states, changes }
  }

  const left = linkRig(), right = linkRig(peerIndex)
  for (const [side, ownedSerial, idx] of [[left, serial, index], [right, peer, peerIndex]]) {
    side.link.startLights()
    assert.equal(side.link.lightsState(), 'probing')
    side.link.feed(config(idx))
    assert.deepEqual(side.link.ownedSerials(), [ownedSerial])
    assert.equal(side.link.lightsDetails()[0].firmware, '')
    assert.equal(side.sent.filter((p) => p[6] === 1 && p[7] === 0).length, 0)
    side.link.feed(lateVersions)
    assert.equal(side.changes.at(-1), 'firmware')
    assert.equal(side.link.lightsDetails()[0].firmware, idx === index ? firmware : '1.3.0')
    side.link.feed(topology(idx, row))
    assert.equal(side.link.lightsDetails()[0].firmware, idx === index ? firmware : '1.3.0', 'a topology poll preserves late firmware')
    side.link.startLights()
    const apiCommands = (command) => side.sent.filter((p) => p[6] === 1 && p[7] === command)
    assert.deepEqual(apiCommands(2), [B.endApiPacket(idx)])
    assert.deepEqual(apiCommands(0), [B.beginApiPacket(idx)])
    assert.ok(side.sent.indexOf(apiCommands(2)[0]) < side.sent.indexOf(apiCommands(0)[0]))
    side.link.feed(ack(idx === index ? peerIndex : index, initialAck))
    side.c.run(66)
    const heapPackets = () => side.sent.filter((p) => p[6] === 2)
    assert.equal(heapPackets().length, 0, 'another block’s ACK cannot seed the renderer')
    side.link.feed(ack(idx, initialAck))
    side.c.run(66)
    assert.equal(heapPackets().length, 2)
    assert.ok(heapPackets().every((packet) => packet[5] === idx))
    assert.equal(side.link.setKeyFrame(idx === index ? peer : serial, frames[0].colors), false)
    side.link.feed(ack(idx, 0))
    side.c.run(33)
    const query = side.sent.find((p) => p[6] === 3)
    assert.equal(query[5], idx)
    side.link.feed(device(idx, [[0x21, 7], [0, 17], ...programFields(readChallenge(query))]))
    assert.equal(side.link.lightsState(), 'ready')
    assert.equal(side.states.at(-1)[0], 'ready')
    assert.equal(side.link.setKeyFrame(ownedSerial, frames[0].colors), true)
    side.c.run(33)
    assert.equal(heapPackets().length, 3)
    assert.equal(heapPackets().at(-1)[5], idx)
    side.link.feed(ack(idx, 1))

    side.link.setApi(true, 'lights')
    side.link.setApi(true, 'read')
    side.link.setApi(false, 'lights')
    side.link.setApi(false, 'read')
    assert.equal(apiCommands(2).length, 1, 'legacy holds do not end an active renderer session')
    side.c.run(1700)
    assert.ok(apiCommands(3).length > 0)
    assert.ok(apiCommands(3).every((packet) => packet[5] === idx), 'ping the real master, scoped to this link')
    side.link.stopLights()
    assert.deepEqual(apiCommands(2), [B.endApiPacket(idx), B.endApiPacket(idx)])
    assert.equal(side.link.lightsState(), 'idle')
    const pings = apiCommands(3).length
    side.c.run(1700)
    assert.equal(apiCommands(3).length, pings, 'no pings after stopLights')
    side.link.stop()
  }

  const usb = linkRig()
  usb.link.setOwnedSerials([serial, peer])
  usb.link.feed(lateVersions)
  usb.link.startLights()
  assert.deepEqual(usb.link.ownedSerials(), [serial, peer])
  for (const idx of [index, peerIndex]) usb.link.feed(ack(idx, initialAck))
  usb.c.run(66)
  assert.deepEqual(usb.sent.filter((p) => p[6] === 2).map((p) => p[5]), [index, peerIndex, index, peerIndex])
  const beforeDrop = usb.sent.length
  usb.link.setOwnedSerials([serial])
  assert.ok(usb.sent.slice(beforeDrop).some((p) => hex(p) === hex(B.endApiPacket(peerIndex))), 'a block that leaves the owned set leaves API mode now')
  usb.sent.length = 0
  usb.c.run(2000)
  assert.ok(usb.sent.filter((p) => [1, 2, 3].includes(p[6]) && p[7] !== 1).every((p) => p[5] === index))
  usb.link.stop()
  usb.sent.length = 0
  usb.c.run(6000)
  assert.deepEqual(usb.sent, [], 'stopping a link cancels all renderer timers')
  assert.equal(usb.link.lightsState(), 'idle')

  const missing = linkRig()
  missing.link.setOwnedSerials([serial])
  missing.link.startLights()
  missing.c.run(6000)
  assert.equal(missing.link.lightsDetails()[0].reason, 'no-firmware')
  assert.equal(missing.link.lightsState(), 'failed')
  missing.link.stop()

  const timedOut = linkRig()
  timedOut.link.setOwnedSerials([serial])
  timedOut.link.feed(lateVersions)
  timedOut.link.startLights()
  timedOut.c.run(6100)
  assert.equal(timedOut.link.lightsDetails()[0].reason, 'timeout')
  assert.equal(timedOut.link.api, false)
  assert.equal(timedOut.sent.filter((p) => hex(p) === hex(B.endApiPacket(index))).length, 2)
  timedOut.link.stop()

  const held = linkRig()
  held.link.setOwnedSerials([serial])
  held.link.feed(lateVersions)
  held.link.setApi(true, 'read')
  held.link.startLights()
  held.sent.length = 0
  held.link.stopLights()
  assert.deepEqual(held.sent, [B.endApiPacket(index), B.beginApiPacket(index)], 'restore the factory program while retaining the read hold')
  held.link.setApi(false, 'read')
  assert.deepEqual(held.sent.at(-1), B.endApiPacket(index))
  held.link.feed(topology(index, [['LKB123CCCCCCCCCC', index]]))
  assert.equal(held.link.info.blocks[0].firmware, '', 'firmware metadata does not follow a reused index')
  held.link.stop()

  // the link's program up to 'ready' on block idx (as above)
  function makeReady(rig, idx) {
    rig.link.feed(ack(idx, initialAck))
    rig.c.run(66)
    rig.link.feed(ack(idx, 0))
    rig.c.run(33)
    const query = rig.sent.filter((p) => p[6] === 3 && p[5] === idx).at(-1)
    rig.link.feed(device(idx, [[0x21, 7], [0, 17], ...programFields(readChallenge(query))]))
    assert.equal(rig.link.lightsState(), 'ready')
  }

  // #4: a block snapped on long after the lights got ready has its own firmware timeout, not an expired one
  const late = (() => {
    const c = clock(), sent = []
    const link = new B.BlocksLink({ ...c, send: (packet) => sent.push(packet) })
    link.start()
    link.feed(topology(index, [[serial, index]], [[index, firmware]]))
    return { c, sent, link }
  })()
  late.link.setOwnedSerials([serial, peer])
  late.link.startLights()
  makeReady(late, index)
  assert.equal(late.link.lightsTimer, null, 'the lights timeout stops once every owned block is ready')
  late.c.run(7000)
  assert.equal(late.link.lightsExpired, false)
  late.link.feed(topology(index, row, [[index, firmware]]))
  assert.deepEqual(late.link.lightsDetails().map((b) => [b.serial, b.state, b.reason]), [[serial, 'ready', null], [peer, 'probing', null]],
    'a block snapped on later waits for its version packet')
  assert.equal(late.link.lightsState(), 'probing')
  late.c.run(6100)
  assert.equal(late.link.lightsDetails()[1].reason, 'no-firmware', 'the new block gets its own timeout')
  late.link.stop()

  // #2: two joined blocks, only the left one's port connected: its link gets ready, the right block has no
  // owner, so the row never gets ready and the app's wait gives up after ROW_LIGHTS_TIMEOUT_MS
  const only = linkRig()
  only.link.startLights()
  only.link.feed(config(index))
  only.link.feed(lateVersions)
  makeReady(only, index)
  const rowBlocks = only.link.info.blocks
  const route = B.routeRowLights(rowBlocks, [only.link])
  assert.equal(route.ready, false)
  assert.deepEqual(route.waiting, [peer])
  assert.equal(route.routed[0].link, only.link)
  let expiredCalls = 0
  const wait = new B.RowLightsWait({ timers: only.c.timers, onExpire: () => expiredCalls++ })
  wait.wait(rowBlocks.map((b) => b.serial).join(','))
  only.c.run(B.ROW_LIGHTS_TIMEOUT_MS - 1)
  assert.equal(wait.expired, false)
  wait.wait(rowBlocks.map((b) => b.serial).join(','))
  only.c.run(1)
  assert.equal(wait.expired, true, 'the same row keeps its deadline')
  assert.equal(expiredCalls, 1)
  wait.reset()
  assert.equal(wait.expired, false)
  wait.wait('a'); only.c.run(5000); wait.wait('b'); only.c.run(5000)
  assert.equal(wait.expired, false, 'another row starts the count again')
  wait.wait(''); only.c.run(10000)
  assert.equal(wait.expired, false, 'nothing waited for: no timeout')
  assert.equal(B.routeRowLights(rowBlocks.slice(0, 1), [only.link]).ready, true)
  only.link.stop()

  // another input feeds the link (a swap, the row folded): the old replies' blocks are forgotten and left in no
  // API mode, and config replies wait for this input's own topology before they say who answers here
  const fed = linkRig()
  fed.link.feed(lateVersions)
  fed.link.startLights()
  fed.link.feed(config(index))
  assert.deepEqual(fed.link.ownedSerials(), [serial])
  fed.c.run(30)
  fed.sent.length = 0
  fed.link.resetOwnership()
  assert.deepEqual(fed.link.ownedSerials(), [])
  assert.ok(fed.sent.some((p) => hex(p) === hex(B.endApiPacket(index))), 'the block it no longer owns leaves API mode')
  assert.ok(fed.sent.some((p) => hex(p) === hex(B.topologyRequest(0))), 'asks the new input for its topology now')
  fed.link.feed(config(peerIndex))
  assert.deepEqual(fed.link.ownedSerials(), [], 'a reply before the new topology is not labelled with the old one')
  fed.sent.length = 0
  fed.link.feed(topology(index, row))
  fed.c.run(100)
  fed.link.feed(config(peerIndex))
  assert.deepEqual(fed.link.ownedSerials(), [peer], 'the new topology labels the replies again')
  fed.link.stop()

  // a link still probing (nothing answered yet) when its input changes: the re-probe gets the full timeout,
  // not what was left of the old one
  const reprobe = linkRig()
  reprobe.link.startLights()
  reprobe.c.run(LIGHTS_TIMEOUT_MS - 100)
  assert.equal(reprobe.link.lightsState(), 'probing')
  reprobe.link.resetOwnership()
  reprobe.c.run(200)
  assert.equal(reprobe.link.lightsState(), 'probing', 'resetOwnership re-arms the lights timer')
  reprobe.c.run(LIGHTS_TIMEOUT_MS)
  assert.equal(reprobe.link.lightsState(), 'failed', 'still bounded')
  reprobe.link.stop()

  // two links that share a block but not the row (one still holds the topology from before a split/snap-on)
  const infoOf = (...serials) => ({ blocks: serials.map((s) => ({ serial: s })) })
  assert.equal(B.rowsDisagree([infoOf('A', 'B'), infoOf('B')]), true, 'split: one link still sees the joined row')
  assert.equal(B.rowsDisagree([infoOf('A'), infoOf('B', 'A')]), true, 'snap-on: one link already sees the joined row')
  assert.equal(B.rowsDisagree([infoOf('A', 'B'), infoOf('B', 'A')]), false, 'the same row on two ports')
  assert.equal(B.rowsDisagree([infoOf('A'), infoOf('B')]), false, 'two keyboards')
  assert.equal(B.rowsDisagree([infoOf('A', 'B'), null]), false)

  console.log('blocks-leds: ok')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
