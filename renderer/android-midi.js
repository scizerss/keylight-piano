// Native Android USB MIDI byte-stream adapter. No WebView Web MIDI dependency.
class MidiStreamParser {
  constructor(emit) { this.emit = emit; this.reset() }
  reset() { this.running = 0; this.message = []; this.needed = 0; this.sysex = false }
  push(bytes) {
    for (const byte of bytes) {
      if (byte >= 0xf8) { this.emit(Uint8Array.of(byte)); continue }
      if (this.sysex) {
        if (byte === 0xf7) { this.message.push(byte); this.emit(Uint8Array.from(this.message)); this.reset(); continue }
        if (byte < 0x80) {
          if (this.message.length >= 65536) { this.reset(); continue }
          this.message.push(byte); continue
        }
        this.reset()
      }
      if (byte >= 0x80) {
        this.message = []; this.needed = 0
        this.running = byte < 0xf0 ? byte : 0
        if (byte === 0xf0) { this.sysex = true; this.message = [byte]; continue }
        const length = byte < 0xf0 ? ((byte & 0xe0) === 0xc0 ? 2 : 3)
          : ({ 241: 2, 242: 3, 243: 2, 246: 1 }[byte] || 0)
        if (!length) continue
        this.message = [byte]; this.needed = length
      } else {
        if (!this.message.length && this.running) {
          this.message = [this.running]
          this.needed = (this.running & 0xe0) === 0xc0 ? 2 : 3
        }
        if (!this.message.length) continue
        this.message.push(byte)
      }
      if (this.message.length === this.needed) {
        this.emit(Uint8Array.from(this.message)); this.message = []; this.needed = 0
      }
    }
  }
}

// One RPC channel shared by MIDI and export. Native checks origin and main frame.
let sequence = 0
const pending = new Map()
const listeners = new Set()
export function nativeRequest(op, args = {}, timeoutMs = 30000) {
  if (!globalThis.KeylightNative) return Promise.reject(new DOMException('Native host unavailable', 'NotSupportedError'))
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timer = timeoutMs === 0 ? null : setTimeout(() => {
      pending.delete(id)
      reject(new DOMException('Native operation timed out', 'TimeoutError'))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    try { globalThis.KeylightNative.postMessage(JSON.stringify({ id, op, ...args })) }
    catch (error) { pending.delete(id); clearTimeout(timer); throw error }
  })
}
// Other bridge consumers (Bluetooth) hear the native events that carry no request id.
export function onNativeEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) }
globalThis.__keylightNativeReceive = (message) => {
  if (message.id) {
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id); clearTimeout(request.timer)
    if (message.error) request.reject(new DOMException(message.error, 'OperationError'))
    else request.resolve(message.result)
  } else for (const listener of listeners) listener(message)
}

class MidiPort extends EventTarget {
  constructor(access, info) {
    super(); Object.assign(this, info)
    this.access = access; this.state = 'connected'; this.connection = 'closed'
    this.onstatechange = null; this.handler = null; this.opening = null
    this.parser = new MidiStreamParser((data) => {
      if (this.connection !== 'open') return
      const event = new Event('midimessage')
      Object.assign(event, { data, receivedTime: performance.now() })
      this.dispatchEvent(event); this.handler?.(event)
    })
  }
  get onmidimessage() { return this.handler }
  set onmidimessage(fn) { this.handler = fn; if (fn) this.open().catch((error) => this.access.fail(error)) }
  async open() {
    if (this.state !== 'connected') throw new DOMException('Port disconnected', 'InvalidStateError')
    if (this.connection === 'open') return this
    if (!this.opening) {
      this.opening = nativeRequest('open', { port: this.id }).then(() => {
        if (this.state !== 'connected') throw new DOMException('Port disconnected', 'InvalidStateError')
        this.connection = 'open'; this.access.changed(this); return this
      }).finally(() => { this.opening = null })
    }
    return this.opening
  }
  async close() {
    await nativeRequest('close', { port: this.id })
    this.connection = 'closed'; this.parser.reset(); this.access.changed(this); return this
  }
  // onFail: the caller's own handler for a failed send (the native queue answers after the fact). Without one it is the access's error.
  send(data, timestamp = 0, onFail) {
    if (this.type !== 'output' || this.state !== 'connected') throw new DOMException('Output unavailable', 'InvalidStateError')
    const bytes = Array.from(data)
    if (!bytes.length || bytes.length > 65536 || bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) throw new TypeError('Expected 1..65536 MIDI bytes')
    if (!Number.isFinite(timestamp)) throw new TypeError('Invalid timestamp')
    // The native serial queue opens implicitly and schedules against its monotonic clock.
    nativeRequest('send', { port: this.id, bytes, delay: Math.max(0, timestamp - performance.now()) })
      .then(() => { if (this.connection !== 'open') { this.connection = 'open'; this.access.changed(this) } })
      .catch((error) => (typeof onFail === 'function' ? onFail(error) : this.access.fail(error, { port: this.id, op: 'send' })))
  }
  clear() {
    if (this.type !== 'output' || this.state !== 'connected') throw new DOMException('Output unavailable', 'InvalidStateError')
    nativeRequest('clear', { port: this.id }).catch((error) => this.access.fail(error, { port: this.id, op: 'clear' }))
  }
}

