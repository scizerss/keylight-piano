// The first-run setup and the Connect screen: the pure parts (which steps, going back, what a row or the banner says).
// No DOM and no app state here, so scripts/test-setup-flow.js loads it as it is. app.js draws the screens from these.
import { stepsFor, normalizeChoice } from './keyboard-profiles.js'

// Every step the setup can show, in order. "connect" also holds the sound check and the optional key range;
// "level" asks how much piano you have played (first run only).
export const SETUP_STEPS = Object.freeze(['welcome', 'pick', 'connect', 'level', 'ready'])

/**
 * The steps for this run. A first run starts on the welcome and asks your level before the end (before "ready",
 * or after the picker for the on-screen keys); a run from Settings starts on the picker and never asks it again,
 * so it can't overwrite settings. "Connect a Bluetooth keyboard" in Settings opens the connect step on its own.
 */
export function planFor(choice, { first = true, connectOnly = false } = {}) {
  if (connectOnly) return ['connect']
  const steps = stepsFor(choice)
  if (!first) return steps
  if (steps.at(-1) === 'ready') return ['welcome', ...steps.slice(0, -1), 'level', 'ready']
  if (normalizeChoice(choice) === 'screen') return ['welcome', ...steps, 'level']
  return ['welcome', ...steps]
}

// ---------- "How much piano have you played?" ----------

export const EXPERIENCES = Object.freeze([
  { id: 'new', name: 'Brand new', sub: 'Start from the very first key. Finger numbers and hand placement help.' },
  { id: 'some', name: 'Know a little', sub: 'You can find a few notes. Note names on the falling notes.' },
  { id: 'experienced', name: 'I already play', sub: 'Go straight to the songs. No extra hints.' }
])
export const GOAL_CHOICES = Object.freeze([5, 10, 15])
export const normalizeExperience = (v) => (EXPERIENCES.some((e) => e.id === v) ? v : '')

/**
 * The settings an answer sets. '' (skipped) changes nothing. Brand new: finger numbers on the notes, 0.75x, songs
 * start in Wait mode (app.js startSong reads experience), and hand placement on Auto. The others turn it off.
 */
export function experienceDefaults(experience) {
  const id = normalizeExperience(experience)
  if (id === 'new') return { experience: 'new', labels: 'fingers', rate: 0.75, handGuide: 'auto', handGuideRuns: 0 }
  if (id === 'some') return { experience: 'some', labels: 'names', rate: 1, handGuide: 'off', handGuideRuns: 0 }
  if (id === 'experienced') return { experience: 'experienced', labels: 'off', rate: 1, handGuide: 'off', handGuideRuns: 0 }
  return {}
}

/**
 * The last screen of the setup, by answer. go / altGo: where the buttons lead ('lesson' = Level 1 lesson 1,
 * 'level' = the placement test, 'songs' = the song library). skip always goes to Home.
 */
export function readyView(experience) {
  const id = normalizeExperience(experience)
  if (id === 'new') return { title: 'You’re set', copy: 'Lesson 1 starts by meeting your fingers, then you play your first tune.', next: 'Start your first lesson', go: 'lesson', alt: null, altGo: null, skip: 'Go to Home' }
  if (id === 'some') return { title: 'You’re set', copy: 'Start at the beginning, or take a short test to skip what you know.', next: 'Start lesson 1', go: 'lesson', alt: 'Find my level', altGo: 'level', skip: 'Go to Home' }
  if (id === 'experienced') return { title: 'You’re set', copy: 'Pick any song. The course and a level test are there when you want them.', next: 'Go to Songs', go: 'songs', alt: null, altGo: null, skip: 'Go to Home' }
  return { title: 'You’re set', copy: 'Watch the start of Ode to Joy, then play it one note at a time.', next: 'Start your first lesson', go: 'lesson', alt: null, altGo: null, skip: 'Go to Home' }
}

/** The step after `current` in this plan, or null when the setup is finished. */
export function nextStep(plan, current) {
  const at = plan.indexOf(current)
  if (at === -1) return plan[0] || null
  return plan[at + 1] || null
}

