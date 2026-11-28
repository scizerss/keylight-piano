// Which keys a piano cover is arranged for, and where the player's window starts on them.

// The notes the keyboard can play: all 88 from A0 for a full piano, else `keys` from the anchor (clamped into MIDI range).
export function coverKeyRange(keys, anchor) {
  if (keys >= 88) return { lo: 21, hi: 108 }
  const lo = Math.max(0, Math.min(128 - keys, anchor))
  return { lo, hi: lo + keys - 1 }
}

// Where the player's window starts. A wide on-screen window starts where the song wants it. Otherwise the keyboard's own base,
// except a full 88-key piano that was never calibrated: its base is snapped to a C (24), which would leave A0 to B0 out of reach,
// so it starts at A0.
export function playerWindowStart({ keys, calibrated, wide, start, base }) {
  if (wide) return start
  if (keys >= 88 && !calibrated) return 21
  return base
}
