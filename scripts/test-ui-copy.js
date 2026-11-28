const { readdirSync, readFileSync } = require('node:fs')
const { join, relative } = require('node:path')

const root = join(__dirname, '..', 'renderer')
const thirdParty = new Set(['vendor', 'third-party', 'node_modules'])
const dash = '\u2014'

function* filesIn(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory() && !thirdParty.has(entry.name)) yield* filesIn(path)
    else if (entry.isFile() && /\.(?:js|html)$/.test(entry.name)) yield path
  }
}

function scanJavaScript(source, check) {
  const token = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|#![^\n]*|[$\w]+|./sy
  const regexp = /\/(?:\\[^\r\n]|\[(?:\\[^\r\n]|[^\]\\\r\n])*\]|[^/\\[\r\n])+\/[a-z]*/y
  const afterWord = /^(?:case|delete|in|instanceof|of|return|throw|typeof|void|yield|await|else|do)$/
  let pos = 0

  function scanString(quote) {
    let start = ++pos
    while (pos < source.length) {
      const ch = source[pos]
      if (ch === '\\') { pos += 2; continue }
      if (ch === quote) {
        check(source.slice(start, pos), start)
        pos++
        return
      }
      if (quote === '`' && source.startsWith('${', pos)) {
        check(source.slice(start, pos), start)
        pos += 2
        scanCode(true)
        start = pos
        continue
      }
      pos++
    }
  }

  function scanCode(interpolation = false) {
    let canStartRegex = true
    let braces = 0
    while (pos < source.length) {
      token.lastIndex = pos
      const [value] = token.exec(source)
      if (value === '"' || value === "'" || value === '`') {
        scanString(value)
        canStartRegex = false
        continue
      }
      if (value === '/' && canStartRegex) {
        regexp.lastIndex = pos
        if (regexp.test(source)) {
          pos = regexp.lastIndex
          canStartRegex = false
          continue
        }
      }
      pos += value.length
      if (/^(?:\s|\/\/|\/\*|#!)/.test(value)) continue
      if (value === '{') braces++
      if (value === '}') {
        if (interpolation && braces === 0) return
        braces--
      }
      canStartRegex = /^[$\w]/.test(value) ? afterWord.test(value) : !/^[)\]}.]$/.test(value)
    }
  }
  scanCode()
}

function scanHtml(source, check) {
  const parts = /<!--[\s\S]*?-->|<(style|script)\b[^>]*>([\s\S]*?)<\/\1\s*>|[^<]+|</gi
  for (const part of source.matchAll(parts)) {
    if (part[0].startsWith('<!--') || part[1]?.toLowerCase() === 'style') continue
    if (part[1]?.toLowerCase() === 'script') {
      const offset = part.index + part[0].indexOf('>') + 1
      scanJavaScript(part[2], (value, at) => check(value, offset + at))
    } else {
      // This also scans attributes such as titles, placeholders and accessible names.
      check(part[0], part.index)
    }
  }
}

const hits = []
for (const path of filesIn(root)) {
  const source = readFileSync(path, 'utf8')
  if (!source.includes(dash)) continue
  const check = (value, start) => {
    for (let i = value.indexOf(dash); i !== -1; i = value.indexOf(dash, i + 1)) {
      const line = source.slice(0, start + i).split('\n').length
      hits.push(`${relative(root, path)}:${line}`)
    }
  }
  if (path.endsWith('.js')) scanJavaScript(source, check)
  else scanHtml(source, check)
}
if (hits.length) {
  console.error('Em dashes in renderer copy:\n' + hits.join('\n'))
  process.exitCode = 1
} else console.log('Renderer copy: no em dashes')
