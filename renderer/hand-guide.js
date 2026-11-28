// Turns the opening phrase of a piece into "put this finger on this key"
// targets, and walks the player through them. Pure ES module: no DOM, no imports.

function inWindow(pitch, windowStart, windowKeys) {
  if (typeof windowStart !== 'number' || typeof windowKeys !== 'number') return true
  return pitch >= windowStart && pitch < windowStart + windowKeys
}

// notes: [{ pitch, time, hand: 'left'|'right', finger }] from fingering.js.
// Right hand comes first, fingers 1->5; then left hand, fingers 5->1. One target
// per finger within a hand (the first pitch seen for that finger).
export function guideTargets(notes = [], { hand = 'both', windowStart, windowKeys, phraseSeconds = 4 } = {}) {
  const timed = notes.filter((note) => typeof note.time === 'number')
  if (!timed.length) return []
  const first = Math.min(...timed.map((note) => note.time))
  const end = first + phraseSeconds
  const picked = { right: new Map(), left: new Map() }

  for (const note of timed) {
    if (note.time >= end) continue
    if (note.finger == null || note.finger === 0) continue
    if (note.hand !== 'left' && note.hand !== 'right') continue
    if (hand !== 'both' && note.hand !== hand) continue
    if (!inWindow(note.pitch, windowStart, windowKeys)) continue
    const fingers = picked[note.hand]
    if (fingers.has(note.finger)) continue
    fingers.set(note.finger, { pitch: note.pitch, finger: note.finger, hand: note.hand })
  }

  const right = [...picked.right.values()].sort((a, b) => a.finger - b.finger)
  const left = [...picked.left.values()].sort((a, b) => b.finger - a.finger)
  return [...right, ...left]
}

// Stable key of a hand position, e.g. "R:1@60,2@62|L:5@48". Same targets in any
// order give the same key, so "position changed" is a plain string compare.
export function startPositionKey(targets = []) {
  const line = (hand, direction) => targets
    .filter((target) => target.hand === hand)
    .sort((a, b) => (a.finger - b.finger) * direction)
    .map((target) => `${target.finger}@${target.pitch}`)
    .join(',')
  return [['R', line('right', 1)], ['L', line('left', -1)]]
    .filter(([, entries]) => entries)
    .map(([letter, entries]) => `${letter}:${entries}`)
    .join('|')
}

// Every C in the keyboard window, low to high.
export function cTargets(windowStart, windowKeys) {
  const out = []
  for (let pitch = windowStart; pitch < windowStart + windowKeys; pitch++) {
    if (pitch % 12 === 0) out.push(pitch)
  }
  return out
}

// Press-by-press state machine. anyOf: the find-C step, where any one target
// completes the whole guide (targets built by the caller with finger 0).
export class HandGuide {
  constructor(targets = [], { anyOf = false } = {}) {
    this.targets = targets.slice()
    this.anyOf = anyOf
    this.index = 0
    this.confirmed = []
  }

  get done() {
    return this.index >= this.targets.length
  }

  get placed() {
    return this.confirmed.slice()
  }

  current() {
    return this.targets[this.index] || null
  }

  // 'ok' advanced | 'wrong' not the current pitch | 'done' finished here | 'ignored' already done
  press(pitch) {
    if (this.done) return 'ignored'
    if (this.anyOf) {
      const match = this.targets.find((target) => target.pitch === pitch)
      if (!match) return 'wrong'
      this.confirmed.push(match)
      this.index = this.targets.length
      return 'done'
    }
    const target = this.current()
    if (pitch !== target.pitch) return 'wrong'
    this.confirmed.push(target)
    this.index += 1
    return this.done ? 'done' : 'ok'
  }

  skip() {
    if (this.done) return 'ignored'
    this.index = this.anyOf ? this.targets.length : this.index + 1
    return this.done ? 'done' : 'ok'
  }

  // Map pitch -> { kind: 'pulse'|'placed', on, hand, finger } for the key lights.
  // The next target pulses (1 Hz by default); placed keys stay steadily lit.
  overlay(nowMs = 0, { pulseHz = 1, reduceMotion = false } = {}) {
    const map = new Map()
    const half = 500 / pulseHz
    const on = reduceMotion ? true : Math.floor(nowMs / half) % 2 === 0
    for (const target of this.confirmed) {
      map.set(target.pitch, { kind: 'placed', on: true, hand: target.hand, finger: target.finger })
    }
    if (this.done) return map
    const pulsing = this.anyOf ? this.targets : [this.current()]
    for (const target of pulsing) {
      if (map.has(target.pitch)) continue
      map.set(target.pitch, { kind: 'pulse', on, hand: target.hand, finger: target.finger })
    }
    return map
  }
}

// Bookkeeping for handGuide 'auto': five good runs in a row (>= 85% accuracy)
// switch it back off. Runs in WATCH or a filtered hand do not count.
export function autoOffUpdate(runs = 0, { accuracy = 0, counted = true } = {}) {
  if (!counted) return { runs, turnOff: false }
  const next = accuracy >= 0.85 ? runs + 1 : 0
  return { runs: next, turnOff: next >= 5 }
}

// Settings > Practice answer. 'auto' is on: setup already stores 'off' for the
// experiences that should not see the guide.
export function handGuideOn(setting, { experience = '' } = {}) {
  if (setting === 'always' || setting === 'auto') return true
  return false
}
