// node --test scripts/test-music2midi-tools.js
// The pieces around the desktop piano cover that are not the pipeline itself: the pinned model and vendor inputs, the model
// manifest, what the packagers copy, and which files git never sees.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { test } = require('node:test')

const ROOT = path.join(__dirname, '..')
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8')
const pin = (text, name) => (text.match(new RegExp(`^${name}="([^"]+)"`, 'm')) || [])[1]
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')

test('the ONNX and Core ML build scripts pin the same checkpoint and upstream commit', () => {
  const coreml = read('tools', 'music2midi', 'fetch-and-build.sh')
  const onnx = read('tools', 'music2midi', 'fetch-and-build-onnx.sh')
  for (const name of ['CKPT_NAME', 'CKPT_URL', 'CKPT_SHA256', 'UPSTREAM_REPO', 'UPSTREAM_COMMIT']) {
    assert.ok(pin(onnx, name), name + ' is pinned')
    assert.equal(pin(onnx, name), pin(coreml, name), name)
  }
  assert.match(pin(onnx, 'ENCODER_SHA256'), /^[0-9a-f]{64}$/)
  assert.match(pin(onnx, 'DECODER_SHA256'), /^[0-9a-f]{64}$/)
})

test('the export only offers weight-FP16 and checks the golden fixture (dynamic INT8 breaks the output)', () => {
  const py = read('tools', 'music2midi', 'export_onnx.py')
  assert.ok(!/quantize_dynamic|QUInt8|QInt8/.test(py.replace(/[\s\S]*?"""[\s\S]*?"""/, '')), 'no quantisation code')
  assert.match(py, /PARITY FAILED/)
  assert.match(py, /golden/)
})

