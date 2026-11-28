import { entitlement, premium, onChange } from './entitlement.js'
import { IS_NATIVE_HOST } from './platform.js'
import { openExternalAsync } from './host-tools.js'

const TERMS = 'https://keylightpiano.app/terms'
const PRIVACY = 'https://keylightpiano.app/privacy'
const PLAN_ORDER = ['yearly', 'monthly', 'lifetime']
const PLAN_NAMES = { yearly: 'Yearly', monthly: 'Monthly', lifetime: 'Lifetime' }

export function premiumStatusText(status) {
  if (!status.active) return 'Not active'
  if (status.lifetime) return 'Lifetime access'
  if (status.inGrace) return 'Check your subscription payment'
  if (!status.expires) return 'Active'
  const date = new Date(status.expires).toLocaleDateString(undefined, { dateStyle: 'medium' })
  return (status.inTrial ? 'Trial ends on ' : status.willRenew ? 'Renews on ' : 'Access ends on ') + date
}

let open = () => Promise.resolve(false)
export function openPaywall() {
  return IS_NATIVE_HOST && !premium() ? open() : Promise.resolve(premium())
}

export function mountPremium() {
  if (!IS_NATIVE_HOST) return
  const settings = document.getElementById('setPremium')
  const settingStatus = settings.querySelector('#premiumStatus')
  const settingMessage = settings.querySelector('#premiumMessage')
  const manage = settings.querySelector('#premiumManage')
  const restore = settings.querySelector('#premiumRestore')
  const upgrade = settings.querySelector('#premiumUpgrade')
  // Beta and purchase-disabled builds have no Premium controls.
  settings.classList.toggle('hidden', !entitlement.available)

  function renderSettings() {
    const status = entitlement.status()
    settingStatus.textContent = entitlement.available ? premiumStatusText(status) : entitlement.unavailable
    upgrade.classList.toggle('hidden', !entitlement.available || premium())
    restore.classList.toggle('hidden', !entitlement.available)
    manage.classList.toggle('hidden', !entitlement.available)
  }
  renderSettings()
  if (!entitlement.available) return

  const dialog = document.getElementById('premiumDialog')
  const plans = dialog.querySelector('#premiumPlans')
  const explanation = dialog.querySelector('#premiumBilling')
  const message = dialog.querySelector('#premiumSheetMessage')
  const buy = dialog.querySelector('#premiumBuy')
  const retry = dialog.querySelector('#premiumRetry')
  const sheetRestore = dialog.querySelector('#premiumSheetRestore')
  let products = []
  let selected = null
  let loading = false
  let loadError = false
  let busy = false
  let awaitingApproval = false
  let opened = null

  function renderSelection() {
    const product = products.find((p) => p.plan === selected)
    const intro = product?.introEligible && product.introText
    plans.disabled = busy || loading
    buy.hidden = !product
    buy.disabled = busy || loading
    buy.textContent = intro ? 'Continue' : product?.plan === 'lifetime' ? 'Buy lifetime access' : 'Subscribe'
    explanation.hidden = !product
    if (!product) return
    const price = product.period ? `${product.price} per ${product.period}` : `${product.price} once`
    explanation.replaceChildren()
    const terms = document.createElement('p')
    terms.textContent = product.period
      ? `${intro ? intro + ', then ' : ''}${price}. Your subscription renews automatically unless you cancel at least 24 hours before it ends. Manage or cancel in your account settings.`
      : `${price}. Includes lifetime access.`
    explanation.append(terms)
    if (product.period) {
      const founder = document.createElement('p')
      founder.textContent = 'Founder price: you keep this price while you stay subscribed'
      explanation.append(founder)
    }
  }

  async function loadPlans() {
    if (loading) return
    loading = true
    loadError = false
    retry.hidden = true
    message.textContent = 'Loading plans…'
    try {
      const result = await entitlement.products()
      products = PLAN_ORDER.flatMap((plan) => {
        const product = result.find((p) => p?.plan === plan && typeof p.price === 'string' && p.price.trim()
          && p.period === ({ yearly: 'year', monthly: 'month', lifetime: null })[plan])
        return product ? [product] : []
      })
      loadError = !products.length
    } catch {
      loadError = true
    } finally {
      loading = false
    }
    selected = products.some((p) => p.plan === selected) ? selected : products[0]?.plan
    plans.replaceChildren(...products.map((product) => {
      const label = document.createElement('label')
      const radio = document.createElement('input')
      radio.type = 'radio'
      radio.name = 'premiumPlan'
      radio.checked = selected === product.plan
      radio.onchange = () => { selected = product.plan; renderSelection() }
      const name = document.createElement('strong')
      name.textContent = PLAN_NAMES[product.plan]
      const price = document.createElement('span')
      const billed = product.period ? `${product.price} per ${product.period}` : `${product.price} once`
      price.textContent = product.introEligible && product.introText ? `${product.introText}, then ${billed}` : billed
      label.append(radio, name, price)
      return label
    }))
    plans.hidden = !products.length
    retry.hidden = !loadError
    if (!busy) message.textContent = loadError ? 'Plans could not be loaded. Try again.' : pendingText()
    renderSelection()
  }

  const pendingText = () => awaitingApproval ? 'Purchase is waiting for approval. You can close this and keep playing.' : ''

  // Each purchase/restore/manage call gets a ticket. releaseBusy() abandons the running one, so its late answer
  // can't re-enable the buttons or overwrite the message while a newer call is in flight.
  let op = 0
  const begin = () => { setBusy(true); return ++op }
  const current = (ticket) => ticket === op
  function setBusy(value) {
    busy = value
    manage.disabled = restore.disabled = sheetRestore.disabled = value
    renderSelection()
  }

  // storeBuy/storeRestore have no timeout: if the host never answers (an interrupted purchase
  // sheet, a dismissed App Store dialog), busy would stay set and every button stay disabled.
  // A store event or coming back to the app means the answer has landed (or never will): let the
  // user try again instead of leaving the sheet stuck on "Waiting for purchase…".
  function releaseBusy() {
    if (!busy) return
    op++
    setBusy(false)
    message.textContent = pendingText()
    if (settingMessage.textContent === 'Restoring purchases…') settingMessage.textContent = ''
  }

  async function restoreFrom(output) {
    if (busy) return
    const ticket = begin()
    output.textContent = 'Restoring purchases…'
    try {
      const result = await entitlement.restore()
      if (current(ticket)) output.textContent = result.active ? 'Purchases restored.' : 'No active purchases found.'
    } catch {
      if (current(ticket)) output.textContent = 'Could not restore purchases. Try again.'
    } finally {
      if (current(ticket)) setBusy(false)
    }
  }

  buy.onclick = async () => {
    if (busy || loading || !selected) return
    const ticket = begin()
    message.textContent = 'Waiting for purchase…'
    try {
      const result = await entitlement.buy(selected)
      awaitingApproval = result === 'pending' && !premium()
      if (!current(ticket)) return
      if (result === 'purchased' && premium()) message.textContent = ''
      else if (result === 'pending' || result === 'cancelled') message.textContent = pendingText()
      else message.textContent = 'Could not complete the purchase. Try again.'
    } catch {
      if (current(ticket)) message.textContent = 'Could not complete the purchase. Try again.'
    } finally {
      if (current(ticket)) setBusy(false)
    }
  }

  manage.onclick = async () => {
    if (busy) return
    const ticket = begin()
    settingMessage.textContent = ''
    try {
      if (!await entitlement.manage() && current(ticket)) settingMessage.textContent = 'Could not open subscription settings.'
    } catch {
      if (current(ticket)) settingMessage.textContent = 'Could not open subscription settings.'
    } finally {
      if (current(ticket)) setBusy(false)
    }
  }

  upgrade.onclick = openPaywall
  restore.onclick = () => restoreFrom(settingMessage)
  sheetRestore.onclick = () => restoreFrom(message)
  retry.onclick = loadPlans
  for (const [id, url] of [['premiumTerms', TERMS], ['premiumPrivacy', PRIVACY]]) {
    dialog.querySelector('#' + id).onclick = async (event) => {
      event.preventDefault()
      if (!await openExternalAsync(url)) message.textContent = 'Could not open this link.'
    }
  }
  function closePaywall(unlocked = false) {
    const pending = opened
    opened = null
    if (dialog.open) dialog.close()
    pending?.resolve(unlocked)
  }
  dialog.addEventListener('keydown', (event) => event.stopPropagation())
  for (const type of ['cancel', 'submit']) dialog.addEventListener(type, (event) => {
    event.preventDefault()
    closePaywall()
  })
  dialog.addEventListener('close', () => { if (!dialog.open) closePaywall() })
  onChange(() => {
    releaseBusy()   // a store event is the host answering, even if the request never resolved
    renderSettings()
    if (premium()) {
      awaitingApproval = false
      if (dialog.open) closePaywall(true)
    }
  })
  // a purchase sheet or an App Store dialog can swallow the answer while the page is hidden:
  // coming back means the request is no longer worth waiting on
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') releaseBusy()
  })
  open = () => {
    if (dialog.open) return opened.promise
    if (opened) closePaywall()
    let resolve
    const promise = new Promise((done) => { resolve = done })
    opened = { promise, resolve }
    dialog.showModal()
    if (!busy) {
      selected = null
      products = []
      plans.hidden = true
      plans.replaceChildren()
      renderSelection()
      void loadPlans()
    }
    return promise
  }
  void entitlement.refresh().catch(() => {})
}
