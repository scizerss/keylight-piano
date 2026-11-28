export const BETA_NOTICE_SEEN_KEY = 'lumi.betaNoticeSeen'

const FOUNDER_PRICES = { yearly: '29.99 USD', monthly: '4.99 USD', lifetime: '89.99 USD' }
const NOTICE = 'Thanks for testing Keylight. When the beta ends, Keylight for iPhone and iPad becomes a subscription. '
  + `Early supporters get the founder price: ${FOUNDER_PRICES.yearly} a year or ${FOUNDER_PRICES.monthly} a month, kept for as long as you stay subscribed. `
  + `Or pay once: ${FOUNDER_PRICES.lifetime} for Lifetime.`

export function mountBetaNotice({ beta, store }) {
  if (!beta) return () => {}
  const row = document.getElementById('openBetaNotice')
  const dialog = document.getElementById('betaNotice')
  document.getElementById('betaNoticeText').textContent = NOTICE
  row.classList.remove('hidden')

  let seen = store.get(BETA_NOTICE_SEEN_KEY, false) === true
  function open() {
    if (dialog.open) return
    dialog.showModal()
    return new Promise((resolve) => dialog.addEventListener('close', () => {
      if (!seen) {
        seen = true
        store.set(BETA_NOTICE_SEEN_KEY, true)
      }
      resolve()
    }, { once: true }))
  }
  row.onclick = open
  dialog.addEventListener('keydown', (event) => event.stopPropagation())
  return () => { if (!seen) return open() }
}