// Back goes to the step you came from (a history, not the plan: the plan changes when the choice does).
// Choices live in settings, so going back keeps them.
export const pushStep = (history, step) => (history.at(-1) === step ? history.slice() : [...history, step])
export const backStep = (history) => (history.length > 1 ? history.slice(0, -1) : history.slice())
export const canGoBack = (history) => history.length > 1

// ---------- what the keyboard is ----------

/** "24 keys", "48 keys, two joined", "48 keys, two keyboards", "49 keys"; '' when the count is not known. */
export function keysText(info) {
  if (!info || !Number.isFinite(info.keys) || info.keys <= 0) return ''
  if ((info.blocks || 0) >= 2) return info.keys + ' keys, ' + (info.joined ? 'two joined' : 'two keyboards')
  return info.keys + ' keys'
}

/** "Connected: LUMI Keys, 24 keys." from keyboardInfo() (app.js); falls back to the port name. */
export function connectedText(info, fallbackName = '') {
  const name = (info && info.name) || fallbackName || 'your keyboard'
  const keys = keysText(info)
  return 'Connected: ' + name + (keys ? ', ' + keys : '') + '.'
}

/** The title and line for the connect step, by choice. */
export function connectCopy(choice, { ios = false } = {}) {
  if (normalizeChoice(choice) === 'roli') return { title: 'Turn on your keyboard', copy: 'Press the power button. Using two? Snap them together first.' }
  if (normalizeChoice(choice) === 'partykeys') return { title: 'Turn on your keyboard', copy: ios ? 'Hold the power button for 3 seconds, until the keys light up in a moving pattern. A short press only shows the battery.' : 'Plug in a USB cable, or hold the power button for 3 seconds and connect by Bluetooth.' }
  return { title: 'Connect your keyboard', copy: ios ? 'Turn on Bluetooth on your keyboard, or plug it in with a USB adapter.' : 'Plug in a USB cable, or turn on Bluetooth on your keyboard.' }
}

// ---------- a row in the device list ----------

export const CONNECT_TIMEOUT_MS = 8000

/**
 * What a device row shows. device: { id, name, state, known } from ios-ble.js (or a MIDI port turned into one);
 * since: when Connect was tapped for it (0 if never, -1 when that attempt already failed); several: more than one keyboard is connected.
 * action: 'connect' (button), 'identify' (flash its lights) or null.
 */
export function rowView(device, { since = 0, now = 0, several = false } = {}) {
  const state = device && device.state
  if (state === 'connected') return { status: 'Connected', tone: 'ok', busy: false, action: several ? 'identify' : null, button: several ? 'Identify' : '' }
  if (state === 'reconnecting') return { status: 'Reconnecting…', tone: 'wait', busy: true, action: null, button: '' }
  // Connect was tapped (or the device says it is connecting): a spinner for up to 8 s, then a way to try again
  const waiting = state === 'connecting' || since > 0   // app.js clears `since` once the device reports connected or reconnecting
  if (since < 0 || (waiting && since > 0 && now - since >= CONNECT_TIMEOUT_MS)) return { status: 'Didn’t connect. Is it switched on and close by?', tone: 'warn', busy: false, action: 'connect', button: 'Try again' }
  if (waiting) return { status: 'Connecting…', tone: 'wait', busy: true, action: null, button: '' }
  if (state === 'lost') return { status: 'Turned off or out of range', tone: 'warn', busy: false, action: 'connect', button: 'Connect' }
  return { status: device && device.known ? 'Used before' : 'Ready to connect', tone: 'idle', busy: false, action: 'connect', button: 'Connect' }
}

/** Rows in a stable order: connected first, then the rest by name (ios-ble.js already numbers twins "LUMI Keys 1", "LUMI Keys 2"). */
export function sortDevices(devices) {
  const rank = { connected: 0, connecting: 1, reconnecting: 1, lost: 2, found: 3 }
  return (Array.isArray(devices) ? devices : []).filter((d) => d && d.id)
    .slice().sort((a, b) => (rank[a.state] ?? 4) - (rank[b.state] ?? 4) || String(a.name).localeCompare(String(b.name), undefined, { numeric: true }))
}

