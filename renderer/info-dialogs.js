// The keyboard-shortcuts and About dialogs. Both are styled <dialog>s in index.html: showModal() makes the
// app behind them inert, focus lands on the Close button and goes back to where it was when they close.
// No network calls: everything shown here is static text or the version the app was started with.

const $ = (id) => document.getElementById(id)

function openDialog(dlg) {
  if (!dlg || dlg.open) return false
  const back = document.activeElement
  dlg.addEventListener('close', () => { if (back && back.isConnected && back !== document.body) back.focus() }, { once: true })
  dlg.showModal()
  const first = dlg.querySelector('.support-actions .primary')
  if (first) first.focus({ preventScroll: true })
  return true
}

/** True when typing in this element should not trigger a shortcut. */
function typing(t) {
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
}

/**
 * Wire the two dialogs.
 * @param {{version: string, songCount: number, mutopiaCount: number, canOpen: () => boolean}} o
 *   canOpen: false while something else owns the keyboard (the results, the setup)
 *   licencesBundled: the notices files are in the app (iPhone/iPad), so About can show them in a sheet
 */
export function mountInfoDialogs(o) {
  const shortcuts = $('shortcutsDialog'), about = $('aboutDialog')
  if (!shortcuts || !about) return { openShortcuts() {}, openAbout() {} }
  $('aboutVersion').textContent = /^\d/.test(o.version) ? 'v' + o.version : o.version
  $('aboutMusic').textContent = `${o.songCount - o.mutopiaCount} easy songs are public domain. ${o.mutopiaCount} advanced piano pieces are public-domain compositions from the Mutopia Project, each typeset by a volunteer who chose its licence (shown under the song title while you play, and listed in LICENSES/mutopia-songs.md). The README has the full Music credits.`
  if (o.licencesBundled) $('aboutMusic').textContent = $('aboutMusic').textContent.replace(/ \(shown under the song title while you play, and listed in LICENSES\/mutopia-songs\.md\)/, ' (shown under the song title while you play)').replace(/ The README has the full Music credits\./, ' The credits are in Licences and acknowledgements.')
  const openShortcuts = () => openDialog(shortcuts)
  const openAbout = () => openDialog(about)
  const swap = (from, to) => () => { from.close(); to.showModal(); const b = to.querySelector('.support-actions .primary'); if (b) b.focus({ preventScroll: true }) }
  $('shortcutsAbout').onclick = swap(shortcuts, about)
  $('aboutShortcuts').onclick = swap(about, shortcuts)
  // Licences and acknowledgements, in the app: the notices files travel inside the iPhone/iPad app (web/THIRD_PARTY_NOTICES.md,
  // LICENSES/), one level above the page. Where they are not bundled (the desktop app has them in its folder, not on the page) the row stays hidden.
  const licences = $('aboutLicences'), notices = $('noticesDialog')
  if (licences && notices) {
    const FILES = [['Third-party notices', '../THIRD_PARTY_NOTICES.md'], ['Salamander Grand Piano recordings (CC BY 3.0)', '../LICENSES/piano-samples-CC-BY-3.0.txt'], ['Piano recordings: credits', '../LICENSES/piano-samples.md'], ['Music from the Mutopia Project', '../LICENSES/mutopia-songs.md']]
    let loaded = null
    const load = () => loaded || (loaded = Promise.all(FILES.map(([title, path]) => fetch(new URL(path, location.href)).then((r) => (r.ok ? r.text() : null)).catch(() => null).then((text) => [title, text]))).then((all) => all.filter(([, t]) => t)))
    const show = async () => {
      const body = $('noticesBody')
      const parts = await load()
      body.replaceChildren(...parts.flatMap(([title, text]) => {
        const h = document.createElement('h3'); h.textContent = title
        const pre = document.createElement('pre'); pre.textContent = text.trim()
        return [h, pre]
      }))
      if (!parts.length) { const p = document.createElement('p'); p.textContent = 'The licence texts could not be loaded.'; body.replaceChildren(p) }
    }
    if (o.licencesBundled) {
      licences.classList.remove('hidden')
      licences.onclick = () => { about.close(); notices.showModal(); show(); const b = notices.querySelector('.support-actions .primary'); if (b) b.focus({ preventScroll: true }) }
      notices.addEventListener('close', () => { if (!about.open) about.showModal() })
    }
  }
  const link = (id, fn) => { const b = $(id); if (b) b.onclick = fn }
  link('openShortcuts', openShortcuts)
  link('openAbout', openAbout)
  document.addEventListener('keydown', (e) => {
    if (e.key !== '?' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
    if (typing(e.target) || document.querySelector('dialog[open]') || !o.canOpen()) return
    e.preventDefault()
    openShortcuts()
  })
  return { openShortcuts, openAbout }
}
