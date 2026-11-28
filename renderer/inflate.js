// A small raw-DEFLATE (RFC 1951) decompressor, for browsers whose DecompressionStream does not
// know 'deflate-raw' (an .mxl file is a zip of deflated entries). Own code, no dependencies.
//
// inflateRaw(bytes, { maxBytes }) -> Uint8Array
//   Throws InflateError for damaged input (.tooLarge is false) or when the result would pass
//   maxBytes (.tooLarge is true). The output buffer grows as needed but never past maxBytes, and
//   input is never read past its end, so bad or hostile data cannot use unbounded memory or time.

export class InflateError extends Error {
  constructor(message, tooLarge = false) { super(message); this.name = 'InflateError'; this.tooLarge = tooLarge }
}
const damaged = () => new InflateError('The compressed data is damaged')

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

// A canonical Huffman code: how many codes there are of each length, and the symbols in code order.
function buildTree(lengths, count) {
  const counts = new Uint16Array(16)
  for (let i = 0; i < count; i++) counts[lengths[i]]++
  counts[0] = 0
  // reject a code that uses more bit patterns than exist (an incomplete one is allowed, as in zlib for a single code)
  let left = 1
  for (let len = 1; len < 16; len++) { left = left * 2 - counts[len]; if (left < 0) throw damaged() }
  const offsets = new Uint16Array(17)
  for (let len = 1; len < 16; len++) offsets[len + 1] = offsets[len] + counts[len]
  const symbols = new Uint16Array(count)
  for (let i = 0; i < count; i++) if (lengths[i]) symbols[offsets[lengths[i]]++] = i
  return { counts, symbols }
}

let fixedTrees = null
function fixed() {
  if (!fixedTrees) {
    const lit = new Uint8Array(288)
    lit.fill(8, 0, 144); lit.fill(9, 144, 256); lit.fill(7, 256, 280); lit.fill(8, 280, 288)
    fixedTrees = { lit: buildTree(lit, 288), dist: buildTree(new Uint8Array(30).fill(5), 30) }
  }
  return fixedTrees
}

export function inflateRaw(input, { maxBytes = 50 * 1024 * 1024 } = {}) {
  const src = input instanceof Uint8Array ? input : new Uint8Array(input)
  let pos = 0, bitBuf = 0, bitCount = 0
  let out = new Uint8Array(Math.min(maxBytes, Math.max(1024, src.length * 4)))
  let size = 0

  const bit = () => {
    if (bitCount === 0) {
      if (pos >= src.length) throw new InflateError('The compressed data ends too early')
      bitBuf = src[pos++]; bitCount = 8
    }
    const b = bitBuf & 1
    bitBuf >>>= 1; bitCount--
    return b
  }
  const bits = (n) => { let v = 0; for (let i = 0; i < n; i++) v |= bit() << i; return v }
  const room = (extra) => {
    if (size + extra <= out.length) return
    if (size + extra > maxBytes) throw new InflateError('The unpacked data is too large', true)
    const grown = new Uint8Array(Math.min(maxBytes, Math.max(out.length * 2, size + extra)))
    grown.set(out.subarray(0, size))
    out = grown
  }
  const symbol = (tree) => {
    let sum = 0, cur = 0, len = 0
    do {
      cur = cur * 2 + bit()
      if (++len > 15) throw damaged()
      sum += tree.counts[len]
      cur -= tree.counts[len]
    } while (cur >= 0)
    const at = sum + cur
    if (at >= tree.symbols.length) throw damaged()
    return tree.symbols[at]
  }

  const codes = (lit, dist) => {
    for (;;) {
      const sym = symbol(lit)
      if (sym < 256) { room(1); out[size++] = sym; continue }
      if (sym === 256) return
      const li = sym - 257
      if (li >= 29) throw damaged()
      const length = LEN_BASE[li] + bits(LEN_EXTRA[li])
      const di = symbol(dist)
      if (di >= 30) throw damaged()
      const distance = DIST_BASE[di] + bits(DIST_EXTRA[di])
      if (distance > size) throw damaged()
      room(length)
      for (let i = 0; i < length; i++, size++) out[size] = out[size - distance]
    }
  }

  const dynamic = () => {
    const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4
    if (hlit > 286 || hdist > 30) throw damaged()
    const clens = new Uint8Array(19)
    for (let i = 0; i < hclen; i++) clens[CODE_LENGTH_ORDER[i]] = bits(3)
    const clTree = buildTree(clens, 19)
    const lengths = new Uint8Array(hlit + hdist)
    for (let i = 0; i < lengths.length;) {
      const sym = symbol(clTree)
      if (sym < 16) { lengths[i++] = sym; continue }
      let value = 0, repeat
      if (sym === 16) { if (i === 0) throw damaged(); value = lengths[i - 1]; repeat = 3 + bits(2) }
      else if (sym === 17) repeat = 3 + bits(3)
      else repeat = 11 + bits(7)
      if (i + repeat > lengths.length) throw damaged()
      lengths.fill(value, i, i + repeat); i += repeat
    }
    if (lengths[256] === 0) throw damaged()      // no end-of-block code
    codes(buildTree(lengths.subarray(0, hlit), hlit), buildTree(lengths.subarray(hlit), hdist))
  }

  const stored = () => {
    bitCount = 0                                  // the rest of the current byte is skipped
    if (pos + 4 > src.length) throw new InflateError('The compressed data ends too early')
    const len = src[pos] | (src[pos + 1] << 8), nlen = src[pos + 2] | (src[pos + 3] << 8)
    if ((len ^ nlen) !== 0xffff) throw damaged()
    pos += 4
    if (pos + len > src.length) throw new InflateError('The compressed data ends too early')
    room(len)
    out.set(src.subarray(pos, pos + len), size)
    size += len; pos += len
  }

  let last
  do {
    last = bit()
    const type = bits(2)
    if (type === 0) stored()
    else if (type === 1) { const f = fixed(); codes(f.lit, f.dist) }
    else if (type === 2) dynamic()
    else throw damaged()
  } while (!last)
  return out.slice(0, size)
}