test('every script that unpickles the checkpoint checks its pinned SHA-256 first', () => {
  const sha = pin(read('tools', 'music2midi', 'fetch-and-build.sh'), 'CKPT_SHA256')
  assert.match(sha, /^[0-9a-f]{64}$/)
  for (const file of ['export_coreml.py', 'export_onnx.py', 'dump_reference_tokens.py']) {
    const py = read('tools', 'music2midi', file)
    assert.ok(py.includes(`PINNED_CKPT_SHA256 = "${sha}"`), file + ' pins the checkpoint hash')
    assert.match(py, /def sha256_file\(/, file)
    if (file === 'export_coreml.py') { assert.match(py, /got = sha256_file\(args\.ckpt\)\n\s+if got != PINNED_CKPT_SHA256/); continue }
    // the other two load the checkpoint in main(): the check has to come first
    const checkAt = py.indexOf('check_checkpoint(args.ckpt)')
    assert.ok(checkAt > 0 && checkAt < py.indexOf('load_from_checkpoint('), file + ': the hash check comes before load_from_checkpoint')
    assert.match(py, /def check_checkpoint\([\s\S]*?got != PINNED_CKPT_SHA256/, file)
  }
})

test('vendored onnxruntime-web matches its pinned SHA-256 values and ships its licence', () => {
  execFileSync('bash', [path.join(ROOT, 'scripts', 'vendor-onnxruntime.sh'), '--check'], { stdio: 'pipe' })
  const dir = path.join(ROOT, 'renderer', 'vendor', 'onnxruntime-web')
  assert.match(fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8'), /MIT License[\s\S]*Microsoft Corporation/)
  assert.ok(fs.statSync(path.join(dir, 'ThirdPartyNotices.txt')).size > 100000)
  const notices = read('THIRD_PARTY_NOTICES.md')
  assert.match(notices, /onnxruntime-web 1\.31\.1/)
  assert.match(notices, /Music2MIDI/)
})

test('cover-models: manifest, verification, staging and a damaged cache', () => {
  const { verifyModels, stageModels } = require('./cover-models.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keylight-models-'))
  try {
    const from = path.join(tmp, 'cache'), to = path.join(tmp, 'resources', 'music2midi-models')
    fs.mkdirSync(from)
    assert.equal(verifyModels(from), null, 'no cache is not an error')
    assert.equal(stageModels(to, from), 0)
    assert.ok(!fs.existsSync(to))
    fs.writeFileSync(path.join(from, 'encoder.onnx'), 'encoder bytes')
    assert.throws(() => verifyModels(from), /without a manifest\.json/, 'model files without a manifest are an error, not a silent fallback')
    fs.writeFileSync(path.join(from, 'decoder.onnx'), 'decoder bytes')
    assert.throws(() => stageModels(path.join(tmp, 'never'), from), /without a manifest\.json/)
    fs.writeFileSync(path.join(from, 'stray.onnx'), 'not shipped')
    execFileSync('node', [path.join(ROOT, 'tools', 'music2midi', 'write-onnx-manifest.mjs'), from, '--ckpt-sha256', 'ab'.repeat(32)], { stdio: 'pipe' })
    const manifest = JSON.parse(fs.readFileSync(path.join(from, 'manifest.json'), 'utf8'))
    assert.equal(manifest.files.encoder.sha256, sha('encoder bytes'))
    assert.equal(manifest.files.decoder.bytes, 'decoder bytes'.length)
    assert.equal(manifest.precision, 'weight-fp16')
    assert.equal(manifest.maxLength, 320)
    assert.ok(verifyModels(from))
    assert.ok(stageModels(to, from) > 0)
    assert.deepEqual(fs.readdirSync(to).sort(), ['decoder.onnx', 'encoder.onnx', 'manifest.json'], 'only the three served files are copied')
    fs.writeFileSync(path.join(from, 'decoder.onnx'), 'decoder bytez')
    assert.throws(() => verifyModels(from), /decoder\.onnx does not match/)
    assert.throws(() => stageModels(path.join(tmp, 'again'), from), /does not match/)
    const bad = JSON.parse(JSON.stringify(manifest))
    bad.files.encoder.name = '../encoder.onnx'
    fs.writeFileSync(path.join(from, 'manifest.json'), JSON.stringify(bad))
    assert.throws(() => verifyModels(from), /encoder entry is not valid/)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('cover-models: an explicit KEYLIGHT_ONNX_DIR without a manifest is an error', () => {
  const { verifyModels } = require('./cover-models.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keylight-models-env-'))
  const before = process.env.KEYLIGHT_ONNX_DIR
  try {
    assert.equal(verifyModels(tmp), null, 'an empty folder that was not asked for stays silent')
    process.env.KEYLIGHT_ONNX_DIR = tmp
    assert.throws(() => verifyModels(tmp), /KEYLIGHT_ONNX_DIR is set but .*manifest\.json is missing/)
  } finally {
    if (before === undefined) delete process.env.KEYLIGHT_ONNX_DIR; else process.env.KEYLIGHT_ONNX_DIR = before
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('the files the app serves, the manifest entries and the packagers agree', () => {
  const scheme = require('../renderer/app-scheme.cjs')
  assert.deepEqual([...scheme.MODEL_FILES].sort(), ['decoder.onnx', 'encoder.onnx', 'manifest.json'])
  assert.match(read('scripts', 'package.sh'), /scripts\/cover-models\.js" stage "\$RES\/music2midi-models"/)
  assert.match(read('scripts', 'package-win.js'), /stageModels\(path\.join\(appDir, 'resources\/music2midi-models'\)\)/)
  assert.match(read('main.js'), /process\.resourcesPath, 'music2midi-models'/)
})

test('model files and the model cache stay out of git', () => {
  for (const file of ['tools/music2midi/.cache/onnx/encoder.onnx', 'tools/music2midi/.cache/onnx/manifest.json', 'some/where/model.onnx']) {
    execFileSync('git', ['check-ignore', '-q', file], { cwd: ROOT })
  }
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n')
  assert.deepEqual(tracked.filter((f) => /\.onnx$|\.ckpt$|\.mlpackage/.test(f)), [])
})

const cache = path.join(ROOT, 'tools', 'music2midi', '.cache', 'onnx')
test('the local model cache, when there is one, matches its manifest', { skip: !fs.existsSync(path.join(cache, 'manifest.json')) && 'no model cache' }, () => {
  const { verifyModels } = require('./cover-models.js')
  const manifest = verifyModels(cache)
  const pins = read('tools', 'music2midi', 'fetch-and-build-onnx.sh')
  assert.equal(manifest.files.encoder.sha256, pin(pins, 'ENCODER_SHA256'))
  assert.equal(manifest.files.decoder.sha256, pin(pins, 'DECODER_SHA256'))
})
