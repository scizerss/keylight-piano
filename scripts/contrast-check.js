// Run by hand: node scripts/contrast-check.js. Reads the colour tokens in renderer/tokens.css (the first :root block) and checks the
// pairs the design relies on against WCAG 2.2 (docs/DESIGN-DIRECTION.md 6.1). Translucent tokens are blended over the surface they sit on.
// Exits 1 when a pair is under its target.
const { readFileSync } = require('node:fs')
const path = require('node:path')
function readTokens(file, selector) {
  const css = readFileSync(path.join(__dirname, '..', 'renderer', file), 'utf8')
  const start = css.indexOf(selector + ' {')
  if (start < 0) throw new Error('cannot find ' + selector + ' in ' + file)
  const block = css.slice(start, css.indexOf('\n}', start))
  return Object.fromEntries(Array.from(block.matchAll(/--([\w-]+):\s*([^;]+?);/g), (m) => [m[1], m[2].trim()]))
}
const desktop = readTokens('tokens.css', ':root')
const ios = { ...desktop, ...readTokens('ios.css', 'html.ios') }
function parse(raw, v, depth = 0) {
  v = String(v).trim()
  const ref = v.match(/^var\(--([\w-]+)\)$/)
  if (ref && depth < 5) return parse(raw, raw[ref[1]], depth + 1)
  let m = v.match(/^#([0-9a-f]{6})$/i)
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1)
  m = v.match(/^rgba?\(([^)]+)\)$/)
  if (m) { const p = m[1].split(',').map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1] }
  throw new Error('cannot read colour: ' + v)
}
const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1)
const lum = (c) => { const [r, g, b] = c.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
const tok = (raw, name, on) => { const c = parse(raw, raw[name]); return c[3] < 1 ? over(c, on) : c }

// [foreground token, background token, minimum ratio, what it is]
const pairs = [
  ['text', 'bg', 7, 'body text on the page'], ['text', 'surface', 7, 'body text on a card'],
  ['muted', 'bg', 4.5, 'secondary text on the page'], ['muted', 'surface', 4.5, 'secondary text on a card'], ['muted', 'surface-2', 4.5, 'secondary text in a row'],
  ['faint', 'bg', 4.5, 'captions on the page'], ['faint', 'surface', 4.5, 'captions on a card'], ['faint', 'surface-2', 4.5, 'captions in a row'],
  ['accent', 'bg', 4.5, 'accent text and links'], ['accent', 'surface', 4.5, 'accent text on a card'], ['ink', 'accent', 4.5, 'text on the accent button'],
  ['ink', 'accent-hover', 4.5, 'text on the pressed accent button'], ['bad', 'surface', 4.5, 'error text'], ['warn', 'surface', 4.5, 'warning text'],
  ['right', 'bg', 3, 'right-hand colour (graphics)'], ['left', 'bg', 3, 'left-hand colour (graphics)'], ['accent', 'surface-3', 3, 'switch and radio on a raised control'],
  ['star', 'surface', 3, 'earned star (graphics)']
]
const iosPairs = [
  // Illuminated Studio tokens (docs/DESIGN-ILLUMINATED-STUDIO.md)
  ['text', 'surface-2', 7, 'ivory on a raised key'], ['text', 'surface-3', 7, 'ivory on the segment thumb'],
  ['muted', 'surface-3', 4.5, 'secondary text on the segment thumb'],
  ['ok', 'bg', 4.5, 'emerald text (connected, passed)'], ['ok', 'surface', 4.5, 'emerald text on a card'], ['ink', 'ok', 4.5, 'ink on the emerald complete mark'],
  ['alert-text', 'bg', 4.5, 'error text on the page'], ['alert-text', 'surface', 4.5, 'error text on a card'], ['alert-text', 'surface-2', 4.5, 'error text in a row'],
  ['left', 'surface', 3, 'cobalt light on a card (graphics)'], ['right', 'surface', 3, 'amber light on a card (graphics)'],
  ['left', 'surface-2', 3, 'cobalt focus ring on a raised key (graphics)'], ['star', 'surface-2', 3, 'star on a raised key (graphics)'],
  ['ink', 'accent-deep', 4.5, 'ink on the pressed ivory button'], ['ink', 'right', 4.5, 'ink on a lit amber key'],
  ['faint', 'surface-3', 4.5, 'captions in raised controls'],
  ['accent', 'accent-soft', 4.5, 'tinted buttons on a raised surface'],
  ['switch-on', 'surface', 3, 'on switch track in a group'],
  ['control-outline', 'surface', 3, 'off switch boundary in a group']
]
let bad = 0
for (const [label, raw, checks, base] of [
  ['Default', desktop, pairs, 'bg'],
  ['iOS', ios, [...pairs, ...iosPairs], 'surface-3']
]) {
  console.log(label)
  for (const [fg, bg, min, what] of checks) {
    const back = tok(raw, bg, parse(raw, raw[base]))
    const r = ratio(tok(raw, fg, back), back)
    const ok = r >= min
    if (!ok) bad++
    console.log((ok ? 'ok   ' : 'FAIL ') + r.toFixed(2).padStart(5) + ' (min ' + min + ')  ' + fg + ' on ' + bg + ' : ' + what)
  }
}
// Home key-light rail: the hero's words sit over the strongest light a plume can leave there. A plume is drawn at the engine cap
// (home-light.js) and the canvas mask lets a third through where the title sits (ios.css); both hand colours are tried, on the page and on
// the raised card colour, and the title (ivory), the subtitle (muted) and the caption (faint) must keep their ratios.
{
  const lightSrc = readFileSync(path.join(__dirname, '..', 'renderer', 'home-light.js'), 'utf8')
  const iosCss = readFileSync(path.join(__dirname, '..', 'renderer', 'ios.css'), 'utf8')
  const cap = Number((lightSrc.match(/cap: ([\d.]+)/) || [])[1])
  const mask = Number((iosCss.match(/\.key-light-canvas \{[^}]*?rgba\(0, 0, 0, (\.\d+)\) 62%/) || [])[1])
  if (!(cap > 0 && cap <= 1 && mask > 0 && mask <= 1)) throw new Error('cannot read the rail cap or mask')
  console.log('iOS Home rail (plume alpha at the title: ' + (cap * mask).toFixed(2) + ', limit .35)')
  if (cap * mask > 0.35) { bad++; console.log('FAIL plume alpha behind the title is over .35') }
  for (const [name, rgb] of [['cobalt', [134, 182, 255]], ['amber', [255, 138, 61]]]) {
    const page = parse(ios, ios.bg), plumed = over([...rgb, cap * mask], page)
    // the Home light field (#ambient) sits under the plume: its strongest pool (ios.css) plus the plume on top is the worst case
    const peak = Number((iosCss.match(/var\(--c1, #86b6ff\) (\d+)%/) || [])[1]) / 100
    const both = over([...rgb, cap * mask], over([...rgb, peak], page))
    for (const [fg, min, what, back, label] of [
      ['text', 7, 'title', plumed, ' plume'], ['muted', 4.5, 'subtitle', plumed, ' plume'], ['muted', 4.5, 'caption (hero meta)', plumed, ' plume'],
      ['text', 7, 'title', both, ' plume on its ambient pool'], ['muted', 4.5, 'subtitle', both, ' plume on its ambient pool'], ['muted', 4.5, 'caption (hero meta)', both, ' plume on its ambient pool']
    ]) {
      const r = ratio(tok(ios, fg, back), back)
      const ok = r >= min
      if (!ok) bad++
      console.log((ok ? 'ok   ' : 'FAIL ') + r.toFixed(2).padStart(5) + ' (min ' + min + ')  ' + what + ' over a ' + name + label)
    }
  }
}
console.log(bad ? bad + ' pair(s) under target' : 'contrast: all ' + (pairs.length * 2 + iosPairs.length) + ' pairs pass')
process.exit(bad ? 1 : 0)
