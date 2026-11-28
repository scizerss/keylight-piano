// Settings search: types into #settingsSearch filter the rows of the grouped Settings page (#screen-settings).
// A "unit" is one row of a .kl-group (or a whole card that has no group); it matches on its own text plus an optional data-kw
// (extra words, like "metronome" on the Count-in row). A card whose title matches shows all of its rows. Cards left with no
// match are hidden, and the folded Advanced group opens while a search matches inside it (and closes again afterwards).
// Rows another part of the app hid (the .hidden class: no battery, no camera on a phone) are never shown by a search.
const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim()

export function matchUnits(units, query) {
  const q = norm(query)
  return units.map((u) => !q || norm(u.text + ' ' + (u.kw || '')).includes(q))
}

// Move grouped help text out of the inset surface, keeping each group's footer together.
export function moveSettingsFooters(root) {
  // Groups with an id are shown and hidden by the app (the TV card), so their footers stay inside them.
  for (const group of root.querySelectorAll('#screen-settings .settings-card > .kl-group:not([id])')) {
    group.after(...group.querySelectorAll(':scope > p.cam-help'))
  }
}

export function mountSettingsSearch(root = document) {
  const input = root.getElementById('settingsSearch')
  const screen = root.getElementById('screen-settings')
  if (!input || !screen) return { filter() {} }
  const clear = root.getElementById('settingsSearchClear'), none = root.getElementById('settingsNoMatch')
  let advancedWas = null

  const cardsOf = () => [...screen.querySelectorAll('.settings-grid > .settings-card, .settings-grid > .settings-group')]
  const hidden = (el) => el.classList.contains('hidden') || el.getAttribute('aria-hidden') === 'true'

  function filter(raw) {
    const q = norm(raw)
    clear && clear.classList.toggle('hidden', !raw)
    let shown = 0
    for (const card of cardsOf()) {
      const own = hidden(card)
      const title = norm((card.querySelector('h3, summary') || {}).textContent)
      const groups = [...card.querySelectorAll(':scope > .kl-group')]
      if (root.documentElement?.classList.contains('ios')) {
        for (const footer of card.querySelectorAll(':scope > p.cam-help')) footer.classList.toggle('s-off', !!q)
      }
      const all = !q || title.includes(q)
      let any = false
      for (const group of groups.length ? groups : [card]) {
        const units = group === card ? [card] : group.children
        let groupHit = false
        for (const u of units) {
          const hit = all || (!u.matches('p.cam-help') && norm(u.textContent + ' ' + (u.dataset?.kw || '')).includes(q))
          if (u !== card) u.classList.toggle('s-off', !hit)
          if (hit && !hidden(u)) groupHit = true
        }
        if (group !== card) group.classList.toggle('s-off', !!q && !groupHit)
        if (groupHit && !hidden(group) && !own) any = true
      }
      card.classList.toggle('s-off', !any && !!q)
      if (any || !q) shown++
      if (card.tagName === 'DETAILS' && card.id === 'setAdvanced') {
        if (q && any) { if (advancedWas == null) advancedWas = card.open; card.open = true }
        else if (!q && advancedWas != null) { card.open = advancedWas; advancedWas = null }
      }
    }
    if (none) none.classList.toggle('hidden', !q || shown > 0)
  }
  input.addEventListener('input', () => filter(input.value))
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value) { e.stopPropagation(); input.value = ''; filter('') } })
  if (clear) clear.addEventListener('click', () => { input.value = ''; filter(''); input.focus() })
  return { filter }
}
