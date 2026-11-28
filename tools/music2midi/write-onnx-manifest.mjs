// Writes manifest.json next to encoder.onnx and decoder.onnx: the size and SHA-256 renderer/piano-cover-worker.js checks
// before it hands the bytes to onnxruntime-web, plus where the files came from.
//   node tools/music2midi/write-onnx-manifest.mjs <onnx dir> [--ckpt-sha256 <hex>] [--commit <git sha>] [--precision weight-fp16]
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const dir = args[0]
if (!dir) { console.error('usage: write-onnx-manifest.mjs <onnx dir> [--ckpt-sha256 hex] [--commit sha] [--precision name]'); process.exit(2) }
const flag = (name, fallback) => { const i = args.indexOf(name); return i > 0 ? args[i + 1] : fallback }
const entry = (name) => {
  const file = path.join(dir, name)
  return { name, bytes: statSync(file).size, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }
}
const manifest = {
  format: 1,
  model: 'music2midi',
  precision: flag('--precision', 'weight-fp16'),
  checkpointSha256: flag('--ckpt-sha256', null),
  upstreamCommit: flag('--commit', null),
  maxLength: 320,
  files: { encoder: entry('encoder.onnx'), decoder: entry('decoder.onnx') }
}
writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log('wrote', path.join(dir, 'manifest.json'))
