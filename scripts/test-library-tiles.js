// The Songs grid and the Home rail reuse their tiles; they must still refresh when anything a tile shows changes.
// Runs the real functions from renderer/app.js in a vm with stubs: node scripts/test-library-tiles.js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')

;(async () => {
  const { coverSignature } = await import(pathToFileURL(path.join(__dirname, '..', 'renderer/cover-art.js')).href)
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/app.js'), 'utf8')
  const cut = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i > 0 && j > i, 'slice ' + a); return src.slice(i, j) }
  const code = cut('const libTiles = new Map()', 'function libTile(') + '\n' + cut('function refreshSongRail(', 'function renderLibrary()')
  const state = { premium: false, favs: new Set(), best: {}, built: 0, rail: { dataset: {}, children: [], replaceChildren() { this.children = [] }, appendChild(c) { this.children.push(c) } }, songs: [] }
  const ctx = vm.createContext({
    coverSignature, COVER_PRINTS: {}, libView: 'grid', premium: () => state.premium,
    isFav: (f) => state.favs.has(f), bestFor: (f) => state.best[f] || 0, levelName: (l) => l,
    libTile: (item) => ({ tile: item.file, n: ++state.built }), coverTile: (item) => ({ rail: item.file, fav: state.favs.has(item.file) }),
    $: () => state.rail, allSongs: () => state.songs
  })
  vm.runInContext(code + '\nthis.cached = libTileCached; this.prune = pruneLibTiles; this.refreshRail = refreshSongRail; this.tiles = libTiles', ctx)
  const notes = (n) => Array.from({ length: n }, (_, i) => ({ pitch: 50 + i, start: i, dur: 1, hand: 'right' }))
  const mine = { file: 'imp-1', id: 'imp-1', title: 'Mine', artist: 'Imported', imported: true, tempo: 100, notes: notes(30) }
  const built = { file: 'a.xml', title: 'A', artist: 'Bach', level: 'Easy' }

  // grid tiles: reused when nothing changed, rebuilt on a favourite, a score, and on edits that keep the note count
  const t1 = ctx.cached(mine)
  assert.equal(ctx.cached(mine), t1, 'unchanged: same tile')
  const edited = { ...mine, notes: notes(30).map((n, i) => (i === 4 ? { ...n, pitch: n.pitch + 7 } : n)) }
  assert.notEqual(ctx.cached(edited), t1, 'edited notes, same count: new tile')
  // far past the opening: a key-changing edit rebuilds the tile, one that changes nothing visual keeps it
  const longMine = { ...mine, file: 'imp-2', id: 'imp-2', notes: [...notes(60), ...Array.from({ length: 120 }, (_, i) => ({ pitch: 60 + [0, 2, 4, 5, 7, 9, 11][i % 7], start: 60 + i, dur: 1, hand: 'right' }))] }
  const tl = ctx.cached(longMine)
  assert.equal(ctx.cached({ ...longMine, notes: longMine.notes.map((n, i) => (i >= 60 ? { ...n, pitch: n.pitch + 12 } : n)) }), tl, 'edit past note 60, same key: tile kept')
  assert.notEqual(ctx.cached({ ...longMine, notes: longMine.notes.map((n, i) => (i >= 60 ? { ...n, pitch: n.pitch + 1 } : n)) }), tl, 'edit past note 60 that changes the key: new tile')
  const t2 = ctx.cached(edited)
  assert.equal(ctx.cached(edited), t2)
  assert.notEqual(ctx.cached({ ...edited, title: 'Renamed' }), t2, 'rename: new tile')
  const t3 = ctx.cached(built)
  state.favs.add('a.xml'); assert.notEqual(ctx.cached(built), t3, 'favourite: new tile')
  const t4 = ctx.cached(built)
  state.best['a.xml'] = 3; assert.notEqual(ctx.cached(built), t4, 'stars: new tile')

  // pruning: a deleted song leaves the cache even while a filter hides everything else
  assert.ok(ctx.tiles.has('imp-1') && ctx.tiles.has('a.xml'))
  ctx.prune([built])
  assert.ok(!ctx.tiles.has('imp-1') && ctx.tiles.has('a.xml'), 'deleted song purged')

  // Home rail: rebuilt on a favourite, an edit, a delete; untouched otherwise
  state.favs.clear(); state.songs = [built, mine]
  ctx.refreshRail()
  const first = state.rail.children
  assert.equal(first.length, 2)
  ctx.refreshRail(); assert.equal(state.rail.children, first, 'nothing changed: rail kept')
  state.favs.add('a.xml'); ctx.refreshRail()
  assert.notEqual(state.rail.children, first, 'favourite changed in Songs: rail refreshed')
  assert.equal(state.rail.children[0].fav, true)
  const second = state.rail.children
  state.songs = [built, edited]; ctx.refreshRail()
  assert.notEqual(state.rail.children, second, 'edited notes: rail refreshed')
  const third = state.rail.children
  state.songs = [built]; ctx.refreshRail()
  assert.notEqual(state.rail.children, third); assert.equal(state.rail.children.length, 1, 'deleted: rail refreshed')
  const lockedTile = ctx.cached(built), lockedRail = state.rail.children
  state.premium = true
  ctx.refreshRail()
  assert.notEqual(ctx.cached(built), lockedTile, 'purchase rebuilds the tile')
  assert.notEqual(state.rail.children, lockedRail, 'purchase rebuilds the Home rail')
  // Play through a song in Wait mode, then read its rating the way the Songs tile does.
  const { Player } = await import('../renderer/player.js')
  const { coverScoreFile } = await import('../renderer/importer.js')
  const progress = new Map()
  const noop = () => {}
  const finishCtx = vm.createContext({
    IS_IOS: true, HAS_COVERS: true, coverScoreFile,
    store: { get: (key, fallback) => progress.get(key) ?? fallback, set: (key, value) => progress.set(key, value) },
    stopBacking: noop, lyricsEditor: { isOpen: () => false }, guided: { onFinish: () => false },
    keysStayAt: () => null, noteHandGuideRun: noop, markCalm: noop,
    showResults: noop, celebrate: noop, renderLibrary: noop, renderRecent: noop, updateHome: noop, syncHudButtons: noop,
    importedSongs: [], gameMeta: null, lessonMeta: null, exerciseMeta: null, courseRun: null,
    setTimeout: noop, performance: { now: () => 0 }, lastPlayerAnnouncement: 0, PLAYER_ANNOUNCE_MS: 250,
    practisedKey: (id) => 'practised.' + id, renderLessons: noop
  })
  vm.runInContext(
    cut('function bestFor(', 'function coverHTML(') + cut('function onFinish(', '/* ============================== local progress'),
    finishCtx
  )
  const firstNote = notes(1)[0]
  const waitSong = { ...built, notes: [firstNote, { ...firstNote, hand: 'left' }], duration: 1 }
  const fakeClock = { currentTime: 0 }
  let result
  const player = new Player({ getCtx: () => fakeClock, onFinish: (summary) => { result = summary; finishCtx.onFinish(summary) } })
  Object.assign(finishCtx, { player, song: waitSong })
  player.load(waitSong)
  player.setMode('PRACTISE')
  player.setAdvancement('pauseAndSnap')
  assert.ok(player.startArmed())
  assert.equal(player.noteOn(waitSong.notes[0].pitch).kind, 'cold')
  fakeClock.currentTime = waitSong.duration + 1
  player.tick()
  assert.equal(result.totalNotesHit, 2, 'one key press credits both hands on the unison')
  assert.equal(result.missed, 0)
  assert.equal(result.starRating, 5, 'finished Wait run earns five stored-scale stars')
  assert.equal(finishCtx.bestFor(built.file), 5, 'Songs reads the stars earned in Wait mode')
  assert.equal(vm.runInContext('starsOffer(bestFor(song.file))', finishCtx), '3 of 3 stars')
  assert.equal(progress.has('lumi.bestacc.' + built.file), false, 'Wait does not replace timed accuracy')
  finishCtx.onFinish({ ...result, starRating: 1 })
  assert.equal(finishCtx.bestFor(built.file), 5, 'a lower score keeps the existing best')

  const cover = { file: 'imported:cover', coverRaw: true, coverArrangement: { difficulty: 'easy', keyRange: { lo: 48, hi: 71 } } }
  finishCtx.importedSongs = [cover]
  finishCtx.coverKeyRange = () => cover.coverArrangement.keyRange
  finishCtx.song = cover
  finishCtx.lessonMeta = { id: 'intro' }
  finishCtx.onFinish({ ...result })
  assert.equal(finishCtx.bestFor(cover.file), 0, 'lesson practice does not rate the song')
  finishCtx.lessonMeta = null
  finishCtx.onFinish({ ...result, mode: 'WATCH' })
  assert.equal(finishCtx.bestFor(cover.file), 0, 'Watch does not rate the song')
  finishCtx.onFinish({ ...result })
  assert.equal(finishCtx.bestFor(cover.file), 5, 'an imported cover keeps stars for its arrangement')
  assert.equal(progress.has('lumi.best.' + cover.file), false, 'cover stars use the arrangement key')
  console.log('song ratings OK: Wait saves stars for Songs, Watch and lesson practice leave them empty')
  console.log('library-tiles OK')
})().catch((e) => { console.error('library-tiles FAIL:', e.message); process.exit(1) })
