// The key-light engine has ONE source file: renderer/key-light-engine.js (the app's Home and Results use it). The website hero uses a
// byte-identical copy, site-next/key-light-engine.js. This script writes that copy; with --check it only compares and exits 1 on drift
// (scripts/test-ios-studio.js runs it, so npm test fails when someone edits the copy by hand).
//   node scripts/sync-key-light-engine.js           copy the source over the site copy
//   node scripts/sync-key-light-engine.js --check   exit 1 if they differ
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const SOURCE = path.join(root, 'renderer', 'key-light-engine.js')
const COPY = path.join(root, 'site-next', 'key-light-engine.js')

function inSync() {
  return fs.existsSync(COPY) && fs.readFileSync(COPY).equals(fs.readFileSync(SOURCE))
}

if (require.main === module) {
  if (process.argv.includes('--check')) {
    if (inSync()) { console.log('key-light-engine: site-next copy matches renderer/key-light-engine.js'); process.exit(0) }
    console.error('key-light-engine: site-next/key-light-engine.js differs from renderer/key-light-engine.js; run node scripts/sync-key-light-engine.js')
    process.exit(1)
  }
  fs.copyFileSync(SOURCE, COPY)
  console.log('key-light-engine: copied to site-next/key-light-engine.js')
}
module.exports = { inSync, SOURCE, COPY }
