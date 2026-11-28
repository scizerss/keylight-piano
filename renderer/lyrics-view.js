// On-screen lyrics: the current line large, the next line dimmed, syllables lit as they pass when the lyrics carry word
// timing. Pure DOM, no dependency on the app: give it a container, the lyrics (see lyrics-model.js) and a clock.
//
//   const view = createLyricsView(container, { getTime: () => player.now(), lyrics: lyricsOfSong(song) })
//   view.start()                       // follows the clock on animation frames; view.stop() pauses it
//   view.setLyrics(other)              // a new song; an empty list hides the view
//   view.update()                      // one refresh now (after a seek, or when driving it yourself)
//   view.destroy()
// Styles are in lyrics.css (link it once). The container is hidden (hidden attribute) while there are no lyrics.
import { groupLyricLines, locateLine, sanitizeLyrics } from './lyrics-model.js'

export { groupLyricLines, locateLine }

export function createLyricsView(container, { getTime, lyrics = [], raf = globalThis.requestAnimationFrame, caf = globalThis.cancelAnimationFrame } = {}) {
  const doc = container.ownerDocument
  const root = doc.createElement('div')
  root.className = 'kl-lyrics'
  root.setAttribute('role', 'group')
  root.setAttribute('aria-label', 'Lyrics')
  const cur = doc.createElement('p'); cur.className = 'kl-lyric-cur'
  const next = doc.createElement('p'); next.className = 'kl-lyric-next'
  root.append(cur, next)
  container.appendChild(root)

  let lines = []
  let shown = null               // line index the "current" element shows (null: nothing yet)
  let spans = []                 // the current line's syllable elements
  let lit = -2                   // syllable lit last
  let handle = 0
  let running = false

  const fill = (el, line, withParts) => {
    el.replaceChildren()
    if (!line) return []
    if (!withParts || !line.timed) { el.textContent = line.text; return [] }
    return line.parts.map((part) => {
      const s = doc.createElement('span')
      s.className = 'kl-syl'
      s.textContent = part.text + (part.space ? ' ' : '')
      el.appendChild(s)
      return s
    })
  }

  function update() {
    if (!lines.length) return
    const now = Number(getTime())
    const at = locateLine(lines, Number.isFinite(now) ? now : 0)
    // before the first line starts, it waits dimmed as the "next" line (locateLine answers index -1, next 0)
    const index = at.index, upcoming = at.next
    if (index !== shown) {
      shown = index
      spans = fill(cur, lines[index], true)
      lit = -2
      root.dataset.state = index >= 0 ? 'singing' : 'waiting'
    }
    if (next.dataset.line !== String(upcoming)) {
      next.dataset.line = String(upcoming)
      fill(next, upcoming >= 0 ? lines[upcoming] : null, false)
    }
    if (spans.length && at.part !== lit) {
      for (let i = 0; i < spans.length; i++) {
        spans[i].classList.toggle('done', i < at.part)
        spans[i].classList.toggle('on', i === at.part)
      }
      lit = at.part
    }
  }

  const tick = () => { if (!running) return; update(); handle = raf(tick) }

  const api = {
    element: root,
    get lines() { return lines },
    setLyrics(next_) {
      lines = groupLyricLines(sanitizeLyrics(next_))
      shown = null; lit = -2; spans = []
      cur.replaceChildren(); next.replaceChildren(); delete next.dataset.line
      container.hidden = lines.length === 0
      root.hidden = lines.length === 0
      update()
    },
    update,
    start() { if (!running && lines.length && raf) { running = true; handle = raf(tick) } },
    stop() { running = false; if (handle && caf) caf(handle); handle = 0 },
    destroy() { api.stop(); root.remove() }
  }
  api.setLyrics(lyrics)
  return api
}
