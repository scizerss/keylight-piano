// Generated covers: node scripts/test-cover-art.js
// Deterministic, valid SVG, bounded size, safe for 0 / 1 / 5,000 notes, different songs differ, every built-in song has a print.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const root = path.join(__dirname, '..')

;(async () => {
  const { coverArt, coverSignature, fingerprintOf, composerPalette } = await import(pathToFileURL(path.join(root, 'renderer/cover-art.js')).href)
  const { COVER_PRINTS } = await import(pathToFileURL(path.join(root, 'renderer/cover-prints.js')).href)
  const { MUTOPIA_SONGS } = await import(pathToFileURL(path.join(root, 'renderer/songs-mutopia.js')).href)

  const mk = (n, seed = 1) => Array.from({ length: n }, (_, i) => ({ pitch: 48 + ((i * 7 + seed * 5) % 30), start: i * 0.25, dur: 0.2 + (i % 3) * 0.1, hand: (i + seed) % 3 ? 'right' : 'left' }))
  const nodes = (svg) => (svg.match(/<(path|circle|g|svg)\b/g) || []).length
  const wellFormed = (svg) => {
    assert.ok(svg.startsWith('<svg ') && svg.endsWith('</svg>'), 'one svg element')
    assert.ok(!/NaN|undefined|Infinity/.test(svg), 'no NaN in the markup')
    assert.ok(!/<(text|image|script|foreignObject)\b/i.test(svg), 'no text, pictures or scripts in the art')
    const open = (svg.match(/<(?!\/)[a-z]+\b[^>]*[^/]>/g) || []).filter((t) => !/^<(path|circle)/.test(t)).length
    const close = (svg.match(/<\/[a-z]+>/g) || []).length
    assert.equal(open, close, 'tags balance')
  }

  // deterministic, and the memo does not change the answer
  const song = { id: 's1', title: 'Song', artist: 'Chopin', tempo: 100, notes: mk(80) }
  const a = coverArt(song), b = coverArt({ ...song, notes: mk(80) })
  assert.deepEqual(a, b, 'same song, same cover')
  wellFormed(a.svg)

  // 0, 1, 5,000 notes; every size class; bounded node count
  for (const n of [0, 1, 2, 5000]) for (const size of ['thumb', 'card', 'hero']) {
    const c = coverArt({ id: 'n' + n, title: 'T', artist: 'Joplin', tempo: 120, notes: mk(n) }, { size })
    wellFormed(c.svg)
    assert.ok(nodes(c.svg) <= 120, `${n} notes at ${size}: ${nodes(c.svg)} nodes`)
    assert.ok(/gradient/.test(c.bg), 'a background field')
  }
  const fp5k = fingerprintOf({ tempo: 100, notes: mk(5000) })
  assert.ok(fp5k.o.length <= 40 && fp5k.n === 5000, 'the fingerprint keeps only the opening')
  assert.equal(fingerprintOf({}).o.length, 0)
  assert.equal(fingerprintOf({ notes: [{ pitch: 'x', start: 0 }, null] }).n, 0, 'junk notes are ignored')
  wellFormed(coverArt({ title: 'No id, no notes' }).svg)
  wellFormed(coverArt(null).svg)

  // editing the opening notes (same count) or renaming changes the cover: the cache cannot serve a stale one
  const edited = mk(80); edited[3].pitch += 5; edited[0].hand = 'left'
  assert.notEqual(coverArt({ ...song, notes: edited }).svg, a.svg, 'edited notes, same count: new cover')
  assert.notEqual(coverArt({ ...song, title: 'Renamed', artist: 'Joplin' }).bg, a.bg, 'new composer: new colours')
  const slower = coverArt({ ...song, notes: mk(80).map((n) => ({ ...n, dur: n.dur * 3 })) })
  assert.notEqual(slower.svg, a.svg, 'different note lengths: new cover')

  // the key is inferred from the whole song: an edit far past the opening that changes it changes the cover; one that changes nothing visual does not
  const longSong = { id: 'long', title: 'Long', artist: 'Bach', tempo: 100, imported: true, notes: [...mk(60), ...Array.from({ length: 120 }, (_, i) => ({ pitch: 60 + [0, 2, 4, 5, 7, 9, 11][i % 7], start: 60 + i, dur: 1, hand: 'right' }))] }
  const base = coverArt(longSong), sigBase = coverSignature(longSong)
  const keyed = { ...longSong, notes: longSong.notes.map((n, i) => (i >= 60 ? { ...n, pitch: n.pitch + 1 } : n)) }
  assert.notEqual(coverSignature(keyed), sigBase, 'edit past note 60 that changes the key: new signature')
  assert.notEqual(coverArt(keyed).bg + coverArt(keyed).svg, base.bg + base.svg, 'and a new cover')
  const octave = { ...longSong, notes: longSong.notes.map((n, i) => (i >= 60 ? { ...n, pitch: n.pitch + 12, vel: 5 } : n)) }
  assert.equal(coverSignature(octave), sigBase, 'edit past note 60 that changes nothing visual: same signature')
  assert.deepEqual(coverArt(octave), base, 'and the same cover')

  // different songs differ
  const covers = new Set(MUTOPIA_SONGS.map((s) => coverArt({ ...s }, { fp: COVER_PRINTS[s.file] }).svg))
  assert.ok(covers.size >= MUTOPIA_SONGS.length - 1, `${covers.size} distinct covers for ${MUTOPIA_SONGS.length} songs`)
  assert.notEqual(coverArt({ id: 'a', title: 'A', notes: mk(40, 1) }).svg, coverArt({ id: 'b', title: 'B', notes: mk(40, 2) }).svg)

  // palettes: one family per composer, imported songs distinct, lessons distinct from songs
  assert.deepEqual(composerPalette({ artist: 'Chopin' }), composerPalette({ artist: 'F. F. Chopin' }))
  assert.notDeepEqual(composerPalette({ artist: 'Chopin' }).field, composerPalette({ artist: 'Joplin' }).field)
  assert.equal(composerPalette({ artist: 'Whoever', imported: true }).key, 'mine')
  assert.notEqual(coverArt(song).bg, coverArt(song, { lesson: true }).bg)

  // every built-in song has a print, and uses only the colours it should
  const app = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8')
  const files = [...app.matchAll(/^\s*\{ file: '([^']+\.xml)'/gm)].map((m) => m[1]).concat(MUTOPIA_SONGS.map((s) => s.file))
  for (const f of files) assert.ok(COVER_PRINTS[f] && COVER_PRINTS[f].o.length >= 4, `no cover print for ${f}: run node tools/covers/prints.js`)
  console.log(`cover-art OK: ${files.length} songs, ${covers.size} distinct covers`)
})().catch((e) => { console.error('cover-art FAIL:', e.message); process.exit(1) })
