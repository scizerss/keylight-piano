import { loadSampledInstrument, sampledInstrumentStatus, sampledPianoStatus, setInstrument, currentInstrument, instrumentList } from './audio.js'

export function mountInstrumentControls({ settings, save, notice, changed }) {
  const selects = ['instrument', 'btnInst'].map((id) => document.getElementById(id))
  const state = document.getElementById('sampleStatus')
  let request = 0
  for (const select of selects) select.replaceChildren(...instrumentList().map((instrument) => Object.assign(document.createElement('option'), { value: instrument.id, textContent: instrument.name })))
  const sync = () => { for (const select of selects) select.value = currentInstrument() }
  const updateStatus = (id = currentInstrument()) => {
    const target = id === 'harmonium' ? 'harmonium' : 'sampled-piano'
    const status = target === 'harmonium' ? sampledInstrumentStatus('harmonium') : sampledPianoStatus()
    state.textContent = status.state === 'loading' ? `Loading ${status.loaded} of ${status.total} recordings`
      : status.state === 'ready' ? 'Bundled recordings ready'
        : status.state === 'unavailable' ? 'Unavailable. Select instrument again to retry.' : 'Bundled recordings, ready to load'
  }
  async function choose(id, persist = true) {
    const token = ++request
    if (id === 'sampled-piano' || id === 'harmonium') {
      state.textContent = id === 'harmonium' ? 'Loading bundled harmonium recordings' : 'Loading bundled piano recordings'
      const timer = setInterval(() => updateStatus(id), 100)
      let loaded
      try { loaded = await loadSampledInstrument(id) } finally { clearInterval(timer); updateStatus(id) }
      if (token !== request) return false
      if (loaded.state !== 'ready') {
        updateStatus(); sync()
        notice(loaded.error || 'The sampled instrument could not load. Your previous instrument is still selected.')
        return false
      }
    }
    if (token !== request) return false
    if (!setInstrument(id)) { sync(); return false }
    if (persist) { settings.instrument = currentInstrument(); save() }
    sync()
    changed(); updateStatus()
    return true
  }
  for (const select of selects) select.onchange = () => choose(select.value)
  updateStatus()
  sync()
  const initial = settings.instrument || 'sampled-piano'
  choose(initial)
  return { choose, sync }
}
