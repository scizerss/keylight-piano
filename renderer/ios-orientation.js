// iPhone only: the player (and lesson) screen turns the phone to landscape while it is open, and lets it rotate freely again
// when it closes. The native side (ios/Keylight/WebViewController.swift, bridge op "orientation") ignores the request on an iPad.
// app.js calls enterPlayer() / leavePlayer() from showScreenNow; both are harmless no-ops on every other platform.
import { IS_IOS } from './platform.js'

let locked = false
function send(mode) {
  // loaded on demand: the bridge module installs the native receiver, which no other platform should have
  return import('./ios-midi.js').then((m) => m.nativeRequest('orientation', { mode })).catch(() => {})
}
export function enterPlayer() {
  if (!IS_IOS || locked) return
  locked = true
  send('landscape')
}
export function leavePlayer() {
  if (!IS_IOS || !locked) return
  locked = false
  send('free')
}
