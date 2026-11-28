// Lyrics and incoming files: node scripts/test-song-import.js
// MIDI lyric / karaoke events and MusicXML <lyric> into song.lyrics, the lyrics model (paste and tap along), the lyrics view's
// line and syllable selection, redo in the note editor, video files in the importer, and files arriving from the iOS host.
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const load = (f) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', f)).href)
let count = 0
const check = async (label, fn) => { await fn(); count++; process.stdout.write('ok ' + label + '\n') }

// ---------- a tiny MIDI writer: ticks 480 per beat, 120 bpm = 0.5 s per beat ----------
const vlq = (n) => { const out = [n & 0x7f]; while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80); return out }
const bytes = (s) => [...Buffer.from(s, 'latin1')]
function midi(tracks) {
  const chunks = tracks.map((events) => {
    const body = []
    let last = 0
    for (const e of [...events].sort((a, b) => a.tick - b.tick)) {
      body.push(...vlq(e.tick - last)); last = e.tick
      if (e.meta != null) { const data = typeof e.data === 'string' ? bytes(e.data) : e.data; body.push(0xff, e.meta, ...vlq(data.length), ...data) }
      else body.push(...e.raw)
    }
    body.push(0, 0xff, 0x2f, 0)
    return [0x4d, 0x54, 0x72, 0x6b, (body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255, ...body]
  })
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, 0x01, 0xe0]
  return Uint8Array.from([...head, ...chunks.flat()]).buffer
}
const note = (tick, pitch, len = 240) => [{ tick, raw: [0x90, pitch, 90] }, { tick: tick + len, raw: [0x80, pitch, 0] }]
const text = (tick, meta, data) => ({ tick, meta, data })

// ---------- a tiny XML DOM, enough for musicxml.js (Node has no DOMParser) ----------
function parseXml(src) {
  const root = { tagName: '#doc', children: [], attrs: {}, text: '', parent: null }
  let cur = root
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+)/g
  let m
  while ((m = re.exec(src))) {
    if (m[1]) cur = cur.parent
    else if (m[2]) {
      const el = { tagName: m[2], children: [], attrs: {}, text: '', parent: cur }
      for (const a of m[3].matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) el.attrs[a[1]] = a[2]
      cur.children.push(el)
      if (!m[4]) cur = el
    } else if (m[5]) cur.text += m[5]
  }
  const walk = (el) => {
    el.getAttribute = (n) => (n in el.attrs ? el.attrs[n] : null)
    el.hasAttribute = (n) => n in el.attrs
    Object.defineProperty(el, 'textContent', { get: () => el.text + el.children.map((c) => c.textContent).join('') })
    Object.defineProperty(el, 'nextElementSibling', { get: () => { const s = el.parent.children; return s[s.indexOf(el) + 1] || null } })
    const all = () => el.children.flatMap((c) => [c, ...c.querySelectorAll('*')])
    el.querySelectorAll = (sel) => {
      if (sel === '*') return all()
      const chain = sel.split('>').map((s) => s.trim())
      return all().filter((n) => {
        let x = n
        for (let i = chain.length - 1; i >= 0; i--) { if (!x || x === el || x.tagName !== chain[i]) return false; x = x.parent }
        return true
      })
    }
    el.querySelector = (sel) => el.querySelectorAll(sel)[0] || null
    el.children.forEach(walk)
  }
  walk(root)
  root.documentElement = root.children[0]
  return root
}
globalThis.DOMParser = class { parseFromString(s) { const d = parseXml(s); if (!d.documentElement) { d.querySelector = () => ({}); return d } return d } }

const xml = (lyrics) => `<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes><sound tempo="120"/>
${lyrics}</measure></part></score-partwise>`
const xn = (pitch, lyric) => `<note><pitch><step>${pitch}</step><octave>4</octave></pitch><duration>1</duration>${lyric}</note>`
const ly = (syllabic, t, n = '1') => `<lyric number="${n}"><syllabic>${syllabic}</syllabic><text>${t}</text></lyric>`

