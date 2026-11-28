// The Songs catalogue's pure logic: accent-blind multi-word search with ranking, and every filter. node scripts/test-discover.js
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

;(async () => {
  const D = await import(pathToFileURL(path.join(__dirname, '..', 'renderer/discover.js')).href)
  const levelName = (l) => ({ 'Level 1': 'First steps' }[l] || l)
  const song = (title, artist, level, extra = {}) => ({ file: title + '.xml', title, artist, level, genre: 'Classical', ...extra })
  const songs = [
    song('Für Elise', 'Beethoven', 'Easy', { composer: 'Ludwig van Beethoven', era: 'Classical', moods: ['Tender', 'Melancholy'] }),
    song('Slavonic Dance Op. 46 No. 8', 'Dvořák', 'Advanced', { composer: 'Antonín Dvořák', era: 'Romantic', moods: ['Bright', 'Playful'] }),
    song('Nocturne in E-flat', 'Chopin', 'Intermediate', { composer: 'Frédéric Chopin', era: 'Romantic', moods: ['Calm', 'Tender'] }),
    song('Raindrop Prelude', 'Chopin', 'Intermediate', { composer: 'Frédéric Chopin', era: 'Romantic', moods: ['Calm', 'Melancholy'] }),
    song('Revolutionary Étude', 'Chopin', 'Virtuoso', { composer: 'Frédéric Chopin', era: 'Romantic', moods: ['Dramatic'] }),
    song('Gymnopédie No. 1', 'Satie', 'Beginner', { era: 'Impressionist', moods: ['Calm'] }),
    song('Twinkle Twinkle Little Star', 'Traditional', 'Level 1', { era: 'Traditional', moods: ['Tender'], genre: 'Traditional' }),
    song('C Major Scale', 'Exercise', 'Level 1', { genre: 'Exercise' }),
    song('Calm Waters', 'Someone', 'Easy'),
    { file: 'mine.xml', title: 'My Recording', artist: 'Recording', imported: true }
  ]
  const secs = { 'Für Elise.xml': 180, 'Raindrop Prelude.xml': 400, 'Gymnopédie No. 1.xml': 90, 'C Major Scale.xml': 12 }
  const secondsOf = (s) => secs[s.file] || 0
  const titles = (l) => l.map((s) => s.title)
  const find = (q) => titles(D.searchSongs(songs, q, levelName))

  // accent and case folding
  assert.equal(D.fold('Dvořák'), 'dvorak')
  assert.equal(D.fold('Für Elise'), 'fur elise')
  assert.equal(D.fold("Brahms' Lullaby"), 'brahms lullaby')
  assert.equal(D.fold(null), '')
  // other scripts are kept, so a non-Latin search is not an empty search
  assert.equal(D.fold('月光 Sonata'), '月光 sonata')
  assert.deepEqual(D.searchWords('月光'), ['月光'])
  assert.equal(D.fold('Лунная'), 'лунная')
  assert.equal(D.fold('مُوسِيقَى'), D.fold('موسيقى'))
  assert.deepEqual(find('dvorak'), ['Slavonic Dance Op. 46 No. 8'])
  assert.deepEqual(find('DVOŘÁK'), ['Slavonic Dance Op. 46 No. 8'])
  assert.deepEqual(find('fur elise'), ['Für Elise'])
  assert.deepEqual(find('Etude'), ['Revolutionary Étude'])
  assert.deepEqual(find('Antonin'), ['Slavonic Dance Op. 46 No. 8'], 'the full composer name is searched')

  // every field: composer, artist, era, mood, genre, level (and its shown name)
  assert.equal(find('chopin').length, 3)
  assert.deepEqual(find('impressionist'), ['Gymnopédie No. 1'])
  assert.deepEqual(find('dramatic'), ['Revolutionary Étude'])
  assert.deepEqual(find('exercise'), ['C Major Scale'])
  assert.deepEqual(find('first steps').sort(), ['C Major Scale', 'Twinkle Twinkle Little Star'])
  assert.deepEqual(find('virtuoso'), ['Revolutionary Étude'])

  // every word is required
  assert.deepEqual(find('chopin calm').sort(), ['Nocturne in E-flat', 'Raindrop Prelude'])
  assert.deepEqual(find('calm chopin').sort(), ['Nocturne in E-flat', 'Raindrop Prelude'])
  assert.deepEqual(find('chopin calm melancholy'), ['Raindrop Prelude'])
  assert.deepEqual(find('chopin bright'), [])
  assert.deepEqual(find('zzzz'), [])

  // ranking: title starts with, then title contains, then other fields
  const ranked = find('calm')
  assert.equal(ranked[0], 'Calm Waters', 'title starts with the word')
  assert.ok(ranked.indexOf('Gymnopédie No. 1') > 0, 'a mood match comes after')
  const r2 = titles(D.searchSongs([song('Late Dream', 'X', 'Easy'), song('Other', 'Dream Composer', 'Easy'), song('Dream', 'X', 'Easy')], 'dream'))
  assert.deepEqual(r2, ['Dream', 'Late Dream', 'Other'])
  assert.equal(D.searchRank(songs[0], D.searchWords('fur e'), levelName), 3)
  assert.equal(D.searchRank(songs[0], D.searchWords('zz'), levelName), 0)
  // equal ranks keep the incoming order (the app sorts first)
  assert.deepEqual(titles(D.searchSongs([song('B Tune', 'Chopin', 'Easy'), song('A Tune', 'Chopin', 'Easy')], 'chopin')), ['B Tune', 'A Tune'])
  // empty or blank search returns the list untouched
  assert.equal(D.searchSongs(songs, '   ', levelName), songs)
  assert.equal(D.searchSongs(songs, "'", levelName), songs, 'punctuation only is no search')

  // cache: an edited song is searched by its new text
  const edit = song('Old Name', 'Bach', 'Easy', { era: 'Baroque' })
  assert.equal(D.searchSongs([edit], 'old', levelName).length, 1)
  edit.title = 'New Name'
  assert.equal(D.searchSongs([edit], 'old', levelName).length, 0)
  assert.equal(D.searchSongs([edit], 'new', levelName).length, 1)
  edit.moods = ['Grand']
  assert.equal(D.searchSongs([edit], 'grand', levelName).length, 1)

  // songs with no era or moods still list and filter without error
  assert.equal(D.applyFilter(songs, { era: 'Baroque' }).length, 0)
  assert.equal(D.applyFilter(songs, { mood: 'Calm' }).length, 3)
  assert.equal(D.applyFilter(songs, {}).length, songs.length)
  assert.equal(D.applyFilter(songs, undefined).length, songs.length)
  assert.deepEqual(D.erasPresent([{}, { moods: 'nope' }]), [])
  assert.deepEqual(D.moodsPresent([{}, { moods: 'nope' }, { moods: [1, null] }]), [])

  // values present, in vocabulary order
  assert.deepEqual(D.erasPresent(songs), ['Traditional', 'Classical', 'Romantic', 'Impressionist'].sort((a, b) => D.ERAS.indexOf(a) - D.ERAS.indexOf(b)))
  assert.deepEqual(D.moodsPresent(songs), ['Calm', 'Bright', 'Dramatic', 'Playful', 'Melancholy', 'Tender'])
  assert.deepEqual(D.erasPresent([{ era: 'Zzz' }, { era: 'Baroque' }]), ['Baroque', 'Zzz'])
  const levels = D.levelsPresent(songs, ['Level 1', 'Level 2', 'Beginner', 'Easy', 'Intermediate', 'Advanced', 'Virtuoso'])
  assert.deepEqual(levels, ['Level 1', 'Beginner', 'Easy', 'Intermediate', 'Advanced', 'Virtuoso'])
  const comps = D.composersOf(songs)
  assert.equal(comps[0].name, 'Chopin'); assert.equal(comps[0].count, 3)
  assert.ok(!comps.some((c) => ['Exercise', 'Recording', 'Imported'].includes(c.name)))
  assert.equal(D.topComposers(songs, 2).length, 2)

  // each filter
  const f = (o) => titles(D.applyFilter(songs, { level: '', composer: '', era: '', mood: '', length: '', ...o }, secondsOf))
  assert.deepEqual(f({ level: 'Virtuoso' }), ['Revolutionary Étude'])
  assert.equal(f({ composer: 'Chopin' }).length, 3)
  assert.equal(f({ era: 'Romantic' }).length, 4)
  assert.deepEqual(f({ mood: 'Dramatic' }), ['Revolutionary Étude'])
  assert.equal(f({ mood: 'Tender' }).length, 3, 'a song may carry two moods')
  assert.deepEqual(f({ length: 'short' }), ['Gymnopédie No. 1', 'C Major Scale'])
  assert.deepEqual(f({ length: 'medium' }), ['Für Elise'])
  assert.deepEqual(f({ length: 'long' }), ['Raindrop Prelude'])
  assert.equal(D.lengthBucket(119), 'short'); assert.equal(D.lengthBucket(120), 'medium'); assert.equal(D.lengthBucket(300), 'medium'); assert.equal(D.lengthBucket(301), 'long')
  assert.equal(D.lengthBucket(0), ''); assert.equal(D.lengthBucket(undefined), '')
  assert.deepEqual(f({ length: 'short', mood: 'Calm' }), ['Gymnopédie No. 1'], 'songs with no known length never match a length')

  // filters combine (all must pass)
  assert.deepEqual(f({ composer: 'Chopin', mood: 'Calm', level: 'Intermediate' }).sort(), ['Nocturne in E-flat', 'Raindrop Prelude'])
  assert.deepEqual(f({ composer: 'Chopin', mood: 'Calm', level: 'Intermediate', length: 'long' }), ['Raindrop Prelude'])
  assert.deepEqual(f({ composer: 'Chopin', era: 'Baroque' }), [])
  // filter and search together
  const filtered = D.applyFilter(D.searchSongs(songs, 'chopin', levelName), { mood: 'Melancholy' })
  assert.deepEqual(titles(filtered), ['Raindrop Prelude'])

  // length is offered only when every song has a known duration
  assert.deepEqual(D.lengthsPresent(songs.slice(0, 1), secondsOf).map((l) => l.id), ['medium'])
  assert.deepEqual(D.lengthsPresent(songs, secondsOf), [], 'one song without a length hides the filter')
  assert.deepEqual(D.lengthsPresent([], secondsOf), [])

  // saved filters: old shape (level and composer only), unknown values, damaged data
  const have = { eras: D.erasPresent(songs), moods: D.moodsPresent(songs), lengths: ['short', 'medium', 'long'] }
  const clean = (x) => D.cleanFilter(x, levels, comps, have)
  const none = { level: '', composer: '', era: '', mood: '', length: '' }
  assert.deepEqual(clean({ level: 'Virtuoso', composer: 'Chopin' }), { ...none, level: 'Virtuoso', composer: 'Chopin' }, 'the old shape still loads')
  assert.deepEqual(clean({ level: 'Gone', composer: 'Nobody', era: 'Baroque', mood: 'Loud', length: 'epic' }), none, 'unknown values are dropped')
  assert.deepEqual(clean({ era: 'Romantic', mood: 'Calm', length: 'long' }), { ...none, era: 'Romantic', mood: 'Calm', length: 'long' })
  for (const bad of [null, undefined, 5, 'x', [], { level: 7, composer: {}, era: ['Romantic'], mood: null }]) assert.deepEqual(clean(bad), none)
  assert.deepEqual(D.cleanFilter({ era: 'Baroque', mood: 'Grand' }, levels, comps), { ...none, era: 'Baroque', mood: 'Grand' }, 'without a list the built-in vocabulary decides')
  assert.deepEqual(D.cleanFilter({ level: 'Virtuoso', composer: 'Chopin' }, levels, []), { ...none, level: 'Virtuoso' }, 'a composer the library no longer has is dropped')

  // badge count and storage shape (older readers still see level and composer)
  assert.equal(D.filterCount(none), 0)
  assert.equal(D.filterCount({ ...none, level: 'Easy', era: 'Baroque', length: 'short' }), 3)
  assert.equal(D.filterCount(null), 0)
  assert.equal(JSON.stringify(D.storableFilter({ level: 'Virtuoso', composer: 'Chopin', era: '', mood: '', length: '' })), '{"level":"Virtuoso","composer":"Chopin"}')
  assert.deepEqual(D.storableFilter({ mood: 'Calm' }), { level: '', composer: '', mood: 'Calm' })
  assert.deepEqual(D.storableFilter(null), { level: '', composer: '' })

  // the vocabularies carry what the library files use
  for (const e of ['Traditional', 'Baroque', 'Classical', 'Romantic', 'Impressionist', 'Ragtime', 'Modern']) assert.ok(D.ERAS.includes(e))
  for (const m of ['Calm', 'Bright', 'Dramatic', 'Playful', 'Melancholy', 'Tender', 'Grand']) assert.ok(D.MOODS.includes(m))

  // speed: 150 songs, many keystrokes
  const big = Array.from({ length: 150 }, (_, i) => song('Piece ' + i, ['Chopin', 'Bach', 'Liszt'][i % 3], 'Easy', { composer: 'Some Composer ' + i, era: 'Romantic', moods: ['Calm'] }))
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < 400; i++) D.searchSongs(big, ['c', 'ch', 'cho', 'chop', 'chopin calm'][i % 5], levelName)
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  assert.ok(ms < 500, '400 searches of 150 songs took ' + ms.toFixed(0) + ' ms')
  console.log('test-discover: ok (' + ms.toFixed(0) + ' ms for 400 searches of 150 songs)')
})().catch((e) => { console.error(e); process.exit(1) })
