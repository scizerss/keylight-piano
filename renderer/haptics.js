// Haptic feedback on iPhone/iPad (docs/DESIGN-DIRECTION.md 5.2). One call, haptic(kind); a no-op everywhere else, when the
// "Vibration feedback" setting is off, and for calls that come within 40 ms of the last one (a burst is one tap).
// kinds: select, light, soft, rigid, heavy, success, warning, error. The native side ignores any other word.
// Never call this for falling notes or for MIDI keys; the player taps only for what the table in the doc lists.
import { IS_IOS } from './platform.js'

export const HAPTIC_KINDS = ['select', 'light', 'soft', 'rigid', 'heavy', 'success', 'warning', 'error']
const COALESCE_MS = 40
let enabled = true
let last = 0

export const setHapticsEnabled = (on) => { enabled = on !== false }
export const hapticsEnabled = () => enabled

/** @param {string} kind one of HAPTIC_KINDS @param {number} [intervalMs] extra throttle for this call (the on-screen piano keys) */
export function haptic(kind, intervalMs = 0) {
  if (!IS_IOS || !enabled || !HAPTIC_KINDS.includes(kind)) return
  const now = performance.now()
  if (now - last < Math.max(COALESCE_MS, intervalMs)) return
  last = now
  // loaded on demand: the bridge module installs the native receiver, which no other platform should have
  import('./ios-midi.js').then((m) => m.nativeRequest('haptic', { kind })).catch(() => {})
}

// a short run of kinds (three stars: success, then two light taps)
export function hapticSequence(steps) {
  if (!IS_IOS || !enabled) return
  let at = 0
  for (const [kind, gap] of steps) {
    at += gap
    setTimeout(() => { last = 0; haptic(kind) }, at)
  }
}