// fake DOM for the lyrics view
function fakeDocument() {
  const make = (tag) => {
    const el = {
      tag, children: [], dataset: {}, className: '', _text: '', hidden: false, attrs: {},
      classList: { set: new Set(), toggle(c, on) { on ? this.set.add(c) : this.set.delete(c) }, contains(c) { return this.set.has(c) } },
      setAttribute(k, v) { this.attrs[k] = v },
      append(...n) { this.children.push(...n) }, appendChild(n) { this.children.push(n); n.parent = this; return n },
      replaceChildren(...n) { this.children = n; this._text = '' }, remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this) },
      get textContent() { return this._text + this.children.map((c) => c.textContent).join('') }, set textContent(v) { this._text = v; this.children = [] }
    }
    return el
  }
  const doc = { createElement: make }
  const container = make('div'); container.ownerDocument = doc
  return container
}

;(async () => {
  const model = await load('lyrics-model.js')
  const { parseMidi } = await load('smf.js')
  const { parseMusicXml } = await load('musicxml.js')
  const view = await load('lyrics-view.js')

  await check('MIDI lyric events become timed syllables, words and lines', () => {
    const lyr = (tick, s) => text(tick, 0x05, s)
    const p = parseMidi(midi([
      [...note(0, 60, 1920), lyr(0, 'Twin'), lyr(480, 'kle '), lyr(960, 'twin'), lyr(1440, 'kle '), lyr(1920, '/Lit'), lyr(2400, 'tle '), lyr(2880, 'star')],
    ]))
    assert.deepEqual(p.lyrics.map((l) => [l.t, l.text, !!l.cont, !!l.nl]), [
      [0, 'Twin', true, false], [0.5, 'kle', false, false], [1, 'twin', true, false], [1.5, 'kle', false, false],
      [2, 'Lit', true, true], [2.5, 'tle', false, false], [3, 'star', false, false]])
    const lines = model.groupLyricLines(p.lyrics)
    assert.deepEqual(lines.map((l) => l.text), ['Twinkle twinkle', 'Little star'])
    assert.equal(lines[0].parts.length, 4)
  })

  await check('karaoke files: text events after the @KMIDI marker, @ info lines dropped, tempo respected', () => {
    const t = (tick, s) => text(tick, 0x01, s)
    const p = parseMidi(midi([
      [text(0, 0x01, '@KMIDI KARAOKE FILE'), text(0, 0x01, '@LENGL'), text(0, 0x01, '@TSong title')],
      [...note(0, 60, 960), t(0, '\\Hel'), t(480, 'lo '), t(960, 'world'), t(1440, '\r\n')]
    ]))
    assert.deepEqual(p.lyrics.map((l) => l.text), ['Hel', 'lo', 'world'])
    assert.equal(p.lyrics[0].nl, true)
    assert.equal(p.lyrics[1].t, 0.5)
    // plain text events (chord names) in an ordinary file are not lyrics
    assert.deepEqual(parseMidi(midi([[...note(0, 60), text(0, 0x01, 'Cmaj7'), text(480, 0x01, 'Fmaj7')]])).lyrics, [])
  })

  await check('no spaces anywhere: one word per event; a file with no lyrics gives []', () => {
    const p = parseMidi(midi([[...note(0, 60), text(0, 0x05, 'Hello'), text(480, 0x05, 'there')]]))
    assert.deepEqual(p.lyrics.map((l) => [l.text, !!l.cont]), [['Hello', false], ['there', false]])
    assert.deepEqual(parseMidi(midi([note(0, 60)])).lyrics, [])
  })

  await check('MusicXML lyrics: syllabic joined, verse 1 only, one part', () => {
    const p = parseMusicXml(xml(xn('C', ly('begin', 'Twin') + ly('begin', 'Ver', '2')) + xn('D', ly('end', 'kle') + ly('end', 'se', '2')) + xn('E', ly('single', 'star'))))
    assert.deepEqual(p.lyrics, [{ t: 0, text: 'Twin', cont: true }, { t: 0.5, text: 'kle' }, { t: 1, text: 'star' }])
    assert.equal(model.groupLyricLines(p.lyrics)[0].text, 'Twinkle star')
    assert.deepEqual(parseMusicXml(xml(xn('C', ''))).lyrics, [])
  })

  await check('lyrics survive into the song fields; old songs load without them', () => {
    const f = model.lyricFields([{ t: 0, text: 'Twin', cont: true }, { t: 0.5, text: 'kle' }, { t: 5, text: 'Bye' }])
    assert.equal(f.lyricsFromFile, true)
    assert.deepEqual(f.lyrics.synced.map((l) => l.text), ['Twinkle', 'Bye'])
    assert.equal(f.lyricWords.length, 3)
    assert.deepEqual(model.lyricFields([]), { lyricWords: null, lyrics: null, lyricsFromFile: false })
    assert.deepEqual(model.lyricsOfSong({ notes: [] }), [])
    assert.deepEqual(model.lyricsOfSong({ lyrics: { synced: [{ t: 1, text: 'la la' }] } }), [{ t: 1, text: 'la la', line: true }])
    assert.deepEqual(model.lyricsOfSong({ lyrics: { plain: 'x' } }), [])
    assert.equal(model.lyricsOfSong({ lyricWords: f.lyricWords, lyrics: f.lyrics }).length, 3)
    assert.deepEqual(model.sanitizeLyrics([{ t: -1, text: 'a' }, { t: 1, text: '' }, { t: NaN, text: 'b' }, null, { t: 2, text: ' ok ' }, { t: 1, text: 'first' }]).map((l) => l.text), ['first', 'ok'])
    assert.deepEqual(model.sanitizeLyrics('x'), [])
  })

  await check('grouping: gaps, sentence ends and long lines break; line-level lyrics stay as lines', () => {
    const w = (t, text) => ({ t, text })
    const l = model.groupLyricLines([w(0, 'one'), w(1, 'two.'), w(1.5, 'three'), w(10, 'four')])
    assert.deepEqual(l.map((x) => x.text), ['one two.', 'three', 'four'])
    const long = model.groupLyricLines(Array.from({ length: 30 }, (_, i) => w(i * 0.3, 'w' + i)))
    assert.ok(long.length >= 3 && long.every((x) => x.parts.length <= 12))
    const lines = model.groupLyricLines([{ t: 1, text: 'Hallelujah', line: true }, { t: 3, text: 'Hallelujah', line: true }])
    assert.equal(lines.length, 2); assert.equal(lines[0].timed, false)
    assert.equal(model.groupLyricLines([{ t: 1, text: 'one two three' }, { t: 4, text: 'four five' }]).length, 2)
  })

  await check('tap along: paste, tap per line, retime, nudge, clear, untap, serialise', () => {
    assert.throws(() => model.LyricsTapper.fromText('  \n\n '), /Paste some lyrics/)
    const tp = model.LyricsTapper.fromText('Line one\r\n\r\n  Line   two \nLine three\n')
    assert.equal(tp.count, 3); assert.equal(tp.lines[1].text, 'Line two')
    assert.equal(tp.tap(1.2344), 0); assert.equal(tp.tap(3), 1)
    assert.equal(tp.lines[0].t, 1.234)
    assert.equal(tp.next, 2); assert.equal(tp.complete, false)
    assert.equal(tp.tap(2.5), 2)                        // earlier than line 2: held to its neighbour
    assert.equal(tp.lines[2].t, 3); assert.equal(tp.tap(9), -1)
    assert.equal(tp.complete, true)
    assert.equal(tp.retime(1, 2), true); assert.equal(tp.lines[1].t, 2)
    assert.equal(tp.retime(1, 0.2), true); assert.equal(tp.lines[1].t, 1.234)   // not before line 0
    assert.equal(tp.nudge(1, 0.1), true); assert.equal(tp.lines[1].t, 1.334)
    assert.equal(tp.nudge(1, -0.1), true); assert.equal(tp.lines[1].t, 1.234)
    assert.equal(tp.nudge(0, -5), true); assert.equal(tp.lines[0].t, 0)
    assert.equal(tp.nudge(5, 0.1), false); assert.equal(tp.retime(1, NaN), false)
    assert.equal(tp.clear(1), true); assert.equal(tp.lines[1].t, null); assert.equal(tp.next, 1)
    assert.equal(tp.nudge(1, 0.1), false)
    assert.deepEqual(tp.toLyrics(), [{ t: 0, text: 'Line one', line: true }, { t: 3, text: 'Line three', line: true }])
    assert.equal(tp.tap(2), 1)                          // the cleared line takes the next tap
    assert.equal(tp.untap(), 1); assert.equal(tp.lines[1].t, null)
    tp.clearAll(); assert.equal(tp.timedCount, 0); assert.deepEqual(tp.toLyrics(), [])
    const again = model.LyricsTapper.fromLyrics([{ t: 0, text: 'Twin', cont: true }, { t: 0.5, text: 'kle' }])
    assert.equal(again.count, 1); assert.equal(again.lines[0].text, 'Twinkle')
    // what it serialises is valid lyrics for a song
    const t2 = model.LyricsTapper.fromText('a b\nc d'); t2.tap(1); t2.tap(2)
    assert.equal(model.lyricFields(t2.toLyrics()).lyrics.synced.length, 2)
  })

  await check('locateLine: before, during, after; syllable highlight', () => {
    const lines = model.groupLyricLines([{ t: 1, text: 'Twin', cont: true }, { t: 1.5, text: 'kle' }, { t: 2, text: 'star.' }, { t: 5, text: 'Next' }])
    assert.deepEqual(model.locateLine(lines, 0), { index: -1, next: 0, part: -1 })
    assert.deepEqual(model.locateLine(lines, 1.6), { index: 0, next: 1, part: 1 })
    assert.deepEqual(model.locateLine(lines, 2.4), { index: 0, next: 1, part: 2 })
    assert.equal(model.locateLine(lines, 5).index, 1)
    assert.equal(model.locateLine(lines, 50).index, -1)   // long after the last line
    const plain = model.groupLyricLines([{ t: 1, text: 'a b', line: true }, { t: 3, text: 'c d', line: true }])
    assert.equal(model.locateLine(plain, 1.5).part, -1)
    assert.deepEqual(model.locateLine([], 3), { index: -1, next: -1, part: -1 })
  })

  await check('lyrics view: hidden without lyrics, current and next line, syllables light up', () => {
    const container = fakeDocument()
    let now = 0
    const v = view.createLyricsView(container, { getTime: () => now, lyrics: [] })
    assert.equal(container.hidden, true)
    v.setLyrics([{ t: 1, text: 'Twin', cont: true }, { t: 1.5, text: 'kle' }, { t: 2, text: 'star.' }, { t: 5, text: 'Next line' }])
    assert.equal(container.hidden, false)
    const [cur, next] = v.element.children
    now = 0; v.update()
    assert.equal(cur.textContent, ''); assert.equal(next.textContent, 'Twinkle star.')
    assert.equal(v.element.dataset.state, 'waiting')
    now = 1.6; v.update()
    assert.equal(cur.textContent, 'Twinkle star.'); assert.equal(next.textContent, 'Next line')
    assert.deepEqual(cur.children.map((s) => [s.classList.contains('done'), s.classList.contains('on')]), [[true, false], [false, true], [false, false]])
    now = 2.1; v.update()
    assert.deepEqual(cur.children.map((s) => [s.classList.contains('done'), s.classList.contains('on')]), [[true, false], [true, false], [false, true]])
    now = 6; v.update()
    assert.equal(cur.textContent, 'Next line'); assert.equal(next.textContent, '')
    // line-level lyrics show whole lines, no syllables
    v.setLyrics([{ t: 1, text: 'Hello you', line: true }, { t: 3, text: 'Bye', line: true }])
    now = 1.5; v.update()
    assert.equal(cur.textContent, 'Hello you'); assert.equal(cur.children.length, 0); assert.equal(next.textContent, 'Bye')
    v.setLyrics([]); assert.equal(container.hidden, true)
    // follows the clock on frames, and stops
    let frames = 0, cb = null
    const w = view.createLyricsView(fakeDocument(), { getTime: () => now, lyrics: [{ t: 0, text: 'a', line: true }], raf: (f) => { cb = f; return ++frames }, caf: () => { cb = null } })
    w.start(); cb(); cb(); assert.ok(frames >= 3); w.stop(); assert.equal(cb, null)
    w.destroy()
  })

  await check('redo: undo then redo restores, a new change clears redo, both ways reach the original', async () => {
    const { NoteDraft } = await load('editor-model.js')
    const song = { title: 'T', importedId: 'imp-1', source: 'score', tempo: 100, duration: 4, notes: [{ pitch: 60, start: 0, dur: 1, vel: 90, hand: 'right' }, { pitch: 64, start: 1, dur: 1, vel: 90, hand: 'right' }] }
    const d = new NoteDraft(song)
    assert.equal(d.canRedo, false); assert.equal(d.redo(), false)
    const key = d.notes[0].key
    d.set(key, 'pitch', 'D4'); d.setTempo(120)
    assert.equal(d.notes[0].pitch, 62); assert.equal(d.tempo, 120)
    assert.equal(d.undo(), true); assert.equal(d.tempo, 100); assert.equal(d.notes[0].pitch, 62); assert.equal(d.canRedo, true)
    assert.equal(d.redo(), true); assert.equal(d.tempo, 120); assert.equal(d.canRedo, false)
    d.undo(); d.undo()
    assert.equal(d.notes[0].pitch, 60); assert.equal(d.dirty, false)
    d.redo(); assert.equal(d.notes[0].pitch, 62)
    d.undo(); d.add(); assert.equal(d.canRedo, false); assert.equal(d.redo(), false)
    const n = d.notes.length
    d.undo(); assert.equal(d.notes.length, n - 1); d.redo(); assert.equal(d.notes.length, n)
    // redo of a removal
    d.remove(d.notes[0].key); d.undo(); d.redo(); assert.equal(d.notes.length, n - 1)
    // lyrics ride along into the built song
    const built = new NoteDraft({ ...song, lyricWords: [{ t: 0, text: 'a' }], lyrics: { synced: [{ t: 0, text: 'a' }] }, lyricsFromFile: true }).build().song
    assert.equal(built.lyricWords.length, 1); assert.equal(built.lyricsFromFile, true)
  })

  await check('importer: video files are accepted; decode failures read as sentences; .kar is a score', async () => {
    const imp = await load('importer.js')
    const f = (name, type = '') => ({ name, type })
    assert.equal(imp.isAudioFile(f('Clip.MP4')), true); assert.equal(imp.isAudioFile(f('x.mov', 'video/quicktime')), true)
    assert.equal(imp.isAudioFile(f('x', 'video/mp4')), true); assert.equal(imp.isAudioFile(f('x.mp3')), true)
    assert.equal(imp.isAudioFile(f('x.pdf')), false); assert.equal(imp.isAudioFile(f('x.webm', 'video/webm')), false)
    assert.equal(imp.isAudioFile(f('Recording.webm')), true); assert.equal(imp.isAudioFile(f('Recording.webm', 'audio/webm')), true)
    assert.equal(imp.isVideoFile(f('a.m4v')), true); assert.equal(imp.isVideoFile(f('a.m4a')), false)
    assert.equal(imp.isScoreFile(f('a.kar')), true)
    const ctx = { decodeAudioData: async () => { throw new Error('Unable to decode audio data') } }
    const file = (name) => ({ name, arrayBuffer: async () => new ArrayBuffer(8) })
    await assert.rejects(imp.decodeFileAudio(ctx, file('a.mp4')), /sound of this video could not be read.*Save just the audio/)
    await assert.rejects(imp.decodeFileAudio(ctx, file('a.mp3')), /audio file could not be read.*mp3, m4a or wav/)
    const ok = { decodeAudioData: async (b) => ({ duration: 1, b }) }
    assert.equal((await imp.decodeFileAudio(ok, file('a.mp4'))).duration, 1)
    await assert.rejects(imp.importFile(f('x.pdf'), { ctx: ok }), /Pick a MIDI, MusicXML, audio or video file/)
  })

  await check('incoming files: kinds, import through the handler or the importer, queue before listening, errors reported once', async () => {
    const inc = await load('incoming-file.js')
    const f = (name, type = '') => ({ name, type })
    assert.deepEqual(['a.mp3', 'a.mp4', 'a.mid', 'a.kar', 'a.mxl', 'a.lrc', 'a.pdf', 'a.webm'].map((n) => inc.incomingKind(f(n))), ['audio', 'video', 'score', 'score', 'score', 'lyrics', null, 'audio'])
    assert.equal(inc.incomingKind(null), null)
    await assert.rejects(inc.importIncoming(f('notes.pdf'), {}), /audio, video, MIDI and MusicXML/)
    const taken = []
    assert.equal(await inc.importIncoming(f('a.mp3'), { handle: async (x) => taken.push(x.name) }), null)
    assert.deepEqual(taken, ['a.mp3'])
    // listener: files queued before mount are taken at once, later ones on the event, one after another
    const target = new EventTarget()
    const queue = [f('early.mp3')]
    const entry = (file) => { queue.push(file); target.dispatchEvent(new Event('keylight-incoming-file')) }
    entry.take = () => queue.splice(0)
    target.keylightIncomingFile = entry
    const errors = [], order = []
    const stop = inc.mountIncomingFile({ target, handle: async (x) => { order.push('start ' + x.name); await new Promise((r) => setTimeout(r, 5)); order.push('end ' + x.name) }, onError: (m) => errors.push(m) })
    entry(f('late.mid')); entry(f('bad.pdf'))
    await new Promise((r) => setTimeout(r, 60))
    assert.deepEqual(order, ['start early.mp3', 'end early.mp3', 'start late.mid', 'end late.mid'])
    assert.equal(errors.length, 1); assert.match(errors[0], /bad\.pdf/)
    stop(); entry(f('after.mp3')); await new Promise((r) => setTimeout(r, 20))
    assert.equal(order.length, 4)
  })

  await check('every extension the iOS host allows is typed and accepted by the page; the lists agree', async () => {
    const fs = require('node:fs')
    const { INCOMING_MIME, incomingMime } = await load('incoming-types.js')
    const inc = await load('incoming-file.js')
    const iosSource = path.join(__dirname, '..', 'ios', 'Keylight', 'IncomingFiles.swift')
    if (fs.existsSync(iosSource)) {
      const swift = fs.readFileSync(iosSource, 'utf8')
      const block = /static let extensions: Set<String> = \[([\s\S]*?)\]/.exec(swift)[1]
      const native = [...block.matchAll(/"([a-z0-9]+)"/g)].map((m) => m[1])
      assert.ok(native.length >= 20)
      assert.deepEqual([...native].sort(), Object.keys(INCOMING_MIME).sort(), 'native allow-list and page type list differ')
    }
    for (const ext of Object.keys(INCOMING_MIME)) {
      const type = incomingMime('My song.' + ext.toUpperCase())
      assert.ok(type, ext + ' has no MIME type')
      assert.ok(inc.incomingKind({ name: 'My song.' + ext, type }), ext + ' is not accepted by the importer')
      assert.ok(inc.incomingKind({ name: 'My song.' + ext, type: '' }), ext + ' is not accepted by name alone')
    }
  })

  await check('the cap on a kept video recording is 60 MB (importFile itself needs the model, so it is not run here)', async () => {
    const imp = await load('importer.js')
    assert.equal(imp.MAX_KEPT_VIDEO, 60 * 1024 * 1024)
  })

  // ---------- big files, early length check, and the .mxl fallback inflater ----------
  const zlib = require('node:zlib')
  const crypto = require('node:crypto')

  await check('files over 100 MB are refused before anything is read', async () => {
    const imp = await load('importer.js')
    let touched = false
    const huge = (name, type) => ({ name, type, size: 100 * 1024 * 1024 + 1, arrayBuffer: async () => { touched = true; return new ArrayBuffer(8) }, slice: () => { touched = true; return new Blob([]) } })
    const message = 'This file is too large to add. The limit is 100 MB.'
    await assert.rejects(imp.importFile(huge('big.mp3', 'audio/mpeg'), { ctx: { decodeAudioData: async () => { touched = true } } }), { message })
    await assert.rejects(imp.importFile(huge('big.mid', 'audio/midi'), {}), { message })
    await assert.rejects(imp.importFile(huge('big.mp4', 'video/mp4'), {}), { message })
    await assert.rejects(imp.decodeFileAudio({ decodeAudioData: async () => { touched = true } }, huge('big.wav')), { message })
    assert.equal(touched, false)
    assert.doesNotThrow(() => imp.checkImportSize({ size: 100 * 1024 * 1024 }))
    assert.doesNotThrow(() => imp.checkImportSize({ name: 'no size given' }))
    assert.equal(imp.MAX_IMPORT_BYTES, 100 * 1024 * 1024)
  })

  await check('a recording that is too long is refused from its header, before decoding', async () => {
    const imp = await load('importer.js')
    assert.doesNotThrow(() => imp.checkImportDuration(null)); assert.doesNotThrow(() => imp.checkImportDuration(20 * 60))
    assert.throws(() => imp.checkImportDuration(20 * 60 + 1), /up to 20 minutes/)
    // a real WAV: 25 minutes of 8 kHz 8-bit mono, its length stated in the header
    const claimed = 8000 * 60 * 25
    const h = Buffer.alloc(44)
    h.write('RIFF', 0); h.writeUInt32LE(36 + claimed, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16)
    h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(8000, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34)
    h.write('data', 36); h.writeUInt32LE(claimed, 40)
    const file = new File([h, Buffer.alloc(claimed)], 'Long Talk.wav', { type: 'audio/wav' })
    assert.equal(Math.round((await imp.readTags(file)).duration), 1500)
    let decoded = false
    await assert.rejects(imp.importFile(file, { ctx: { decodeAudioData: async () => { decoded = true; return { duration: 1500 } } } }), /Recordings up to 20 minutes can be added/)
    assert.equal(decoded, false, 'decodeAudioData must not run')
    // a file whose header says nothing still has the check after decoding
    await assert.rejects(imp.importFile({ name: 'x.mp3', type: 'audio/mpeg', size: 10, arrayBuffer: async () => new ArrayBuffer(8) }, { ctx: { decodeAudioData: async () => ({ duration: 21 * 60 }) } }), /20 minutes/)
  })

  // a zip with deflated (or stored) entries: [name, bytes, method]
  const zipOf = (files) => {
    const locals = [], centrals = []
    let offset = 0
    for (const [name, data, method = 8] of files) {
      const packed = method === 8 ? zlib.deflateRawSync(data) : Buffer.from(data)
      const nm = Buffer.from(name)
      const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8)
      local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nm.length, 26)
      const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10)
      central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nm.length, 28); central.writeUInt32LE(offset, 42)
      locals.push(local, nm, packed); centrals.push(central, nm)
      offset += 30 + nm.length + packed.length
    }
    const cd = Buffer.concat(centrals)
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
    const out = Buffer.concat([...locals, cd, end])
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.length)
  }
  const container = '<?xml version="1.0"?><container><rootfiles><rootfile full-path="score.xml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>'
  const scoreXml = xml(xn('C', ly('single', 'la')) + xn('D', '')).repeat(1) + '<!-- ' + 'padding '.repeat(5000) + '-->'
  // runs fn with DecompressionStream removed, or present but refusing 'deflate-raw' (what an older Safari may do)
  const withStream = async (how, fn) => {
    const had = Object.getOwnPropertyDescriptor(globalThis, 'DecompressionStream')
    if (how === 'missing') globalThis.DecompressionStream = undefined
    if (how === 'unsupported') globalThis.DecompressionStream = class { constructor(format) { throw new TypeError('Unsupported compression format: ' + format) } }
    try { return await fn() } finally { if (had) Object.defineProperty(globalThis, 'DecompressionStream', had); else delete globalThis.DecompressionStream }
  }

  await check('inflate.js matches zlib on stored, fixed and dynamic blocks and on copies that overlap', async () => {
    const { inflateRaw } = await load('inflate.js')
    const samples = [Buffer.alloc(0), Buffer.from('a'), crypto.randomBytes(70000), Buffer.alloc(1_500_000, 7), Buffer.from(scoreXml.repeat(30)),
      Buffer.from('abcabcabcabc'.repeat(9000))]
    for (const sample of samples) {
      for (const options of [{ level: 0 }, { level: 1 }, { level: 9 }, { strategy: zlib.constants.Z_FIXED }, { strategy: zlib.constants.Z_HUFFMAN_ONLY }]) {
        assert.ok(Buffer.from(inflateRaw(zlib.deflateRawSync(sample, options))).equals(sample), `${sample.length} bytes, ${JSON.stringify(options)}`)
      }
    }
  })

  await check('inflate.js refuses damaged, cut-off and oversized data with a plain message', async () => {
    const { inflateRaw, InflateError } = await load('inflate.js')
    const good = zlib.deflateRawSync(Buffer.from(scoreXml))
    const refuses = (data, opts, tooLarge, pattern) => assert.throws(() => inflateRaw(data, opts), (e) => e instanceof InflateError && e.tooLarge === tooLarge && pattern.test(e.message))
    refuses(Buffer.from([0x07, 0xff, 0xff]), {}, false, /damaged/)                  // block type 3
    refuses(Buffer.from([0x01, 0x05, 0x00, 0x00, 0x00, 1, 2, 3, 4, 5]), {}, false, /damaged/)   // stored length does not match its check
    refuses(good.subarray(0, 20), {}, false, /ends too early/)
    refuses(new Uint8Array(0), {}, false, /ends too early/)
    refuses(zlib.deflateRawSync(Buffer.alloc(5_000_000)), { maxBytes: 1_000_000 }, true, /too large/)
    refuses(zlib.deflateRawSync(Buffer.alloc(2000), { level: 0 }), { maxBytes: 1000 }, true, /too large/)
    // a back-reference before the start of the output
    refuses(Buffer.from([0x03, 0x02]), {}, false, /damaged|ends too early/)
    // random bytes are never turned into output without an error or a bounded result
    for (let i = 0; i < 50; i++) {
      try { assert.ok(inflateRaw(crypto.randomBytes(300), { maxBytes: 100000 }).length <= 100000) } catch (e) { assert.ok(e instanceof InflateError) }
    }
  })

  await check('an .mxl opens through DecompressionStream, with it missing, and with deflate-raw unsupported', async () => {
    const imp = await load('importer.js')
    const archive = zipOf([['META-INF/container.xml', Buffer.from(container)], ['score.xml', Buffer.from(scoreXml)], ['notes.txt', Buffer.from('stored entry'), 0]])
    for (const how of ['native', 'missing', 'unsupported']) {
      await withStream(how, async () => {
        assert.equal(await imp.readMxl(archive), scoreXml, how)
        assert.equal(Buffer.from(await imp.unzip(archive).read('notes.txt')).toString(), 'stored entry', how + ' (stored)')
      })
    }
    // the whole importer: a real score inside an .mxl, read without DecompressionStream
    await withStream('missing', async () => {
      const mxl = zipOf([['META-INF/container.xml', Buffer.from(container)], ['score.xml', Buffer.from(xml(xn('C', ly('single', 'la')) + xn('D', '')))]])
      const song = await imp.importFile(new File([mxl], 'Someone - Little Song.mxl'), { lookup: false })
      assert.equal(song.source, 'score'); assert.equal(song.notes.length, 2)
    })
  })

  await check('a damaged or oversized .mxl entry fails in plain words on every path', async () => {
    const imp = await load('importer.js')
    const stored = zipOf([['score.xml', Buffer.from(scoreXml), 0]])
    const directory = stored.byteLength - 22 - 46 - 'score.xml'.length
    new DataView(stored).setUint32(directory + 20, 50 * 1024 * 1024 + 1, true)
    await assert.rejects(imp.readMxl(stored), /too large to open/)
    const good = Buffer.from(zipOf([['score.xml', Buffer.from(scoreXml)]]))
    const bad = Buffer.from(good)
    for (let i = 36; i < 36 + 40; i++) bad[i] ^= 0xa5           // scramble the start of the deflated data
    const cut = good.subarray(0, 36 + 10)
    const cutZip = Buffer.concat([cut, good.subarray(good.length - 76)])      // data cut, directory kept
    for (const how of ['native', 'missing', 'unsupported']) {
      await withStream(how, async () => {
        await assert.rejects(imp.readMxl(bad.buffer.slice(bad.byteOffset, bad.byteOffset + bad.length)), /damaged and could not be unpacked/, how)
        await assert.rejects(imp.readMxl(cutZip.buffer.slice(cutZip.byteOffset, cutZip.byteOffset + cutZip.length)), /damaged|Broken|No score/, how + ' cut')
      })
    }
    // a directory that claims a small size for 60 MB of zeros: counted while unpacking, on both paths
    const bomb = zipOf([['score.xml', Buffer.alloc(60 * 1024 * 1024)]])
    const forged = Buffer.from(bomb)
    const cd = forged.length - 22 - 46 - 'score.xml'.length
    forged.writeUInt32LE(1000, cd + 24)
    const forgedBuffer = forged.buffer.slice(forged.byteOffset, forged.byteOffset + forged.length)
    for (const how of ['native', 'missing']) await withStream(how, async () => { await assert.rejects(imp.readMxl(forgedBuffer), /too large to open/, how) })
  })

  console.log(`song import: ${count} checks ok`)
})().catch((e) => { console.error(e); process.exit(1) })
