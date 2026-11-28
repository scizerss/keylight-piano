// Unit test for the piano course (renderer/course/): node scripts/test-course.js
// Data, logic and course actions, no browser, keyboard or sound.
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const load = (f) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'course', f)).href)

async function testHomeExperience(app) {
  const { experienceDefaults, normalizeExperience, SETUP_STEPS } = await import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'setup-flow.js')).href)
  const slice = (start, end) => app.slice(app.indexOf(start), app.indexOf(end))
  const saved = new Map()
  let hidden, refreshes = 0
  const context = vm.createContext({
    experienceDefaults, normalizeExperience, SETUP_STEPS,
    store: { get: (key, def) => saved.get(key) ?? def, set: (key, value) => saved.set(key, value) },
    $: () => ({ classList: { toggle: (_cls, show) => { hidden = show } } }),
    settings: { experience: '' }, setup: { first: true, step: SETUP_STEPS.indexOf('level') },
    player: null, course: { refreshExperience: () => { refreshes++ } },
    saveSettings() {}, syncHudButtons() {}, syncLevelSettings() {}, setupPlan() {}, nextStep: () => 'ready', goSetupStep() {}
  })
  vm.runInContext([
    slice('function syncExperienceCard(', 'function updateHome('),
    slice('function applyExperience(', 'function applySetupLevel('),
    slice('const setupSkip =', '// "Find my level" on the last screen'),
    'globalThis.skip = setupSkip'
  ].join('\n'), context)
  context.syncExperienceCard()
  assert.equal(hidden, true, 'new installs do not show the card before onboarding')
  saved.set('lumi.onboarded', true)
  context.syncExperienceCard()
  assert.equal(hidden, false, 'an onboarded user without an answer sees the card')
  context.dismissExperienceCard()
  context.syncExperienceCard()
  assert.equal(hidden, true, 'Not now persists across Home visits')
  saved.delete('lumi.experienceCardDismissed')
  context.skip()
  context.syncExperienceCard()
  assert.equal(hidden, true, 'skipping the setup level step also dismisses the card')
  assert.equal(context.settings.experience, '')
  saved.delete('lumi.experienceCardDismissed')
  assert.ok(context.applyExperience('new'))
  assert.deepEqual(context.settings, { experience: 'new', labels: 'fingers', rate: 0.75, handGuide: 'auto', handGuideRuns: 0 })
  assert.equal(refreshes, 1, 'changing experience refreshes the course')
  context.settings.experience = ''
  context.syncExperienceCard()
  assert.equal(hidden, true, 'clearing a previous answer does not reoffer the card')
}

