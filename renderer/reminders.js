// Optional daily practice reminder (iPhone/iPad app only). The Swift host schedules a local notification (ios/Keylight/Reminders.swift)
// over the reminderSet / reminderClear / reminderStatus bridge requests; this file is the Settings row, the saved choice
// (settings.reminder = { on, hour, minute }) and the "already practised today" hint, which skips today's notification.
// Off by default. Nothing here runs on Mac, Windows or Android: the row stays hidden.

export const DENIED = 'Notifications are off for Keylight. Turn them on in the Settings app.'
export const DEFAULT_TIME = { hour: 19, minute: 0 }
// The system asks for permission on the first request, and the person may take a while to answer it.
const ASK_MS = 10 * 60 * 1000

const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null)

/** The saved choice, cleaned: anything odd means Off at the default time. */
export function cleanReminder(value) {
  const r = value && typeof value === 'object' ? value : {}
  const hour = int(r.hour, 0, 23), minute = int(r.minute, 0, 59)
  return hour === null || minute === null ? { on: false, ...DEFAULT_TIME } : { on: r.on === true, hour, minute }
}

/** "07:05" from an <input type="time"> value; null when it is not a time. */
export function parseTime(text) {
  const m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(String(text || ''))
  if (!m) return null
  const hour = int(Number(m[1]), 0, 23), minute = int(Number(m[2]), 0, 59)
  return hour === null || minute === null ? null : { hour, minute }
}
export const formatTime = (hour, minute) => String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0')

// Local calendar day as YYYY-MM-DD, the same keys app.js uses for lumi.days and lumi.streak.last.
export const dayKey = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')

/** True when the player has already practised today (app.js writes lumi.streak.last and lumi.days when it counts playing time). */
export function practisedToday(storage, now = new Date()) {
  const today = dayKey(now)
  const read = (key) => { try { const raw = storage.getItem(key); return raw == null ? null : JSON.parse(raw) } catch { return null } }
  if (read('lumi.streak.last') === today) return true
  const days = read('lumi.days')
  return !!days && typeof days === 'object' && Number(days[today]) > 0
}

/**
 * Brings the system's schedule in line with the saved choice. Returns { on, denied }: on is what the choice should now be.
 * Reschedules only when something differs (or when today is skipped, since the one-time requests must be made again each day).
 */
export async function syncReminder({ reminder, request, practised }) {
  const r = cleanReminder(reminder)
  const status = await request('reminderStatus')
  if (!r.on) {
    if (status?.scheduled) await request('reminderClear')
    return { on: false, denied: false }
  }
  if (status?.authorization === 'notDetermined') return { on: true, denied: false, needsPermission: true }
  if (!status || status.authorized !== true) return { on: false, denied: true }
  const inPlace = status.scheduled && status.hour === r.hour && status.minute === r.minute && !status.skipping
  if (practised || !inPlace) {
    const set = await request('reminderSet', { hour: r.hour, minute: r.minute, skipToday: practised }, ASK_MS)
    if (!set || set.authorized !== true) return { on: false, denied: true }
  }
  return { on: true, denied: false }
}

/**
 * Wires the Settings row (#reminderRow) and keeps the schedule in sync. Add to app.js once settings and saveSettings exist:
 *   mountReminders({ settings, save: saveSettings })
 * The extras are for tests. Resolves to { sync, row } once the page is wired (nothing is wired outside the iPhone/iPad app).
 */
export async function mountReminders({ settings, save, request, storage, doc, isIOS, notice } = {}) {
  const d = doc || (typeof document !== 'undefined' ? document : null)
  if (!d || !settings) return null
  if (isIOS === undefined) { try { isIOS = (await import('./platform.js')).IS_IOS } catch { isIOS = false } }
  if (!isIOS) return null
  const row = d.getElementById('reminderRow')
  const mode = d.getElementById('reminderMode'), time = d.getElementById('reminderTime'), note = d.getElementById('reminderNote')
  const permission = d.getElementById('reminderPermission')
  if (!row || !mode || !time) return null
  if (!request) {
    const { nativeRequest } = await import('./ios-midi.js')
    request = (op, args, timeout) => nativeRequest(op, args, timeout)
  }
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : { getItem: () => null })
  const practised = () => practisedToday(store)

  settings.reminder = cleanReminder(settings.reminder)
  const show = (message = '', needsPermission = false) => {
    mode.value = settings.reminder.on ? 'on' : 'off'
    time.value = formatTime(settings.reminder.hour, settings.reminder.minute)
    time.classList.toggle('hidden', !settings.reminder.on)
    if (note) { note.textContent = message; note.classList.toggle('hidden', !message) }
    permission?.classList.toggle('hidden', !needsPermission)
  }
  const turnOff = (message) => { settings.reminder = { ...settings.reminder, on: false }; save?.(); show(message) }
  row.classList.remove('hidden')
  show()

  let queue = Promise.resolve()          // one request at a time, in the order the person made them
  const run = (job) => (queue = queue.then(job, job))
  async function apply() {
    try {
      const result = await syncReminder({ reminder: settings.reminder, request, practised: practised() })
      if (!result.on && settings.reminder.on) turnOff(result.denied ? DENIED : 'The reminder could not be set. Try again.')
      else permission?.classList.toggle('hidden', !result.needsPermission)
    } catch {
      if (settings.reminder.on) notice?.('The reminder could not be updated')
    }
  }
  async function change() {
    const wasOn = settings.reminder.on
    if (mode.value === 'on') {
      const t = parseTime(time.value) || settings.reminder
      settings.reminder = { on: true, hour: t.hour, minute: t.minute }
      save?.(); show()
      try {
        // asked directly (not through syncReminder): this is the moment the system may ask for permission
        const set = await request('reminderSet', { hour: t.hour, minute: t.minute, skipToday: practised() }, ASK_MS)
        if (!set || set.authorized !== true) turnOff(DENIED)
      } catch { turnOff('The reminder could not be set. Try again.') }
    } else {
      settings.reminder = { ...settings.reminder, on: false }
      save?.(); show()
      if (wasOn) { try { await request('reminderClear') } catch { /* nothing was scheduled that we can reach */ } }
    }
  }
  mode.onchange = () => run(change)
  time.onchange = () => { if (settings.reminder.on) run(change) }
  if (permission) permission.onclick = () => run(change)

  const sync = () => run(apply)
  // Practising happens while the page is shown, and the day rolls over while it is away: look again both when it leaves and when it returns.
  d.addEventListener?.('visibilitychange', sync)
  sync()
  return { sync: () => run(apply), row }
}
