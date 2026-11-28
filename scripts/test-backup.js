// Unit test for renderer/backup.js: node scripts/test-backup.js
// A backup carries the imported songs (recordings byte for byte) and the lumi.* entries;
// a restore checks the whole file first, writes nothing when declined or refused, adds
// to what is there, and undoes its settings writes when saving the songs fails.
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// localStorage as the app sees it; `full` names a key whose write fails like a full quota
class MemoryStorage {
  constructor(entries = {}) { this.map = new Map(Object.entries(entries)); this.full = null }
  get length() { return this.map.size }
  key(i) { return [...this.map.keys()][i] ?? null }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null }
  setItem(k, v) { if (k === this.full) throw new Error('QuotaExceededError'); this.map.set(k, String(v)) }
  removeItem(k) { this.map.delete(k) }
  snapshot() { return Object.fromEntries(this.map) }
}

const bytes = Uint8Array.from({ length: 256 * 3 }, (_, i) => i % 256)
const record = (id, extra = {}) => ({
  id, file: 'imported:' + id, title: 'Song ' + id, artist: 'A', album: '', duration: 12, tempo: 100,
  notes: [{ pitch: 60, start: 0, dur: 0.5, vel: 100, hand: 'right', finger: 1 }, { pitch: 43, start: 0.5, dur: 1, vel: 70, hand: 'left', finger: 5, track: 1, trackName: 'Bass' }],
  timeSignature: { beats: 3, beatType: 4 }, parts: [{ index: 0, name: 'Piano', channel: 0, program: 0, hand: null }], bars: [0, 1.8],
  score: { xml: '<score-partwise/>', order: [0, 1], starts: [0, 3], tempo: [{ beat: 0, bpm: 100 }] },
  cover: 'data:image/png;base64,iVBORw0KGgo=', lyrics: { synced: [{ t: 0.5, text: 'héllo 你好' }] }, lyricsFromFile: false,
  audio: null, source: 'score', added: 1700000000000, ...extra
})

