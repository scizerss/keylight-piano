// Run with node scripts/test-reminders.js. The daily practice reminder page logic (renderer/reminders.js) against a fake host and a
// fake page; the Swift side (validation, scheduling plan, permission flow) is tested by xcodebuild test (BridgeMessageTests, ReminderTests).
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const path = require('node:path')
const { readFileSync } = require('node:fs')
const load = (file) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', file)).href)

class El {
  constructor() { this.value = ''; this.textContent = ''; this.classes = new Set(['hidden']); this.onchange = null }
  get classList() { return { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c), contains: (c) => this.classes.has(c), toggle: (c, on) => (on ? this.classes.add(c) : this.classes.delete(c)) } }
}
function fakePage() {
  const els = { reminderRow: new El(), reminderMode: new El(), reminderTime: new El(), reminderNote: new El(), reminderPermission: new El() }
  const listeners = {}
  return { els, listeners, doc: { getElementById: (id) => els[id] || null, addEventListener: (t, f) => { listeners[t] = f } } }
}
const storageOf = (items) => ({ getItem: (k) => (k in items ? JSON.stringify(items[k]) : null) })
const settle = () => new Promise((r) => setTimeout(r, 5))

async function main() {
  const r = await load('reminders.js')
  const now = new Date(2026, 4, 4, 9, 0)
  let tests = 0
  const t = (name, fn) => { tests++; return Promise.resolve(fn()).then(() => console.log('ok  ' + name)) }

  await t('cleanReminder keeps good values and turns odd ones Off', () => {
    assert.deepEqual(r.cleanReminder({ on: true, hour: 7, minute: 5 }), { on: true, hour: 7, minute: 5 })
    for (const bad of [undefined, null, 5, 'x', {}, { on: true }, { on: true, hour: 24, minute: 0 }, { on: true, hour: 7, minute: 60 }, { on: true, hour: '7', minute: 0 }, { on: true, hour: 7.5, minute: 0 }, { on: true, hour: -1, minute: 0 }]) {
      assert.deepEqual(r.cleanReminder(bad), { on: false, hour: 19, minute: 0 }, JSON.stringify(bad))
    }
    assert.equal(r.cleanReminder({ on: 'yes', hour: 7, minute: 5 }).on, false)
  })

  await t('parseTime and formatTime', () => {
    assert.deepEqual(r.parseTime('07:05'), { hour: 7, minute: 5 })
    assert.deepEqual(r.parseTime('23:59'), { hour: 23, minute: 59 })
    assert.deepEqual(r.parseTime('00:00:30'), { hour: 0, minute: 0 })
    for (const bad of ['', '24:00', '12:60', '7:05', 'ab:cd', null, undefined, '12']) assert.equal(r.parseTime(bad), null, String(bad))
    assert.equal(r.formatTime(7, 5), '07:05')
  })

  await t('practisedToday reads the streak day and the minutes played', () => {
    assert.equal(r.dayKey(now), '2026-05-04')
    assert.equal(r.practisedToday(storageOf({}), now), false)
    assert.equal(r.practisedToday(storageOf({ 'lumi.streak.last': '2026-05-03' }), now), false)
    assert.equal(r.practisedToday(storageOf({ 'lumi.streak.last': '2026-05-04' }), now), true)
    assert.equal(r.practisedToday(storageOf({ 'lumi.days': { '2026-05-04': 90 } }), now), true)
    assert.equal(r.practisedToday(storageOf({ 'lumi.days': { '2026-05-04': 0, '2026-05-03': 600 } }), now), false)
    assert.equal(r.practisedToday({ getItem: () => '{broken' }, now), false)
    assert.equal(r.practisedToday({ getItem: () => { throw new Error('blocked') } }, now), false)
  })

  await t('syncReminder: Off clears a stale schedule, denied turns Off, in place does not reschedule', async () => {
    const calls = []
    const host = (status) => async (op, args) => { calls.push([op, args]); return op === 'reminderStatus' ? status : { ...status, authorized: true, scheduled: true } }
    assert.deepEqual(await r.syncReminder({ reminder: { on: false, hour: 7, minute: 0 }, request: host({}), practised: false }), { on: false, denied: false })
    assert.deepEqual(calls.map((c) => c[0]), ['reminderStatus'])
    calls.length = 0
    assert.deepEqual(await r.syncReminder({ reminder: { on: false }, request: host({ scheduled: true }), practised: false }), { on: false, denied: false })
    assert.deepEqual(calls.map((c) => c[0]), ['reminderStatus', 'reminderClear'])
    calls.length = 0
    assert.deepEqual(await r.syncReminder({ reminder: { on: true, hour: 7, minute: 0 }, request: host({ authorized: false, scheduled: false }), practised: false }), { on: false, denied: true })
    assert.deepEqual(calls.map((c) => c[0]), ['reminderStatus'])
    calls.length = 0
    const inPlace = { authorized: true, scheduled: true, hour: 7, minute: 0, skipping: false }
    assert.deepEqual(await r.syncReminder({ reminder: { on: true, hour: 7, minute: 0 }, request: host(inPlace), practised: false }), { on: true, denied: false })
    assert.deepEqual(calls.map((c) => c[0]), ['reminderStatus'])
  })

  await t('syncReminder reschedules when missing, moved, skipping, or practised today', async () => {
    const run = async (status, practised) => {
      const calls = []
      const request = async (op, args) => { calls.push([op, args]); return op === 'reminderStatus' ? status : { authorized: true } }
      await r.syncReminder({ reminder: { on: true, hour: 7, minute: 30 }, request, practised })
      return calls.filter((c) => c[0] === 'reminderSet').map((c) => c[1])
    }
    const base = { authorized: true, scheduled: true, hour: 7, minute: 30, skipping: false }
    assert.deepEqual(await run({ ...base, scheduled: false, hour: null, minute: null }, false), [{ hour: 7, minute: 30, skipToday: false }])
    assert.deepEqual(await run({ ...base, hour: 8 }, false), [{ hour: 7, minute: 30, skipToday: false }])
    assert.deepEqual(await run({ ...base, skipping: true }, false), [{ hour: 7, minute: 30, skipToday: false }])
    assert.deepEqual(await run(base, true), [{ hour: 7, minute: 30, skipToday: true }])
  })

  await t('mountReminders stays out of the way outside iOS', async () => {
    const p = fakePage()
    assert.equal(await r.mountReminders({ settings: {}, save() {}, doc: p.doc, isIOS: false, request: async () => { throw new Error('no') } }), null)
    assert.ok(p.els.reminderRow.classes.has('hidden'))
  })

  await t('mountReminders: turn On, permission granted, saved', async () => {
    const p = fakePage(), settings = {}, saved = [], calls = []
    const request = async (op, args, timeout) => { calls.push(timeout === undefined ? [op, args] : [op, args, timeout]); return op === 'reminderStatus' ? { authorized: true, scheduled: false } : { authorized: true, scheduled: true, hour: args?.hour, minute: args?.minute, skipping: false } }
    const mounted = await r.mountReminders({ settings, save: () => saved.push(JSON.stringify(settings.reminder)), doc: p.doc, isIOS: true, request, storage: storageOf({}) })
    assert.ok(mounted)
    await settle()
    assert.ok(!p.els.reminderRow.classes.has('hidden'))
    assert.equal(p.els.reminderMode.value, 'off')
    assert.ok(p.els.reminderTime.classes.has('hidden'))
    assert.deepEqual(calls, [['reminderStatus', undefined]])
    p.els.reminderMode.value = 'on'; p.els.reminderTime.value = '18:45'
    p.els.reminderMode.onchange(); await settle()
    assert.deepEqual(calls.at(-1), ['reminderSet', { hour: 18, minute: 45, skipToday: false }, 600000])
    assert.deepEqual(settings.reminder, { on: true, hour: 18, minute: 45 })
    assert.ok(!p.els.reminderTime.classes.has('hidden'))
    assert.ok(p.els.reminderNote.classes.has('hidden'))
    // changing the time reschedules
    p.els.reminderTime.value = '20:00'; p.els.reminderTime.onchange(); await settle()
    assert.deepEqual(calls.at(-1)[1], { hour: 20, minute: 0, skipToday: false })
    assert.equal(settings.reminder.hour, 20)
    // turning Off clears
    p.els.reminderMode.value = 'off'; p.els.reminderMode.onchange(); await settle()
    assert.equal(calls.at(-1)[0], 'reminderClear')
    assert.equal(settings.reminder.on, false)
    assert.equal(JSON.parse(saved.at(-1)).on, false)
  })

  await t('mountReminders: permission denied shows the plain line and goes back to Off', async () => {
    const p = fakePage(), settings = {}
    const request = async (op) => (op === 'reminderStatus' ? { authorized: false } : { authorized: false, scheduled: false })
    await r.mountReminders({ settings, save() {}, doc: p.doc, isIOS: true, request, storage: storageOf({}) })
    p.els.reminderMode.value = 'on'; p.els.reminderMode.onchange(); await settle()
    assert.equal(settings.reminder.on, false)
    assert.equal(p.els.reminderMode.value, 'off')
    assert.equal(p.els.reminderNote.textContent, 'Notifications are off for Keylight. Turn them on in the Settings app.')
    assert.ok(!p.els.reminderNote.classes.has('hidden'))
    assert.ok(p.els.reminderTime.classes.has('hidden'))
    assert.ok(!/—|–/.test(r.DENIED))
  })

  await t('mountReminders: restored On waits for a permission button tap', async () => {
    const p = fakePage(), settings = { reminder: { on: true, hour: 6, minute: 15 } }, calls = []
    const request = async (op) => {
      calls.push(op)
      return op === 'reminderStatus' ? { authorization: 'notDetermined', authorized: false } : { authorized: true }
    }
    await r.mountReminders({ settings, doc: p.doc, isIOS: true, request, storage: storageOf({}) })
    await settle()
    assert.deepEqual(calls, ['reminderStatus'])
    assert.equal(settings.reminder.on, true)
    assert.ok(!p.els.reminderPermission.classes.has('hidden'))
    assert.ok(p.els.reminderNote.classes.has('hidden'))
    await p.els.reminderPermission.onclick()
    assert.deepEqual(calls, ['reminderStatus', 'reminderSet'])
    assert.ok(p.els.reminderPermission.classes.has('hidden'))
    assert.equal(settings.reminder.on, true)
  })

  await t('mountReminders: relaunch re-syncs a saved On, and skips today once practised', async () => {
    const p = fakePage(), settings = { reminder: { on: true, hour: 6, minute: 15 } }, calls = []
    let status = { authorized: true, scheduled: false }
    const request = async (op, args) => { calls.push([op, args]); return op === 'reminderStatus' ? status : { authorized: true, scheduled: true } }
    const today = new Date()
    const mounted = await r.mountReminders({ settings, save() {}, doc: p.doc, isIOS: true, request, storage: storageOf({}) })
    await settle()
    assert.equal(p.els.reminderMode.value, 'on')
    assert.equal(p.els.reminderTime.value, '06:15')
    assert.deepEqual(calls.filter((c) => c[0] === 'reminderSet').map((c) => c[1]), [{ hour: 6, minute: 15, skipToday: false }])   // nothing was scheduled: rescheduled
    calls.length = 0
    status = { authorized: true, scheduled: true, hour: 6, minute: 15, skipping: false }
    p.listeners.visibilitychange(); await settle()
    assert.deepEqual(calls.map((c) => c[0]), ['reminderStatus'])                               // in place: only a look
    // practised today: the next look asks the host to skip today
    const p2 = fakePage(), calls2 = []
    await r.mountReminders({ settings: { reminder: { on: true, hour: 6, minute: 15 } }, save() {}, doc: p2.doc, isIOS: true,
      request: async (op, args) => { calls2.push([op, args]); return op === 'reminderStatus' ? status : { authorized: true } },
      storage: storageOf({ 'lumi.streak.last': r.dayKey(today) }) })
    await settle()
    assert.deepEqual(calls2.filter((c) => c[0] === 'reminderSet').map((c) => c[1]), [{ hour: 6, minute: 15, skipToday: true }])
    assert.ok(mounted.sync)
  })

  await t('mountReminders: notifications switched off in iOS Settings turn the row Off on launch', async () => {
    const p = fakePage(), settings = { reminder: { on: true, hour: 6, minute: 15 } }
    await r.mountReminders({ settings, save() {}, doc: p.doc, isIOS: true, request: async () => ({ authorized: false }), storage: storageOf({}) })
    await settle()
    assert.equal(settings.reminder.on, false)
    assert.equal(p.els.reminderNote.textContent, r.DENIED)
  })

  await t('the Settings row is in index.html and hidden by default; the bundle copies reminders.js', () => {
    const html = readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8')
    const card = html.slice(html.indexOf('id="setPractice"'), html.indexOf('id="setDisplay"'))
    for (const id of ['reminderRow', 'reminderMode', 'reminderTime', 'reminderNote']) assert.ok(card.includes('id="' + id + '"'), id)
    assert.match(card, /id="reminderRow"[^>]*class="setting hidden"|class="setting hidden" id="reminderRow"/)
    assert.ok(!/—/.test(card))
  })

  console.log(`reminders: ${tests} tests, 0 failures`)
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
