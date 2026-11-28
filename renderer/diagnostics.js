import { downloadFile } from './download.js'

const text = (value) => String(value ?? '').slice(0, 160).replace(/[\r\n\t]/g, ' ')
const ports = (list) => (list || []).map((port) => `${text(port.name) || 'Unnamed port'} (${text(port.state) || 'unknown'})`).join(', ') || 'None'
const milliseconds = (seconds) => Number.isFinite(seconds) && seconds > 0 ? (seconds * 1000).toFixed(1) + ' ms' : 'Not reported'

function nativeLogLines(entries) {
  if (!Array.isArray(entries)) return []
  return entries.slice(-20).filter((entry) => typeof entry?.message === 'string').map((entry) => {
    const source = /^[\w.-]+\.(?:js|mjs|html)$/.test(entry.source) ? entry.source : ''
    const location = source && Number.isInteger(entry.line) ? source + ':' + entry.line : source
    const details = [location, Number.isInteger(entry.code) ? 'code ' + entry.code : ''].filter(Boolean)
    return '- ' + text(entry.message) + (details.length ? ' (' + details.join(', ') + ')' : '')
  })
}

export function diagnosticReport(snapshot) {
  const { audio = {}, camera = {}, lights = {} } = snapshot
  const failures = (snapshot.failures || []).map((failure) =>
    '- ' + text(failure.at) + ' ' + text(failure.area) + ': ' + text(failure.operation) + ' (' + text(failure.detail) + ')')
  const nativeLog = nativeLogLines(snapshot.nativeLog)
  return [
    'Keylight connection report',
    'Version: ' + text(snapshot.version),
    'Platform: ' + text(snapshot.platform),
    'MIDI available: ' + (snapshot.midiAvailable ? 'Yes' : 'No'),
    'MIDI status: ' + (text(snapshot.midiStatus) || 'Unknown'),
    'MIDI inputs: ' + ports(snapshot.inputs),
    'MIDI outputs: ' + ports(snapshot.outputs),
    'Keyboard input: ' + (text(snapshot.keyboard) || 'None selected'),
    'Second keyboard: ' + (text(snapshot.keyboard2) || 'None selected'),
    'Keyboard range: ' + text(snapshot.range),
    'Key light output: ' + (text(snapshot.lightOutput) || 'None selected'),
    'Light transport: ' + text(lights.transport),
    'Light service: ' + text(lights.state),
    'Full-colour boards: ' + (Number.isInteger(lights.boards) ? lights.boards : 0),
    'Audio buffer: ' + milliseconds(audio.base),
    'Output delay estimate: ' + milliseconds(audio.output),
    'Audio sample rate: ' + (Number.isFinite(audio.sampleRate) && audio.sampleRate > 0 ? audio.sampleRate + ' Hz' : 'Not reported'),
    'Camera: ' + (camera.running ? 'Running' : 'Off'),
    'Camera calibration: ' + (camera.calibrated ? 'Set' : 'Not set'),
    'Gesture MIDI input: ' + (text(snapshot.gestureInput) || 'Off'),
    'External instrument output: ' + (text(snapshot.instrumentOutput) || 'Off'),
    '',
    'Recent connection and storage failures:',
    ...(failures.length ? failures : ['None recorded']),
    ...(nativeLog.length ? ['', 'Native log:', ...nativeLog] : []),
    '',
    'This report contains port names and the settings above. It excludes music, recordings,',
    'device serial fields, local file paths, song titles, progress, and payment information.',
    'Nothing is sent automatically. Review it before sharing.'
  ].join('\n')
}

export function mountDiagnostics(getSnapshot, { share = false, getNativeLog } = {}) {
  const open = document.getElementById('openDiagnostics')
  const dialog = document.getElementById('diagnosticsDialog')
  const report = document.getElementById('diagnosticsReport')
  const status = document.getElementById('diagnosticsStatus')
  const refreshButton = document.getElementById('refreshDiagnostics')
  const saveButton = document.getElementById('saveDiagnostics')
  const save = () => downloadFile(new Blob([report.textContent], { type: 'text/plain;charset=utf-8' }), 'keylight-connection-report.txt')
  const refresh = async () => {
    if (open.disabled) return
    open.disabled = refreshButton.disabled = saveButton.disabled = true
    try {
      let nativeLog
      if (share) { try { nativeLog = await getNativeLog?.() } catch { /* Older hosts may lack the log. */ } }
      report.textContent = diagnosticReport({ ...getSnapshot(), nativeLog })
      status.textContent = ''
    } finally {
      open.disabled = refreshButton.disabled = saveButton.disabled = false
    }
  }
  open.onclick = async () => {
    if (open.disabled) return
    await refresh()
    if (!dialog.open) dialog.showModal()
  }
  refreshButton.onclick = refresh
  if (share) saveButton.textContent = 'Share report'
  saveButton.onclick = () => {
    save()
    if (!share) status.textContent = 'Download requested. Review the report before sharing it.'
  }
  dialog.addEventListener('keydown', (event) => event.stopPropagation())
}
