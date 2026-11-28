import { LyricsTapper, groupLyricLines, lyricFields, lyricsOfSong } from './lyrics-model.js'

export function lyricsFingerprint(record) {
  return JSON.stringify([record?.lyricWords ?? null, record?.lyrics ?? null])
}

export function createLyricsSession({ transport, tapper, record, offset = 0.15, onReview = () => {} }) {
  const existing = lyricsOfSong(record)
  tapper ??= existing.length ? LyricsTapper.fromLyrics(existing) : null
  let step = tapper ? (tapper.timedCount ? 'review' : 'tap') : 'paste'
  let retiming = null
  const hadTimedLyrics = !!(existing.length || tapper?.timedCount)
  const plain = record?.lyrics?.plain || ''
  let initialLines = tapper ? JSON.stringify(tapper.lines) : null
  const syllableTiming = groupLyricLines(existing).some((line) => line.timed)

  function review() {
    transport.pause()
    retiming = null
    step = 'review'
    onReview()
  }

  function nextUntimed(from) {
    if (from == null) return null
    const i = tapper.lines.findIndex((line, i) => i >= from && line.t == null)
    return i < 0 ? null : i
  }

  const session = {
    get tapper() { return tapper },
    get step() { return step },
    get text() { return tapper ? tapper.lines.map((line) => line.text).join('\n') : plain },
    get next() { return retiming ?? nextUntimed(tapper?.next) },
    get isPlaying() { return transport.isPlaying() },
    get dirty() {
      if (!tapper) return false
      if (initialLines != null) return JSON.stringify(tapper.lines) !== initialLines
      return !!tapper.timedCount || (!!plain && session.text !== plain)
    },
    get removesLyrics() { return hadTimedLyrics && tapper?.timedCount === 0 },
    // a plain-only song saves only once a line is timed: edited text with no times would silently keep the old text
    get canSave() { return session.dirty && (hadTimedLyrics || !!tapper?.timedCount) },
    syllableTiming,
    editText() {
      transport.pause()
      step = 'paste'
    },
    start(text) {
      // Compare the displayed text first: an imported lyric can exceed the paste limits.
      if (!tapper || text !== session.text) {
        const draft = LyricsTapper.fromText(text)
        if (!tapper && text === plain) initialLines = JSON.stringify(draft.lines)
        draft.lines.forEach((line, i) => {
          const previous = tapper?.lines[i]
          if (previous?.text === line.text) line.t = previous.t
        })
        tapper = draft
      }
      if (tapper.complete) { review(); return }
      tapper.seek(0)
      transport.seek(0)
      step = 'tap'
      transport.play()
    },
    tap() {
      if (step !== 'tap') return -1
      const t = transport.getTime() - offset
      if (!Number.isFinite(t)) return -1
      if (retiming != null) {
        // Keep the old time until a replacement tap arrives.
        tapper.clear(retiming)
        tapper.seek(retiming)
        retiming = null
      }
      const i = tapper.tap(Math.max(0, t))
      if (i >= 0 && session.next == null) review()
      return i
    },
    undo() {
      retiming = null
      return tapper.untap()
    },
    restart() {
      retiming = null
      tapper.clearAll()
      transport.seek(0)
      step = 'tap'
    },
    back() {
      const next = nextUntimed(0)
      if (next == null) return
      transport.pause()
      tapper.seek(next)
      step = 'tap'
    },
    tapFrom(i) {
      const line = tapper.lines[i]
      if (!line) return
      const previous = tapper.lines.slice(0, i).findLast((l) => l.t != null)
      transport.pause()
      transport.seek(Math.max(0, (previous?.t ?? line.t ?? 0) - 1))
      retiming = i
      tapper.seek(i)
      step = 'tap'
      transport.play()
    },
    preview(i) {
      const t = tapper.lines[i]?.t
      if (t == null) return
      transport.pause()
      transport.seek(Math.max(0, t - 1))
      transport.play()
    },
    togglePlay() {
      if (transport.isPlaying()) transport.pause()
      else transport.play()
    },
    pause: () => transport.pause(),
    review,
    nudge: (i, delta) => tapper.nudge(i, delta),
    clear: (i) => tapper.clear(i),
    save() {
      if (!session.canSave) return null
      const fields = lyricFields(tapper.toLyrics())
      if (!fields.lyricWords && !hadTimedLyrics && plain) fields.lyrics = { plain }
      return fields
    }
  }
  transport.onEnd(() => {
    if (step === 'tap') review()
  })
  return session
}

