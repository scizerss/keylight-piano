// Unit tests for the one text sanitiser used by the device report and the USB probe. node scripts/test-sanitize-text.js
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

let n = 0
const eq = (actual, expected, msg) => { n++; assert.equal(actual, expected, msg) }

;(async () => {
  const M = await import(pathToFileURL(path.join(__dirname, '..', 'renderer/sanitize-text.js')).href)
  const sanitizeText = M.sanitizeText
  eq(typeof sanitizeText, 'function', 'sanitizeText is exported')

  // ---------- control characters ----------
  eq(sanitizeText('a\u0001b\u001fc'), 'a b c', 'C0 control chars become spaces')
  eq(sanitizeText('\u0000x'), 'x', 'NUL dropped (then trimmed)')
  eq(sanitizeText('a\u007fb'), 'a b', 'DEL becomes a space')
  eq(sanitizeText('a\u000Bb'), 'a b', 'vertical tab becomes a space')

  // ---------- bidi controls / invisible format characters: stripped before redaction ----------
  eq(sanitizeText('ab\u202Ecd'), 'abcd', 'RLO bidi override removed')
  eq(sanitizeText('a\u2066b\u2069c'), 'abc', 'bidi isolates removed')
  eq(sanitizeText('a\u061Cb'), 'ab', 'Arabic letter mark removed')
  eq(sanitizeText('ja\u200Bne here'), 'jane here', 'zero-width space removed')
  eq(sanitizeText('a\u200Db\u2060c'), 'abc', 'a joiner next to Latin letters and a word joiner are removed')
  eq(sanitizeText('a\uFEFFb'), 'ab', 'a BOM inside the text is removed, not turned into a space')
  eq(sanitizeText('a\u00ADb\u034Fc'), 'abc', 'soft hyphen and combining grapheme joiner removed')
  eq(sanitizeText('a\u{E0061}b'), 'ab', 'tag characters removed')
  const named = sanitizeText("Jane's iPad")
  assert.ok(!/Jane/.test(named), 'baseline: the owner name is redacted')
  for (const hidden of ['Ja\u200Bne', 'Ja\uFEFFne', 'Ja\u00ADne', 'Ja\u{E0061}ne', 'Jane\u061C']) {
    eq(sanitizeText(hidden + "'s iPad"), named, 'an invisible character cannot hide a name from the redaction: ' + JSON.stringify(hidden))
  }
  eq(sanitizeText('\u{1F468}\u200D\u{1F469}\u200D\u{1F467} iPad'), '\u{1F468}\u200D\u{1F469}\u200D\u{1F467} iPad', 'an emoji family keeps its joiners')
  eq(sanitizeText('\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645'), '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645', 'a Persian word keeps its zero-width non-joiner')
  eq(sanitizeText('a\u009Bb'), 'a b', 'a C1 control becomes a space')
  eq(sanitizeText('a\u2028b', 80, { keepLines: true }), 'a\nb', 'a line separator is a line break in a note')
  eq(sanitizeText('a\u2028b'), 'a b', 'a line separator is a space in a one-line text')
  eq(sanitizeText('\u0645\u200C\u009B'), '\u0645', 'a joiner left dangling by a control character goes')

  // ---------- whitespace ----------
  eq(sanitizeText('  a \t\n\n  b   c  '), 'a b c', 'all whitespace collapses to one space, ends trimmed')

  // ---------- keepLines ----------
  eq(sanitizeText('  a \t\n\n\n\n  b   c  ', 80, { keepLines: true }), 'a\n\nb c', 'keepLines keeps breaks, trims lines, caps blank runs')
  eq(sanitizeText('a\r\nb\rc', 80, { keepLines: true }), 'a\nb\nc', 'keepLines normalises CRLF and CR to LF')
  eq(sanitizeText('a\nb', 80, {}), 'a b', 'keepLines defaults to false: a note is one line')
  eq(sanitizeText('```js```'), "'''js'''", 'code fences are neutralised')

  // ---------- max length ----------
  eq(sanitizeText('abcdefghij', 4), 'abcd', 'truncates to max')
  eq(sanitizeText('ab😀😀😀', 3), 'ab😀', 'truncation counts code points: a surrogate pair is never split')
  eq(sanitizeText('aaa bbb', 4), 'aaa', 'truncation trims a dangling space')
  eq(sanitizeText('abc', 0), '', 'max 0 gives an empty string')
  eq(sanitizeText('x'.repeat(100)).length, 80, 'max defaults to 80')

  // ---------- non-string input ----------
  eq(sanitizeText(null), '', 'null is empty')
  eq(sanitizeText(undefined), '', 'undefined is empty')
  eq(sanitizeText(''), '', 'empty string stays empty')
  eq(sanitizeText(42), '42', 'a number is stringified')
  eq(sanitizeText({ a: 1 }), '[object Object]', 'an object is stringified')

  // ---------- the computer's own names ----------
  eq(sanitizeText('Jane Doe played', 80, { redact: ['Jane Doe'] }), '[user] played', 'every part of a known name is redacted')
  eq(sanitizeText('the Mac mini of Music', 80, { redact: ['mac', 'music'] }), 'the [user] mini of [user]', 'an explicit redact entry wins over the common-word list')
  eq(sanitizeText('JANE-DOE and jane_s', 80, { redact: ['janedoe'] }), '[user] and [user]', 'adjacent letter runs spelling a name go whole')

  // ---------- possessives are taken as a person's name ----------
  eq(sanitizeText("Jane's iPad"), "[name]'s iPad", 'a capitalised name before \'s becomes [name]')
  eq(sanitizeText("that's fine"), "that's fine", 'an ordinary word before \'s is left alone')

  // ---------- paths, emails, ids, serials ----------
  eq(sanitizeText('/Users/jane/Songs/x.mid failed'), '[path removed]', 'a /Users path goes whole, to the end of the line')
  eq(sanitizeText('C:\\Users\\jane\\x.mid failed'), '[path removed]', 'a Windows path goes whole')
  eq(sanitizeText('~/secret/file.txt oops'), '[path removed]', 'a ~/ path goes whole')
  eq(sanitizeText('mail me at jane@example.com now'), 'mail me at [email removed] now', 'an email is removed')
  eq(sanitizeText('id 123e4567-e89b-12d3-a456-426614174000 ok'), 'id [id removed] ok', 'a UUID is removed')
  eq(sanitizeText('mac 00:1b:44:11:3a:b7 ok'), 'mac [id removed] ok', 'a MAC address is removed')
  eq(sanitizeText('hash deadbeef1234 ok'), 'hash [id removed] ok', 'a long hex id is removed')
  eq(sanitizeText('Serial: AB12CD ok'), 'Serial: [removed] ok', 'a labelled serial loses its value')
  eq(sanitizeText('sn: XY99 ok'), 'sn: [removed] ok', 'a short "sn:" label lose its value')

  console.log(`sanitize-text: ${n} assertions passed (control chars, whitespace, keepLines, max+surrogates, non-strings, redaction, paths/emails/ids)`)
})().catch((e) => { console.error(e); process.exit(1) })
