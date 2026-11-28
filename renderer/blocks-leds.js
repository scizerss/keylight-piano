// LittleFoot key renderer and heap transport adapted from blocksd v0.8.0.
// Copyright (c) 2025-2026 hyperb1iss (Stefanie Jane), ISC. See LICENSES/blocksd-ISC.txt.
import { frame, pack7, programEventPacket } from './blocks.js'

// Generated from blocksd v0.8.0 key_led_program(), ISC, hyperb1iss.
export const KEY_PROGRAM = Object.freeze([
  0x1a, 0x07, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x30, 0x00, 0x64, 0x8c, 0x16, 0x00, 0x8d, 0x6f,
  0x28, 0x00, 0x0b, 0xea, 0x68, 0x00, 0x0d, 0x64, 0x0d, 0x24, 0x07, 0xf6, 0xf8, 0x0b, 0x07, 0x8e,
  0x7e, 0x0b, 0x0c, 0x07, 0xa3, 0x81, 0x05, 0x00, 0x0b, 0x10, 0x0d, 0x18, 0x24, 0x36, 0x03, 0x65,
  0x00, 0x10, 0x0d, 0x10, 0x22, 0x0b, 0x18, 0x02, 0x0d, 0x05, 0x18, 0x03, 0x0d, 0x0b, 0x20, 0x40,
  0x0d, 0x03, 0x2d, 0x0d, 0x06, 0x18, 0x04, 0x0d, 0x05, 0x20, 0x40, 0x0d, 0x02, 0x2d, 0x0d, 0x05,
  0x18, 0x05, 0x40, 0x0d, 0x03, 0x2d, 0x0e, 0xff, 0x00, 0x07, 0x83, 0x3f, 0x07, 0x0b, 0xc2, 0x08,
  0x0c, 0x20, 0x01, 0x29, 0x00, 0x08, 0x05, 0x00, 0x18, 0x01, 0x0f, 0x44, 0x45, 0x4c, 0x42, 0x24,
  0x02, 0x8e, 0x00, 0x18, 0x02, 0x0d, 0x02, 0x24, 0x02, 0x8e, 0x00, 0x0d, 0x64, 0x0d, 0x24, 0x07,
  0xf6, 0xf8, 0x18, 0x03, 0x0d, 0x02, 0x0f, 0x44, 0x45, 0x4c, 0x42, 0x07, 0xd2, 0xce, 0x05, 0x03
])

export const LUMI_HEAP_SIZE = 7200
const KEY_COUNT = 24
const PIXEL_BYTES = KEY_COUNT * 2
const FRAME_MS = 33
const RETRY_MS = 250
export const LIGHTS_TIMEOUT_MS = 6000
const READY_MARKER = 0x424c4544
const KEY_RENDERER = 2
const MAX_NONCE = 0x7fffffff
let nonce = Math.floor(Math.random() * MAX_NONCE)

const UNKNOWN = 0x100
const COUNTER_MASK = 0x3ff
const IN_FLIGHT_BYTES = 200
const BODY_BITS = (200 - 8) * 7 // SysEx header + index + checksum + terminator

function diffRegions(current, target) {
  const regions = []
  for (let offset = 0; offset < target.length;) {
    const skip = current[offset] === target[offset]
    let end = offset + 1
    while (end < target.length && (current[end] === target[end]) === skip) end++
    regions.push({ skip, offset, count: end - offset })
    offset = end
  }
  // Merge short SET, SKIP, SET sequences, from right to left as in blocksd.
  for (let i = regions.length - 1; i >= 2; i--) {
    const [left, middle, right] = [regions[i - 2], regions[i - 1], regions[i]]
    const count = left.count + middle.count + right.count
    if (!left.skip && middle.skip && !right.skip && count < 32) {
      left.count = count
      regions.splice(i - 1, 2)
      i--
    }
  }
  if (regions.at(-1)?.skip) regions.pop()
  return regions
}

