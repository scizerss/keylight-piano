const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { runInNewContext } = require('node:vm')

;(async () => {
  globalThis.location = { search: '?platform=mac' }
  const { createEntitlement, ENTITLEMENT_CACHE_KEY, tvAllowed } = await import('../renderer/entitlement.js')
  const { nativeRequest } = await import('../renderer/android-midi.js')
  const { createBackup, readBackup } = await import('../renderer/backup-format.js')
  const { premiumStatusText } = await import('../renderer/paywall.js')
  const { BETA_NOTICE_SEEN_KEY, mountBetaNotice } = await import('../renderer/beta-notice.js')
  const values = new Map()
  const storage = {
    get length() { return values.size },
    key: (i) => [...values.keys()][i],
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  }
  const fail = () => assert.fail('Unscheduled store operation')
  const desktop = createEntitlement({ platform: 'desktop', listen: fail, request: fail, getStorage: fail })
  const android = createEntitlement({ platform: 'android', listen: fail, request: fail, getStorage: fail })
  // the launch switch off (the default until App Store Connect is set up): iPhone/iPad are unlocked like desktop
  const iosOff = createEntitlement({ platform: 'ios', iosPaywall: false, listen: fail, request: fail, getStorage: fail })
  assert.equal(iosOff.premium(), true, 'iOS with the paywall switched off is unlocked')
  assert.equal(desktop.premium(), true)
  assert.equal(tvAllowed(), true)
  assert.equal(android.premium(), true)
  assert.equal(android.available, false)
  assert.equal(android.status().active, false)
  await assert.rejects(android.products(), /not available yet/)
  assert.equal(values.size, 0)

  const beta = createEntitlement({ platform: 'ios', iosPaywall: true, beta: true, listen: fail, request: fail, getStorage: fail })
  assert.equal(beta.premium(), true, 'beta unlocks content even when the paywall switch is on')
  assert.equal(beta.available, false, 'beta hides the Premium settings')
  assert.equal((await beta.refresh()).active, false)
  for (const call of [beta.products, () => beta.buy('yearly'), beta.restore, beta.manage]) {
    await assert.rejects(call(), /Purchases are unavailable/)
  }
  beta.dispose()

  class Dialog extends EventTarget {
    open = false
    openings = 0
    showModal() { assert.equal(this.open, false); this.open = true; this.openings++ }
    close() { this.open = false; this.dispatchEvent(new Event('close')) }
  }
  const dialog = new Dialog()
  const row = { classList: new Set(['hidden']) }
  row.classList.remove = (name) => row.classList.delete(name)
  const description = {}
  const elements = { betaNotice: dialog, openBetaNotice: row, betaNoticeText: description }
  globalThis.document = { getElementById: (id) => elements[id] }
  const noticeStore = {
    get: (key, fallback) => JSON.parse(storage.getItem(key)) ?? fallback,
    set: (key, value) => storage.setItem(key, JSON.stringify(value))
  }
  try {
    const production = mountBetaNotice({ beta: false, store: { get: fail, set: fail } })
    assert.equal(production(), undefined)
    assert.equal(row.classList.has('hidden'), true)
    const showOnce = mountBetaNotice({ beta: true, store: noticeStore })
    assert.equal(row.classList.has('hidden'), false)
    assert.match(description.textContent, /29\.99 USD a year or 4\.99 USD a month/)
    assert.match(description.textContent, /89\.99 USD for Lifetime\./)
    const dismissal = showOnce()
    assert.equal(dialog.openings, 1)
    assert.equal(showOnce(), undefined, 'an open notice is not shown again')
    assert.equal(storage.getItem(BETA_NOTICE_SEEN_KEY), null, 'opening does not mark the notice seen')
    dialog.close()
    await dismissal
    assert.equal(storage.getItem(BETA_NOTICE_SEEN_KEY), 'true')
    assert.equal(showOnce(), undefined)
    const relaunch = mountBetaNotice({ beta: true, store: noticeStore })
    assert.equal(relaunch(), undefined, 'the saved dismissal survives relaunch')
    const reopened = row.onclick()
    assert.equal(dialog.openings, 2, 'Settings reopens a dismissed notice')
    dialog.close()
    await reopened
  } finally {
    delete globalThis.document
  }

  const now = Date.UTC(2026, 10, 23)
  const trial = { active: true, plan: 'yearly', expires: now + 604800000, inTrial: true, willRenew: true }
  const lifetime = { active: true, plan: 'lifetime', expires: null, lifetime: true }
  const inactive = { active: false }
  const comparePlans = [{ plan: 'yearly', price: '299,00 kr', period: 'year', introEligible: true, introText: '7 days free' }]
  let listener, statusReply, buyReply
  const iOS = { iosPaywall: true,
    platform: 'ios', now: () => now, getStorage: () => storage,
    listen(fn) { listener = fn; return () => { listener = null } },
    async request(op, args, timeout) {
      switch (op) {
        case 'storeStatus': return new Promise((resolve) => { statusReply = resolve })
        case 'storeProducts': return comparePlans
        case 'storeBuy':
          assert.deepEqual(args, { plan: 'yearly' })
          assert.equal(timeout, 0)
          return buyReply
        case 'storeRestore':
          assert.equal(timeout, 0)
          return lifetime
        case 'storeManage': return true
        default: return fail()
      }
    }
  }
  storage.setItem(ENTITLEMENT_CACHE_KEY, JSON.stringify(trial))
  const store = createEntitlement(iOS)
  assert.equal(store.premium(), true, 'cached unexpired trial paints before the bridge replies')
  assert.equal(store.plan(), 'yearly')
  assert.match(premiumStatusText(store.status()), /^Trial ends on /)
  let changes = 0
  const unsubscribe = store.onChange(() => changes++)
  const refresh = store.refresh()
  listener({ kind: 'store', ...inactive })
  statusReply(trial)
  await refresh
  assert.equal(store.premium(), false, 'newer native refund wins over the startup reply')
  assert.equal(store.plan(), null)
  assert.equal(changes, 1)
  listener({ kind: 'store', ...inactive })
  listener({ kind: 'ports', ...trial })
  assert.equal(changes, 1, 'duplicates and unrelated bridge events do not redraw')

  assert.deepEqual(await store.products(), comparePlans)
  for (const result of ['pending', 'cancelled', 'failed']) {
    buyReply = { result, status: inactive }
    assert.equal(await store.buy('yearly'), result)
    assert.equal(store.premium(), false)
  }
  await assert.rejects(store.buy('keylight.premium.yearly'), /Unknown purchase plan/)
  buyReply = { result: 'purchased', status: trial }
  assert.equal(await store.buy('yearly'), 'purchased')
  assert.equal(store.premium(), true)
  listener({ kind: 'store', ...trial, inTrial: false })
  assert.match(premiumStatusText(store.status()), /^Renews on /)
  listener({ kind: 'store', ...trial, inTrial: false, willRenew: false, inGrace: true })
  assert.equal(store.premium(), true, 'verified billing grace retains access')
  listener({ kind: 'store', ...trial, inTrial: false, willRenew: false })
  assert.match(premiumStatusText(store.status()), /^Access ends on /)
  listener({ kind: 'store', ...inactive })
  assert.equal(premiumStatusText(store.status()), 'Not active')
  assert.equal((await store.restore()).lifetime, true)
  assert.equal(store.plan(), 'lifetime')
  assert.equal(premiumStatusText(store.status()), 'Lifetime access')
  assert.equal(await store.manage(), true)
  unsubscribe()
  store.dispose()
  assert.equal(listener, null)

  assert.ok(!ENTITLEMENT_CACHE_KEY.startsWith('lumi.'))
  storage.setItem('lumi.settings', '{}')
  const backup = await createBackup({ storage, songs: [] })
  const decoded = await readBackup(backup.blob)
  assert.deepEqual(decoded.storage, { 'lumi.settings': '{}', [BETA_NOTICE_SEEN_KEY]: 'true' })
  storage.setItem(ENTITLEMENT_CACHE_KEY, JSON.stringify({ ...trial, expires: now }))
  const expired = createEntitlement(iOS)
  assert.equal(expired.premium(), false, 'an expired cache grants no local grace period')
  listener({ kind: 'store', ...inactive })
  assert.equal(JSON.parse(storage.getItem(ENTITLEMENT_CACHE_KEY)).active, false, 'native status replaces the stale cache')
  expired.dispose()
  assert.doesNotThrow(() => createEntitlement({ ...iOS, getStorage: () => { throw new Error('disabled') } }).dispose())

  const realSetTimeout = globalThis.setTimeout
  try {
    globalThis.setTimeout = () => fail()
    globalThis.KeylightNative = { postMessage(raw) {
      const { id, op } = JSON.parse(raw)
      globalThis.__keylightNativeReceive({ id, result: op })
    } }
    assert.equal(await nativeRequest('storeRestore', {}, 0), 'storeRestore', 'native RPC schedules no timer at timeout 0')
  } finally {
    globalThis.setTimeout = realSetTimeout
    delete globalThis.KeylightNative
  }

  const app = readFileSync(require.resolve('../renderer/app.js'), 'utf8')
  const slice = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)))
  const testGate = slice('const STARTER_SONGS', 'const LIBRARY')
    + slice('async function openLibrary(', 'async function openImported(')
  let offers = 0, readFile = null, unlocked = false
  const openLibrary = runInNewContext(testGate + '\n;openLibrary', {
    premium: () => unlocked, openPaywall: async () => { offers++; return unlocked },
    fetchLibraryFile: (file) => { readFile = file; return file }, loadSongFile: async () => ({}),
    LIBRARY: [], pushRecent: () => {}, startSong: () => {},
    LESSONS: [{ file: 'c-major-scale.xml' }, { file: 'ode-to-joy.xml' }]   // every built-in lesson's song is free
  })
  await openLibrary('twinkle.xml')
  assert.equal(readFile, 'twinkle.xml')
  await openLibrary('mary-had-a-little-lamb.xml')
  assert.equal(readFile, 'mary-had-a-little-lamb.xml')
  await openLibrary('c-major-scale.xml')
  assert.equal(readFile, 'c-major-scale.xml', 'a song the built-in lessons play is free')
  await openLibrary('fur-elise.xml')
  assert.equal(readFile, 'c-major-scale.xml', 'a song outside the free set still opens the paywall')
  assert.equal(offers, 1)
  unlocked = true
  await openLibrary('fur-elise.xml')
  assert.equal(readFile, 'fur-elise.xml')
  console.log('entitlement: beta bypass and notice, platform adapters, purchase and restore, native updates, backup isolation and page gates passed')
})().catch((error) => { console.error(error); process.exitCode = 1 })
