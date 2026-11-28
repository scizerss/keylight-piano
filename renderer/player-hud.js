// Player HUD behaviour (presentation only): auto-hide after ~3 s of playing, tap/move/key to wake, the "More" sheet,
// the compact speed popover, drag scrubbing on the progress bar, the idle progress line and section ticks.
// It reads the page (body[data-screen], #btnPlay icon, #speedTrack .on) and never touches the player, scoring or audio.
// Styles: player.css. Everything here is a no-op outside the player screen.
const $ = (id) => document.getElementById(id)
const IDLE_MS = 3000

export function prefersReducedMotion() {
  return document.documentElement.classList.contains('reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches
}

// The label of the compact speed chip for a playback rate: 1 -> "Full speed", 0.6 -> "0.6x", 0.8 -> "0.8x" (a custom rate
// matches none of the four buttons, so the chip must still say what the rate is).
export function speedChipLabel(rate) {
  const r = Number(rate)
  if (!Number.isFinite(r) || r <= 0) return 'Speed'
  if (r === 1) return 'Full speed'
  return String(Math.round(r * 100) / 100) + 'x'
}
// What a click inside the compact speed control does: a closed chip opens the list whatever was hit (the chip is the track itself
// when no button is selected); an open list takes a choice from a button and ignores clicks on its padding.
export function compactSpeedClick({ compact, open, onButton }) {
  if (!compact) return 'pass'
  if (!open) return 'open'
  return onButton ? 'choose' : 'ignore'
}

export function mountPlayerHud({ seekFraction, onFit }) {
  const body = document.body
  let lastAct = performance.now()
  const wake = () => { lastAct = performance.now(); body.classList.remove('hud-idle') }
  const onPlay = () => body.dataset.screen === 'play'
  const playing = () => { const u = $('btnPlay') && $('btnPlay').querySelector('use'); return !!u && u.getAttribute('href') === '#i-pause' }
  const waitMode = () => !!document.querySelector('#speedTrack button.on[data-speed="wait"]')
  const overlayOpen = () => body.classList.contains('hud-more') || $('speedTrack').classList.contains('open') ||
    !$('viewMenu').classList.contains('hidden') || !$('results').classList.contains('hidden') ||
    !!document.querySelector('dialog[open], .guided:not(.hidden)') || !!document.querySelector('#screen-play:focus-within :is(select,input):focus')
  for (const ev of ['pointerdown', 'pointermove', 'keydown', 'touchstart']) document.addEventListener(ev, wake, { passive: true, capture: true })

  // ---- the More sheet ----
  const setMore = (on) => {
    body.classList.toggle('hud-more', on)
    $('hudScrim').hidden = !on
    $('hudMore').setAttribute('aria-expanded', String(on))
    if (on) { $('speedTrack').classList.remove('open'); const f = $('hudActions').querySelector('button:not([disabled])'); if (f) f.focus({ preventScroll: true }) }
    else if (document.activeElement && $('hudActions').contains(document.activeElement)) $('hudMore').focus({ preventScroll: true })
  }
  $('hudMore').addEventListener('click', () => setMore(!body.classList.contains('hud-more')))
  $('hudMoreClose').addEventListener('click', () => setMore(false))
  $('hudScrim').addEventListener('click', () => setMore(false))
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && body.classList.contains('hud-more')) { e.preventDefault(); e.stopPropagation(); setMore(false) } }, true)
  // choosing a toggle in the sheet leaves it open (you may set several); leaving the player closes it
  new MutationObserver(() => { if (!onPlay()) setMore(false) }).observe(body, { attributes: true, attributeFilter: ['data-screen'] })

  // ---- compact speed: the chip opens a list ----
  const track = $('speedTrack')
  track.addEventListener('click', (e) => {
    const b = e.target.closest('button')
    const action = compactSpeedClick({ compact: track.matches('.compact'), open: track.classList.contains('open'), onButton: !!b })
    if (action === 'open') { track.classList.add('open'); e.stopPropagation(); e.preventDefault(); return }
    if (action === 'ignore') { e.stopPropagation(); e.preventDefault(); return }
    if (action === 'choose') track.classList.remove('open')
  }, true)
  // with a custom rate no button is selected and none is shown: the chip itself must be reachable by keyboard and open the list
  track.addEventListener('keydown', (e) => {
    if (e.target !== track || !track.matches('.compact') || track.classList.contains('open')) return
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); track.classList.add('open'); const f = track.querySelector('button'); if (f) f.focus({ preventScroll: true }) }
  })
  const syncChipFocus = () => {
    const chip = track.matches('.compact') && !track.querySelector('button.on')
    if (chip) { track.tabIndex = 0; track.setAttribute('role', 'button'); track.setAttribute('aria-label', 'Speed ' + (track.dataset.rate || '')); track.setAttribute('aria-haspopup', 'true') }
    else { track.removeAttribute('tabindex'); track.removeAttribute('role'); track.removeAttribute('aria-label'); track.removeAttribute('aria-haspopup') }
  }
  new MutationObserver(syncChipFocus).observe(track, { attributes: true, attributeFilter: ['class', 'data-rate'], subtree: true })
  document.addEventListener('pointerdown', (e) => { if (track.classList.contains('open') && !track.contains(e.target)) track.classList.remove('open') }, true)
  const mq = matchMedia('(max-width: 699px), (max-height: 520px)')
  // ---- fitting the bar: the parts right of the back button keep their size, so on a narrow bar (iPad 11" upright, a resized
  // window or split view, big text) the hand legend and then the back button itself would run under the speed control.
  // Give way in this order: full legend -> L / R -> the speed buttons fold into the compact chip -> no legend -> Loop and then
  // View move to More.
  const legend = $('handLegend'), left = legend && legend.parentElement, back = $('back')
  const ios = document.documentElement?.classList.contains('ios')
  const title = $('title')
  const titleRange = ios && title ? document.createRange() : null
  let tv = false
  const setCompact = (on) => { track.classList.toggle('compact', on); if (!on) track.classList.remove('open') }
  let fitLater = false
  const fitBar = () => {
    // the More sheet takes the actions out of the bar, and an open speed list is out of the flow: measuring then would undo
    // the fit (and close or blur the list). Fit again when they close, also after a rotation or resize meanwhile.
    if (body.classList.contains('hud-more') || track.classList.contains('open')) { fitLater = true; return }
    fitLater = false
    if (legend) legend.classList.remove('is-short', 'is-squeezed')
    body.classList.remove('hud-tight-1', 'hud-tight-2')
    tv = ios && body.classList.contains('tv-on')
    const preferCompact = mq.matches || tv
    setCompact(preferCompact)
    let titleFloor = 0
    if (titleRange && title.offsetParent !== null) {
      titleRange.selectNodeContents(title)
      titleFloor = Math.min(140, titleRange.getBoundingClientRect().width)
    }
    if (!left || track.offsetParent === null) return   // off the player
    const edge = () => left.getBoundingClientRect().right + 0.5
    const legendOn = !!legend && legend.offsetParent !== null && getComputedStyle(legend).position !== 'absolute'
    const fits = () => (!back || back.offsetParent === null || back.getBoundingClientRect().right <= edge()) &&
      (!titleFloor || title.getBoundingClientRect().width + 0.5 >= titleFloor) &&
      (!legendOn || legend.classList.contains('is-squeezed') || legend.getBoundingClientRect().right <= edge())
    const short = (on) => { if (legend) legend.classList.toggle('is-short', on) }
    if (fits()) return
    if (legendOn) { short(true); if (fits()) return; short(false) }
    if (!preferCompact) setCompact(true)
    if (fits()) return
    if (legendOn) { short(true); if (fits()) return; legend.classList.add('is-squeezed') }
    // still no room for the back button (Slide Over, a narrow split, big text): Loop, then View, wait in More
    if (fits()) return
    body.classList.add('hud-tight-1'); if (fits()) return
    body.classList.add('hud-tight-2')
  }
  // --hud-bottom: where the bar's content ends (without its fade padding), for chips that sit under it (.play-hint). On iPad the
  // bar starts well below the status bar, so a fixed offset put the "Sheet only" chip over the speed control.
  const measureBar = () => {
    const bar = $('topbar')
    if (!onPlay() || !bar || bar.offsetParent === null) return
    const bottom = Math.round(bar.getBoundingClientRect().bottom - (parseFloat(getComputedStyle(bar).paddingBottom) || 0))
    if (bottom > 0) body.style.setProperty('--hud-bottom', bottom + 'px')
  }
  const sync = () => { fitBar(); syncChipFocus(); measureBar(); if (onFit) onFit() }
  sync(); mq.addEventListener?.('change', sync)
  new MutationObserver(() => requestAnimationFrame(measureBar)).observe(body, { attributes: true, attributeFilter: ['data-screen'] })
  // the More sheet or the speed list closed after a refit was put off
  new MutationObserver(() => {
    if ((fitLater || (ios && tv !== body.classList.contains('tv-on'))) &&
        !body.classList.contains('hud-more') && !track.classList.contains('open')) sync()
  }).observe(body, { attributes: true, attributeFilter: ['class'] })
  new MutationObserver(() => { if (fitLater && !body.classList.contains('hud-more') && !track.classList.contains('open')) sync() })
    .observe(track, { attributes: true, attributeFilter: ['class'] })
  if (titleRange) new MutationObserver(() => requestAnimationFrame(sync)).observe(title, { childList: true, characterData: true, subtree: true })
  if (typeof ResizeObserver === 'function' && left) {
    // fitBar resizes what is observed, so it runs on the next frame, never inside the observer's delivery ("ResizeObserver
    // loop" errors). It starts from the widest layout each time, so the follow-up pass changes nothing and it settles.
    let raf = 0
    const ro = new ResizeObserver(() => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; sync() }) })
    ro.observe(left); if (legend) ro.observe(legend)
    // the bar's own box: a safe-area or text-size change can move its bottom without resizing .top-left
    if ($('topbar')) ro.observe($('topbar'), { box: 'border-box' })
  }

  // ---- drag scrubbing (a click already seeks) ----
  const bar = $('progress')
  let dragPointer = null
  const clearDrag = () => { dragPointer = null; body.classList.remove('hud-scrubbing') }
  bar.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || dragPointer != null) return
    dragPointer = e.pointerId
    body.classList.add('hud-scrubbing')
    try { bar.setPointerCapture(e.pointerId) } catch (_e) { /* not capturable */ }
    seekFraction(e.clientX)
  })
  bar.addEventListener('pointermove', (e) => { if (e.pointerId === dragPointer) seekFraction(e.clientX) })
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    bar.addEventListener(type, (e) => { if (e.pointerId === dragPointer) clearDrag() })
  }
  // the pointer already seeked: the browser's follow-up click must not seek twice from a different place
  bar.addEventListener('click', (e) => { e.stopImmediatePropagation() }, true)

  // ---- idle check + the thin progress line ----
  const fill = $('progressFill'), line = $('hudLineFill')
  let interval = null, frame = null
  const tick = () => {
    frame = null
    if (!body.classList.contains('hud-idle')) return
    line.style.width = fill.style.width || '0%'
    frame = requestAnimationFrame(tick)
  }
  const checkIdle = () => {
    const idle = onPlay() && !prefersReducedMotion() && !body.classList.contains('freeplay') && playing() && !waitMode() && !overlayOpen() && dragPointer == null && performance.now() - lastAct > IDLE_MS
    body.classList.toggle('hud-idle', idle)
    if (idle && frame == null) frame = requestAnimationFrame(tick)
  }
  const startIdleCheck = () => { if (interval == null) interval = setInterval(checkIdle, 250) }
  startIdleCheck()
  globalThis.addEventListener?.('pagehide', () => {
    clearInterval(interval)
    if (frame != null) cancelAnimationFrame(frame)
    interval = frame = null
    clearDrag()
    wake()
  })
  globalThis.addEventListener?.('pageshow', startIdleCheck)

  return {
    wake,
    closeMore: () => setMore(false),
    // a tick per phrase (every 4th bar), so a long song reads as sections on the scrubber
    setTicks(bars, from, length) {
      const host = $('hudTicks'); host.replaceChildren()
      if (!bars || bars.length < 9 || !(length > 0)) return
      const step = bars.length > 60 ? 8 : 4
      for (let i = step; i < bars.length; i += step) {
        const f = (bars[i] - from) / length
        if (f <= 0 || f >= 1) continue
        const t = document.createElement('i'); t.style.left = (f * 100).toFixed(2) + '%'; host.append(t)
      }
    }
  }
}
