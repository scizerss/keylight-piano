// Small hand-written browser fakes so the site's ES modules (site-next/*.js) run under plain Node, with no jsdom.
// Only what those modules touch exists here. Time and observers are driven by the test:
//   frame(ms)            runs the queued requestAnimationFrame callbacks once, at a fake timestamp
//   intersect(el, rect)  fires the shared IntersectionObserver for el
//   setReduced(bool)     flips prefers-reduced-motion and fires its 'change' listeners
// Every element made by querySelector/createElement is a FakeElement that bubbles events (capture first) to the document.
class FakeElement {
  constructor(env, tag = 'div', parent = null) {
    Object.assign(this, {
      env, tag, parent, children: [], listeners: [], dataset: {}, attrs: new Map(), animateCalls: 0,
      textContent: '', value: '', hidden: false, inert: false, clientWidth: 800, clientHeight: 220, width: 800, height: 220,
      tabIndex: 0, className: ''
    })
    const classes = new Set()
    this.classList = {
      add: (...n) => n.forEach((x) => classes.add(x)), remove: (...n) => n.forEach((x) => classes.delete(x)),
      toggle: (n, on) => { if (on ?? !classes.has(n)) classes.add(n); else classes.delete(n) }, contains: (n) => classes.has(n)
    }
    const props = new Map()
    this.style = new Proxy({ setProperty: (k, v) => props.set(k, v), getPropertyValue: (k) => props.get(k), removeProperty: (k) => props.delete(k) }, {})
    this.scoped = new Map()
  }
  addEventListener(type, fn, options) { this.listeners.push({ type, fn, capture: options === true || options?.capture === true }) }
  removeEventListener(type, fn) { this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn)) }
  dispatchEvent(event) {
    event.target ||= this
    event.preventDefault ||= () => { event.defaultPrevented = true }
    const path = []
    for (let n = this; n; n = n.parent) path.push(n)
    const run = (node, capture) => {
      for (const l of [...node.listeners]) if (l.type === event.type && l.capture === capture) l.fn.call(node, event)
    }
    for (const node of [...path].reverse()) run(node, true)
    for (const node of path) run(node, false)
    return !event.defaultPrevented
  }
  contains(node) { for (let n = node; n; n = n.parent) if (n === this) return true; return false }
  closest() { return null }
  querySelector(selector) {
    if (!this.scoped.has(selector)) this.scoped.set(selector, new FakeElement(this.env, 'div', this))
    return this.scoped.get(selector)
  }
  querySelectorAll() { return [] }
  append(...nodes) { for (const n of nodes) { if (n?.parent !== undefined) n.parent = this; this.children.push(n) } }
  appendChild(node) { this.append(node); return node }
  setAttribute(k, v) { this.attrs.set(k, String(v)) }
  getAttribute(k) { return this.attrs.get(k) ?? null }
  removeAttribute(k) {
    this.attrs.delete(k)
    if (k.startsWith('data-')) delete this.dataset[k.slice(5).replace(/-./g, (m) => m[1].toUpperCase())]
  }
  toggleAttribute(k, on) { if (on ?? !this.attrs.has(k)) this.attrs.set(k, ''); else this.attrs.delete(k); return this.attrs.has(k) }
  hasAttribute(k) { return this.attrs.has(k) }
  focus() { this.env.document.activeElement = this; this.dispatchEvent({ type: 'focusin', target: this }) }
  blur() { if (this.env.document.activeElement === this) this.env.document.activeElement = this.env.document.body }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight } }
  animate() {
    this.animateCalls++
    this.env.animateCalls++
    return { cancel() {}, finished: Promise.resolve() }
  }
  getAnimations() { return [] }
  getContext() { return this.env.context }
}

