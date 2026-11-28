// The visible Done/Close buttons keep their existing focus and cleanup paths.
const sheets = [
  ['dialog[open]:not(.confirm-dialog)', '.kl-dlg-head, .diagnostics-heading, .ds-head, header, h2', (panel) => panel.close()],
  ['#importSheet:not(.hidden) .sheet', '.kl-dlg-head', (_panel, actions) => actions.closeImport()],
  ['body.filters-open #filterBar', '.fs-head', (_panel, actions) => actions.closeFilters()],
  ['body.hud-more .hud-actions', '.hud-sheet-head', (_panel, actions) => actions.closeMore()],
  ['.guided:not(.hidden) .guided-panel', '.guided-head', (panel) => panel.querySelector('.guided-close').click()],
  ['.cr-sheet', '.cr-sheet-t', (panel) => panel.parentElement.click()]
]
const FLICK = 0.45   // px per ms (the iPhone/iPad app only; Android keeps the distance rule)
const interactive = 'button, a, input, select, textarea, label, summary, [role="button"], [contenteditable]'

export function mountSheetDrag(actions) {
  const narrow = matchMedia('(max-width: 699px)')
  let drag

  function finish(dismiss = false) {
    if (!drag) return
    const { panel, handle, pointer, close } = drag
    drag = null
    const visible = panel.getClientRects().length > 0
    panel.style.removeProperty('transform')
    panel.classList.remove('sheet-dragging')
    if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer)
    if (dismiss && visible) close(panel, actions)
  }

  document.addEventListener('pointerdown', (event) => {
    if (!narrow.matches || drag || !event.isPrimary || event.pointerType === 'mouse' || event.target.closest(interactive)) return
    for (const [selector, header, close] of sheets) {
      const panel = event.target.closest(selector)
      const handle = event.target.closest(header)
      if (!panel || !handle || handle.parentElement !== panel) continue
      try { handle.setPointerCapture(event.pointerId) } catch { break }
      drag = { panel, handle, close, pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false, trail: [[event.timeStamp, event.clientY]] }
      handle.addEventListener('lostpointercapture', () => finish(), { once: true })
      break
    }
  })

  document.addEventListener('pointermove', (event) => {
    if (drag?.pointer !== event.pointerId) return
    const dy = event.clientY - drag.y
    const dx = Math.abs(event.clientX - drag.x)
    if (!drag.moved && dx > 10 && dx > Math.abs(dy)) return finish()
    if (!drag.moved && dy < 6) return
    drag.moved = true
    drag.trail.push([event.timeStamp, event.clientY])
    if (drag.trail.length > 6) drag.trail.shift()
    drag.panel.classList.add('sheet-dragging')
    drag.panel.style.transform = `translateY(${Math.max(0, dy)}px)`
  })

  document.addEventListener('pointerup', (event) => {
    if (drag?.pointer !== event.pointerId) return
    const threshold = Math.min(100, drag.panel.offsetHeight * .25)
    // a flick closes the sheet whatever the distance: faster than 0.45 px/ms over the last few moves
    const [t0, y0] = drag.trail[0]
    const flick = drag.moved && drag.trail.length > 1 && event.timeStamp > t0 && document.documentElement.classList.contains('ios') && (event.clientY - y0) / (event.timeStamp - t0) > FLICK
    finish(drag.moved && (event.clientY - drag.y >= threshold || flick))
  })
  document.addEventListener('pointercancel', (event) => { if (drag?.pointer === event.pointerId) finish() })
  window.addEventListener('blur', () => finish())
  narrow.addEventListener('change', () => finish())
}