class AndroidMidiAccess extends EventTarget {
  constructor() {
    super(); this.inputs = new Map(); this.outputs = new Map(); this.sysexEnabled = true
    this.onstatechange = null; this.onerror = null
    this.receive = (event) => {
      switch (event.kind) {
        case 'ports': this.sync(event.ports); break
        case 'data': this.inputs.get(event.port)?.parser.push(event.bytes); break
        case 'error': this.fail(new DOMException(event.error, 'OperationError')); break
        default: break // Non-MIDI events belong to other bridge consumers.
      }
    }
    listeners.add(this.receive)
  }
  // source: which port and operation failed, when known (a send or a clear), so a listener can ignore errors that are not its own
  fail(error, source = null) {
    this.onerror?.(error, source)
    const event = new Event('error'); Object.assign(event, { error, source })
    this.dispatchEvent(event)
    console.error('Android MIDI:', error)
  }
  changed(port) {
    const event = new Event('statechange'); Object.assign(event, { port })
    const portEvent = new Event('statechange'); Object.assign(portEvent, { port })
    port.dispatchEvent(portEvent); port.onstatechange?.(portEvent)
    this.dispatchEvent(event); this.onstatechange?.(event)
  }
  sync(ports) {
    const changed = []
    for (const map of [this.inputs, this.outputs]) {
      for (const [id, port] of map) if (!ports.some((info) => info.id === id)) {
        map.delete(id); port.state = 'disconnected'; port.connection = 'closed'; port.parser.reset(); changed.push(port)
      }
    }
    // A USB device with several ports gives every port the device's name: the port's own label tells them apart. Only then is a name suffixed
    // (two identical keyboards each have the same one label; iOS puts the label in the name already), and all of the device's ports are, so its
    // input and output still pair by name. The device is its Android id prefix, or the name where ids have no such shape (iOS).
    const device = (info) => (/^[^:]+:(?:input|output):\d+$/.test(String(info.id)) ? String(info.id).split(':')[0] : 'name:' + info.name)
    const label = (info) => String(info.portName ?? '').trim()
    const inName = (info) => { const l = label(info).toLowerCase(); return !!l && new RegExp('(^|[^a-z0-9])' + l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)').test(info.name.toLowerCase()) }
    const nameFor = (info) => {
      const l = label(info)
      if (!l || inName(info)) return info.name
      const mine = ports.filter((o) => device(o) === device(info))
      const several = ['input', 'output'].some((t) => new Set(mine.filter((o) => o.type === t).map(label)).size > 1)
      return several ? info.name + ' ' + l : info.name
    }
    for (const info of ports) {
      const map = info.type === 'input' ? this.inputs : this.outputs
      const name = nameFor(info)
      const existing = map.get(info.id)
      if (!existing) { const port = new MidiPort(this, { ...info, name }); map.set(info.id, port); changed.push(port) }
      else if (existing.name !== name) { existing.name = name; changed.push(existing) }   // a sibling port arrived later: the names stay a matching set
    }
    for (const port of changed) this.changed(port)
  }
}
let accessPromise
export function requestMIDIAccess() {
  if (!accessPromise) {
    const access = new AndroidMidiAccess()
    accessPromise = nativeRequest('list').then((ports) => { access.sync(ports); return access })
      .catch((error) => { listeners.delete(access.receive); accessPromise = undefined; throw error })
  }
  return accessPromise
}
