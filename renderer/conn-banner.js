// The app-wide connection banner: "LUMI Keys disconnected…", "Reconnecting…", "Reconnected". A small pill under the
// status bar, never a modal, gone within a few seconds (it must not cover the player's controls); a tap dismisses it.
// app.js feeds it from the MIDI ports ('keylight:midi', every platform) and from Bluetooth (ios-ble.js, iOS).
// The rules (grace time, how long each shows) are in setup-flow.js and tested in scripts/test-setup-flow.js.
import { bannerStart, bannerEvent, bannerTick, bannerText } from './setup-flow.js'

export function mountConnBanner({ doc = document, now = () => performance.now() } = {}) {
  let state = bannerStart()
  let suppressed = false   // while the setup or Connect screen is open: it shows the same thing itself
  let timer = 0
  const el = doc.createElement('div')
  el.id = 'connBanner'
  el.setAttribute('role', 'status')
  el.setAttribute('aria-live', 'polite')
  el.innerHTML = '<span class="cb-dot" aria-hidden="true"></span><span class="cb-text"></span>'
  const text = el.querySelector('.cb-text')
  el.addEventListener('click', () => { state = { ...state, show: null, lostAt: 0 }; draw() })
  doc.body.append(el)

  function draw() {
    const v = suppressed ? null : bannerText(state)
    el.classList.toggle('show', !!v)
    el.setAttribute('aria-hidden', String(!v))   // a hidden banner is not read out by VoiceOver
    if (v) {
      if (el.dataset.tone !== v.tone) el.dataset.tone = v.tone
      if (text.textContent !== v.text) text.textContent = v.text
    } else if (text.textContent) text.textContent = ''
    // tick only while something is pending or showing
    const busy = !!state.show || (!state.connected && !!state.lostAt && !state.notified)
    if (busy && !timer) timer = setInterval(tick, 250)
    else if (!busy && timer) { clearInterval(timer); timer = 0 }
  }
  function tick() { state = bannerTick(state, now()); draw() }

  return {
    update(ev) { state = bannerEvent(state, ev, now()); tick() },
    // The setup or Connect screen showed the state itself: nothing to repeat when it closes. A keyboard still off then
    // counts as told, so it gets "Reconnected" (not a late "disconnected") when it comes back.
    suppress(on) { suppressed = !!on; if (!on) state = { ...state, show: null, notified: !state.connected && state.seen }; draw() },
    get state() { return state },
    el
  }
}