;(async () => {
  const { COURSE } = await load('index.js')
  const schema = await load('course-schema.js')
  const E = await load('course-engine.js')
  const { seq } = await load('builders.js')
  const { buildPieceSong, pieceHand } = await load('runners.js')
  const { Player } = await import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'player.js')).href)
  const { validateCourse, wordCount, MAX_TEACH_WORDS } = schema
  const clone = (o) => JSON.parse(JSON.stringify(o))
  const [L1, L2, L3] = COURSE.levels
  const approx = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`)

  // ---------- the shipped course ----------
  assert.deepEqual(validateCourse(COURSE), [])
  const ids = []
  for (const level of COURSE.levels) {
    ids.push(level.id)
    if (level.exam) { ids.push(level.exam.id); level.exam.items.forEach((i) => ids.push(i.id)) }
    for (const lesson of level.lessons) {
      ids.push(lesson.id)
      assert.ok(lesson.goal && lesson.goal.length > 10, `${lesson.id} goal`)
      lesson.items.forEach((i) => ids.push(i.id))
      if (!level.draft) {
        assert.ok(lesson.teach.length > 0, `${lesson.id} teach`)
        for (const t of lesson.teach) assert.ok(wordCount(t) <= MAX_TEACH_WORDS, `${lesson.id}: paragraph of ${wordCount(t)} words`)
        assert.ok(!/\b(roli|lumi)\b/i.test(JSON.stringify(lesson)), `${lesson.id} names a brand`)
      }
    }
  }
  assert.equal(new Set(ids).size, ids.length, 'ids are unique')
  assert.ok(L1.lessons.length >= 7 && L2.lessons.length >= 7)
  assert.ok(L3.lessons.length >= 7 && L3.lessons.every((l) => l.items.length >= 3 && l.goal && l.teach.length >= 2))
  // 24-key levels stay inside two octaves of reachable notes per hand window
  for (const level of [L1, L2]) assert.equal(level.keys, 24)

  // The first lesson teaches hand placement, then opens the piece in Watch before its scored Wait run.
  const [handIntro, intro] = L1.lessons[0].items
  assert.deepEqual(handIntro, {
    id: 'hand-intro', title: 'Meet your fingers', type: 'hand-intro',
    params: { hand: 'right', findC: true }, passAt: 1
  })
  const leftLesson = L1.lessons.find((lesson) => lesson.id === 'l1-left')
  assert.deepEqual(leftLesson.items[0], {
    id: 'hand-intro-left', title: 'Place your left hand', type: 'hand-intro',
    params: { hand: 'left', findC: false }, passAt: 1
  })
  assert.equal(intro.id, 'l1-find-c.ode-intro')
  assert.ok(intro.params.watchFirst)
  assert.deepEqual(L1.lessons[0].items.slice(2).map((item) => item.id), ['l1-find-c.theory', 'l1-find-c.game'])
  assert.deepEqual(L1.lessons[0].items.at(-1).params, { game: 'find-the-key', names: ['C'], mode: 'every', rounds: 3 })
  for (const item of [L1.lessons[1].items.at(-1), L1.exam.items.find((item) => item.id === 'l1-exam.names')]) {
    assert.deepEqual(item.params.names, ['C', 'D', 'E', 'F', 'G', 'A', 'B'])
  }

  const app = readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8')
  await testHomeExperience(app)
  const appTest = vm.createContext({ IS_IOS: false, HAS_COVERS: true, dot: () => ' \u00b7 ',
    Player, buildPieceSong, initAudio() {}, resetSession() {}, audioContext() {},
    onPlayerState() {}, onJudgement() {}, onFinish() {}, setKeyCount() {},
    showScreen() {}, syncHudButtons() {}, resize() {}, status() {}, setKeyboardWindow() {}, hintOffKeys() {},
    passText: () => '80%', pieceHand, keysStayAt: () => null, kbKeys: () => 24,
    usesScreenKeys: () => true, $: () => ({}), settings: { countIn: 0 }, player: null, song: null, courseRun: null,
    scheduler: { reset() {} }
  })
  vm.runInContext(app.slice(app.indexOf('async function startCoursePiece'), app.indexOf('async function fetchLibraryFile')), appTest)
  vm.runInContext(app.slice(app.indexOf('function loadIntoPlayer'), app.indexOf('let lastSongKey')), appTest)
  vm.runInContext(app.slice(app.indexOf('function playerRange'), app.indexOf('const lightKeys')), appTest)
  await appTest.startCoursePiece({ item: intro }, 1)
  assert.equal(appTest.player.mode, 'WATCH')
  assert.equal(appTest.player.windowKeys, 24)
  const level10Run = COURSE.levels[9].lessons.flatMap((lesson) => lesson.items).find((item) => item.title === 'Four octaves up, both hands')
  await appTest.startCoursePiece({ item: level10Run }, 10)
  assert.equal(appTest.player.mode, 'PRACTISE')
  assert.ok(appTest.player.windowKeys >= 49)
  assert.equal(appTest.player.playableNotes().length, appTest.song.notes.length, 'the wide on-screen keyboard covers both hands')

  // ---------- builders ----------
  assert.deepEqual(seq('C4 D#4:0.5 r:2 Bb3'), [{ p: 60, beats: 1 }, { p: 63, beats: 0.5 }, { p: null, beats: 2 }, { p: 58, beats: 1 }])
  assert.throws(() => seq('H4'))

  // ---------- validator catches mistakes ----------
  const problems = (mutate) => { const c = clone(COURSE); mutate(c); return validateCourse(c) }
  assert.ok(validateCourse(null).length > 0)
  assert.ok(validateCourse({ levels: [] }).length > 0)
  assert.ok(problems((c) => { c.levels[0].lessons[0].teach[0] = 'word '.repeat(61) }).some((p) => /words/.test(p)))
  assert.ok(problems((c) => { c.levels[0].lessons[1].id = c.levels[0].lessons[0].id }).some((p) => /duplicate/.test(p)))
  assert.ok(problems((c) => { c.levels[1].number = 5 }).some((p) => /number/.test(p)))
  assert.ok(problems((c) => { c.levels[0].lessons[0].items[0].type = 'bogus' }).some((p) => /unknown item type/.test(p)))
  assert.ok(problems((c) => { c.levels[0].lessons[0].items[0].params = { hand: 'both', findC: 'yes' } }).filter((p) => /hand-intro/.test(p)).length === 2)
  assert.ok(problems((c) => { c.levels[0].lessons[0].items.find((item) => item.id === 'l1-find-c.theory').params.answer = 9 }).some((p) => /answer/.test(p)))
  const gameProblems = (patch) => problems((c) => { Object.assign(c.levels[0].lessons[0].items.at(-1).params, patch) })
  assert.ok(gameProblems({ names: [] }).some((p) => /names/.test(p)))
  assert.ok(gameProblems({ names: ['C#'] }).some((p) => /names/.test(p)))
  assert.deepEqual(gameProblems({ names: ['C♯'] }), [])
  assert.ok(gameProblems({ mode: 'all' }).some((p) => /mode/.test(p)))
  assert.ok(gameProblems({ game: 'read-treble' }).some((p) => /mode/.test(p)))
  assert.ok(problems((c) => { c.levels[0].lessons[0].pass.minItemsDone = 99 }).some((p) => /exceeds/.test(p)))
  assert.ok(problems((c) => { delete c.levels[0].lessons[0].goal }).some((p) => /goal/.test(p)))
  assert.ok(problems((c) => { delete c.levels[0].exam }).some((p) => /exam/.test(p)))
  assert.ok(problems((c) => { c.levels[1].lessons[7].items[1].params.tracks.left.pop() }).some((p) => /beats/.test(p)))
  assert.ok(problems((c) => { c.levels[0].lessons[4].items[2].params.notes[0].p = 200 }).some((p) => /MIDI/.test(p)))
  assert.ok(problems((c) => { c.levels[0].lessons[0].items[0].passAt = {} }).some((p) => /passAt/.test(p)))
  assert.ok(problems((c) => { c.levels[0].lessons[3].items[0].params.tb.type = 'nope' }).some((p) => /params\.tb/.test(p)))

  // ---------- progress and status ----------
  const lessonOf = (n, i) => COURSE.levels[n - 1].lessons[i]
  const passAll = (progress, lesson, accuracy = 1) => lesson.items.reduce((p, it) => E.recordItemResult(p, lesson.id, it.id, { accuracy, at: 1 }), progress)
  let prog = E.emptyProgress()
  assert.equal(prog.version, E.PROGRESS_VERSION)
  assert.equal(E.lessonStatus(COURSE, prog, L1.lessons[0].id), 'open')
  assert.equal(E.lessonStatus(COURSE, prog, L1.lessons[1].id), 'ahead')
  assert.equal(E.lessonStatus(COURSE, prog, L2.lessons[0].id), 'ahead')
  assert.equal(E.lessonStatus(COURSE, prog, L3.lessons[0].id), 'ahead')
  assert.equal(E.lessonStatus(COURSE, prog, 'no-such-lesson'), 'ahead')
  assert.equal(E.nextLesson(COURSE, prog).id, L1.lessons[0].id)

  // below the bar does not count; keeps the best result
  const first = L1.lessons[0]
  prog = E.recordItemResult(prog, first.id, first.items[0].id, { accuracy: 0.5 })
  assert.equal(E.lessonStatus(COURSE, prog, first.id), 'open')
  const frozen = JSON.stringify(prog)
  const prog2 = E.recordItemResult(prog, first.id, first.items[0].id, { accuracy: 1, stars: 5, at: 5 })
  assert.equal(JSON.stringify(prog), frozen, 'input is not mutated')
  const rec = prog2.lessons[first.id][first.items[0].id]
  assert.deepEqual([rec.accuracy, rec.stars, rec.tries, rec.at], [1, 5, 2, 5])
  const worse = E.recordItemResult(prog2, first.id, first.items[0].id, { accuracy: 0.2 })
  assert.equal(worse.lessons[first.id][first.items[0].id].accuracy, 1, 'best accuracy is kept')
  assert.equal(E.recordItemResult(prog, 'x', 'y', { accuracy: 7 }).lessons.x.y.accuracy, 1, 'accuracy clamps')
  assert.equal(E.recordItemResult(prog, 'x', 'y', { accuracy: 'bad' }).lessons.x.y.accuracy, 0)
  assert.equal(E.starsFor(0.3), 0); assert.equal(E.starsFor(0.7), 2); assert.equal(E.starsFor(1), 5)

  // a lesson is done once enough items pass
  for (const lesson of [first, leftLesson]) {
    const partial = lesson.items.slice(0, 2).reduce((p, item) => E.recordItemResult(p, lesson.id, item.id, { accuracy: 1 }), E.emptyProgress())
    assert.equal(E.isLessonDone(COURSE, partial, lesson), false)
    const next = E.recordItemResult(partial, lesson.id, lesson.items[2].id, { accuracy: 1 })
    assert.equal(E.isLessonDone(COURSE, next, lesson), true)
  }
  prog = passAll(E.emptyProgress(), first)
  assert.equal(E.lessonStatus(COURSE, prog, first.id), 'done')
  assert.equal(E.lessonStatus(COURSE, prog, L1.lessons[1].id), 'open')
  assert.equal(E.nextLesson(COURSE, prog).id, L1.lessons[1].id)

  // out of order: finishing lesson 3 first leaves 1 open, 2 ahead and 3 done
  let ooo = passAll(E.emptyProgress(), L1.lessons[2])
  assert.equal(E.lessonStatus(COURSE, ooo, L1.lessons[2].id), 'done')
  assert.equal(E.lessonStatus(COURSE, ooo, L1.lessons[1].id), 'ahead')
  assert.equal(E.nextLesson(COURSE, ooo).id, L1.lessons[0].id)
  // Passing lesson 2 early must not make lesson 3 open across the unfinished 1.
  let secondEarly = passAll(E.emptyProgress(), L1.lessons[1])
  assert.deepEqual(L1.lessons.slice(0, 3).map((l) => E.lessonStatus(COURSE, secondEarly, l.id)), ['open', 'done', 'ahead'])
  assert.equal(E.nextLesson(COURSE, secondEarly).id, L1.lessons[0].id)
  assert.equal(E.nextStep(COURSE, secondEarly).lesson.id, L1.lessons[0].id)
  assert.equal(E.levelStatus(COURSE, secondEarly, 1), 'open')
  assert.equal(E.examStatus(COURSE, secondEarly, 1), 'ahead')
  for (const lesson of L1.lessons.slice(2)) secondEarly = passAll(secondEarly, lesson)
  assert.equal(E.examStatus(COURSE, secondEarly, 1), 'ahead', 'every lesson is required, including an earlier gap')
  secondEarly = passAll(secondEarly, L1.lessons[0])
  assert.equal(E.nextLesson(COURSE, secondEarly), null)
  assert.equal(E.nextStep(COURSE, secondEarly).kind, 'exam')
  assert.equal(E.examStatus(COURSE, secondEarly, 1), 'open')
  // results for unknown lessons are kept but harmless
  ooo = E.recordItemResult(ooo, 'old-lesson', 'old-item', { accuracy: 1 })
  assert.equal(E.lessonStatus(COURSE, ooo, 'old-lesson'), 'ahead')

  // minItemsDone and minStars
  const strict = { id: 'l1-strict', items: [{ id: 'a', passAt: { accuracy: 0.8 } }, { id: 'b', passAt: { accuracy: 0.8 } }], pass: { minItemsDone: 1, minStars: 3 } }
  const strictCourse = { levels: [{ ...L1, lessons: [strict] }] }
  let sp = E.recordItemResult(E.emptyProgress(), 'l1-strict', 'a', { accuracy: 0.9, stars: 2 })
  assert.equal(E.isLessonDone(strictCourse, sp, strict), false)
  sp = E.recordItemResult(sp, 'l1-strict', 'b', { accuracy: 0.9, stars: 3 })
  assert.equal(E.isLessonDone(strictCourse, sp, strict), true)
  assert.equal(E.isItemDone({ passAt: { stars: 4 } }, { accuracy: 1, stars: 3 }), false)
  assert.equal(E.isItemDone({ passAt: { accuracy: 0.8 } }, undefined), false)

  // ---------- levels and exams ----------
  let all = E.emptyProgress()
  for (const l of L1.lessons) all = passAll(all, l)
  assert.equal(E.examStatus(COURSE, all, 1), 'open')
  assert.equal(E.examStatus(COURSE, E.emptyProgress(), 1), 'ahead')
  assert.equal(E.examStatus(COURSE, all, 2), 'ahead')
  assert.equal(E.examStatus(COURSE, all, 3), 'ahead', 'a later level exam is ahead')
  const draftCourse = { levels: [{ ...L1, draft: true }] }
  assert.equal(E.examStatus(draftCourse, E.emptyProgress(), 1), 'none', 'a draft level has no exam to take')
  assert.equal(E.isLevelUnlocked(COURSE, all, 2), false, 'lessons alone do not open level 2')
  assert.equal(E.nextStep(COURSE, all).kind, 'exam')

  const score = E.examScore(L1.exam, [100, 100, 100, 100, 100, 0])
  approx(score.percent, 500 / 6); assert.equal(score.passed, false, 'a task under the floor fails')
  assert.equal(E.examScore(L1.exam, [90, 90, 90, 90, 90, 90]).passed, true)
  assert.equal(E.examScore(L1.exam, []).percent, 0)
  assert.equal(E.examScore(L1.exam, [70, 70, 70, 70, 70, 70]).passed, false, 'below the pass mark')

  let failed = E.recordExamResult(all, 'level-1', { percent: 60, passed: false, at: 2 })
  assert.equal(E.isLevelUnlocked(COURSE, failed, 2), false)
  assert.equal(E.examStatus(COURSE, failed, 1), 'open')
  const passed = E.recordExamResult(failed, 'level-1', { percent: 90, passed: true, at: 3 })
  assert.equal(passed.exams['level-1'].tries, 2)
  assert.equal(E.examStatus(COURSE, passed, 1), 'done')
  assert.equal(E.isLevelUnlocked(COURSE, passed, 2), true)
  assert.equal(E.lessonStatus(COURSE, passed, L2.lessons[0].id), 'open')
  assert.equal(E.nextLesson(COURSE, passed).id, L2.lessons[0].id)
  const later = E.recordExamResult(passed, 'level-1', { percent: 10, passed: false })
  assert.equal(later.exams['level-1'].passed, true, 'a pass is never lost'); assert.equal(later.exams['level-1'].percent, 90)

  // skip ahead
  const skipped = E.unlockLevel(E.emptyProgress(), 3)
  assert.deepEqual(skipped.unlocked, [2, 3])
  assert.equal(E.isLevelUnlocked(COURSE, skipped, 2), true)
  assert.equal(E.lessonStatus(COURSE, skipped, L2.lessons[0].id), 'ahead', 'an explicit unlock allows practice without changing Guided order')
  assert.equal(E.lessonStatus(COURSE, skipped, L2.lessons[1].id), 'ahead', 'lessons inside a level still go in order')
  assert.equal(E.lessonStatus(COURSE, skipped, L3.lessons[0].id), 'ahead', 'a skipped-to level still follows earlier levels in Guided order')
  assert.equal(E.lessonStatus(COURSE, skipped, L3.lessons[1].id), 'ahead')
  assert.equal(E.nextLesson(COURSE, skipped).id, L1.lessons[0].id)
  assert.equal(E.nextStep(COURSE, skipped).lesson.id, L1.lessons[0].id)
  assert.equal(E.levelStatus(COURSE, skipped, 2), 'ahead')
  assert.equal(E.levelStatus(COURSE, skipped, 3), 'ahead')
  let skippedReady = skipped
  for (const lesson of L2.lessons) skippedReady = passAll(skippedReady, lesson)
  assert.equal(E.examStatus(COURSE, skippedReady, 2), 'ahead', 'a later exam waits for earlier levels even with all its lessons done')
  assert.equal(E.nextStep(COURSE, skippedReady).lesson.id, L1.lessons[0].id)
  // An isolated later exam pass must not make the following level recommended.
  let laterPass = E.recordExamResult(E.emptyProgress(), L2.id, { percent: 100, passed: true })
  assert.equal(E.isLevelUnlocked(COURSE, laterPass, 3), true)
  assert.equal(E.levelStatus(COURSE, laterPass, 2), 'done')
  assert.equal(E.levelStatus(COURSE, laterPass, 3), 'ahead')
  assert.equal(E.lessonStatus(COURSE, laterPass, L3.lessons[0].id), 'ahead')
  for (const lesson of L3.lessons) laterPass = passAll(laterPass, lesson)
  assert.equal(E.examStatus(COURSE, laterPass, 3), 'ahead')
  assert.equal(E.nextLesson(COURSE, laterPass).id, L1.lessons[0].id)
  assert.equal(E.nextStep(COURSE, laterPass).lesson.id, L1.lessons[0].id)
  assert.equal(E.isLevelUnlocked(COURSE, E.emptyProgress(), 99), false)
  assert.equal(E.isLevelUnlocked(COURSE, E.emptyProgress(), 1), true)
  const placed = E.recordExamResult(E.emptyProgress(), 'level-1', { percent: 95, passed: true, placement: true })
  assert.equal(E.isLevelUnlocked(COURSE, placed, 2), true, 'a placement pass opens the next level')
  assert.equal(placed.exams['level-1'].placement, true)

  // ---------- ahead is advice, never a lock ----------
  const states = (progress, level) => level.lessons.map((l) => E.lessonStatus(COURSE, progress, l.id))
  const fresh0 = E.emptyProgress()
  assert.deepEqual(states(fresh0, L1), ['open', ...L1.lessons.slice(1).map(() => 'ahead')], 'fresh learner: one open, the rest ahead')
  assert.ok(states(fresh0, L2).every((x) => x === 'ahead'), 'a later level is all ahead')
  assert.ok(!COURSE.levels.some((lv) => states(fresh0, lv).includes('locked')), 'no lesson answers locked')
  assert.deepEqual([E.levelStatus(COURSE, fresh0, 1), E.levelStatus(COURSE, fresh0, 2), E.levelStatus(COURSE, fresh0, 42)], ['open', 'ahead', 'ahead'])
  assert.equal(E.levelSummary(COURSE, fresh0, 2).status, 'ahead')
  assert.equal(E.examStatus(COURSE, fresh0, 1), 'ahead', 'the exam comes after the lessons')

  // after passing one lesson the next one is the recommendation
  const one = passAll(fresh0, L1.lessons[0])
  assert.deepEqual(states(one, L1).slice(0, 3), ['done', 'open', 'ahead'])
  assert.equal(E.nextLesson(COURSE, one).id, L1.lessons[1].id)
  assert.equal(E.nextStep(COURSE, one).lesson.id, L1.lessons[1].id)

  // opening an ahead lesson and passing it marks nothing else
  const skipTo = L1.lessons[3]
  assert.equal(E.lessonStatus(COURSE, one, skipTo.id), 'ahead')
  const early = passAll(one, skipTo, 0.9)
  assert.equal(E.lessonStatus(COURSE, early, skipTo.id), 'done')
  assert.equal(E.lessonStatus(COURSE, early, L1.lessons[1].id), 'open', 'the skipped lessons are not passed')
  assert.equal(E.lessonStatus(COURSE, early, L1.lessons[2].id), 'ahead')
  assert.equal(E.isLessonDone(COURSE, early, L1.lessons[1]), false)
  assert.equal(E.isLessonDone(COURSE, early, L1.lessons[2]), false)
  assert.equal(E.levelLessonsDone(COURSE, early, L1), 2)
  assert.deepEqual(Object.keys(early.lessons).sort(), [L1.lessons[0].id, skipTo.id].sort(), 'only what was played has a record')
  assert.equal(E.nextLesson(COURSE, early).id, L1.lessons[1].id, 'Continue still points at the recommended lesson')
  assert.equal(E.nextStep(COURSE, early).lesson.id, L1.lessons[1].id)
  assert.equal(E.examStatus(COURSE, early, 1), 'ahead')
  assert.deepEqual(early.unlocked, [], 'opening early does not unlock a level')

  // levels: playing a later level early does not open it or pass the one before
  const lv2 = passAll(fresh0, L2.lessons[0])
  assert.equal(E.lessonStatus(COURSE, lv2, L2.lessons[0].id), 'done')
  assert.equal(E.isLevelUnlocked(COURSE, lv2, 2), false)
  assert.equal(E.levelStatus(COURSE, lv2, 2), 'ahead')
  assert.equal(E.levelStatus(COURSE, lv2, 1), 'open')
  assert.equal(E.nextLesson(COURSE, lv2).id, L1.lessons[0].id)
  assert.equal(E.nextStep(COURSE, lv2).lesson.id, L1.lessons[0].id)
  assert.equal(E.lessonStatus(COURSE, lv2, L2.lessons[1].id), 'ahead')
  // only a passed exam makes a level done and opens the next one
  assert.equal(E.levelStatus(COURSE, passed, 1), 'done')
  assert.equal(E.levelStatus(COURSE, passed, 2), 'open')
  assert.equal(E.levelStatus(COURSE, skipped, 3), 'ahead')

  // exam entry: ahead until the level's lessons are done, open after, done once passed; an exam taken early is a placement
  assert.equal(E.examStatus(COURSE, early, 1), 'ahead')
  assert.equal(E.examStatus(COURSE, all, 1), 'open')
  const placedEarly = E.recordExamResult(early, 'level-1', { percent: 92, passed: true, placement: true })
  assert.equal(E.examStatus(COURSE, placedEarly, 1), 'done')
  assert.equal(E.levelStatus(COURSE, placedEarly, 1), 'done')
  assert.equal(E.lessonStatus(COURSE, placedEarly, L1.lessons[1].id), 'open', 'a placement pass does not mark lessons passed')
  assert.equal(E.isLevelUnlocked(COURSE, placedEarly, 2), true)
  assert.equal(E.levelStatus(COURSE, placedEarly, 2), 'ahead', 'unfinished earlier lessons still determine Guided order after placement')
  assert.equal(E.lessonStatus(COURSE, placedEarly, L2.lessons[0].id), 'ahead')
  assert.equal(E.nextStep(COURSE, placedEarly).lesson.id, L1.lessons[1].id, 'unfinished lessons stay the recommendation')

  // finishing everything playable
  let full = E.emptyProgress()
  const playable = COURSE.levels.filter((lv) => !lv.draft && lv.exam)
  for (const level of playable) {
    for (const l of level.lessons) full = passAll(full, l)
    full = E.recordExamResult(full, level.id, { percent: 100, passed: true })
  }
  assert.equal(E.nextLesson(COURSE, full), null)
  assert.equal(E.nextStep(COURSE, full), null, 'draft levels offer nothing yet')
  const sum = E.courseSummary(COURSE, full)
  assert.equal(sum.percent, 100); assert.equal(sum.examsPassed, playable.length)
  assert.equal(sum.lessonsTotal, playable.reduce((n, lv) => n + lv.lessons.length, 0))

  // summaries
  const empty = E.courseSummary(COURSE, E.emptyProgress())
  assert.equal(empty.percent, 0); assert.equal(empty.minutesPractised, 0)
  const part = E.recordItemResult(E.emptyProgress(), 'x', 'y', { accuracy: 1, seconds: 125 })
  assert.equal(E.courseSummary(COURSE, part).minutesPractised, 2)
  const ls = E.levelSummary(COURSE, prog, 1)
  assert.deepEqual([ls.done, ls.total, ls.unlocked, ls.exam, ls.playable], [1, L1.lessons.length, true, 'ahead', true])
  assert.equal(ls.minutesDone, first.minutes)
  const lastLevel = COURSE.levels[COURSE.levels.length - 1]
  assert.equal(E.levelSummary(COURSE, prog, lastLevel.number).playable, !lastLevel.draft)
  assert.equal(E.levelSummary(COURSE, prog, 42), null)

  // ---------- serialization ----------
  const round = E.parseProgress(E.serializeProgress(E.unlockLevel(full, 3)))
  assert.deepEqual(round, E.unlockLevel(full, 3))
  assert.equal(JSON.parse(E.serializeProgress(prog)).version, E.PROGRESS_VERSION)
  const fresh = JSON.stringify(E.emptyProgress())
  for (const bad of [null, undefined, '', 'not json', '[]', '42', '{"version":99}', 7, [], '{"version":1,"lessons":5,"exams":"x","unlocked":"y","seconds":"z"}']) {
    assert.equal(JSON.stringify(E.parseProgress(bad)), fresh, `corrupt: ${String(bad)}`)
  }
  const dirty = E.parseProgress(JSON.stringify({
    version: 1, seconds: 30, unlocked: [3, 3, 'x', -4, 1.5, 2],
    lessons: { good: { a: { accuracy: 2, stars: 9, tries: 1.7, at: 5 }, b: { accuracy: 'x' }, c: null }, junk: 5 },
    exams: { 'level-1': { percent: 150, passed: true, tries: 1, at: 2 }, 'level-2': { percent: 1 } }
  }))
  assert.deepEqual(dirty.unlocked, [2, 3])
  assert.deepEqual(dirty.lessons, { good: { a: { accuracy: 1, stars: 5, tries: 1, at: 5 } } })
  assert.deepEqual(Object.keys(dirty.exams), ['level-1']); assert.equal(dirty.exams['level-1'].percent, 100)
  assert.equal(dirty.seconds, 30)

  // reserved keys never reach Object.prototype, in stored text or in recorded results
  const hostile = '{"version":1,"seconds":0,"unlocked":[],"lessons":{"__proto__":{"l1-find-c":{"accuracy":1,"stars":5,"tries":1,"at":1}},"constructor":{"x":{"accuracy":1,"stars":5,"tries":1,"at":1}},"l1":{"__proto__":{"accuracy":1,"stars":5,"tries":1,"at":1},"prototype":{"accuracy":1,"stars":5,"tries":1,"at":1},"ok":{"accuracy":1,"stars":5,"tries":1,"at":1}}},"exams":{"__proto__":{"percent":100,"passed":true,"tries":1,"at":1},"constructor":{"percent":100,"passed":true,"tries":1,"at":1}}}'
  const clean = E.parseProgress(hostile)
  assert.deepEqual(Object.keys(clean.lessons), ['l1'])
  assert.deepEqual(Object.keys(clean.lessons.l1), ['ok'])
  assert.deepEqual(Object.keys(clean.exams), [])
  assert.equal(Object.prototype['l1-find-c'], undefined)
  let hp = E.emptyProgress()
  for (const bad of ['__proto__', 'constructor', 'prototype']) {
    hp = E.recordItemResult(hp, bad, 'x', { accuracy: 1 })
    hp = E.recordItemResult(hp, 'l1-find-c', bad, { accuracy: 1 })
    hp = E.recordExamResult(hp, bad, { percent: 100, passed: true })
  }
  assert.deepEqual(hp, E.emptyProgress())
  hp = E.recordItemResult(hp, 'l1-find-c', 'a', { accuracy: 0.9, at: 5 })
  hp = E.recordItemResult(hp, 'l1-find-c', 'a', { accuracy: 0.5, at: 6 })
  assert.equal(hp.lessons['l1-find-c'].a.tries, 2)
  assert.equal(Object.prototype.a, undefined)
  assert.equal(E.ownGet(hp.lessons, 'constructor'), undefined)
  assert.equal(E.ownGet(hp.lessons, 'toString'), undefined)
  // serialize / parse stays round-trip compatible: same shape, version field
  const roundTrip = E.parseProgress(E.serializeProgress(hp))
  assert.deepEqual(roundTrip, hp)
  assert.equal(JSON.parse(E.serializeProgress(hp)).version, 1)
  const old = '{"version":1,"lessons":{"a":{"b":{"accuracy":0.8,"stars":2,"tries":3,"at":9}}},"exams":{"level-1":{"percent":90,"passed":true,"tries":1,"at":2,"placement":true}},"unlocked":[2],"seconds":61}'
  assert.equal(E.serializeProgress(E.parseProgress(old)), old)

  // ---------- "Find my level" placement (placement.js) ----------
  const P = await load('placement.js')
  const lastNum = COURSE.levels[COURSE.levels.length - 1].number
  // the run walks the exams of levels 1 .. (last - 1): each one opens the level after it
  assert.deepEqual(P.placementLevels(COURSE), COURSE.levels.slice(0, -1).map((l) => l.number))
  // a level without an exam, or a draft level after it, ends the walk there
  const mini = { levels: [{ number: 1, exam: {}, lessons: [] }, { number: 2, exam: {}, lessons: [] }, { number: 3, lessons: [] }, { number: 4, exam: {}, lessons: [] }, { number: 5, lessons: [] }] }
  assert.deepEqual(P.placementLevels(mini), [1, 2])
  assert.deepEqual(P.placementLevels({ levels: [{ number: 1, exam: {}, lessons: [] }, { number: 2, draft: true, lessons: [] }] }), [])
  assert.deepEqual(P.placementLevels({ levels: [{ number: 1, draft: true, exam: {}, lessons: [] }, { number: 2, exam: {}, lessons: [] }] }), [])

  /** Plays a run through: results[i] is the pass of the i-th exam asked for. Returns the finished run and the exams asked. */
  const playRun = (course, results) => {
    let run = P.startPlacement()
    const asked = []
    for (const passed of results) {
      const n = P.nextPlacementLevel(course, run)
      if (n === null) break
      asked.push(n)
      run = P.afterPlacementExam(course, run, n, passed)
    }
    return { run, asked }
  }
  // first exam missed: start at level 1
  let r = playRun(COURSE, [false])
  assert.deepEqual(r.asked, [1]); assert.deepEqual(r.run, { state: 'done', lastPassed: 0 }); assert.equal(P.placementStart(r.run), 1)
  // levels 1 to 3 passed, 4 missed: start at level 4, and the run stops asking
  r = playRun(COURSE, [true, true, true, false, true, true])
  assert.deepEqual(r.asked, [1, 2, 3, 4]); assert.deepEqual(r.run, { state: 'done', lastPassed: 3 }); assert.equal(P.placementStart(r.run), 4)
  assert.equal(P.nextPlacementLevel(COURSE, r.run), null)
  // every exam passed: start at the last level
  r = playRun(COURSE, COURSE.levels.map(() => true))
  assert.equal(r.run.state, 'done'); assert.equal(P.placementStart(r.run), lastNum); assert.equal(r.asked.length, lastNum - 1)
  // the walk stops at a level with no exam after it in a smaller course
  r = playRun(mini, [true, true, true])
  assert.deepEqual(r.asked, [1, 2]); assert.equal(P.placementStart(r.run), 3)
  // only the exam the run waits on counts; a retry, another exam or a finished run changes nothing
  const waiting = P.afterPlacementExam(COURSE, P.startPlacement(), 1, true)
  assert.deepEqual(waiting, { state: 'running', lastPassed: 1 })
  assert.equal(P.nextPlacementLevel(COURSE, waiting), 2)
  assert.equal(P.afterPlacementExam(COURSE, waiting, 1, false), waiting, 'a retry of an exam already counted is ignored')
  assert.equal(P.afterPlacementExam(COURSE, waiting, 5, false), waiting, 'an exam out of turn is ignored')
  const skippedRun = P.skipPlacement()
  assert.equal(P.afterPlacementExam(COURSE, skippedRun, 1, true), skippedRun)
  assert.equal(P.nextPlacementLevel(COURSE, null), null)
  // Stop here keeps what was passed
  assert.deepEqual(P.stopPlacement(waiting), { state: 'done', lastPassed: 1 })
  assert.equal(P.placementStart(P.stopPlacement(P.startPlacement())), 1)
  // messages: plain, no em dashes
  assert.equal(P.placementMessage(4), 'You start at level 4. Earlier levels stay open if you want to review.')
  assert.ok(/level 1/.test(P.placementMessage(1)))
  for (const n of [1, 2, 4, lastNum]) assert.ok(!/—/.test(P.placementMessage(n)))

  // applying a run: stored on progress, levels up to the start opened with unlockLevel
  const placedRun = P.withPlacement(E.emptyProgress(), { state: 'done', lastPassed: 3 })
  assert.deepEqual(placedRun.unlocked, [2, 3, 4])
  assert.deepEqual(placedRun.placement, { state: 'done', lastPassed: 3 })
  assert.deepEqual(P.withPlacement(E.emptyProgress(), { state: 'done', lastPassed: 0 }).unlocked, [])
  assert.deepEqual(P.withPlacement(E.emptyProgress(), P.skipPlacement()).unlocked, [])
  assert.deepEqual(E.emptyProgress(), { version: 1, lessons: {}, exams: {}, unlocked: [], seconds: 0 }, 'withPlacement does not touch its input')

  // which card the Course screen shows
  assert.equal(P.placementCard(COURSE, E.emptyProgress()), 'offer')
  assert.equal(P.placementCard(COURSE, P.withPlacement(E.emptyProgress(), P.startPlacement())), 'running')
  assert.equal(P.placementCard(COURSE, P.withPlacement(E.emptyProgress(), P.skipPlacement())), null)
  assert.equal(P.placementCard(COURSE, placedRun), null)
  assert.equal(P.placementCard(COURSE, E.unlockLevel(E.emptyProgress(), 2)), null, 'not after Skip ahead')
  assert.equal(P.placementCard(COURSE, E.recordExamResult(E.emptyProgress(), L1.id, { percent: 90, passed: true, placement: true })), null, 'not after a placement pass')
  let oneLesson = E.emptyProgress()
  for (const it of L1.lessons[0].items) oneLesson = E.recordItemResult(oneLesson, L1.lessons[0].id, it.id, { accuracy: 1 })
  assert.ok(E.isLessonDone(COURSE, oneLesson, L1.lessons[0]))
  assert.equal(P.placementCard(COURSE, oneLesson), null, 'not once a lesson is done')
  // an exam task tried (not yet a lesson) keeps the card: a run in progress writes exam records
  assert.equal(P.placementCard(COURSE, E.recordItemResult(E.emptyProgress(), L1.exam.id, L1.exam.items[0].id, { accuracy: 1 })), 'offer')

  // the engine: a finished run makes the start level the recommended step, levels below it are for review
  let placedProg = E.emptyProgress()
  for (const lv of COURSE.levels.slice(0, 3)) placedProg = E.recordExamResult(placedProg, lv.id, { percent: 95, passed: true, placement: true })
  placedProg = P.withPlacement(placedProg, { state: 'done', lastPassed: 3 })
  assert.equal(E.placedAt(placedProg), 4)
  const L4 = COURSE.levels[3]
  assert.equal(E.nextStep(COURSE, placedProg).lesson.id, L4.lessons[0].id, 'Continue goes to level 4, lesson 1')
  assert.equal(E.nextLesson(COURSE, placedProg).id, L4.lessons[0].id)
  assert.equal(E.lessonStatus(COURSE, placedProg, L4.lessons[0].id), 'open')
  assert.equal(E.lessonStatus(COURSE, placedProg, L1.lessons[0].id), 'ahead', 'review levels have no Up next')
  assert.equal(E.levelStatus(COURSE, placedProg, 4), 'open')
  assert.equal(E.levelStatus(COURSE, placedProg, 2), 'done')
  // a review lesson done there still counts as done
  let review = placedProg
  for (const it of L1.lessons[0].items) review = E.recordItemResult(review, L1.lessons[0].id, it.id, { accuracy: 1 })
  assert.equal(E.lessonStatus(COURSE, review, L1.lessons[0].id), 'done')
  assert.equal(E.nextStep(COURSE, review).lesson.id, L4.lessons[0].id)
  // without a finished run, nothing changes: a running or skipped run, or a start of 1, keeps the normal order
  for (const pl of [P.startPlacement(), P.skipPlacement(), { state: 'done', lastPassed: 0 }]) {
    const p = P.withPlacement(E.recordExamResult(E.emptyProgress(), L1.id, { percent: 95, passed: true, placement: true }), pl)
    assert.equal(E.placedAt(p), 1)
    assert.equal(E.nextStep(COURSE, p).lesson.id, L1.lessons[0].id)
  }

  // storage: a valid run survives parse; a bad one is dropped, and an old progress gains nothing
  assert.deepEqual(E.parseProgress(E.serializeProgress(placedProg)), placedProg)
  assert.deepEqual(E.parseProgress(JSON.stringify({ ...E.emptyProgress(), placement: { state: 'running', lastPassed: 2 } })).placement, { state: 'running', lastPassed: 2 })
  assert.deepEqual(E.parseProgress(JSON.stringify({ ...E.emptyProgress(), placement: { state: 'done', lastPassed: -3 } })).placement, { state: 'done', lastPassed: 0 })
  for (const bad of [{ state: 'weird' }, 'done', 5, [], null]) {
    assert.equal(Object.hasOwn(E.parseProgress(JSON.stringify({ ...E.emptyProgress(), placement: bad })), 'placement'), false, `bad placement ${JSON.stringify(bad)}`)
  }
  assert.equal(Object.hasOwn(E.parseProgress(old), 'placement'), false)
  assert.equal(E.placedAt(E.parseProgress('{"version":1,"lessons":{},"exams":{},"unlocked":[],"seconds":0,"placement":{"state":"done","lastPassed":1.5}}')), 1)

  globalThis.location = { search: '?platform=mac' }
  globalThis.navigator ||= {}
  const { mountCourse } = await load('course-ui.js')
  globalThis.document = { body: { dataset: { screen: 'course' } } }
  const surface = (stored = new Map(), failRead = () => false, options = {}) => {
    let handleClick
    const host = {
      dataset: {}, scrollTop: 0, querySelector: () => null, contains: () => true,
      addEventListener: (_, handler) => { handleClick = handler }
    }
    const notices = []
    const storage = { getItem(key) { if (failRead(key)) throw new Error('unreadable'); return stored.get(key) ?? null }, setItem: (key, value) => stored.set(key, value) }
    const course = mountCourse({ host, storage, goto: () => course.show(), notice: (text) => notices.push(text), ...options })
    course.show()
    const click = (act, data = {}) => handleClick({ target: { closest: () => ({ dataset: { act, ...data } }) } })
    return { course, host, click, stored, notices }
  }
  const courseKey = 'lumi.course'
  for (const raw of ['{broken', E.serializeProgress(E.emptyProgress())]) {
    const stored = new Map([[courseKey, raw]])
    let blocked = raw !== '{broken'
    const { course, notices } = surface(stored, (key) => blocked && key === courseKey)
    const [lesson] = L1.lessons, [item] = lesson.items
    course.record(lesson.id, item, { accuracy: 1, stars: 5 })
    assert.equal(stored.get(courseKey), raw)
    assert.match(notices.at(-1), /Course progress could not be read/)
    blocked = false
    stored.set(courseKey, E.serializeProgress(E.emptyProgress()))
    course.show()
    course.record(lesson.id, item, { accuracy: 1, stars: 5 })
    assert.equal(E.parseProgress(stored.get(courseKey)).lessons[lesson.id][item.id].accuracy, 1)
  }
  const beginner = surface()
  assert.match(beginner.host.innerHTML, /Already play a little\?/)
  beginner.click('place-skip')
  assert.doesNotMatch(surface(beginner.stored).host.innerHTML, /Already play a little\?/)

  let experience = 'some'
  const levelChoice = surface(new Map(), undefined, { getExperience: () => experience })
  assert.match(levelChoice.host.innerHTML, /Already play a little\?/)
  for (experience of ['new', 'experienced']) {
    levelChoice.course.render()
    assert.doesNotMatch(levelChoice.host.innerHTML, /Already play a little\?/)
  }
  levelChoice.course.findMyLevel()
  assert.equal(levelChoice.course.view.ownerId, L1.exam.id)

  const starts = []
  const runItem = (item, ctx) => starts.push({ item, ctx })
  {
    let premium = false
    let offers = 0
    const launched = []
    const openPaywall = () => { offers++ }
    const { course, click, host } = surface(new Map(), undefined, {
      premium: () => premium, openPaywall, runItem: (item) => launched.push(item.id)
    })
    const lesson = L2.lessons[0], item = lesson.items[0]
    assert.match(host.innerHTML, /Keylight Premium/)
    course.openOwner(lesson.id)
    course.startItem(lesson.id, item.id)
    click('skip', { level: '2' })
    assert.equal(offers, 3)
    assert.deepEqual(launched, [])
    assert.equal(course.progress.unlocked.includes(2), false)
    course.findMyLevel()
    for (const task of L1.exam.items) course.record(L1.exam.id, task, { accuracy: 1 })
    click('place-next')
    assert.equal(course.view.ownerId, L2.exam.id, 'the Level 2 placement exam is accessible')
    course.startItem(L2.exam.id, L2.exam.items[0].id)
    assert.deepEqual(launched, [L2.exam.items[0].id])
    click('place-stop')
    course.openStep()
    assert.equal(offers, 4, 'placed players still need premium for the next lesson')
    premium = true
    course.openOwner(lesson.id)
    assert.equal(course.view.ownerId, lesson.id)
    premium = false
    course.startItem(lesson.id, item.id)
    assert.equal(offers, 5, 'a lapse gates an already-open lesson')
    course.returnToOwner(lesson.id)
    assert.equal(course.view.name, 'map', 'after a lapse Back still leaves an activity')
    assert.equal(offers, 5)
  }
  const introRun = surface(new Map(), undefined, { runItem })
  introRun.course.openStep()
  assert.deepEqual(starts, [{ item: handIntro, ctx: { ownerId: first.id, levelNum: 1 } }])
  assert.equal(introRun.course.record(first.id, handIntro, { accuracy: 0.99 }).passed, false)
  assert.equal(starts.length, 1)
  introRun.course.startItem(first.id, handIntro.id)
  assert.equal(introRun.course.record(first.id, handIntro, { accuracy: 1 }).passed, true)
  assert.deepEqual(starts.map(({ item }) => item.id), [handIntro.id, handIntro.id, intro.id])
  assert.equal(introRun.course.record(first.id, handIntro, { accuracy: 1 }).passed, true)
  assert.equal(starts.length, 3, 'duplicate completion does not start another piece')
  surface(introRun.stored, undefined, { runItem }).course.openStep()
  assert.equal(starts.at(-1).item, intro, 'Continue resumes with Watch if only hand placement was completed')
  assert.equal(starts.length, 4)

  const placement = surface()
  placement.click('place-find')
  assert.equal(placement.course.view.ownerId, L1.exam.id)
  assert.match(placement.host.innerHTML, /Finding your level: test 1 of/)
  for (const item of L1.exam.items) placement.course.record(L1.exam.id, item, { accuracy: 1 })
  assert.equal(placement.course.progress.exams[L1.id].placement, true)
  const resumed = surface(placement.stored)
  assert.match(resumed.host.innerHTML, /Next: the level 2 exam/)
  resumed.click('place-next')
  assert.equal(resumed.course.view.ownerId, L2.exam.id)
  const [firstTask, ...rest] = L2.exam.items
  const theory = rest.at(-1)
  assert.equal(theory.type, 'theory')
  resumed.course.record(L2.exam.id, firstTask, { accuracy: 0 })
  assert.equal(resumed.course.nextAction(L2.exam.id, firstTask.id, false).label, `Next: ${rest[0].title}`)
  for (const item of rest.slice(0, -1)) resumed.course.record(L2.exam.id, item, { accuracy: 1 })
  resumed.course.startItem(L2.exam.id, theory.id)
  resumed.click('answer', { i: (theory.params.answer + 1) % theory.params.options.length })
  assert.match(resumed.host.innerHTML, /See your level/)
  assert.doesNotMatch(resumed.host.innerHTML, /Try again/)
  resumed.click('place-result-action')
  assert.match(resumed.host.innerHTML, /You start at level 2\. Earlier levels stay open/)
  resumed.click('map')
  assert.match(resumed.host.innerHTML, /You start at level 2\. Earlier levels stay open/)
  assert.deepEqual(resumed.course.progress.unlocked, [2])
  assert.equal(resumed.course.progress.exams[L2.id].passed, false)
  assert.equal(E.nextStep(COURSE, surface(resumed.stored).course.progress).lesson.id, L2.lessons[0].id)

  console.log('course: ok')
})().catch((e) => { console.error(e); process.exit(1) })
