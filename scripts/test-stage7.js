// Run with node scripts/test-stage7.js. The keyboard picker's data, the settings search matching, and the haptics module (a no-op off iOS).
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const url = (f) => pathToFileURL(path.join(__dirname, '..', 'renderer', f)).href

function testTVSearch(mountSettingsSearch) {
  const element = (textContent = '', classes = []) => {
    const flags = new Set(classes)
    return { textContent, children: [], matches: () => false, getAttribute: () => null, classList: {
      contains: (flag) => flags.has(flag),
      toggle: (flag, on) => on ? flags.add(flag) : flags.delete(flag)
    } }
  }
  const unlock = element('Unlock TV mode'), delay = element('TV picture delay'), sound = element('Piano sound')
  const notice = { ...element('', ['hidden']), children: [unlock] }
  const controls = { ...element(), children: [delay, sound] }
  const groups = [notice, controls]
  const card = { ...element(), querySelector: (sel) => sel === 'h3, summary' ? element('TV') : groups[0],
    querySelectorAll: () => groups }
  const none = element()
  const elements = {
    settingsSearch: { addEventListener() {} }, 'screen-settings': { querySelectorAll: () => [card] }, settingsNoMatch: none
  }
  const { filter } = mountSettingsSearch({ getElementById: (id) => elements[id] })
  const off = (el) => el.classList.contains('s-off')
  const noMatch = () => !none.classList.contains('hidden')

  filter('picture delay')
  assert.ok(!off(card) && !off(delay) && off(sound) && !noMatch(), 'Premium users find controls in the second group')
  filter('unlock')
  assert.ok(off(card) && noMatch(), 'the hidden upgrade row does not match')

  notice.classList.toggle('hidden', false)
  controls.classList.toggle('hidden', true)
  filter('picture delay')
  assert.ok(off(card) && noMatch(), 'locked controls do not match')
  filter('unlock')
  assert.ok(!off(card) && !off(unlock) && !noMatch() && controls.classList.contains('hidden'))
  filter('')
  assert.ok(!off(card) && !off(unlock) && !noMatch() && controls.classList.contains('hidden'))
}

async function main() {
  globalThis.location = { search: '' }
  const profiles = await import(url('keyboard-profiles.js'))
  const list = profiles.listProfiles()
  assert.deepEqual(list.map((p) => p.id), ['roli', 'partykeys', 'midi', 'screen'], 'one ROLI or LUMI card (the app works out 24, 48 or 49 keys), then PartyKeys')
  assert.deepEqual(profiles.listProfiles(true).map((p) => p.id), ['screen', 'roli', 'partykeys', 'midi'])
  for (const p of list) assert.ok(p.name && p.sub && p.detail && p.glyph, p.id + ' has a name, a line and a glyph')
  assert.deepEqual(list.map((p) => p.keys), [0, 0, 0, null], 'keyboards stay on Automatic; the on-screen keys leave the count alone')
  assert.equal(profiles.profileById('screen').keys, null, 'on-screen only leaves the key count alone')
  list[0].name = 'changed'
  assert.notEqual(profiles.listProfiles()[0].name, 'changed', 'listProfiles hands out copies')
  assert.deepEqual(profiles.stepsFor('screen'), ['pick'])
  assert.deepEqual(profiles.stepsFor('midi'), ['pick', 'connect', 'ready'])
  assert.deepEqual(profiles.stepsFor('partykeys'), ['pick', 'connect', 'ready'])
  assert.deepEqual(profiles.stepsFor('other'), ['pick', 'connect', 'ready'], 'old id')
  assert.deepEqual(profiles.stepsFor('lumi24'), ['pick', 'connect', 'ready'], 'old id')
  for (const p of list) assert.match(profiles.glyphSVG(p.glyph), /^<svg /)

  const { matchUnits, mountSettingsSearch } = await import(url('settings-search.js'))
  const units = [{ text: 'Count-in', kw: 'metronome click beat' }, { text: 'Master volume' }, { text: 'Wait mode' }]
  assert.deepEqual(matchUnits(units, 'metronome'), [true, false, false], 'a keyword finds the row')
  assert.deepEqual(matchUnits(units, ' VOL '), [false, true, false], 'case and spaces are ignored')
  assert.deepEqual(matchUnits(units, ''), [true, true, true])
  testTVSearch(mountSettingsSearch)

  const { haptic, hapticSequence, HAPTIC_KINDS } = await import(url('haptics.js'))
  assert.equal(HAPTIC_KINDS.length, 8)
  assert.doesNotThrow(() => { haptic('select'); haptic('nonsense'); hapticSequence([['success', 0]]) }, 'off iOS every call is a quiet no-op')
  console.log('stage 7: keyboard profiles, settings search matching and haptics no-op pass')
}
main().catch((e) => { console.error(e); process.exit(1) })
