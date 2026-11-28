// Note games: a question on the screen, a key to find on the keyboard, one minute a round.
// Most answers count in any octave. "Every" mode asks for each matching key in the visible row.

export const NOTE_GAMES = [
  { id: 'find-the-key', name: 'Find the Key', sub: 'A note name appears: play it', kind: 'name' },
  { id: 'read-treble', name: 'Read the Treble', sub: 'Right-hand notes on the staff', kind: 'staff', clef: 'treble' },
  { id: 'read-bass', name: 'Read the Bass', sub: 'Left-hand notes on the staff', kind: 'staff', clef: 'bass' }
]

export const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const WHITE = [0, 2, 4, 5, 7, 9, 11]
const RANGE = { treble: [60, 81], bass: [40, 60] }   // middle C to high A, low E to middle C
export const ROUND_SECONDS = 60
export const HINT_AFTER_SECONDS = 5

export const pitchClass = (p) => ((p % 12) + 12) % 12

// Avoid repeating the last note when there is another to ask. rand: returns 0..1, for tests.
export function nextQuestion(game, last = null, rand = Math.random) {
  let pool
  if (game.kind === 'name') {
    pool = NOTE_NAMES.map((_, i) => 60 + i).filter((p) => !game.names || game.names.includes(NOTE_NAMES[pitchClass(p)]))
  }
  else {
    const [lo, hi] = RANGE[game.clef]
    pool = []
    for (let p = lo; p <= hi; p++) if (WHITE.includes(pitchClass(p))) pool.push(p)
  }
  const fresh = pool.filter((p) => !last || pitchClass(p) !== pitchClass(last.pitch))
  const choices = fresh.length ? fresh : pool
  const pitch = choices[Math.floor(rand() * choices.length) % choices.length]
  return { pitch, name: NOTE_NAMES[pitchClass(pitch)] }
}

export const isRight = (q, pitch) => pitchClass(pitch) === pitchClass(q.pitch)

export function matchingPitches(q, start, keys) {
  const matches = []
  for (let i = 0; i < keys; i++) if (isRight(q, start + i)) matches.push(start + i)
  return matches
}

// Right answers in a round, to stars.
const STAR_AT = [10, 18, 26, 34, 42]
export const starsFor = (score) => STAR_AT.filter((n) => score >= n).length

const staffStep = (p) => Math.floor(p / 12) * 7 + WHITE.indexOf(pitchClass(p))
// One note on a staff, as an SVG string. Natural notes only.
export function staffSvg(pitch, clef) {
  const gap = 22, left = 40, width = 420, top = 66
  const bottomStep = clef === 'treble' ? staffStep(64) : staffStep(43)   // E4, G2: the bottom lines
  const y = (step) => top + 4 * gap - (step - bottomStep) * (gap / 2)
  const step = staffStep(pitch), cx = left + 250
  const lines = []
  for (let i = 0; i < 5; i++) lines.push(`<line x1="${left}" x2="${left + width}" y1="${top + i * gap}" y2="${top + i * gap}"/>`)
  for (let s = bottomStep - 2; s >= step; s -= 2) lines.push(`<line x1="${cx - 26}" x2="${cx + 26}" y1="${y(s)}" y2="${y(s)}"/>`)
  for (let s = bottomStep + 10; s <= step; s += 2) lines.push(`<line x1="${cx - 26}" x2="${cx + 26}" y1="${y(s)}" y2="${y(s)}"/>`)
  const clefText = clef === 'treble'
    ? `<text x="${left + 6}" y="${top + 4 * gap + 2}" font-size="118">𝄞</text>`
    : `<text x="${left + 6}" y="${top + 3 * gap + 2}" font-size="82">𝄢</text>`
  return `<svg viewBox="0 0 500 ${top * 2 + 4 * gap}" role="img" aria-label="A note on the ${clef} staff">
    <g stroke="currentColor" stroke-width="2">${lines.join('')}</g>
    <g fill="currentColor" font-family="'Apple Symbols','Segoe UI Symbol','Noto Music',serif">${clefText}</g>
    <ellipse cx="${cx}" cy="${y(step)}" rx="14.5" ry="10.5" transform="rotate(-20 ${cx} ${y(step)})" fill="currentColor"/>
  </svg>`
}
