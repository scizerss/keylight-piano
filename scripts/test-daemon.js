const assert = require('node:assert/strict')

async function main() {
  const { LedDaemon } = await import('../renderer/daemon.js')
  const sent = [], statuses = []
  const daemon = new LedDaemon((state) => statuses.push(state))
  daemon.ws = { send: (message) => sent.push(message), close() {} }
  const left = '18446744073709551614'
  const right = '18446744073709551615'
  const discover = (keyCounts = '') => daemon.handle(`{"type":"discover_response","devices":[
    {"uid":${left},"serial":"LKBLEFT","battery_level":15${keyCounts}},
    {"uid":${right},"serial":"LKBRIGHT","battery_level":31,"battery_charging":true${keyCounts}},
    {"uid":3,"serial":"LPBLIGHTPAD","key_count":0}]}`)

  daemon.discoveryDeadline = Date.now() + 2000
  assert.equal(daemon.discovering, true)
  discover()
  assert.equal(daemon.discovering, false)
  assert.equal(daemon.ready, true, 'the old service still owns both keyboards')
  assert.equal(daemon.frameCapable, false)
  assert.equal(daemon.count, 2)
  assert.deepEqual(daemon.devices.map(({ battery, charging }) => [battery, charging]), [[48, false], [100, true]])
  daemon.send([[255, 0, 0]])
  daemon.brightness(50)
  assert.deepEqual(sent, [])

  discover(',"key_count":24')
  assert.equal(daemon.frameCapable, true, 'discovery enables frames before the first ACK')
  assert.equal(statuses.at(-1), 'boards')
  const frame = Array.from({ length: 48 }, () => [255, 0, 0])
  daemon.send(frame)
  daemon.send(frame)
  assert.equal(sent.length, 2, 'one frame per board is in flight')
  assert.match(sent[0], new RegExp(`"uid":${left},`))
  assert.match(sent[1], new RegExp(`"uid":${right},`))
  daemon.handle(`{"type":"key_frame_ack","uid":${right},"accepted":true}`)
  assert.equal(sent.length, 3)
  assert.match(sent[2], new RegExp(`"uid":${right},`))

  daemon.handle('{"type":"error","message":"unknown type: key_frame"}')
  assert.equal(statuses.at(-1), 'incompatible')
  assert.equal(daemon.ready, true)
  assert.equal(daemon.frameCapable, false)
  assert.ok(daemon.boards.every((board) => !board.busy && board.pending == null))
  discover(',"key_count":24')
  assert.equal(daemon.frameCapable, false, 'rediscovery cannot forget a command error')
  daemon.send(frame)
  assert.equal(sent.length, 3)
  daemon.handle('{"type":"discover_response","devices":[]}')
  assert.equal(daemon.ready, false)
  daemon.close()
  console.log('DAEMON tests passed')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