// Encode as much of a diff as fits, reserving 3 bits for the end command.
function encodeChanges(index, counter, regions, target, expected) {
  const fields = [[2, 7], [counter, 16]]
  let bitsLeft = BODY_BITS - 7 - 16 - 3
  let lastValue = null
  const result = expected.slice()
  let changed = false, complete = true

  for (const { skip, offset, count } of regions) {
    if (skip) {
      const remainder = count % 255
      const skipBits = Math.floor(count / 255) * 11 + (remainder ? (remainder <= 15 ? 7 : 11) : 0)
      if (skipBits > bitsLeft) { complete = false; break }
      bitsLeft -= skipBits
      for (let left = count; left > 0; left -= 255) {
        if (left <= 15) fields.push([2, 3], [left, 4])
        else fields.push([3, 3], [Math.min(left, 255), 8])
      }
      continue
    }

    const end = offset + count
    let pos = offset
    while (pos < end) {
      const value = target[pos]
      let run = 1
      while (pos + run < end && target[pos + run] === value) run++

      let chunk
      if (run >= 3 || end - pos <= 3) {
        if (run > 15 && bitsLeft >= 19) {
          chunk = Math.min(run, 255)
          fields.push([7, 3], [chunk, 8], [value, 8])
          bitsLeft -= 19
        } else if (value === lastValue && bitsLeft >= 7) {
          chunk = Math.min(run, 15)
          fields.push([6, 3], [chunk, 4])
          bitsLeft -= 7
        } else if (bitsLeft >= 15) {
          chunk = Math.min(run, 15)
          fields.push([5, 3], [chunk, 4], [value, 8])
          bitsLeft -= 15
        } else break
      } else {
        let sequenceEnd = pos + 1
        while (sequenceEnd < end) {
          if (sequenceEnd + 2 < end && target[sequenceEnd] === target[sequenceEnd + 1] &&
              target[sequenceEnd] === target[sequenceEnd + 2]) break
          sequenceEnd++
        }
        chunk = Math.min(sequenceEnd - pos, Math.floor((bitsLeft - 3) / 9))
        if (chunk <= 0) break
        fields.push([4, 3])
        for (let i = 0; i < chunk; i++) fields.push([target[pos + i], 8], [i + 1 < chunk ? 1 : 0, 1])
        bitsLeft -= 3 + chunk * 9
      }
      lastValue = target[pos + chunk - 1]
      for (let i = pos; i < pos + chunk; i++) {
        if (expected[i] !== target[i]) changed = true
        result[i] = target[i]
      }
      pos += chunk
    }
    if (pos < end) { complete = false; break }
  }
  if (!changed) return null
  fields.push([complete ? 1 : 0, 3])
  return { packet: frame(index, pack7(fields)), result, complete }
}

// Holds the acknowledged heap, the desired heap, and optimistic results for pending packets.
export class RemoteHeap {
  constructor(size) {
    this.size = size
    this.generation = 0
    this.target = new Uint8Array(size)
    this.confirmed = new Uint16Array(size).fill(UNKNOWN)
    this.pending = []
    this.transfer = null
    this.packetIndex = 0
    this.lastAck = null
  }

  reset() {
    this.target.fill(0)
    this.lastAck = null
    this.resetDeviceState()
  }

  resetDeviceState() {
    this.generation++
    this.confirmed.fill(UNKNOWN)
    this.pending.length = 0
    this.transfer = null
    this.packetIndex = this.lastAck == null ? 0 : (this.lastAck + 1) & COUNTER_MASK
  }

  setBytes(offset, bytes) { this.target.set(bytes, offset) }
  get inFlightCount() { return this.pending.length }
  get inFlightBytes() { return this.pending.reduce((sum, message) => sum + message.packet.length - 8, 0) }
  get isDirty() {
    if (this.transfer) return true
    const expected = this.pending.at(-1)?.result ?? this.confirmed
    return this.target.some(Boolean) && this.target.some((byte, i) => byte !== expected[i])
  }

  sendChanges(index, now = performance.now()) {
    if (this.inFlightBytes >= IN_FLIGHT_BYTES) return null
    if (!this.transfer) {
      if (!this.isDirty) return null
      this.transfer = this.target.slice()
    }
    const target = this.transfer
    const expected = this.pending.at(-1)?.result ??
      Uint8Array.from(this.confirmed, (byte, i) => byte === UNKNOWN ? target[i] ^ 0xff : byte)
    const regions = diffRegions(expected, target)
    if (!regions.length) { this.transfer = null; return null }

    const encoded = encodeChanges(index, this.packetIndex, regions, target, expected)
    if (!encoded) return null
    if (encoded.complete) this.transfer = null
    this.pending.push({ index: this.packetIndex, packet: encoded.packet, result: encoded.result, sentAt: now })
    this.packetIndex = (this.packetIndex + 1) & COUNTER_MASK
    return encoded.packet
  }

  handleAck(counter) {
    if (counter === this.lastAck) return false
    this.lastAck = counter
    const match = this.pending.findIndex((message) => message.index === counter)
    if (match < 0) {
      this.resetDeviceState()
      return false
    }
    this.confirmed.set(this.pending[match].result)
    this.pending.splice(0, match + 1)
    return true
  }

  getRetransmit(now = performance.now()) {
    const first = this.pending[0]
    if (!first || now - first.sentAt < RETRY_MS) return null
    first.sentAt = now
    return first.packet
  }
}

export function supportsKeyRenderer(serial, firmware) {
  const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(firmware ?? '').trim())
  if (!String(serial).toUpperCase().startsWith('LKB') || !version) return false
  const major = Number(version[1]), minor = Number(version[2])
  return major > 1 || (major === 1 && minor >= 3)
}

