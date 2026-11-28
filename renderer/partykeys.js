// The optional "Need a keyboard?" row: an affiliate link to PartyKeys, shown in the first-run keyboard picker and in
// Settings > Your keyboard. It is always disclosed (the disclosure sits next to the button, in the same block), never
// preselected and never blocks Continue or Skip. The markup lives in index.html (#obPartyKeys, #setPartyKeys); the
// words below are the single source, and scripts/test-partykeys.js checks the page carries exactly these words.
// Where PartyKeys may be named in the iPhone and iPad app: this row only, which sits in keyboard context (AGENTS.md).
// Not claimed: light support. Keylight treats PartyKeys as "Another MIDI keyboard" (notes only) until that is built.

// The exact address; the same string is in host-policy.js, external-links.cjs, LinkPolicy.java and LinkPolicy.swift.
export const PARTYKEYS_URL = 'https://www.partykeys.com/discount/MMDMAGDY?ref=m7md333magdy'

export const PARTYKEYS_COPY = Object.freeze({
  title: 'Need a keyboard?',
  body: 'PartyKeys makes a 36-key keyboard with lights in every key. It works with Keylight over USB or Bluetooth, and light support is in the works.',
  disclosure: "Affiliate link: Keylight's developer earns a small commission. PartyKeys sent a keyboard so Keylight can support it.",
  button: 'See PartyKeys'
})

// The code's offer line, filled in at run time so a build never shows a stale deal. During PartyKeys' Black Friday sale
// the code takes 5% off (owner, 2026-11-23); after it, the line names no number until the owner confirms the new one.
// Honest urgency only: the sale ends, the code does not, so never say the code is only for Black Friday.
export const SALE_ENDS = new Date(2026, 11, 1).getTime()   // 1 Dec 2026, local midnight: after Cyber Monday
export function offerLine(now = Date.now()) {
  return now < SALE_ENDS ? 'Black Friday deal: code MMDMAGDY takes 5% off.' : 'Code MMDMAGDY takes money off at checkout.'
}

/**
 * The picker always shows the row, under a hairline below the choices (the owner asked for it to stay; it used to hide
 * once a MIDI keyboard had connected). Settings always shows it too. Kept as a function so the rule has one home.
 */
export function showInPicker(_settings) {
  return true
}
