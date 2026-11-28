// Bluetooth keyboards on iOS. The host (ios/Keylight/BleMidiCentral.swift) scans for Bluetooth MIDI keyboards, connects them,
// hands them to CoreMIDI and reconnects known ones by itself (launch, foreground, keyboard switched off and on). A connected
// keyboard reaches the page as an ordinary MIDI port (hot-plug event), so nothing here touches MIDI data.
// Apple's own pairing sheet (CABTMIDICentralViewController) stays as a fallback: requestPairing().
//
// API (see .omc/redesign/CONTRACT.md):
//   bleAvailable() -> boolean                 the iOS host with this bridge
//   bleScan(on)                               start/stop scanning (the Bluetooth permission prompt may appear on the first scan)
//   onBle(cb) -> unsubscribe                  cb({ type: 'devices', devices: [{ id, name, rssi, state, known }] })
//                                             cb({ type: 'state', bluetooth: 'on' | 'off' | 'unauthorized' | 'unsupported' })
//                                             state: 'found' | 'connecting' | 'connected' | 'lost' | 'reconnecting'; rssi may be null
//   bleConnect(id) -> Promise<boolean>        true once the keyboard is a MIDI device; false if it did not connect
//   bleForget(id) -> Promise<void>            disconnect and stop reconnecting it
//   bleList() -> Promise<{ bluetooth, devices }>
//   requestPairing() -> Promise<boolean>      Apple's sheet
//
// "Connect a Bluetooth keyboard" in Settings dispatches the cancelable window event 'keylight:open-connect'. A connect screen
// that takes over calls event.preventDefault() (or event.detail.ack()) within 300 ms; otherwise Apple's sheet opens.
// The renderer ships inside the app, so page and host always come from the same build (no version checks needed).
import { nativeRequest, onNativeEvent } from './ios-midi.js'

const DEVICE_ID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/
const STATES = new Set(['found', 'connecting', 'connected', 'lost', 'reconnecting'])
const BLUETOOTH = new Set(['on', 'off', 'unauthorized', 'unsupported'])
const el = (doc, tag, attrs = {}, ...kids) => {
  const node = doc.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) { if (k === 'class') node.className = v; else if (k.startsWith('on')) node[k] = v; else node.setAttribute(k, v) }
  node.append(...kids)
  return node
}

/** The iPhone/iPad host (Android also has KeylightNative, but not webkit message handlers). */
export function bleAvailable() {
  return !!(globalThis.KeylightNative && globalThis.webkit?.messageHandlers?.keylight)
}

// Host events, checked before they reach listeners: a page-side bug must not see half-formed devices.
function cleanDevice(d) {
  if (!d || typeof d.id !== 'string' || !DEVICE_ID.test(d.id) || !STATES.has(d.state)) return null
  return { id: d.id, name: typeof d.name === 'string' && d.name ? d.name : 'Bluetooth keyboard',
    rssi: Number.isFinite(d.rssi) ? d.rssi : null, state: d.state, known: d.known === true }
}
const cleanDevices = (list) => (Array.isArray(list) ? list.map(cleanDevice).filter(Boolean) : [])

const listeners = new Set()
let last = { devices: null, bluetooth: null }
let hooked = false
function hook() {
  if (hooked) return
  hooked = true
  onNativeEvent((event) => {
    let ev = null
    if (event?.kind === 'bleDevices') { last.devices = cleanDevices(event.devices); ev = { type: 'devices', devices: last.devices } }
    else if (event?.kind === 'bleState' && BLUETOOTH.has(event.bluetooth)) { last.bluetooth = event.bluetooth; ev = { type: 'state', bluetooth: event.bluetooth } }
    if (!ev) return
    for (const cb of [...listeners]) { try { cb(ev) } catch (error) { console.error('Bluetooth listener:', error) } }
  })
}

/** Subscribes to device and Bluetooth state events; the latest known ones are replayed at once. Returns the unsubscribe. */
// Listen from the start: the host sends the Bluetooth state and keyboards when the page loads, before any screen asks.
hook()