async function main() {
  const backup = await import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'backup.js')).href)
  const { createBackup, readBackup, restoreBackup, BackupError, MAGIC, VERSION } = backup
  let n = 0
  const check = async (label, fn) => { await fn(); n++; process.stdout.write('ok ' + label + '\n') }

  const library = () => [
    record('imp-a', { audio: new File([bytes], 'take one.m4a', { type: 'audio/mp4' }), source: 'audio', score: null }),
    record('imp-b')
  ]
  const userStorage = () => new MemoryStorage({
    'lumi.settings': JSON.stringify({ lightStyle: 'glow', rate: 0.8 }), 'lumi.best.songs/a.mid': '3', 'lumi.streak.count': '4', 'other.app': 'keep'
  })
  const made = await createBackup({ songs: library(), storage: userStorage(), now: new Date(2026, 10, 6, 9, 5) })
  const asFile = (blob) => new File([blob], 'backup.keylightbackup')
  // a backup file written by hand: the format, header and all
  const forge = (manifest, payload = new Uint8Array(0), length) => {
    const body = new TextEncoder().encode(JSON.stringify(manifest))
    const head = new Uint8Array(MAGIC.length + 4)
    head.set(new TextEncoder().encode(MAGIC))
    new DataView(head.buffer).setUint32(MAGIC.length, length ?? body.length, true)
    return new File([head, body, payload], 'x.keylightbackup')
  }
  const goodManifest = (songs) => ({ format: 'keylight-backup', version: VERSION, created: new Date().toISOString(), songs, storage: {} })
  const restoreInto = async (file, storage, saved, opts = {}) => restoreBackup(file, {
    storage, confirm: async () => opts.answer ?? true,
    saveSongs: async (songs) => { if (opts.saveFails) throw new Error('disk full'); saved.push(...songs) }
  })

  await check('a backup names itself and counts what it holds', async () => {
    assert.equal(made.name, 'keylight-backup-20261106-0905.keylightbackup')
    assert.equal(made.songs, 2)
    assert.equal(made.keys, 3)
    assert.deepEqual(made.skipped, [])
  })

  await check('songs, recordings and lumi entries come back exactly', async () => {
    const plan = await readBackup(asFile(made.blob))
    assert.equal(plan.songs.length, 2)
    const [a, b] = plan.songs
    assert.equal(a.audio.name, 'take one.m4a')
    assert.equal(a.audio.type, 'audio/mp4')
    assert.deepEqual(new Uint8Array(await a.audio.arrayBuffer()), bytes)
    assert.equal(b.audio, null)
    const want = record('imp-b')
    for (const k of ['id', 'title', 'artist', 'notes', 'duration', 'tempo', 'timeSignature', 'parts', 'bars', 'score', 'cover', 'lyrics', 'lyricsFromFile', 'source', 'added']) assert.deepEqual(b[k], want[k], k)
    assert.deepEqual(plan.storage, { 'lumi.settings': '{"lightStyle":"glow","rate":0.8}', 'lumi.best.songs/a.mid': '3', 'lumi.streak.count': '4' })
  })

  await check('syllable lyrics and a kept video recording come back; a backup without lyricWords still restores', async () => {
    const words = [{ t: 0, text: 'Twin', cont: true }, { t: 0.5, text: 'kle' }, { t: 3, text: 'Next line' }]
    const lib = [record('imp-w', { lyricWords: words, lyricsFromFile: true, audio: new File([bytes], 'clip.mp4', { type: 'video/mp4' }), source: 'audio' }), record('imp-old')]
    const plan = await readBackup(asFile((await createBackup({ songs: lib, storage: userStorage(), now: new Date(2026, 10, 6, 9, 5) })).blob))
    assert.deepEqual(plan.songs[0].lyricWords, words)
    assert.equal(plan.songs[0].audio.type, 'video/mp4')
    assert.equal(plan.songs[1].lyricWords, null)
    const bad = forge(goodManifest([{ ...record('imp-z'), lyricWords: 'nope' }]))
    await assert.rejects(readBackup(bad), /lyric words are not valid/)
  })

  await check('malformed lyric words reject the backup instead of being repaired; the other new fields stay strict', async () => {
    const good = [{ t: 0, text: 'Twin', cont: true }, { t: 0.5, text: 'kle' }]
    const rejects = async (lyricWords, why) => assert.rejects(readBackup(forge(goodManifest([{ ...record('imp-z'), lyricWords }]))), /lyric word/, why)
    await rejects([...good, null], 'an invalid entry is not dropped')
    await rejects([...good, { t: 'x', text: 'a' }], 'a bad time')
    await rejects([...good, { t: 1, text: '' }], 'empty text')
    await rejects([...good, { t: 1, text: 'a', cont: 'yes' }], 'a wrongly typed flag is not stripped')
    await rejects([...good, { t: 1, text: 'a', nl: 1 }], 'a numeric flag')
    await rejects(Array.from({ length: 20001 }, (_, i) => ({ t: i, text: 'a' })), 'an oversized list is not truncated')
    await rejects({ t: 0, text: 'a' }, 'not a list')
    const plan = await readBackup(forge(goodManifest([{ ...record('imp-ok'), lyricWords: good }])))
    assert.deepEqual(plan.songs[0].lyricWords, good)
    for (const importNotice of [42, 'x'.repeat(401), {}]) await assert.rejects(readBackup(forge(goodManifest([{ ...record('imp-z'), importNotice }]))), /import note/)
    await assert.rejects(readBackup(forge(goodManifest([{ ...record('imp-z'), grid: { offset: 61, division: 2 } }]))), /grid settings/)
    await assert.rejects(readBackup(forge(goodManifest([{ ...record('imp-z'), lyricsFromFile: 'yes' }]))), /lyricsFromFile/)
  })

  await check('the import note travels with the song; older songs without one restore as null', async () => {
    const lib = [record('imp-i', { importNotice: 'The video is too large to keep.' }), record('imp-m')]
    const plan = await readBackup(asFile((await createBackup({ songs: lib, storage: userStorage(), now: new Date(2026, 10, 6, 9, 5) })).blob))
    assert.equal(plan.songs[0].importNotice, 'The video is too large to keep.')
    assert.equal(plan.songs[1].importNotice, null)
    await assert.rejects(readBackup(forge(goodManifest([{ ...record('imp-z'), importNotice: 42 }]))))
  })

  await check('piano-roll grid settings come back; older songs without them still restore; a bad grid is refused', async () => {
    const lib = [record('imp-g', { grid: { offset: 0.125, division: 4 } }), record('imp-n')]
    const plan = await readBackup(asFile((await createBackup({ songs: lib, storage: userStorage(), now: new Date(2026, 10, 6, 9, 5) })).blob))
    assert.deepEqual(plan.songs[0].grid, { offset: 0.125, division: 4 })
    assert.equal(plan.songs[1].grid, null)
    for (const bad of [{ offset: -1, division: 2 }, { offset: 0, division: 0 }, { offset: 0, division: 2.5 }, 'x']) {
      await assert.rejects(readBackup(forge(goodManifest([{ ...record('imp-z'), grid: bad }]))), /grid settings are not valid/)
    }
  })

  await check('a restore adds to what is there', async () => {
    const storage = new MemoryStorage({ 'lumi.streak.count': '9', 'lumi.fav.songs/b.mid': 'true', 'other.app': 'mine' })
    const saved = []
    const r = await restoreInto(asFile(made.blob), storage, saved)
    assert.deepEqual(r, { restored: true, songs: 2, keys: 3 })
    assert.deepEqual(saved.map((s) => s.id), ['imp-a', 'imp-b'])
    assert.equal(storage.getItem('lumi.streak.count'), '4')
    assert.equal(storage.getItem('lumi.fav.songs/b.mid'), 'true')
    assert.equal(storage.getItem('other.app'), 'mine')
  })

  await check('a declined restore writes nothing', async () => {
    const storage = new MemoryStorage({ 'lumi.streak.count': '9' })
    const before = storage.snapshot()
    const saved = []
    const r = await restoreInto(asFile(made.blob), storage, saved, { answer: false })
    assert.equal(r.restored, false)
    assert.deepEqual(storage.snapshot(), before)
    assert.deepEqual(saved, [])
  })

  await check('a failed song save undoes the settings writes', async () => {
    const storage = new MemoryStorage({ 'lumi.streak.count': '9', 'lumi.days': '{}' })
    const before = storage.snapshot()
    await assert.rejects(restoreInto(asFile(made.blob), storage, [], { saveFails: true }), /disk full/)
    assert.deepEqual(storage.snapshot(), before)
  })

  await check('a full storage stops the restore before any song is saved', async () => {
    const storage = new MemoryStorage({ 'lumi.streak.count': '9' })
    storage.full = 'lumi.streak.count'      // written after lumi.settings and lumi.best...: those are undone
    const before = storage.snapshot()
    const saved = []
    await assert.rejects(restoreInto(asFile(made.blob), storage, saved), /Quota/)
    assert.deepEqual(storage.snapshot(), before)
    assert.deepEqual(saved, [])
  })

  await check('a failed song save restores swapped large settings within the original quota', async () => {
    const storage = new MemoryStorage({ 'lumi.a': JSON.stringify('a'.repeat(100)), 'lumi.b': JSON.stringify('b') })
    storage.setItem = function (key, value) {
      const next = new Map(this.map).set(key, String(value))
      if ([...next.values()].reduce((sum, item) => sum + item.length, 0) > 150) throw new Error('QuotaExceededError')
      this.map = next
    }
    const before = storage.snapshot()
    const file = forge({ ...goodManifest([record('imp-z')]), storage: { 'lumi.a': JSON.stringify('a'), 'lumi.b': JSON.stringify('b'.repeat(100)) } })
    await assert.rejects(restoreInto(file, storage, [], { saveFails: true }), /disk full/)
    assert.deepEqual(storage.snapshot(), before)
  })

  const audioSong = (audio) => ({ ...record('imp-z'), audio })
  await check('malformed known settings refuse the whole restore before confirmation or writes', async () => {
    const malformed = [
      ['lumi.days', null], ['lumi.recent', null], ['lumi.settings', { kbKeysFor: null }],
      ['lumi.settings', []], ['lumi.settings', { kbBaseFor: [] }], ['lumi.settings', { kbPair: { port: null } }],
      ['lumi.settings', { kbKeysFor: { port: '49' } }], ['lumi.settings', { kbBaseFor: { port: null } }],
      ['lumi.settings', { kbPair: { port: { side: 2, low: 48 } } }],
      ['lumi.settings', { volume: [] }], ['lumi.settings', { metronome: 'false' }],
      ['lumi.settings', { kbPort: {} }], ['lumi.settings', { expression: [] }],
      ['lumi.settings', { camCalib: { a: null, b: {} } }], ['lumi.settings', { freeScale: [] }],
      ['lumi.settings', { glide: 'true' }], ['lumi.settings', { experience: 'beginner' }],
      ['lumi.settings', { handGuide: true }], ['lumi.settings', { handGuideRuns: -1 }],
      ['lumi.settings', { waitStyle: 'pulse' }], ['lumi.settings', { nextStyle: 'steady' }],
      ['lumi.settings', { tvSetup: 'hdmi' }], ['lumi.settings', { tvDelayMs: '160' }],
      ['lumi.settings', { tvDelayBySetup: [] }], ['lumi.settings', { tvDelayBySetup: '160' }],
      ['lumi.settings', { tvDelayBySetup: { airplay: '160', cable: 0 } }],
      ['lumi.settings', { tvDelayBySetup: { airplay: null } }],
      ['lumi.settings', { tvSound: 'speaker' }], ['lumi.settings', { tvPhoneNotes: 1 }],
      ['lumi.settings', { tvCalibOffered: 'false' }],
      ['lumi.settings', { kbMidiSeen: 1 }], ['lumi.settings', { tourDone: 'true' }],
      ['lumi.settings', { kbOwnColours: null }],
      ['lumi.settings', { kbOwnColours: { serial: { values: { 34: 'black' }, written: {}, dirty: true, at: 1 } } }],
      ['lumi.betaNoticeSeen', 'true'],
      ['lumi.days', []], ['lumi.days', { '2026-11-06': '60' }],
      ['lumi.recent', {}], ['lumi.recent', [null]], ['lumi.recent', [{ file: 7, at: 1 }]],
      ['lumi.guided.progress.song', null], ['lumi.guided.progress.song', { '1-4': [] }],
      ['lumi.guided.progress.song', { '1-4': { 'right.PLAY.60': { passed: true, best: '1', tries: 1 } } }],
      ['lumi.guided.weak.song', null], ['lumi.guided.weak.song', { 0: {} }],
      ['lumi.guided.section.song', {}], ['lumi.guided.mode', []], ['lumi.guided.hand', null], ['lumi.guided.rate', {}],
      ['lumi.streak.count', []], ['lumi.streak.last', {}], ['lumi.best.song', {}],
      ['lumi.game.quiz', null], ['lumi.lesson.first.PLAY', -1], ['lumi.exercise.major.0.both', 6],
      ['lumi.exercise.major.0.both.bpm', []], ['lumi.fav.song', {}],
      ['lumi.lessonwatched.first', 'true'], ['lumi.lessonpractised.first', 1], ['lumi.onboarded', null]
    ]
    const failures = []
    for (const [key, value] of malformed) {
      const storage = userStorage(), before = storage.snapshot(), saved = [record('existing')]
      let asked = false, rejected = false
      try {
        await restoreBackup(forge({ ...goodManifest([record('imp-z')]), storage: { 'lumi.streak.count': '2', [key]: JSON.stringify(value) } }), {
          storage, confirm: () => { asked = true; return true }, saveSongs: async (songs) => saved.push(...songs)
        })
      } catch (error) {
        if (!(error instanceof BackupError)) throw error
        rejected = error.message === `The setting ${key} is not valid`
      }
      if (!rejected || asked || JSON.stringify(storage.snapshot()) !== JSON.stringify(before) || saved.length !== 1) failures.push(`${key}=${JSON.stringify(value)}`)
    }
    assert.deepEqual(failures, [], 'malformed settings accepted or changed existing storage/songs')
  })

  await check('current storage shapes and defaults round-trip without dropping entries', async () => {
    const values = {
      settings: { brightness: 255, volume: 80, backingVolume: 70, countIn: 4, metronome: false, labels: 'off', view: 'CASCADE', hands: 'both', rate: 1, band: false, waitMode: 'pauseAndSnap', instrument: 'sampled-piano', keyboardMode: 'Pro', bendRange: 12, accompany: true, kbZero: 48, kbPort: '', kbLast: '', kbKeysFor: { '': 49, 'LUMI Keys BLOCK': 24, paired: 48 }, kbBaseFor: { paired: 36 }, kbPair: { left: { side: 0, low: 48 }, right: { side: 1, low: 60 } }, kbLightsLeft: '', kbLightsSwap: false, userColor: '#a78bfa', expression: null, audioOutput: '', recordTakes: false, sheet: false, camCalib: { a: { x: 0.1, y: 0.8 }, b: { x: 0.9, y: 0.8 } }, freeScale: { root: 0, idx: 0 } },
      days: { '2026-11-06': 60.5 }, recent: [{ file: 'imported:imp-a', at: 1700000000000 }],
      'guided.progress.song': { '1-4': { 'right.PLAY.60': { passed: true, best: 0.9, tries: 2 } } },
      'guided.weak.song': { 0: 2 }, 'guided.section.song': '1-4', 'guided.mode': 'wait', 'guided.hand': 'both', 'guided.rate': 0.8,
      'streak.count': 4, 'streak.last': null, 'best.song': 5, 'game.quiz': 3, 'lesson.first.PRACTISE': 2,
      'exercise.major.0.both': 4, 'exercise.major.0.both.bpm': 80, 'fav.song': true,
      'lessonwatched.first': true, 'lessonpractised.first': false, onboarded: true, audioSafeBuffer: 1, supportOfferSeen: 1,
      betaNoticeSeen: true,
      futureSetting: { preserved: true }
    }
    Object.assign(values.settings, {
      tourDone: true, kbMidiSeen: true, kbOwnColours: { serial: { values: { 34: 123 }, written: { 34: 0 }, dirty: true, at: 1 } },
      experience: 'new', handGuide: 'auto', handGuideRuns: 2, glide: true, waitStyle: 'breathe', nextStyle: 'pulse',
      tvSetup: 'cable', tvDelayBySetup: { airplay: 160, cable: 10 }, tvDelayMs: 160,
      tvSound: 'phone', tvPhoneNotes: true, tvCalibOffered: true
    })
    for (const overrides of [{}, { settings: {}, days: {}, recent: [], 'guided.progress.song': {}, 'guided.weak.song': {}, 'guided.section.song': null, 'streak.last': '2026-11-06' }]) {
      const entries = Object.fromEntries(Object.entries({ ...values, ...overrides }).map(([key, value]) => ['lumi.' + key, JSON.stringify(value)]))
      const result = await createBackup({ songs: library(), storage: new MemoryStorage(entries) })
      assert.deepEqual(result.skipped, [])
      const storage = new MemoryStorage(), saved = []
      await restoreInto(asFile(result.blob), storage, saved)
      assert.deepEqual(storage.snapshot(), entries)
      assert.deepEqual(saved.map((song) => song.id), ['imp-a', 'imp-b'])
    }
  })

  const refusals = [
    ['another file', () => new File([new TextEncoder().encode('PK\u0003\u0004 not a backup at all')], 'x.zip'), /not a Keylight backup/],
    ['a cut-off file', async () => new File([(await made.blob.arrayBuffer()).slice(0, made.blob.size - 10)], 'x'), /damaged|incomplete/],
    ['extra bytes at the end', () => new File([made.blob, new Uint8Array([0])], 'x'), /bytes no song uses/],
    ['a header claiming a huge manifest', () => forge(goodManifest([]), undefined, 0xffffffff), /damaged|incomplete/],
    ['a newer version', () => forge({ ...goodManifest([]), version: VERSION + 1 }), /newer Keylight/],
    ['a note out of range', () => forge(goodManifest([{ ...record('imp-z'), notes: [{ pitch: 200, start: 0, dur: 1, hand: 'right' }] }])), /Note 1 /],
    ['an SVG cover', () => forge(goodManifest([{ ...record('imp-z'), cover: 'data:image/svg+xml;base64,PHN2Zz4=' }])), /cover/],
    ['a script cover', () => forge(goodManifest([{ ...record('imp-z'), cover: 'javascript:alert(1)' }])), /cover/],
    ['an unsafe id', () => forge(goodManifest([record('../x')])), /valid id/],
    ['the same song twice', () => forge(goodManifest([record('imp-z'), record('imp-z')])), /twice/],
    ['a recording that is not audio', () => forge(goodManifest([audioSong({ offset: 0, size: 1, type: 'text/html', name: 'a' })]), new Uint8Array(1)), /not audio/],
    ['a recording past the end', () => forge(goodManifest([audioSong({ offset: 0, size: 99, type: 'audio/mpeg', name: 'a' })]), new Uint8Array(1)), /damaged|incomplete/],
    ['recordings that overlap', () => forge(goodManifest([audioSong({ offset: 0, size: 1, type: '', name: 'a' }), { ...audioSong({ offset: 0, size: 1, type: '', name: 'b' }), id: 'imp-y' }]), new Uint8Array(2)), /recording is not valid/],
    ['a setting of another app', () => forge({ ...goodManifest([]), storage: { 'other.app': '1' } }), /does not use/],
    ['a setting that is not JSON', () => forge({ ...goodManifest([]), storage: { 'lumi.settings': '{oops' } }), /not valid/],
    ['a song list that is not a list', () => forge({ ...goodManifest([]), songs: { length: 1 } }), /song list/]
  ]
  for (const [label, make, message] of refusals) {
    await check('refuses ' + label + ', writing nothing', async () => {
      const storage = new MemoryStorage({ 'lumi.streak.count': '9' })
      const before = storage.snapshot()
      const saved = []
      let asked = false
      await assert.rejects(restoreBackup(await make(), { storage, confirm: () => { asked = true; return true }, saveSongs: async (s) => saved.push(...s) }),
        (e) => e instanceof BackupError && message.test(e.message))
      assert.equal(asked, false)
      assert.deepEqual(storage.snapshot(), before)
      assert.deepEqual(saved, [])
    })
  }

  const courseJson = (lessons, exams = '{}') => '{"version":1,"lessons":' + lessons + ',"exams":' + exams + ',"unlocked":[2],"seconds":120}'
  const rec = '{"accuracy":0.9,"stars":3,"tries":2,"at":1700000000000}'
  await check('a populated lumi.course progress round-trips through a backup', async () => {
    const value = courseJson('{"l1-find-c":{"a":' + rec + ',"b":' + rec + '}}', '{"l1-exam":{"percent":88,"passed":true,"tries":1,"at":1700000000000,"placement":false}}')
    const entries = { 'lumi.course': value }
    const result = await createBackup({ songs: library(), storage: new MemoryStorage(entries) })
    assert.deepEqual(result.skipped, [])
    const storage = new MemoryStorage(), saved = []
    await restoreInto(asFile(result.blob), storage, saved)
    assert.deepEqual(storage.snapshot(), entries)
  })
  for (const bad of ['__proto__', 'constructor', 'prototype']) {
    for (const [where, value] of [
      ['a lesson id', courseJson('{"' + bad + '":{"x":' + rec + '}}')],
      ['an item id', courseJson('{"l1":{"' + bad + '":' + rec + '}}')],
      ['an exam id', courseJson('{}', '{"' + bad + '":{"percent":50,"passed":false,"tries":1,"at":1}}')]
    ]) {
      await check('refuses ' + bad + ' as ' + where + ' in lumi.course, writing nothing', async () => {
        const storage = new MemoryStorage({ 'lumi.streak.count': '9' })
        const before = storage.snapshot()
        await assert.rejects(restoreInto(forge({ ...goodManifest([]), storage: { 'lumi.course': value } }), storage, []), (e) => e instanceof BackupError && /not valid/.test(e.message))
        assert.deepEqual(storage.snapshot(), before)
        assert.equal(Object.prototype.l1, undefined)
      })
    }
  }

  await check('a song that would not restore is named, not dropped quietly', async () => {
    const storage = new MemoryStorage({ 'lumi.days': 'not json' })
    const r = await createBackup({ songs: [record('imp-a'), { ...record('imp-b'), title: 'Broken', notes: [] }], storage })
    assert.equal(r.songs, 1)
    assert.deepEqual(r.skipped.map((s) => s.title), ['Broken', 'lumi.days'])
  })

  // ---------- size limit and "progress only" ----------
  const { createProgressOnlyBackup, backupSize, RECORDINGS_TOO_LARGE } = backup
  const { SHARE_LIMIT_BYTES } = await import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'export-limit.js')).href)
  // a recording that only claims to be big: a Blob of that many zero bytes would need the memory
  const fakeBig = (size, name = 'big.m4a') => { const f = new File([bytes], name, { type: 'audio/mp4' }); Object.defineProperty(f, 'size', { value: size }); return f }
  const bigLibrary = () => [record('imp-a', { audio: fakeBig(200 * 1024 * 1024), source: 'audio', score: null }), record('imp-c', { audio: fakeBig(100 * 1024 * 1024, 'c.m4a'), source: 'audio', score: null }), record('imp-b')]

  await check('the size is worked out before the file is made', async () => {
    assert.equal(SHARE_LIMIT_BYTES, 256 * 1024 * 1024)
    const sizes = backupSize({ songs: bigLibrary(), storage: userStorage() })
    assert.equal(sizes.recordings, 2)
    assert.ok(sizes.full > SHARE_LIMIT_BYTES && sizes.withoutRecordings < 100000)
    assert.ok(sizes.full - sizes.withoutRecordings >= 300 * 1024 * 1024 && sizes.full - sizes.withoutRecordings < 300 * 1024 * 1024 + 2000)   // the recordings plus their manifest entries
    const small = backupSize({ songs: library(), storage: userStorage() })
    assert.equal(small.full, made.blob.size)
    assert.equal(small.recordings, 1)
  })

  await check('a backup over the limit leaves the recordings out, keeps everything else, and says so', async () => {
    const result = await createBackup({ songs: bigLibrary(), storage: userStorage(), maxBytes: SHARE_LIMIT_BYTES })
    assert.equal(result.notice, 'Your recordings are too large to include, so this backup has your progress, settings and songs but not the recordings.')
    assert.equal(result.notice, RECORDINGS_TOO_LARGE)
    assert.equal(result.recordingsIncluded, false); assert.equal(result.recordingsLeftOut, 2)
    assert.ok(result.blob.size <= SHARE_LIMIT_BYTES)
    assert.deepEqual(result.skipped, [])
    assert.equal(result.songs, 3); assert.equal(result.keys, 3)
    const plan = await readBackup(asFile(result.blob))
    assert.deepEqual(plan.songs.map((s) => [s.id, s.audio]), [['imp-a', null], ['imp-c', null], ['imp-b', null]])
    assert.deepEqual(plan.songs[2].notes, record('imp-b').notes)
    assert.equal(Object.keys(plan.storage).length, 3)
  })

  await check('a backup under the limit keeps its recordings and gives no notice', async () => {
    const result = await createBackup({ songs: library(), storage: userStorage(), maxBytes: SHARE_LIMIT_BYTES })
    assert.equal(result.notice, ''); assert.equal(result.recordingsIncluded, true); assert.equal(result.recordingsLeftOut, 0)
    assert.equal(result.blob.size, made.blob.size)
    // no limit given: the same big library keeps its recordings (a desktop backup)
    const sizes = backupSize({ songs: bigLibrary(), storage: userStorage() })
    assert.equal(made.recordingsIncluded, true); assert.equal(made.notice, '')
    assert.ok(sizes.full > SHARE_LIMIT_BYTES)
  })

  await check('"progress only" is a choice: no recordings, notes and progress kept, and it restores', async () => {
    const result = await createProgressOnlyBackup({ songs: library(), storage: userStorage() })
    assert.equal(result.recordingsIncluded, false); assert.equal(result.recordingsLeftOut, 1)
    assert.equal(result.notice, 'This backup has your progress, settings and songs but not the recordings.')
    assert.ok(result.blob.size < made.blob.size)
    const storage = new MemoryStorage(), saved = []
    const r = await restoreInto(asFile(result.blob), storage, saved)
    assert.deepEqual(r, { restored: true, songs: 2, keys: 3 })
    assert.deepEqual(saved.map((s) => s.audio), [null, null])
    assert.equal(storage.getItem('lumi.streak.count'), '4')
    // a library with no recordings has nothing to leave out, so no notice
    const none = await createProgressOnlyBackup({ songs: [record('imp-b')], storage: userStorage() })
    assert.equal(none.notice, ''); assert.equal(none.recordingsLeftOut, 0)
    // a song whose recording is over 1 GB is skipped in a full backup but kept (without it) in a progress-only one
    const huge = [record('imp-h', { audio: fakeBig(2 * 1024 ** 3, 'h.m4a'), source: 'audio', score: null })]
    assert.equal((await createBackup({ songs: huge, storage: userStorage() })).skipped.length, 1)
    assert.deepEqual((await createProgressOnlyBackup({ songs: huge, storage: userStorage() })).skipped, [])
  })

  await check('when even the lean backup is over the limit it refuses in plain words', async () => {
    await assert.rejects(createBackup({ songs: library(), storage: userStorage(), maxBytes: 100 }), (e) => e instanceof BackupError && /too large for one backup file/.test(e.message))
  })

  // ----- automatic backup (iPhone and iPad): backup.js runAutoBackup + the file type declared in ios/project.yml -----
  const { runAutoBackup, restorePrompt, AUTO_BACKUP_KEY, AUTO_BACKUP_INTERVAL_MS, AUTO_BACKUP_MAX_BYTES, EXTENSION } = backup
  const fakeHost = (opts = {}) => {
    const calls = [], chunks = []
    let size = 0
    const request = async (op, params = {}) => {
      calls.push(op)
      if (opts.failAt === op) throw new Error('host refused')
      if (op === 'autoBackupBegin') { size = params.size; return 'tok-12345678' }
      if (op === 'autoBackupChunk') { assert.equal(params.token, 'tok-12345678'); chunks.push(Buffer.from(params.data, 'base64')); return true }
      return true
    }
    return { request, calls, chunks, size: () => size, file: () => new File([Buffer.concat(chunks)], 'Keylight Backup.keylightbackup') }
  }
  const NOW = new Date(2026, 10, 22, 12, 0)

  await check('calibrated keyboard counts survive a backup and restore', async () => {
    const settings = { kbKeysFor: { small: 24, medium: 61, large: 88 }, volume: 0.5 }
    const storage = new MemoryStorage({ 'lumi.settings': JSON.stringify(settings) })
    const { blob } = await createBackup({ songs: [], storage })
    const dest = new MemoryStorage({})
    await restoreInto(asFile(blob), dest, [])
    assert.deepEqual(JSON.parse(dest.getItem('lumi.settings')), settings)
  })

  await check('the automatic backup is a progress-only backup sent in chunks that restores, and it keeps its time outside the backup', async () => {
    const storage = userStorage(), host = fakeHost()
    const result = await runAutoBackup({ listSongs: async () => library(), storage, request: host.request, now: NOW })
    assert.equal(result, 'saved')
    assert.equal(host.calls[0], 'autoBackupBegin'); assert.equal(host.calls.at(-1), 'autoBackupFinish')
    assert.ok(host.calls.filter((c) => c === 'autoBackupChunk').length >= 1)
    assert.ok(host.chunks.every((c) => c.length <= 32768), 'chunks stay under the host limit')
    assert.equal(Buffer.concat(host.chunks).length, host.size(), 'the announced size is the sent size')
    assert.ok(host.size() <= AUTO_BACKUP_MAX_BYTES)
    const plan = await readBackup(host.file())
    assert.equal(plan.songs.length, 2)
    assert.deepEqual(plan.songs.map((s) => s.audio), [null, null], 'no recordings')
    assert.equal(plan.storage['lumi.streak.count'], '4')
    assert.equal(storage.getItem(AUTO_BACKUP_KEY), String(NOW.getTime()))
    assert.ok(!AUTO_BACKUP_KEY.startsWith('lumi.') && !('keylight.autoBackupAt' in plan.storage), 'the time never travels inside a backup')
  })

  await check('the automatic backup waits 6 hours, and a clock set back counts as due', async () => {
    const storage = userStorage(), host = fakeHost()
    storage.setItem(AUTO_BACKUP_KEY, String(NOW.getTime() - AUTO_BACKUP_INTERVAL_MS + 1000))
    assert.equal(await runAutoBackup({ listSongs: async () => library(), storage, request: host.request, now: NOW }), 'skipped')
    assert.deepEqual(host.calls, [], 'nothing is sent while the last one is under 6 hours old')
    storage.setItem(AUTO_BACKUP_KEY, String(NOW.getTime() - AUTO_BACKUP_INTERVAL_MS))
    assert.equal(await runAutoBackup({ listSongs: async () => library(), storage, request: host.request, now: NOW }), 'saved')
    storage.setItem(AUTO_BACKUP_KEY, String(NOW.getTime() + 86400000))
    assert.equal(await runAutoBackup({ listSongs: async () => library(), storage, request: fakeHost().request, now: NOW }), 'saved')
  })

  await check('a page with no songs and no progress saves nothing (a fresh install must not push a good backup out)', async () => {
    const host = fakeHost()
    const fresh = new MemoryStorage({ 'lumi.onboarded': '1', 'lumi.settings': '{}', 'lumi.libview': '"grid"', 'lumi.support': '1', 'other.app': 'x' })
    assert.equal(await runAutoBackup({ listSongs: async () => [], storage: fresh, request: host.request, now: NOW }), 'nothing')
    assert.deepEqual(host.calls, []); assert.equal(fresh.getItem(AUTO_BACKUP_KEY), null)
    assert.equal(await runAutoBackup({ listSongs: async () => [], storage: new MemoryStorage({ 'lumi.streak.count': '2' }), request: fakeHost().request, now: NOW }), 'saved', 'progress alone is worth saving')
    assert.equal(await runAutoBackup({ listSongs: async () => [record('imp-b')], storage: fresh, request: fakeHost().request, now: NOW }), 'saved', 'an added song is worth saving')
  })

  await check('changing preferences and dismissing the beta notice never replace an existing backup', async () => {
    const settings = {
      tourDone: true, kbMidiSeen: true, kbOwnColours: {},
      experience: 'new', handGuide: 'auto', handGuideRuns: 2, glide: true, waitStyle: 'steady', nextStyle: 'pulse',
      tvSetup: 'cable', tvDelayBySetup: { cable: 10 }, tvSound: 'muted', tvPhoneNotes: true, tvCalibOffered: true
    }
    const storage = new MemoryStorage({ 'lumi.settings': JSON.stringify(settings), 'keylight.store-status.v1': '{}' })
    const host = fakeHost()
    const run = () => runAutoBackup({ listSongs: async () => [], storage, request: host.request, now: NOW })
    assert.equal(await run(), 'nothing')
    storage.setItem('lumi.betaNoticeSeen', 'true')
    assert.equal(await run(), 'nothing')
    assert.deepEqual(host.calls, [])
    assert.equal(storage.getItem(AUTO_BACKUP_KEY), null)
  })

  await check('only meaningful course progress triggers a backup', async () => {
    const { COURSE, emptyProgress, recordItemResult, recordExamResult } = await import('../renderer/course/index.js')
    const [level] = COURSE.levels, [lesson] = level.lessons, [item] = lesson.items
    const backupCourse = (progress, host) => runAutoBackup({ listSongs: async () => [], request: host.request, now: NOW,
      storage: new MemoryStorage({ 'lumi.courseOrder': '"open"', 'lumi.course': JSON.stringify(progress) }) })
    const empty = emptyProgress(), host = fakeHost()
    for (const progress of [empty, { ...empty, placement: { state: 'skipped', lastPassed: 0 } },
      { ...empty, placement: { state: 'running', lastPassed: 0 } },
      { ...empty, placement: { state: 'done', lastPassed: 0 } },
      recordItemResult(empty, lesson.id, item.id, { accuracy: 0, stars: 0 })]) {
      assert.equal(await backupCourse(progress, host), 'nothing')
    }
    assert.deepEqual(host.calls, [])
    for (const progress of [recordItemResult(empty, lesson.id, item.id, { accuracy: 1, stars: 5 }),
      recordExamResult(empty, level.id, { percent: 100, passed: true }), { ...empty, unlocked: [2] },
      { ...empty, placement: { state: 'done', lastPassed: 1 } }]) {
      assert.equal(await backupCourse(progress, fakeHost()), 'saved')
    }
  })

  await check('auto-backup skips during restore and aborts a transfer that overlaps one', async () => {
    const storage = userStorage(), host = fakeHost()
    const file = asFile(made.blob)
    let ready, release
    const started = new Promise((resolve) => { ready = resolve })
    const pending = new Promise((resolve) => { release = resolve })
    const restore = () => restoreBackup(file, { storage, confirm: () => true, saveSongs: () => { ready(); return pending } })
    const run = (request) => runAutoBackup({ storage, listSongs: async () => library(), request, now: NOW })
    const restoring = restore()
    await started
    assert.equal(await run(host.request), 'skipped')
    assert.deepEqual(host.calls, [])
    release()
    await restoring
    assert.equal(await run(async (op, params) => {
      if (op === 'autoBackupChunk') await restore()
      return host.request(op, params)
    }), 'skipped')
    assert.deepEqual(host.calls, ['autoBackupBegin', 'autoBackupChunk', 'autoBackupAbort'])
    assert.equal(storage.getItem(AUTO_BACKUP_KEY), null)
  })

  await check('a host failure aborts the transfer, rethrows for the caller to drop, and keeps the old time', async () => {
    for (const failAt of ['autoBackupBegin', 'autoBackupChunk', 'autoBackupFinish']) {
      const storage = userStorage(), host = fakeHost({ failAt })
      await assert.rejects(runAutoBackup({ listSongs: async () => library(), storage, request: host.request, now: NOW }), /host refused/)
      assert.equal(storage.getItem(AUTO_BACKUP_KEY), null, failAt + ': no time kept, so the next hide tries again')
      assert.equal(host.calls.includes('autoBackupAbort'), failAt !== 'autoBackupBegin', failAt + ': an open transfer is aborted')
    }
    const storage = userStorage(); storage.full = AUTO_BACKUP_KEY            // the time cannot be written: still saved
    assert.equal(await runAutoBackup({ listSongs: async () => library(), storage, request: fakeHost().request, now: NOW }), 'saved')
  })

  await check('the backup file type is declared for iOS and the page agrees on it', async () => {
    const fs = require('node:fs')
    const root = path.join(__dirname, '..')
    assert.equal(EXTENSION, '.keylightbackup')
    const iosProject = path.join(root, 'ios', 'project.yml')
    if (fs.existsSync(iosProject)) {
      const yml = fs.readFileSync(iosProject, 'utf8')
      assert.match(yml, /UTExportedTypeDeclarations:[\s\S]*UTTypeIdentifier: org\.keylight\.piano\.backup[\s\S]*UTTypeConformsTo: \[public\.data\][\s\S]*public\.filename-extension: \[keylightbackup\]/)
      assert.match(yml, /CFBundleTypeName: Keylight backup[\s\S]*?- org\.keylight\.piano\.backup/)
      assert.match(yml, /UIFileSharingEnabled: true/); assert.match(yml, /LSSupportsOpeningDocumentsInPlace: true/)
    }
    const host = fs.readFileSync(path.join(root, 'renderer', 'ios-host.js'), 'utf8')
    assert.ok(host.includes(`const BACKUP_EXTENSION = '${EXTENSION}'`), 'ios-host.js uses the same extension as backup-format.js')
    assert.match(host, /visibilitychange[\s\S]*visibilityState !== 'hidden'/, 'the automatic backup runs when the page goes hidden')
    const picker = fs.readFileSync(path.join(root, 'renderer', 'backup.js'), 'utf8')
    assert.match(picker, /type: 'file', accept: EXTENSION/, 'the restore picker asks for the declared type')
  })

  await check('the restore question names the date, songs and entries', async () => {
    const text = restorePrompt({ created: new Date(2026, 10, 6).toISOString(), songs: [1, 2], storage: { a: 1 } })
    assert.match(text, /^Restore the backup from .+\?\n\n2 songs and 1 saved settings and progress entries are added\./)
  })

  console.log(`test-backup: ${n} checks passed`)
}
main().catch((e) => { console.error(e); process.exit(1) })
