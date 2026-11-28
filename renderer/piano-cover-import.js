import { nativeRequest, onNativeEvent } from './ios-midi.js'

// A host that has hung never answers coverCancel, so waiting for the reply has a limit. When it runs out the staged file may
// still be in use: the error carries `cancelUnconfirmed`, and the caller keeps the file instead of releasing it.
export const CANCEL_REPLY_MS = 5000
export const START_REPLY_MS = 5000

export async function generatePianoCover(token, {
  signal, onProgress, onTimeout, modelDifficulty = 'intermediate', request = nativeRequest, subscribe = onNativeEvent,
  inactivityMs = 120_000, startReplyMs = START_REPLY_MS, cancelReplyMs = CANCEL_REPLY_MS, page = globalThis.document
} = {}) {
  signal?.throwIfAborted()
  let jobId
  let timer
  let settled = false
  let timedOut = false
  let resolveCompletion
  let failure
  let startUnconfirmed = false
  const completion = new Promise((resolve) => { resolveCompletion = resolve })
  const finish = (event) => {
    settled = true
    clearTimeout(timer)
    resolveCompletion(event)
  }
  // The host pauses a job while the app is in the background, so the silence timer waits too and starts again on return.
  const watchProgress = () => {
    clearTimeout(timer)
    if (page?.hidden) return
    timer = setTimeout(() => {
      timedOut = true
      const message = 'The piano cover stopped responding. Try again.'
      finish({ kind: 'coverError', message })
      onTimeout?.(message)
    }, inactivityMs)
  }
  const earlyEvents = []
  const receive = (event) => {
    if (settled || !event || !['coverProgress', 'coverDone', 'coverError'].includes(event.kind)) return
    if (!jobId) { earlyEvents.push(event); return }
    if (event.jobId !== jobId) return
    if (event.kind === 'coverProgress') {
      watchProgress()
      if (event.total > 0) onProgress?.(Math.min(1, event.done / event.total))
    } else finish(event)
  }
  const unsubscribe = subscribe(receive)
  const abort = () => finish(null)
  const visibility = () => { if (settled) return; if (page.hidden) clearTimeout(timer); else if (jobId) watchProgress() }
  signal?.addEventListener('abort', abort, { once: true })
  page?.addEventListener?.('visibilitychange', visibility)
  try {
    // WebKit may deliver the start reply and the first events in the same batch.
    startUnconfirmed = true
    try {
      jobId = await boundedRequest(request, 'coverStart', { token, genre: 'pop', difficulty: modelDifficulty }, startReplyMs)
    } catch (error) {
      // An explicit host rejection means it never opened the file.
      if (error?.name === 'OperationError' || error?.name === 'NotSupportedError' || ['busy', 'File not found'].includes(error?.message)) startUnconfirmed = false
      throw error
    }
    if (typeof jobId !== 'string' || !jobId) throw new Error('Could not start the piano cover')
    startUnconfirmed = false
    signal?.throwIfAborted()
    watchProgress()
    for (const event of earlyEvents) receive(event)
    const result = await completion
    signal?.throwIfAborted()
    if (timedOut) throw new DOMException(result.message, 'CoverTimeoutError')
    if (result.kind === 'coverError') throw new Error(result.message || 'Could not make a piano cover')
    return { notes: result.notes, duration: result.duration, modelDifficulty }
  } catch (error) {
    if (signal?.aborted) failure = new DOMException('The piano cover was cancelled.', 'AbortError')
    else if (error?.message === 'busy') failure = new DOMException('Another song is still being made into a piano cover.', 'CoverBusyError')
    else failure = error instanceof Error ? error : new Error('Could not make a piano cover', { cause: error })
    throw failure
  } finally {
    clearTimeout(timer)
    unsubscribe()
    signal?.removeEventListener('abort', abort)
    page?.removeEventListener?.('visibilitychange', visibility)
    if (failure) {
      let stopped = !startUnconfirmed
      if ((timedOut || signal?.aborted) && !startUnconfirmed && jobId) {
        // Only the native reply after task.value confirms that the staged file can be released.
        stopped = await boundedRequest(request, 'coverCancel', { jobId }, cancelReplyMs).then((ok) => ok === true, () => false)
      }
      if (!stopped) {
        failure.cancelUnconfirmed = true
        if (startUnconfirmed) console.warn?.('Keylight coverStart timed out without a job ID; the native job may still be stopping')
      }
    }
  }
}

function boundedRequest(request, op, args, ms) {
  ms = Math.max(1, ms)   // nativeRequest uses zero to disable its timeout
  if (request === nativeRequest) return request(op, args, ms)
  return new Promise((resolve, reject) => {
    // Forward the timeout to the RPC so it removes its pending entry. Also bound injected bridges.
    const work = request(op, args, ms)
    const timer = setTimeout(() => reject(new DOMException('Native operation timed out', 'TimeoutError')), ms)
    Promise.resolve(work).then(
      (reply) => { clearTimeout(timer); resolve(reply) },
      (error) => { clearTimeout(timer); reject(error) }
    )
  })
}
