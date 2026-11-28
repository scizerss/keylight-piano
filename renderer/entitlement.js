import { IS_ANDROID, IS_IOS, IS_IOS_BETA, IOS_PAYWALL_ENABLED } from './platform.js'
import { nativeRequest, onNativeEvent } from './android-midi.js'

// Device-only fast paint. Backups include lumi.* settings, never this cache.
export const ENTITLEMENT_CACHE_KEY = 'keylight.store-status.v1'
const PLANS = ['monthly', 'yearly', 'lifetime']
const INACTIVE = Object.freeze({
  active: false, plan: null, expires: null, willRenew: false, inGrace: false, inTrial: false, lifetime: false
})
// TODO: Turn off the Android access bypass when the Play Billing adapter is ready.
const ANDROID_PREMIUM_BYPASS = true
function normalize(raw) {
  if (raw?.active === false) return INACTIVE
  if (raw?.active !== true || !PLANS.includes(raw.plan)) return null
  const lifetime = raw.plan === 'lifetime'
  const expires = typeof raw.expires === 'number' && Number.isFinite(new Date(raw.expires).getTime()) ? raw.expires : null
  if (lifetime && raw.lifetime !== true) return null
  return Object.freeze({
    active: true, plan: raw.plan, expires, lifetime,
    willRenew: raw.willRenew === true, inGrace: raw.inGrace === true, inTrial: raw.inTrial === true
  })
}

export function createEntitlement({
  platform, request = nativeRequest, listen = onNativeEvent, getStorage = () => globalThis.localStorage, now = Date.now,
  iosPaywall = IOS_PAYWALL_ENABLED, beta = IS_IOS_BETA
}) {
  const available = platform === 'ios' && iosPaywall && !beta
  const included = platform === 'desktop' || (platform === 'android' && ANDROID_PREMIUM_BYPASS) || (platform === 'ios' && !available)
  const unavailable = platform === 'android' ? 'Subscriptions are not available yet.' : 'Purchases are unavailable.'
  const listeners = new Set()
  let current = INACTIVE
  let revision = 0
  let expirationTimer
  if (available) {
    try {
      const cached = normalize(JSON.parse(getStorage()?.getItem(ENTITLEMENT_CACHE_KEY) ?? 'null'))
      if (cached?.lifetime || cached?.expires > now()) current = cached
    } catch { /* StoreKit will supply the status when storage is unavailable. */ }
  }

  function apply(raw) {
    const next = normalize(raw)
    if (!next) return
    revision++
    const changed = Object.keys(next).some((key) => next[key] !== current[key])
    if (changed || revision === 1) {
      try { getStorage()?.setItem(ENTITLEMENT_CACHE_KEY, JSON.stringify(next)) } catch { /* Fast paint is optional. */ }
    }
    if (!changed) return
    current = next
    scheduleStatusCheck()
    for (const listener of listeners) listener(current)
  }

  const unsubscribe = available ? listen((event) => { if (event?.kind === 'store') apply(event) }) : null
  const call = (op, args, timeout) => available ? request(op, args, timeout) : Promise.reject(new Error(unavailable))

  async function refresh() {
    if (!available) return current
    const before = revision
    const result = await call('storeStatus')
    if (before === revision) apply(result)
    return current
  }

  // Recheck an expiring subscription even if the app stays in the foreground.
  function scheduleStatusCheck() {
    clearTimeout(expirationTimer)
    if (current.expires == null || current.expires <= now()) return
    const remaining = current.expires - now()
    const delay = Math.min(remaining, 0x7fffffff)
    expirationTimer = setTimeout(() => {
      if (current.expires > now()) scheduleStatusCheck()
      else void refresh().catch(() => {})
    }, delay)
  }
  scheduleStatusCheck()

  return {
    available, unavailable,
    premium: () => included || current.active,
    plan: () => current.plan,
    status: () => current,
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    dispose() { unsubscribe?.(); clearTimeout(expirationTimer); listeners.clear() },
    refresh,
    products: () => call('storeProducts'),
    async buy(plan) {
      if (!PLANS.includes(plan)) throw new TypeError('Unknown purchase plan')
      const answer = await call('storeBuy', { plan }, 0)
      apply(answer?.status)
      return answer?.result
    },
    async restore() {
      apply(await call('storeRestore', {}, 0))
      return current
    },
    manage: () => call('storeManage')
  }
}

export const entitlement = createEntitlement({ platform: IS_IOS ? 'ios' : IS_ANDROID ? 'android' : 'desktop' })
export const { premium, plan, status, onChange } = entitlement
export const tvAllowed = premium
