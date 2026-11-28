# Adding Mutopia pieces

The free library (`renderer/songs-mutopia.js`) is made of MIDI files from the
[Mutopia Project](https://www.mutopiaproject.org). Only Mutopia is a source: nothing from other sites.

## Rules (all must hold; if the page is unclear, skip the piece)

- **Licence**, read from the piece page itself, never guessed, exactly one of: Public Domain, CC BY 2.5 / 3.0 / 4.0,
  CC BY-SA 1.0 / 2.0 / 2.5 / 3.0 / 4.0. Prefer Public Domain. CC BY-SA files go in `renderer/songs/mutopia-sa/` and
  need `shareAlike: true`; keep them few. Any other licence (NonCommercial, "Copyright reserved", ...) is a no.
- **Composer died in 1955 or earlier** (more than 70 years ago, so also safe in the EU).
- **Solo piano, harpsichord or keyboard**: no duets, no voice, no accompaniment parts.
- **One complete piece or movement**, not an excerpt, a fragment or a whole book in one file.
- **Not already in the library** (check `mutopiaId` in `songs-mutopia.js`).
- **The MIDI must be usable**: it parses with `parseMidi` (`renderer/smf.js`) in Node, has notes, two or more parts so the
  hands can be told apart (all current files do), and a duration between 25 s and 12 min after `tempoScale`.
- Files are kept unmodified, named `mutopia-<piece id>-<original name>.mid`.

## Steps

1. Find ids: `node tools/songs/fetch-mutopia.mjs list <ComposerCode> [Piano] [maxPages] [searchText]`
   (composer codes are on https://www.mutopiaproject.org/browse.html, for example `BachJS`, `SchumannR`).
2. Check a piece without downloading: `node tools/songs/fetch-mutopia.mjs info <id...>`. It prints a JSON record with
   title, composer, instrument, licence, typesetter and a `problems` list (empty means it passes the rules above).
3. Download: `node tools/songs/fetch-mutopia.mjs save <id...>`. It refuses pieces with problems, fetches only the `.mid`,
   one request at a time with a pause and a generic User-Agent, and puts the file in the right folder. Nothing downloaded
   is ever executed.
4. Parse the file and look at it (duration, notes per second, hands). Delete it if it is broken or not what the page said.
5. Add an entry to `MUTOPIA_SONGS` in the same shape as its neighbours: `id`, `file`, `title`, `artist`, `composer`,
   `cover: 'covers/<id>.png'` (the picture need not exist), `level` (Level 1, Level 2, Beginner, Easy, Intermediate,
   Advanced, Virtuoso, graded honestly by speed, hand span and polyphony), `genre`, `era` (one of `ERAS`), `moods`
   (one or two of `MOODS`), `hands`, `tier`, `licence`, `typesetter`, `source`, `mutopiaId`.
6. Add a row to the right table of `LICENSES/mutopia-songs.md` (title, composer, licence, typesetter, source, file), keep
   the counts in the headings right, and make sure `THIRD_PARTY_NOTICES.md` names the licence.
7. Add a row to `docs/SONG-TEMPOS.md`. If the file's tempo gives a silly length, add `tempoScale` in the `TEMPO` table.
8. Regenerate cover fingerprints: `node tools/covers/prints.js` (it rewrites `renderer/cover-prints.js`).
9. Run `node scripts/test-song-licences.js`, `node scripts/test-song-tempos.js`, `node scripts/test-cover-art.js` and
   `node scripts/test-library-tiles.js`. All must pass.
