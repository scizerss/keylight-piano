// Pure rules for what the page lets cross to the Android host (and take back). No imports, so the tests load it
// as it is. Native hosts check the destinations again before opening them.
const DESTINATIONS = new Set([
  'https://keylightpiano.app/terms', 'https://keylightpiano.app/privacy',
  'https://github.com/scizerss/keylight-piano', 'https://github.com/scizerss/keylight-piano/issues',
  'https://github.com/scizerss/keylight-piano/releases', 'https://github.com/scizerss/keylight-piano/releases/latest',
  'https://github.com/demixme/GRAB',
  'https://www.partykeys.com/discount/MMDMAGDY?ref=m7md333magdy'
])
const DESKTOP_SUPPORT = new Set(['https://ko-fi.com/scizers', 'https://ko-fi.com/scizers/'])
const ISSUE_NEW = 'https://github.com/scizerss/keylight-piano/issues/new'
const SUPPORT_MAIL = 'mailto:support@keylightpiano.app'
const ENCODED = /^(?:[A-Za-z0-9\-._~!*'()]|%[0-9A-F]{2})+$/
// Percent-encoded bytes a mail header or body must not carry: a control byte in a header is header injection (a
// newline in a body is fine), and the Unicode line separators break lines in many mail apps.
const CONTROL = /%(?:0[0-9A-F]|1[0-9A-F]|7F)/i
const BODY_CONTROL = /%(?:0[0-9B-F]|1[0-9A-F]|7F)/i
const BREAK = /%C2%85|%E2%80%A8|%E2%80%A9/i
const decodes = (v) => { try { decodeURIComponent(v); return true } catch (_e) { return false } }

// The support email the iPhone/iPad wizard writes: the one address, then exactly the keys subject and body, each
// once and once-encoded. Both must percent-decode cleanly as UTF-8, and neither may carry an encoded control byte
// (the body keeps %0A) or a Unicode line separator: from a mailto those only ever mean header injection.
function isSupportMail(value) {
  if (value.length > 2000 || !value.startsWith(SUPPORT_MAIL + '?')) return false
  const pairs = value.slice(SUPPORT_MAIL.length + 1).split('&')
  if (pairs.length !== 2) return false
  const keys = []
  for (const pair of pairs) {
    const at = pair.indexOf('=')
    if (at < 1) return false
    const key = pair.slice(0, at), val = pair.slice(at + 1)
    if (!['subject', 'body'].includes(key) || !ENCODED.test(val) || /%25/.test(val)) return false
    if (!decodes(val) || (key === 'subject' ? CONTROL : BODY_CONTROL).test(val) || BREAK.test(val)) return false
    keys.push(key)
  }
  if (new Set(keys).size !== 2) return false
  try {
    const u = new URL(value)
    return u.protocol === 'mailto:' && u.pathname === 'support@keylightpiano.app' && !u.hash
  } catch (_e) { return false }
}

export function isAllowedLink(value, { native = true } = {}) {
  if (typeof value !== 'string') return false
  if (DESTINATIONS.has(value) || (!native && DESKTOP_SUPPORT.has(value)) || isSupportMail(value)) return true
  if (value.length > 2000 || !value.startsWith(ISSUE_NEW + '?')) return false
  const pairs = value.slice(ISSUE_NEW.length + 1).split('&')
  if (pairs.length !== 2) return false
  const keys = []
  for (const pair of pairs) {
    const at = pair.indexOf('=')
    if (at < 1) return false
    const key = pair.slice(0, at), val = pair.slice(at + 1)
    if (!['title', 'body'].includes(key) || !ENCODED.test(val) || /%25/.test(val)) return false
    keys.push(key)
  }
  if (new Set(keys).size !== 2) return false
  try { const u = new URL(value); return u.origin === 'https://github.com' && u.pathname === '/scizerss/keylight-piano/issues/new' && !u.username && !u.password && !u.port && !u.hash } catch (_e) { return false }
}

const text = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) : '')
const HEX4 = /^0x[0-9a-f]{4}$/
/**
 * The host's answer to the "Support my device" USB read, rebuilt field by field: only the named fields survive,
 * so a serial number or a device path the host should never send cannot reach the report. Anything malformed
 * reads as "not available" (null).
 */
export function cleanUsb(raw) {
  if (!raw || typeof raw !== 'object' || raw.ok !== true || !Array.isArray(raw.devices)) return null
  const devices = []
  for (const d of raw.devices.slice(0, 12)) {
    if (!d || !HEX4.test(d.vendorId) || !HEX4.test(d.productId)) continue
    devices.push({
      vendorId: d.vendorId, productId: d.productId, product: text(d.product), manufacturer: text(d.manufacturer),
      bcdDevice: /^\d{1,3}\.\d{1,3}$/.test(d.bcdDevice) ? d.bcdDevice : '', class: d.class === 'audio' ? 'audio' : '',
      subclass: Number.isInteger(d.subclass) && d.subclass >= 0 && d.subclass < 256 ? d.subclass : 0,
      protocol: Number.isInteger(d.protocol) && d.protocol >= 0 && d.protocol < 256 ? d.protocol : 0
    })
  }
  const os = raw.os && typeof raw.os === 'object' ? { platform: 'android', release: text(raw.os.release).slice(0, 40), arch: text(raw.os.arch).slice(0, 20) } : { platform: 'android', release: '', arch: '' }
  return { ok: true, devices, source: 'UsbManager', reason: '', os, redact: [] }
}
