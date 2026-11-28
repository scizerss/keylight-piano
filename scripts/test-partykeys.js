// The optional PartyKeys "Need a keyboard?" row: when it shows, that its disclosure sits with the button everywhere
// the link is offered, and that the page can open only the one exact address. See renderer/partykeys.js.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')

const renderer = path.join(__dirname, '..', 'renderer')
const read = (name) => fs.readFileSync(path.join(renderer, name), 'utf8')
const load = (name) => import(pathToFileURL(path.join(renderer, name)).href)

;(async () => {
  const { PARTYKEYS_URL, PARTYKEYS_COPY, showInPicker, offerLine, SALE_ENDS } = await load('partykeys.js')
  // the offer line: the Black Friday number while the sale runs, no number after it, never "only on Black Friday"
  assert.equal(offerLine(SALE_ENDS - 1), 'Black Friday deal: code MMDMAGDY takes 5% off.')
  assert.ok(!/\d+%/.test(offerLine(SALE_ENDS)), 'no stale percentage after the sale')
  for (const t of [SALE_ENDS - 1, SALE_ENDS]) assert.ok(!/only|exclusive|ends|last chance/i.test(offerLine(t)), offerLine(t))
  const { validStoredValue } = await load('storage-validation.js')
  const { isAllowedLink } = await load('host-policy.js')
  const desktop = require('../renderer/external-links.cjs')

  assert.equal(PARTYKEYS_URL, 'https://www.partykeys.com/discount/MMDMAGDY?ref=m7md333magdy')
  assert.equal(isAllowedLink(PARTYKEYS_URL), true)
  assert.equal(desktop.isAllowedExternalUrl(PARTYKEYS_URL), true)

  // show / hide: the picker row stays until a MIDI keyboard has connected once; only a real true counts
  assert.equal(showInPicker({}), true)
  assert.equal(showInPicker({ kbMidiSeen: false }), true)
  assert.equal(showInPicker({ kbMidiSeen: true }), true, 'always offered in the picker, also after a keyboard has connected')
  for (const odd of [undefined, null, 'true', 1, {}]) assert.equal(showInPicker({ kbMidiSeen: odd }), true, String(odd))
  assert.equal(showInPicker(undefined), true)
  assert.equal(validStoredValue('lumi.settings', { kbMidiSeen: true }), true)
  assert.equal(validStoredValue('lumi.settings', { kbMidiSeen: 'yes' }), false, 'the saved flag must be a boolean')

  // the words: plain English, no em dash, no claim that the lights work yet
  for (const value of Object.values(PARTYKEYS_COPY)) assert.ok(!/[—–]/.test(value), value)
  assert.match(PARTYKEYS_COPY.body, /light support is in the works/)
  assert.ok(!/lights? (?:work|are supported)|drives? the lights/i.test(PARTYKEYS_COPY.body))
  assert.match(PARTYKEYS_COPY.disclosure, /^Affiliate link: .*commission.*sent a keyboard so Keylight can support it/)

  // the page: two blocks (setup picker, Settings > Your keyboard); each has the title, body, disclosure and the button together
  const html = read('index.html')
  const blocks = html.split('<div class="kb-affiliate').slice(1).map((part) => '<div class="kb-affiliate' + part.slice(0, part.indexOf('</p></div></div>') + 16))
  assert.equal(blocks.length, 2, 'the row is in exactly two places')
  for (const block of blocks) {
    assert.ok(block.includes('>' + PARTYKEYS_COPY.title + '<'), 'title')
    assert.ok(block.includes('>' + PARTYKEYS_COPY.body + '<'), 'body')
    assert.ok(block.includes('data-partykeys-offer>' + offerLine(SALE_ENDS - 1) + '<'), 'offer line, filled again at run time')
    assert.ok(block.includes('>' + PARTYKEYS_COPY.disclosure + '<'), 'disclosure is in the same block as the button')
    assert.ok(block.includes('data-partykeys-open>' + PARTYKEYS_COPY.button + '</button>'), 'button')
    assert.ok(block.indexOf('data-partykeys-open') < block.indexOf(PARTYKEYS_COPY.disclosure), 'disclosure sits next to the button, in the same action row')
    assert.ok(!/hidden|href=/.test(block.replace(/id="\w+"/, '')), 'always visible, and no direct link: it opens through openExternal')
  }
  assert.ok(!html.includes('partykeys.com'), 'the address is not in the page: it comes from partykeys.js through openExternal')
  const at = (needle) => { const i = html.indexOf(needle); assert.ok(i > 0, needle); return i }
  assert.ok(at('id="obPick"') < at('id="obPartyKeys"') && at('id="obPartyKeys"') < at('data-panel="connect"'), 'picker row is under the list, in the pick step')
  assert.ok(html.slice(at('id="obPick"'), at('id="obPartyKeys"')).includes('</div>'), 'not inside the radio group')
  assert.ok(at('id="setKeyboard"') < at('id="setPartyKeys"') && at('id="setPartyKeys"') < at('id="setSound"'), 'Settings row is in the Keyboard card')
  assert.ok(html.slice(at('id="setPartyKeys"'), at('id="setSound"')).includes('</div>\n        </div>'), 'and it closes inside that card')

  // the website: every page with the dated button loads the script that takes the sale line down
  for (const page of fs.readdirSync(path.join(__dirname, '..', 'site-next')).filter((f) => f.endsWith('.html'))) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'site-next', page), 'utf8')
    if (text.includes('data-pk-offer')) assert.ok(text.includes('<script src="pk-offer.js" defer></script>'), page + ' loads pk-offer.js')
  }
  // app.js: opens through openExternal, remembers the first MIDI keyboard, keeps the picker row on show
  const app = read('app.js')
  assert.match(app, /\[data-partykeys-open\][^\n]*openExternal\(PARTYKEYS_URL\)/)
  assert.match(app, /settings\.kbMidiSeen = true/)
  assert.match(app, /kbMidiSeen: false/)
  const pick = app.slice(app.indexOf('function renderPick('), app.indexOf('function chooseKeyboard('))
  const classes = new Set(['x'])
  const row = { classList: { toggle: (name, on) => { on ? classes.add(name) : classes.delete(name) } } }
  const list = { dataset: {}, innerHTML: '' }
  const ctx = vm.createContext({ $: (id) => (id === 'obPick' ? list : row), listProfiles: () => [], glyphSVG: () => '', normalizeChoice: (id) => id, IS_IOS: false, settings: { kbChoice: '' }, showPartyKeysInPicker: showInPicker })
  vm.runInContext(pick, ctx)
  vm.runInContext('renderPick()', ctx)
  assert.equal(classes.has('hidden'), false, 'first run: shown')
  ctx.settings.kbMidiSeen = true
  vm.runInContext('renderPick()', ctx)
  assert.equal(classes.has('hidden'), false, 'after a MIDI keyboard has connected: still shown in the picker')

  console.log('PartyKeys row: show/hide, disclosure with the button in both places, exact address allowed everywhere passed')
})().catch((error) => { console.error(error); process.exitCode = 1 })
