// The piano cover model files at packaging time: node scripts/cover-models.js stage <destination folder>
// Reads tools/music2midi/.cache/onnx (or KEYLIGHT_ONNX_DIR), checks every file against manifest.json and copies the three
// files the app serves (renderer/app-scheme.cjs MODEL_FILES). Without a model cache it says so and succeeds: the build
// then keeps Basic Pitch. A cache that does not match its manifest, model files without a manifest, or a KEYLIGHT_ONNX_DIR
// without one are errors.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const DEFAULT_DIR = process.env.KEYLIGHT_ONNX_DIR || path.join(ROOT, 'tools', 'music2midi', '.cache', 'onnx')

function readManifest(dir) {
  const file = path.join(dir, 'manifest.json')
  if (!fs.existsSync(file)) {
    const explicit = process.env.KEYLIGHT_ONNX_DIR && path.resolve(process.env.KEYLIGHT_ONNX_DIR) === path.resolve(dir)
    if (explicit) throw new Error(`KEYLIGHT_ONNX_DIR is set but ${file} is missing: build the models (tools/music2midi/fetch-and-build-onnx.sh) or unset it`)
    for (const name of ['encoder.onnx', 'decoder.onnx']) {
      if (fs.existsSync(path.join(dir, name))) throw new Error(`${name} is in ${dir} without a manifest.json: build the models again (tools/music2midi/fetch-and-build-onnx.sh)`)
    }
    return null
  }
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const role of ['encoder', 'decoder']) {
    const entry = manifest?.files?.[role]
    if (!entry || entry.name !== role + '.onnx' || !/^[0-9a-f]{64}$/.test(entry.sha256) || !Number.isInteger(entry.bytes)) {
      throw new Error(`${file}: the ${role} entry is not valid`)
    }
  }
  return manifest
}

// Throws unless both model files exist with the size and SHA-256 the manifest records. Returns the manifest, or null with no cache.
function verifyModels(dir = DEFAULT_DIR) {
  const manifest = readManifest(dir)
  if (!manifest) return null
  for (const role of ['encoder', 'decoder']) {
    const entry = manifest.files[role]
    const data = fs.readFileSync(path.join(dir, entry.name))
    if (data.length !== entry.bytes || crypto.createHash('sha256').update(data).digest('hex') !== entry.sha256) {
      throw new Error(`${entry.name} does not match ${path.join(dir, 'manifest.json')}: build the models again (tools/music2midi/fetch-and-build-onnx.sh)`)
    }
  }
  return manifest
}

// Copies manifest.json, encoder.onnx and decoder.onnx into `to`. Returns the number of bytes, or 0 with no model cache.
function stageModels(to, dir = DEFAULT_DIR) {
  const manifest = verifyModels(dir)
  if (!manifest) return 0
  fs.mkdirSync(to, { recursive: true })
  let bytes = 0
  for (const name of ['manifest.json', manifest.files.encoder.name, manifest.files.decoder.name]) {
    fs.copyFileSync(path.join(dir, name), path.join(to, name))
    bytes += fs.statSync(path.join(to, name)).size
  }
  return bytes
}

module.exports = { verifyModels, stageModels, DEFAULT_DIR }

if (require.main === module) {
  const [command, destination] = process.argv.slice(2)
  if (command !== 'stage' || !destination) { console.error('usage: node scripts/cover-models.js stage <destination folder>'); process.exit(2) }
  try {
    const bytes = stageModels(destination)
    if (bytes) console.log(`piano cover models: ${(bytes / 1e6).toFixed(0)} MB copied to ${destination}`)
    else console.error('note: no piano cover models (run tools/music2midi/fetch-and-build-onnx.sh first): this build keeps Basic Pitch for songs')
  } catch (error) { console.error('error: ' + error.message); process.exit(1) }
}