export function onBle(cb) {
  if (typeof cb !== 'function') return () => {}
  hook()
  listeners.add(cb)
  queueMicrotask(() => {
    const replay = (ev) => { if (!listeners.has(cb)) return; try { cb(ev) } catch (error) { console.error('Bluetooth listener:', error) } }
    if (last.bluetooth) replay({ type: 'state', bluetooth: last.bluetooth })
    if (last.devices) replay({ type: 'devices', devices: last.devices })
  })
  return () => { listeners.delete(cb) }
}

export function bleScan(on) {
  if (!bleAvailable()) return
  hook()
  nativeRequest('bleScan', { on: !!on }).catch((error) => console.error('Bluetooth scan:', error))
}

/** Resolves true when the keyboard became a MIDI device (up to ~25 s for a first connect with a pairing prompt). */
export async function bleConnect(id) {
  if (!bleAvailable() || typeof id !== 'string' || !DEVICE_ID.test(id)) return false
  hook()
  try { return (await nativeRequest('bleConnect', { device: id }, 40000)) === true } catch { return false }
}

export async function bleForget(id) {
  if (!bleAvailable() || typeof id !== 'string' || !DEVICE_ID.test(id)) return
  await nativeRequest('bleForget', { device: id }).catch((error) => console.error('Bluetooth forget:', error))
}

export async function bleList() {
  if (!bleAvailable()) return { bluetooth: 'unsupported', devices: [] }
  hook()
  const result = await nativeRequest('bleList').catch(() => null)
  if (!result || typeof result !== 'object') return { bluetooth: last.bluetooth || 'off', devices: last.devices || [] }   // keep what we knew
  const devices = cleanDevices(result?.devices)
  const bluetooth = BLUETOOTH.has(result?.bluetooth) ? result.bluetooth : 'off'
  last = { devices, bluetooth }
  return { bluetooth, devices }
}

/** Asks the host to show Apple's pairing sheet. Resolves true when it is on screen. `host` and `notify` are optional
 * (app.js passes its own request function and status line). */
export function requestPairing(host, notify = () => {}) {
  const request = host && typeof host.request === 'function' ? host.request : nativeRequest
  return Promise.resolve().then(() => request('blePair')).then((shown) => {
    if (shown === false) notify('Close the other sheet first, then try again')
    return shown !== false
  }).catch((error) => { notify('Could not open Bluetooth pairing: ' + (error && error.message ? error.message : 'unavailable')); return false })
}

/** Offers the connect screen ('keylight:open-connect'); Apple's sheet opens if nothing takes it within 300 ms. */
export function openConnect(host, notify = () => {}, win = globalThis.window) {
  if (!win || typeof win.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return requestPairing(host, notify)
  let handled = false
  const event = new CustomEvent('keylight:open-connect', { cancelable: true, detail: { ack: () => { handled = true } } })
  if (!win.dispatchEvent(event)) handled = true
  if (handled) return Promise.resolve(true)
  return new Promise((resolve) => setTimeout(resolve, 300)).then(() => (handled ? true : requestPairing(host, notify)))
}

/** host: { request(op, args) -> Promise }. Adds a row to Settings and one to the "no keyboard found" hint. */
export function mountPairing({ host, notify = () => {}, doc = document } = {}) {
  const anchor = doc.getElementById('kbHelp')
  if (!anchor || doc.getElementById('blePairRow')) return null
  const pair = () => openConnect(host, notify, doc.defaultView)
  const button = (id) => el(doc, 'button', { type: 'button', class: 'mini-btn', id, onclick: pair }, 'Connect a Bluetooth keyboard')
  const row = el(doc, 'div', { class: 'setting-row', id: 'blePairRow' }, el(doc, 'span', {}, 'Bluetooth keyboard'), button('blePairOpen'))
  const hint = el(doc, 'div', { class: 'setting-row hidden', id: 'blePairHint' }, el(doc, 'span', {}, 'Using a Bluetooth keyboard?'), button('blePairHintOpen'))
  anchor.insertAdjacentElement('beforebegin', row)
  anchor.insertAdjacentElement('afterend', hint)
  const sync = () => hint.classList.toggle('hidden', anchor.classList.contains('hidden'))
  new MutationObserver(sync).observe(anchor, { attributes: true, attributeFilter: ['class'] })
  sync()
  return { row, hint, pair }
}
