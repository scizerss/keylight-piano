#!/usr/bin/env node
// Fetch Mutopia pieces politely: one request at a time, a pause between requests, generic User-Agent.
//   node tools/songs/fetch-mutopia.mjs info <id...>           print a JSON record per piece (no download)
//   node tools/songs/fetch-mutopia.mjs save <id...>           the same, and download the .mid into renderer/songs/
//   node tools/songs/fetch-mutopia.mjs list <ComposerCode|-> [Instrument=Piano] [maxPages=5] [searchText]
//                                                              list pieces (id, title, licence) from the search pages; composer codes are on https://www.mutopiaproject.org/browse.html
// Only .mid files are downloaded; nothing downloaded is ever executed. Licence is read from the
// piece page and mapped only when it is exactly one the library accepts; otherwise `licence` is null
// and `save` refuses. See tools/songs/README.md for the rules.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const UA = 'Mozilla/5.0 (compatible; song-library-tool)'
const DELAY_MS = 1500
const MAX_DEATH_YEAR = 1955
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function get(url, binary = false) {
  await sleep(DELAY_MS)
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`${res.status} for ${url}`)
  return binary ? Buffer.from(await res.arrayBuffer()) : res.text()
}

const unesc = (s) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/\s+/g, ' ').trim()

// The licence text on the page -> the library's licence value, or null when it is anything else.
export function mapLicence(text) {
  const t = unesc(text)
  if (/^Public Domain$/i.test(t)) return 'Public Domain'
  let m = /^Creative Commons Attribution-ShareAlike (\d\.\d)$/i.exec(t)
  if (m && ['1.0', '2.0', '2.5', '3.0', '4.0'].includes(m[1])) return 'CC BY-SA ' + m[1]
  m = /^Creative Commons Attribution (\d\.\d)$/i.exec(t)
  if (m && ['2.5', '3.0', '4.0'].includes(m[1])) return 'CC BY ' + m[1]
  return null
}

export function parsePiece(html, id) {
  const title = /<h2>([\s\S]*?)<\/h2>/.exec(html)?.[1]
  const by = /<h4>by ([\s\S]*?)<\/h4>/.exec(html)?.[1]
  const cell = (label) => new RegExp(`<b>${label}:?</b>\\s*([\\s\\S]*?)</td>`).exec(html)?.[1]
  const copyright = cell('Copyright')
  const years = by ? /\((\d{4})\s*[–-]\s*(\d{4})\)/.exec(unesc(by)) : null
  const mid = /href="([^"]+\.mid)"/.exec(html)?.[1]
  const licenceText = copyright ? unesc(copyright.split('&nbsp;')[0].replace(/<img[^>]*>/g, '')) : null
  return {
    mutopiaId: id,
    source: `https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=${id}`,
    title: title ? unesc(title) : null,
    composer: by ? unesc(by).replace(/\s*\(.*$/, '') : null,
    composerDied: years ? +years[2] : null,
    instrument: cell('Instrument\\(s\\)') ? unesc(cell('Instrument\\(s\\)')) : null,
    style: cell('Style') ? unesc(cell('Style')) : null,
    opus: cell('Opus') ? unesc(cell('Opus')) : null,
    licencePage: licenceText,
    licence: licenceText ? mapLicence(licenceText) : null,
    typesetter: cell('Maintainer') ? unesc(cell('Maintainer')) : null,
    midiUrl: mid || null,
  }
}

export async function pieceInfo(id) {
  return parsePiece(await get(`https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=${id}`), id)
}

async function listComposer(code, instrument = 'Piano', maxPages = 5, text = '') {
  const out = []
  for (let p = 0; p < maxPages; p++) {
    const html = await get(`https://www.mutopiaproject.org/cgibin/make-table.cgi?Composer=${code === '-' ? '' : encodeURIComponent(code)}&Instrument=${encodeURIComponent(instrument)}&timelength=1&startat=${p * 10}&searchingfor=${encodeURIComponent(text)}`)
    const blocks = html.split('<table class="table-bordered result-table">').slice(1)
    if (!blocks.length) break
    let n = 0
    for (const b of blocks) {
      const id = /piece-info\.cgi\?id=(\d+)/.exec(b)?.[1]
      if (!id) continue
      n++
      const tds = [...b.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => unesc(m[1]))
      out.push({ id: +id, title: tds[0], opus: tds[2], collection: tds[3], instrument: tds[4], licence: mapLicence(tds[tds.findIndex((t) => /^(Public Domain|Creative Commons)/.test(t))] || '') })
    }
    if (n < 10) break
  }
  return out
}

function destFor(rec) {
  const base = path.basename(new URL(rec.midiUrl).pathname).toLowerCase().replace(/[^\w.-]/g, '-')
  const dir = /^CC BY-SA/.test(rec.licence) ? 'mutopia-sa' : 'mutopia'
  return path.join(ROOT, 'renderer', 'songs', dir, `mutopia-${rec.mutopiaId}-${base}`)
}

const [cmd, ...args] = process.argv.slice(2)
if (import.meta.url === `file://${process.argv[1]}`) {
  if (cmd === 'list') {
    for (const r of await listComposer(args[0], args[1] || 'Piano', +args[2] || 5, args[3] || '')) console.log(JSON.stringify(r))
  } else if (cmd === 'info' || cmd === 'save') {
    for (const id of args) {
      const rec = await pieceInfo(+id)
      const problems = []
      if (!rec.licence) problems.push('licence not accepted: ' + rec.licencePage)
      if (!rec.typesetter) problems.push('no maintainer on page')
      if (!rec.midiUrl) problems.push('no .mid link')
      if (!rec.composerDied || rec.composerDied > MAX_DEATH_YEAR) problems.push('composer death year not <= ' + MAX_DEATH_YEAR)
      // exact allowlist: anything else (duet, four hands, piano with another instrument or voice) is refused
      if (!/^(Piano|Harpsichord|Keyboard|Clavichord|Harpsichord, Piano|Piano, Harpsichord)$/i.test(String(rec.instrument || '').trim())) problems.push('instrument not solo keyboard: ' + rec.instrument)
      rec.problems = problems
      if (cmd === 'save' && !problems.length) {
        const file = destFor(rec)
        if (!/\.mid$/.test(rec.midiUrl)) throw new Error('only .mid is downloaded')
        const buf = await get(rec.midiUrl, true)
        if (buf.subarray(0, 4).toString('latin1') !== 'MThd') { rec.problems.push('download is not a MIDI file') } else {
          fs.writeFileSync(file, buf)
          rec.file = path.relative(path.join(ROOT, 'renderer', 'songs'), file)
          rec.bytes = buf.length
        }
      }
      console.log(JSON.stringify(rec))
    }
  } else {
    console.error('usage: fetch-mutopia.mjs info|save <id...>   |   list <ComposerCode> [Instrument] [maxPages]')
    process.exit(2)
  }
}