// ---------- "Keyboard not listed?" ----------

export const SUPPORT_EMAIL = 'support@keylightpiano.app'

/** Plain text for the support email: what Keylight saw, no personal data. */
export function supportDetails({ name = '', keys = 0, platform = '', version = '' } = {}) {
  return [
    'Keyboard: ' + (name || 'not detected'),
    'Keys: ' + (keys > 0 ? keys : 'unknown'),
    platform && 'Device: ' + platform,
    version && 'Keylight: ' + version
  ].filter(Boolean).join('\n')
}

/** mailto with a subject and body prefilled (needs a link rule that accepts it: see the iOS LinkPolicy). */
export function supportMailto(details = {}) {
  const subject = 'Keyboard not listed' + (details.name ? ': ' + details.name : '')
  const body = 'Hello, Keylight does not list my keyboard.\n\n' + supportDetails(details) + '\n\n'
  return 'mailto:' + SUPPORT_EMAIL + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body)
}

// ---------- the connection banner (whole app) ----------
// Fed with { connected, name, reconnecting } snapshots from the MIDI ports (all platforms) and Bluetooth (iOS).
// "Lost" shows only after a keyboard was connected and stays gone for LOST_GRACE_MS (a port reopening flickers),
// "Reconnected" shows for RECONNECTED_MS, and nothing stays on screen longer than SHOW_MAX_MS (player controls).

export const LOST_GRACE_MS = 1500
export const RECONNECTED_MS = 2000
export const SHOW_MAX_MS = 6000

export const bannerStart = () => ({ seen: false, connected: false, name: '', lostAt: 0, reconnecting: false, notified: false, show: null, shownAt: 0, until: 0 })

export function bannerEvent(state, ev, now) {
  const s = { ...state }
  if (!ev) return s
  if (ev.connected) {
    const wasDown = s.seen && !s.connected
    s.connected = true; s.seen = true; s.lostAt = 0; s.reconnecting = false
    if (ev.name) s.name = ev.name
    // "Reconnected" only when the user was told it was gone (a quick port reopen stays silent)
    if (wasDown && s.notified) { s.show = 'reconnected'; s.shownAt = now; s.until = now + RECONNECTED_MS }
    else if (s.show !== 'reconnected') s.show = null
    s.notified = false
    return s
  }
  if (!s.seen) return s                      // a keyboard that was never connected was not lost
  if (s.connected) { s.connected = false; s.lostAt = now; s.notified = false; if (s.show === 'reconnected') s.show = null }
  if (ev.reconnecting && !s.reconnecting) {
    s.reconnecting = true
    // told it was gone (the notice may have timed out since): say it is coming back
    if (s.notified) { s.show = 'reconnecting'; s.shownAt = now; s.until = now + SHOW_MAX_MS }
  } else if (ev.reconnecting === false) { s.reconnecting = false; if (s.show === 'reconnecting') s.show = null }
  return s
}

export function bannerTick(state, now) {
  const s = { ...state }
  if (!s.connected && s.lostAt && !s.show && !s.notified && now - s.lostAt >= LOST_GRACE_MS) {
    s.show = s.reconnecting ? 'reconnecting' : 'lost'; s.shownAt = now; s.until = now + SHOW_MAX_MS; s.notified = true
  }
  if (s.show && now >= s.until) s.show = null   // one notice per loss; the keyboard chip keeps the state
  return s
}

export function bannerText(state) {
  const name = state.name || 'Your keyboard'
  if (state.show === 'lost') return { tone: 'warn', spin: false, text: name + ' disconnected. Turn it back on and Keylight reconnects.' }
  if (state.show === 'reconnecting') return { tone: 'wait', spin: true, text: 'Reconnecting to ' + name + '…' }
  if (state.show === 'reconnected') return { tone: 'ok', spin: false, text: 'Reconnected' }
  return null
}
