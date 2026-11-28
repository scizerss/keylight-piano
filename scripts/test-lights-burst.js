// Many separate sends in one tick overflow the iOS MIDI bridge queue (64 requests): clearLights and the identify flash must
// batch notes 0-127 into a handful of multi-message buffers.
const assert = require('node:assert/strict')

async function main() {
  const L = await import('../renderer/lights.js')
  const bursts = L.noteBursts(0x90, 127)
  assert.ok(bursts.length <= 8, 'few sends: ' + bursts.length)
  const notes = bursts.flatMap((b) => { assert.ok(b.length <= 96 && b.length % 3 === 0); return b.filter((_, i) => i % 3 === 1) })
  assert.deepEqual(notes, Array.from({ length: 128 }, (_, i) => i), 'every note 0-127 exactly once, in order')
  assert.ok(bursts.every((b) => b.every((v, i) => (i % 3 === 0 ? v === 0x90 : i % 3 === 2 ? v === 127 : true))))

  const sent = []
  L.clearLights({ send: (d) => sent.push([...d]) })
  assert.ok(sent.length <= 8, 'clearLights stays far under the 64-request queue: ' + sent.length)
  assert.deepEqual(sent[0], [0xb0, 64, 0], 'sustain off first')
  assert.deepEqual(sent[sent.length - 1], [0xb0, 123, 0], 'all notes off last, so it is not dropped')
  const offs = sent.slice(1, -1).flat().filter((_, i) => i % 3 === 1)
  assert.equal(offs.length, 128)
  console.log('lights burst: ok')
}
main().catch((e) => { console.error(e); process.exit(1) })
