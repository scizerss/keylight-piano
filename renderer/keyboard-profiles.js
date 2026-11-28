// The ways to play Keylight, for the first-run picker and Settings > Your keyboard.
// A PartyKeys card lights its keys through SysEx (party-lights.js); Keylight also finds the keyboard by its port name, so the
// lights follow whichever card was chosen. One card covers every ROLI and LUMI keyboard: Keylight works out the model (24, 48 or 49 keys) from the keyboard itself
// (app.js keyboardInfo, blocks.js) and follows a second block snapped on or off, so the user never picks a size.
// `keys` is the value the "Number of keys" setting takes (0 = Automatic, null = leave it as it is); `lights` says whether
// Keylight lights the keys on this setup. Keyboard names are allowed in the iOS page (AGENTS.md); nothing else names a product.
// Where a key count is stored and applied is app.js (chooseKeyboard): the same path as the Number of keys control.
export const KB_CHOICES = Object.freeze([
  { id: 'roli', name: 'ROLI or LUMI', keys: 0, lights: true, glyph: 'roli',
    sub: 'Piano M, LUMI Keys or ROLI Piano. Snap two together and Keylight sees both.', detail: 'Lights show where to play' },
  { id: 'partykeys', name: 'PartyKeys', keys: 0, lights: true, glyph: 'partykeys',
    sub: 'A keyboard with lights in every key. Connect by USB or Bluetooth.', detail: 'Lights: beta' },
  { id: 'midi', name: 'Another MIDI keyboard', keys: 0, lights: false, glyph: 'midi',
    sub: 'Connect by Bluetooth or a USB cable.', detail: 'Any size' },
  { id: 'screen', name: 'On-screen keys', keys: null, lights: false, glyph: 'screen',
    sub: 'Play right on the screen. Connect a keyboard any time.', touchSub: 'Play right on your iPhone or iPad.', detail: 'No keyboard needed' }
])

// Ids saved by earlier versions: the three ROLI/LUMI sizes are one choice now, "other" is "midi".
const OLD_IDS = Object.freeze({ lumi24: 'roli', piano49: 'roli', two24: 'roli', other: 'midi' })
/** The current id for a saved one ('' when there is none or it is unknown). */
export function normalizeChoice(id) {
  if (typeof id !== 'string' || !id) return ''
  const now = OLD_IDS[id] || id
  return KB_CHOICES.some((c) => c.id === now) ? now : ''
}

/** The picker's rows, in order. A copy, so callers cannot change the list. `touch` picks the phone/tablet wording. */
export function listProfiles(screenFirst = false, { touch = false } = {}) {
  const choices = screenFirst ? [KB_CHOICES.at(-1), ...KB_CHOICES.slice(0, -1)] : KB_CHOICES
  return choices.map((choice) => ({ ...choice, sub: touch && choice.touchSub ? choice.touchSub : choice.sub }))
}
export const profileById = (id) => KB_CHOICES.find((c) => c.id === normalizeChoice(id)) || null
/** The setup steps after the welcome: a keyboard is connected and checked, the screen finishes at once. */
export function stepsFor(id) {
  const choice = normalizeChoice(id)
  return choice === 'roli' || choice === 'partykeys' || choice === 'midi' ? ['pick', 'connect', 'ready'] : ['pick']
}

// A generic keyboard can start on any MIDI note (the optional "Set key range" check).
export function readGenericEndKeys(low, pitch) {
  if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127) return { low: null, wrong: pitch }
  if (low == null) return { low: pitch }
  const keys = pitch - low + 1
  if (keys >= 24 && keys <= 88) return { done: true, keys }
  return { low: null, wrong: pitch }
}

// A small drawing for each row: two key blocks snapped together, a MIDI plug, or a phone with keys.
// 'one', 'long' and 'two' are kept for anything that still draws the old sizes.
export function glyphSVG(kind) {
  const keys = (x, y, n, w, h, gap) => Array.from({ length: n }, (_, i) => `<rect x="${x + i * (w + gap)}" y="${y}" width="${w}" height="${h}" rx="1.6"/>`).join('')
  const body = kind === 'roli' ? keys(3.5, 11, 4, 3.4, 18, 0.9) + keys(21.4, 11, 4, 3.4, 18, 0.9) + '<rect class="seam" x="19.3" y="8" width="1.2" height="24" rx=".6"/>' +
      '<rect class="lit" x="7.8" y="11" width="3.4" height="18" rx="1.2"/><rect class="lit" x="30" y="11" width="3.4" height="18" rx="1.2"/>'
    : kind === 'one' || kind === 'partykeys' ? keys(5, 11, 6, 4.4, 18, 1.6) + '<rect class="lit" x="19.4" y="11" width="4.4" height="18" rx="1.6"/>'
    : kind === 'long' ? keys(3, 12, 11, 2.7, 16, 0.9) + '<rect class="lit" x="19.2" y="12" width="2.7" height="16" rx="1"/>'
    : kind === 'two' ? keys(3, 7, 5, 3.4, 11, 1) + keys(3, 22, 5, 3.4, 11, 1) + '<rect class="lit" x="10.8" y="7" width="3.4" height="11" rx="1.2"/>' + '<rect class="lit" x="24.6" y="22" width="3.4" height="11" rx="1.2"/>'
    : kind === 'midi' ? '<circle cx="20" cy="20" r="11" fill="none" stroke-width="1.8"/><circle cx="20" cy="12.6" r="1.4"/><circle cx="13.8" cy="16.2" r="1.4"/><circle cx="26.2" cy="16.2" r="1.4"/><circle cx="15.4" cy="24" r="1.4"/><circle cx="24.6" cy="24" r="1.4"/>'
    : '<rect x="11" y="5" width="18" height="30" rx="4" fill="none" stroke-width="1.8"/>' + keys(13.5, 24, 4, 2.6, 8, 0.8) + '<rect class="lit" x="19.3" y="24" width="2.6" height="8" rx="1"/>'
  return `<svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">${body}</svg>`
}