// RGB565 in LittleFoot's heap layout: red occupies the low 5 bits.
function encodeFrame(colors, brightness) {
  const pixels = new Uint8Array(PIXEL_BYTES)
  const scale = Math.max(0, Math.min(1, brightness))
  for (let i = 0; i < KEY_COUNT; i++) {
    const color = colors[i]
    if (color?.length !== 3 || !Number.isFinite(color[0]) || !Number.isFinite(color[1]) || !Number.isFinite(color[2])) return null
    const [r, g, b] = Array.from(color, (channel) => Math.floor(Math.max(0, Math.min(255, channel)) * scale))
    const rgb = (r >> 3) | ((g >> 2) << 5) | ((b >> 3) << 11)
    pixels[2 * i] = rgb & 0xff
    pixels[2 * i + 1] = rgb >> 8
  }
  return pixels
}

export class KeyRenderer {
  constructor({ serial, index, firmware, send, onState = () => {}, timers = globalThis, now = () => performance.now() }) {
    this.serial = serial
    this.index = index
    this.firmware = firmware
    this.send = send
    this.onState = onState
    this.t = timers
    this.now = now
    this.heap = new RemoteHeap(LUMI_HEAP_SIZE)
    this.pixels = new Uint8Array(PIXEL_BYTES)
    this.state = 'idle'
    this.reason = null
    this.timer = null
  }

  start() {
    if (this.state !== 'idle') return
    if (!supportsKeyRenderer(this.serial, this.firmware)) {
      this.setState('failed', 'unsupported')
      return
    }
    this.prepareUpload()
    this.deadline = this.now() + LIGHTS_TIMEOUT_MS
    this.timer = this.t.setInterval(() => this.tick(), FRAME_MS)
    // The begin-API ACK supplies the current counter before the first heap write.
    this.setState('probing')
  }

  reset() {
    this.stopTimer()
    this.heap.reset()
    this.pixels.fill(0)
    this.setState('idle')
  }

  stopTimer() {
    if (this.timer != null) this.t.clearInterval(this.timer)
    this.timer = null
  }

  prepareUpload() {
    this.heap.target.fill(0)
    this.heap.setBytes(0, KEY_PROGRAM)
    this.challenge = [READY_MARKER, KEY_RENDERER, nonce = nonce % MAX_NONCE + 1]
    this.lastQuery = null
  }

  setState(state, reason = null) {
    if (this.state === state && this.reason === reason) return
    this.state = state
    this.reason = reason
    this.onState(state, reason)
  }

  onAck(counter) {
    if (this.state !== 'probing' && this.state !== 'ready') return
    const generation = this.heap.generation
    const matched = this.heap.handleAck(counter)
    if (generation !== this.heap.generation) {
      this.prepareUpload()
      if (this.state === 'ready') {
        this.deadline = this.now() + LIGHTS_TIMEOUT_MS
        this.setState('probing')
      }
    } else if (matched && this.state === 'ready') {
      this.deadline = this.heap.inFlightCount ? this.now() + LIGHTS_TIMEOUT_MS : null
    }
  }

  onProgramEvent(values) {
    if (this.state !== 'probing' || this.lastQuery == null ||
        values.length !== this.challenge.length || !this.challenge.every((part, i) => part === values[i])) return
    this.deadline = null
    this.heap.setBytes(KEY_PROGRAM.length, this.pixels)
    this.framePending = true
    this.setState('ready')
  }

  setFrame(colors24, brightness = 1) {
    if ((this.state !== 'probing' && this.state !== 'ready') ||
        colors24?.length !== KEY_COUNT || !Number.isFinite(brightness)) return false
    const pixels = encodeFrame(colors24, brightness)
    if (!pixels) return false
    if (this.pixels.every((byte, i) => byte === pixels[i])) return true
    this.pixels = pixels
    if (this.state === 'ready') {
      this.heap.setBytes(KEY_PROGRAM.length, pixels)
      this.framePending = true
    }
    return true
  }

  tick() {
    const now = this.now()
    if (this.deadline != null && now >= this.deadline) {
      this.stopTimer()
      this.setState('failed', 'timeout')
      return
    }
    if (this.heap.lastAck == null) return

    if (this.state === 'probing' && !this.heap.inFlightCount && !this.heap.isDirty) {
      if (this.lastQuery == null || now - this.lastQuery >= RETRY_MS) {
        this.lastQuery = now
        this.send(programEventPacket(this.index, ...this.challenge))
      }
      return
    }
    const retry = this.heap.getRetransmit(now)
    if (retry) { this.send(retry); return }

    if (this.state === 'ready' && !this.framePending) return
    const packet = this.heap.sendChanges(this.index, now)
    if (this.state === 'ready') this.framePending = this.heap.isDirty
    if (!packet) return
    if (this.state === 'ready' && this.deadline == null) this.deadline = now + LIGHTS_TIMEOUT_MS
    this.send(packet)
  }
}