function installBrowserFakes({ mounted = {} } = {}) {
  const env = { animateCalls: 0, frames: [], reduced: false, audioTones: [], observed: new Map(), mqListeners: new Map() }
  const ctx = new Proxy({}, {
    get: (t, k) => k in t ? t[k] : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} })
      : k === 'measureText' ? () => ({ width: 10 }) : k === 'getImageData' ? () => ({ data: new Uint8ClampedArray(4) }) : () => {},
    set: (t, k, v) => { t[k] = v; return true }
  })
  env.context = ctx

  const document = new FakeElement(env, 'document')
  document.parent = null
  document.hidden = false
  document.body = new FakeElement(env, 'body', document)
  document.activeElement = document.body
  document.createElement = (tag) => new FakeElement(env, tag)
  const roots = new Map()
  document.querySelector = (selector) => {
    if (!(selector in mounted)) return null
    if (!roots.has(selector)) roots.set(selector, new FakeElement(env, 'section', document))
    return roots.get(selector)
  }
  env.document = document
  env.roots = roots

  class FakeAudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {} }
    resume() { return Promise.resolve() }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, value: 1 }, connect(n) { return n } } }
    createBiquadFilter() {
      const tone = { frequencies: [] }
      env.audioTones.push(tone)
      return { frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect(n) { return n }, tone }
    }
    createOscillator() {
      const tones = env.audioTones
      return { type: '', frequency: { set value(v) { tones.at(-1)?.frequencies.push(v) } }, connect(n) { return n }, start() {}, stop() {} }
    }
  }
  const windowListeners = new FakeElement(env, 'window')
  const win = Object.assign(windowListeners, { AudioContext: FakeAudioContext })

  const media = new Map()
  const matchMedia = (query) => {
    if (!media.has(query)) {
      const mq = {
        media: query, get matches() { return /prefers-reduced-motion/.test(query) ? env.reduced : false },
        addEventListener(type, fn) { if (type === 'change') (env.mqListeners.get(query) ?? env.mqListeners.set(query, []).get(query)).push(fn) },
        removeEventListener() {}
      }
      media.set(query, mq)
    }
    return media.get(query)
  }
  env.queries = media
  env.setReduced = (value) => {
    env.reduced = value
    for (const [query, fns] of env.mqListeners) if (/prefers-reduced-motion/.test(query)) for (const fn of fns) fn({ matches: value })
  }

  class FakeIntersectionObserver {
    constructor(callback) { env.observerCallback = callback; env.observerCount = (env.observerCount ?? 0) + 1 }
    observe(el) { env.observed.set(el, true) }
    unobserve(el) { env.observed.delete(el) }
    disconnect() {}
  }
  class FakeResizeObserver { observe() {} disconnect() {} }
  env.intersect = (target, entry = {}) => env.observerCallback([{
    target, isIntersecting: true, intersectionRatio: 1, boundingClientRect: { top: -50 }, rootBounds: { top: 0 }, ...entry
  }])

  let id = 0
  const requestAnimationFrame = (fn) => { env.frames.push(fn); return ++id }
  const cancelAnimationFrame = () => { env.frames.length = 0 }
  env.frameCount = () => env.frames.length
  // Runs the queued callbacks once per call, `ms` after the last one. Returns how many ran.
  let clock = 1000
  env.frame = (ms = 16) => {
    clock += ms
    const run = env.frames.splice(0)
    for (const fn of run) fn(clock)
    return run.length
  }

  Object.assign(globalThis, {
    document, window: win, matchMedia, IntersectionObserver: FakeIntersectionObserver, ResizeObserver: FakeResizeObserver,
    requestAnimationFrame, cancelAnimationFrame, devicePixelRatio: 1
  })
  // Node's globalThis.addEventListener does not exist; modules call window.addEventListener, which is `win` above.
  env.keydown = (key, code = 'Key' + key.toUpperCase()) => {
    const event = { type: 'keydown', key, code, isTrusted: true, repeat: false, defaultPrevented: false, target: document.body }
    document.dispatchEvent(event)
    document.dispatchEvent({ type: 'keyup', key, code, isTrusted: true, target: document.body })
    return event
  }
  return env
}

module.exports = { installBrowserFakes }