const timeLabel = (t) => {
  if (t == null) return 'Untimed'
  const tenths = Math.round(t * 10)
  return Math.floor(tenths / 600) + ':' + (tenths % 600 / 10).toFixed(1).padStart(4, '0')
}

export function mountLyricsEditor({ load, begin, save, notice }) {
  const dialog = document.createElement('dialog')
  dialog.id = 'lyricsEditor'
  dialog.setAttribute('aria-labelledby', 'lyricsEditorTitle')
  dialog.innerHTML = `
    <section data-step="paste" hidden>
      <header class="le-header">
        <button type="button" class="ghost" data-cancel>Cancel</button>
        <h2 id="lyricsEditorTitle" tabindex="-1">Add lyrics</h2>
        <button type="button" class="primary" id="lyricsStart">Start timing</button>
      </header>
      <textarea id="lyricsText" aria-label="Lyrics" aria-describedby="lyricsTextHint lyricsTextTimingHint" spellcheck="false"></textarea>
      <p id="lyricsTextHint" class="le-note">One line of the song per line.</p>
      <p id="lyricsTextTimingHint" class="le-note le-warning" hidden>Changing the text clears the times of changed lines</p>
    </section>
    <section data-step="tap" hidden>
      <header class="le-header">
        <button type="button" class="ghost" data-cancel>Cancel</button>
        <h2 id="lyricsCounter" tabindex="-1"></h2>
        <div class="le-actions">
          <button type="button" class="ghost" id="lyricsUndo">Undo</button>
          <button type="button" class="ghost" id="lyricsRestart">Restart</button>
          <button type="button" class="primary" id="lyricsDone">Done</button>
        </div>
      </header>
      <div class="le-timing">
        <div class="le-lines">
          <div class="le-line-context" id="lyricsPrevious"></div>
          <div id="lyricsCurrent" aria-live="polite"></div>
          <div class="le-line-context" id="lyricsNext"></div>
          <button type="button" class="ghost" id="lyricsPause">Pause</button>
        </div>
        <button type="button" class="primary" id="lyricsTap">Tap</button>
      </div>
    </section>
    <section data-step="review" hidden>
      <header class="le-header">
        <button type="button" class="ghost" data-cancel>Cancel</button>
        <h2 id="lyricsReviewTitle" tabindex="-1">Lyric timing</h2>
        <button type="button" class="primary" id="lyricsSave">Save</button>
      </header>
      <div class="le-review-tools">
        <button type="button" class="ghost" id="lyricsEditText">Edit text</button>
        <button type="button" class="ghost" id="lyricsBack" hidden disabled>Back to tapping</button>
      </div>
      <p class="le-note le-warning" id="lyricsConversion" hidden>Saving changes word timing to line timing.</p>
      <p class="le-note le-warning" id="lyricsWarning" role="status" hidden></p>
      <p class="le-note" id="lyricsSaveHint" hidden>Tap at least one line</p>
      <ul id="lyricsReview" aria-label="Lyric lines"></ul>
    </section>
    <p class="le-note le-error" id="lyricsError" role="alert" hidden></p>`
  document.body.append(dialog)

  const $ = (id) => dialog.querySelector('#' + id)
  const sections = [...dialog.querySelectorAll('[data-step]')]
  const text = $('lyricsText')
  const start = $('lyricsStart')
  const tapPad = $('lyricsTap')
  const reviewList = $('lyricsReview')
  const error = $('lyricsError')
  let draft = null
  let opening = false
  let saving = false
  let tappedOnPointerDown = false

  function showError(message = '') {
    error.textContent = message
    error.hidden = !message
  }

  function refreshTap() {
    const { session } = draft
    const { tapper, isPlaying } = session
    const i = session.next ?? tapper.count
    $('lyricsCounter').textContent = `${tapper.timedCount} of ${tapper.count} timed`
    $('lyricsPrevious').textContent = tapper.lines[i - 1]?.text || ''
    $('lyricsCurrent').textContent = tapper.lines[i]?.text || 'All lines timed'
    $('lyricsNext').textContent = tapper.lines[i + 1]?.text || ''
    $('lyricsPause').textContent = isPlaying ? 'Pause' : 'Resume'
    $('lyricsUndo').disabled = !tapper.lines.slice(0, tapper.next ?? tapper.count).some((line) => line.t != null)
    tapPad.disabled = session.next == null
  }

  function refreshReview() {
    const { session } = draft
    const untimed = session.tapper.count - session.tapper.timedCount
    const warning = $('lyricsWarning')
    $('lyricsBack').hidden = $('lyricsBack').disabled = untimed === 0
    warning.hidden = untimed === 0
    if (session.removesLyrics) warning.textContent = 'Saving removes the lyrics from this song'
    else warning.textContent = untimed === 1 ? "1 line has no time and won't show" : `${untimed} lines have no time and won't show`
    const saveButton = $('lyricsSave')
    saveButton.disabled = !session.canSave
    saveButton.textContent = session.removesLyrics ? 'Remove lyrics' : 'Save'
    $('lyricsSaveHint').hidden = session.canSave || session.tapper.timedCount > 0
    $('lyricsConversion').hidden = !session.syllableTiming || session.removesLyrics
  }

  function refreshPaste() {
    const { session } = draft
    start.disabled = !text.value.trim()
    $('lyricsTextTimingHint').hidden = !session.tapper?.timedCount || text.value === session.text
  }

  function reviewRow(line, i) {
    const row = document.createElement('li')
    const button = (label, action, meaning = label) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'ghost'
      b.textContent = label
      b.setAttribute('aria-label', `${meaning}, line ${i + 1}`)
      b.onclick = action
      row.append(b)
      return b
    }
    const preview = button('', () => draft.session.preview(i), 'Preview')
    preview.className = 'le-preview'
    const time = document.createElement('span')
    time.className = 'le-time'
    const words = document.createElement('span')
    words.className = 'le-words'
    words.textContent = line.text
    words.title = line.text
    preview.replaceChildren(time, words)
    const earlier = button('−0.1', () => nudge(-0.1), 'Move 0.1 seconds earlier')
    const later = button('+0.1', () => nudge(0.1), 'Move 0.1 seconds later')
    const clear = button('Clear', () => {
      draft.session.clear(i)
      update()
      from.focus()
      refreshReview()
    })
    const from = button('Tap from here', () => {
      draft.session.tapFrom(i)
      render()
    })
    function nudge(delta) {
      draft.session.nudge(i, delta)
      update()
      refreshReview()
    }
    function update() {
      time.textContent = timeLabel(line.t)
      preview.setAttribute('aria-label', `Preview line ${i + 1}, ${time.textContent}, ${line.text}`)
      for (const b of [preview, earlier, later, clear]) b.disabled = line.t == null
    }
    update()
    return row
  }

  function render() {
    const { session } = draft
    const { step } = session
    const heading = { paste: 'lyricsEditorTitle', tap: 'lyricsCounter', review: 'lyricsReviewTitle' }[step]
    dialog.setAttribute('aria-labelledby', heading)
    showError()
    for (const section of sections) section.hidden = section.dataset.step !== step
    if (step === 'paste') {
      text.value = session.text
      refreshPaste()
    } else if (step === 'tap') {
      tappedOnPointerDown = false
      refreshTap()
    } else {
      reviewList.replaceChildren(...session.tapper.lines.map(reviewRow))
      reviewList.scrollTop = 0
      refreshReview()
    }
    if (dialog.open) (step === 'tap' ? tapPad : $(heading)).focus()
  }

  function finishClose() {
    const closing = draft
    draft = null
    reviewList.replaceChildren()
    text.value = ''
    for (const section of sections) section.hidden = true
    if (closing) {
      closing.restore()
      if (closing.returnFocus?.isConnected) closing.returnFocus.focus({ preventScroll: true })
    }
  }
  function close() {
    if (dialog.open) dialog.close()
    finishClose()
  }
  dialog.addEventListener('close', () => { if (!dialog.open) finishClose() })
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault()
    if (!saving) close()
  })
  for (const button of dialog.querySelectorAll('[data-cancel]')) button.onclick = close

  function tap() {
    if (!draft) return
    draft.session.tap()
    if (draft.session.step === 'tap') refreshTap()
  }

  dialog.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (draft?.session.step !== 'tap' || (e.key !== ' ' && e.key !== 'Enter') || e.altKey || e.ctrlKey || e.metaKey) return
    if (e.target !== tapPad && e.target.closest('button')) return
    e.preventDefault()
    if (!e.repeat && !tapPad.disabled) tap()
  })
  tapPad.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || e.button !== 0 || tapPad.disabled) return
    tappedOnPointerDown = true
    tap()
  })
  tapPad.addEventListener('pointercancel', () => { tappedOnPointerDown = false })
  tapPad.addEventListener('click', (e) => {
    const alreadyTapped = tappedOnPointerDown
    tappedOnPointerDown = false
    if (e.detail === 0 && !alreadyTapped) tap()
  })
  text.oninput = () => { refreshPaste(); showError() }
  start.onclick = () => {
    try { draft.session.start(text.value) } catch (e) { showError(e.message); return }
    if (draft.session.step === 'tap') render()
  }
  for (const [id, action] of [['lyricsPause', 'togglePlay'], ['lyricsUndo', 'undo'], ['lyricsRestart', 'restart']]) {
    $(id).onclick = (e) => {
      draft.session[action]()
      refreshTap()
      if (e.detail > 0 || $(id).disabled) tapPad.focus()   // never leave focus on a button that just turned off
    }
  }
  $('lyricsDone').onclick = () => draft.session.review()
  $('lyricsBack').onclick = () => { draft.session.back(); render() }
  $('lyricsEditText').onclick = () => { draft.session.editText(); render() }
  async function saveDraft() {
    const current = draft
    if (!current || saving || current.session.step !== 'review') return
    const fields = current.session.save()
    if (!fields) return
    const removesLyrics = current.session.removesLyrics
    saving = true
    current.session.pause()
    const review = sections.find((section) => section.dataset.step === 'review')
    review.inert = true
    dialog.setAttribute('aria-busy', 'true')
    try {
      const result = await save(current.target, current.fingerprint, fields)
      if (draft !== current) return
      if (result?.keepOpen) showError(result.message)
      else close()
      notice(result?.message || (removesLyrics ? 'Lyrics removed' : 'Lyrics saved'))
    } catch (e) {
      if (draft === current) showError(e.message || 'Could not save lyrics')
    } finally {
      saving = false
      review.inert = false
      dialog.removeAttribute('aria-busy')
      if (draft === current) $('lyricsSave').focus()
    }
  }
  $('lyricsSave').onclick = saveDraft

  return {
    isOpen: () => dialog.open,
    get session() { return draft?.session },
    close,
    pause() {
      if (!draft) return
      draft.session.pause()
      if (draft.session.step === 'tap') refreshTap()
    },
    end: () => draft?.onEnd?.(),
    save: saveDraft,
    async open(target) {
      if (opening || saving || draft || dialog.open) return false
      const returnFocus = document.activeElement
      opening = true
      try {
        const record = await load(target)
        if (!record) { notice('Could not find the saved song'); return false }
        // The target can change while storage is being read.
        const playback = begin(target)
        if (!playback) return false
        const { transport, restore } = playback
        draft = { target, fingerprint: lyricsFingerprint(record), restore, returnFocus }
        draft.session = createLyricsSession({
          record,
          transport: { ...transport, onEnd: (cb) => { draft.onEnd = cb } },
          onReview: render
        })
        dialog.showModal()
        render()
        return true
      } catch (e) {
        close()
        notice(e.message || 'Could not open lyrics')
        return false
      } finally {
        opening = false
      }
    }
  }
}
