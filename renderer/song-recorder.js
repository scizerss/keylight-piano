export const MAX_RECORDING_SECONDS = 600

export function recordingTime(seconds) {
  const whole = Math.max(0, Math.floor(seconds))
  return [Math.floor(whole / 60), whole % 60].map((part) => String(part).padStart(2, '0')).join(':')
}

export const recordingMessages = {
  denied: 'Turn on Microphone for Keylight in Settings.',
  tv: 'Disconnect the TV to record.',
  playing: 'Stop the song before recording.',
  unsupported: 'Recording is unavailable on this device.',
  tooShort: 'Record for at least one second.',
  busy: 'Finish the current recording first.',
  cancelled: 'Recording cancelled. Tap the microphone to try again.',
  failed: 'Could not record. Check your microphone and try again.'
}

const formats = [['audio/mp4', 'm4a'], ['audio/webm;codecs=opus', 'webm']]
const stopTracks = (stream) => stream.getTracks().forEach((track) => track.stop())

// The caller can cancel while the permission prompt is open. A late grant must
// release the stream before any recorder or audio graph is created.
export async function startBrowserRecording({ isCurrent, onLevel, onEnded }) {
  const Recorder = globalThis.MediaRecorder
  const devices = globalThis.navigator?.mediaDevices
  const format = formats.find(([mime]) => Recorder?.isTypeSupported?.(mime))
  if (!format || !devices?.getUserMedia) return { status: 'unsupported' }

  let stream
  try {
    stream = await devices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
  } catch (error) {
    return { status: error.name === 'NotAllowedError' || error.name === 'SecurityError' ? 'denied' : 'failed' }
  }
  if (!isCurrent()) {
    stopTracks(stream)
    return { status: 'cancelled' }
  }

  const [mimeType, extension] = format
  let recorder, context
  try {
    recorder = new Recorder(stream, { mimeType })
    context = new AudioContext()
    void context.resume().catch(() => {})
    const analyser = context.createAnalyser()
    context.createMediaStreamSource(stream).connect(analyser)
    const samples = new Float32Array(analyser.fftSize)
    const chunks = []
    let seconds = 0, discarded = false, ending = false, released = false
    let meter, limit, fallback, resolve
    const result = new Promise((done) => { resolve = done })
    const startedAt = performance.now()
    const elapsed = () => Math.min(MAX_RECORDING_SECONDS, (performance.now() - startedAt) / 1000)
    // Stops the tracks, meter and context. Safe to call more than once.
    const release = () => {
      if (released) return
      released = true
      clearInterval(meter)
      clearTimeout(limit)
      clearTimeout(fallback)
      stopTracks(stream)
      void context.close().catch(() => {})
    }
    // Builds the answer from what was captured. resolve() keeps only the first answer.
    const settle = () => {
      if (discarded) resolve({ status: 'cancelled' })
      else if (seconds < 1) resolve({ status: 'tooShort' })
      else if (!chunks.length) resolve({ status: 'failed' })
      else {
        const stamp = new Date().toLocaleString('sv-SE').slice(0, 16).replace(':', '-')
        const type = (recorder.mimeType || mimeType).split(';')[0]
        resolve({ status: 'saved', file: new File(chunks, `Recording ${stamp}.${extension}`, { type }) })
      }
    }
    const finish = (discard = false) => {
      discarded ||= discard
      if (ending) {
        // A discard after Stop (or while the stop event is late) must not leave the microphone open or the answer pending.
        if (discarded) { release(); settle() }
        return result
      }
      ending = true
      seconds = elapsed()
      clearInterval(meter)
      clearTimeout(limit)
      if (recorder.state === 'inactive') {          // already stopped: no stop event will follow
        release()
        settle()
        return result
      }
      try {
        recorder.stop()
      } catch {
        release()
        resolve({ status: 'failed' })
        return result
      }
      // The last chunk arrives after stop(), so a normal finish keeps the tracks until onstop or onerror (or a short timeout).
      if (discarded) { release(); settle() }
      else fallback = setTimeout(() => { release(); settle() }, 3000)
      return result
    }
    recorder.ondataavailable = (event) => { if (!discarded && event.data.size) chunks.push(event.data) }
    recorder.onstop = () => {
      if (!ending) {
        ending = true
        seconds = elapsed()
        onEnded(result, 'interrupted')
      }
      release()
      settle()
    }
    recorder.onerror = () => {
      const notify = !ending
      ending = true
      release()
      resolve({ status: 'failed' })
      if (notify) onEnded(result, 'interrupted')
    }

    recorder.start(1000)
    meter = setInterval(() => {
      analyser.getFloatTimeDomainData(samples)
      const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length)
      onLevel(Math.max(0, Math.min(1, (20 * Math.log10(rms) + 60) / 60)), elapsed())
    }, 1000 / 15)
    limit = setTimeout(() => onEnded(finish(), 'limit'), MAX_RECORDING_SECONDS * 1000)
    return { status: 'recording', finish }
  } catch {
    stopTracks(stream)
    if (context) void context.close().catch(() => {})
    return { status: 'failed' }
  }
}
