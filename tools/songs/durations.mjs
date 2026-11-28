// Adds the length of every Mutopia song missing from renderer/song-durations.js (existing values are kept).
//   node tools/songs/durations.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseMidi } from '../../renderer/smf.js'
import { normalise } from '../../renderer/songloader.js'
import { MUTOPIA_SONGS, applyTempoScale } from '../../renderer/songs-mutopia.js'
import { SONG_SECONDS } from '../../renderer/song-durations.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const out = path.join(root, 'renderer', 'song-durations.js')
const added = []
for (const s of MUTOPIA_SONGS) {
  if (s.file in SONG_SECONDS) continue
  const bytes = fs.readFileSync(path.join(root, 'renderer', 'songs', s.file))
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  let song = normalise(s.title, parseMidi(buf))
  if (s.tempoScale) song = applyTempoScale(song, s.tempoScale) || song
  const secs = Math.round(song.duration)
  if (!(secs > 0)) throw new Error('no duration for ' + s.file)
  added.push(`'${s.file}': ${secs}`)
}
if (added.length) {
  const src = fs.readFileSync(out, 'utf8')
  const end = src.lastIndexOf('}')
  const lines = []
  for (let i = 0; i < added.length; i += 3) lines.push('  ' + added.slice(i, i + 3).join(', '))
  fs.writeFileSync(out, src.slice(0, end).replace(/\s*$/, '') + ',\n' + lines.join(',\n') + '\n}\n')
}
console.log(`durations: ${added.length} added`)
