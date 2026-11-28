// "Find my level": a placement run for people who already play. Pure: no DOM, no storage.
// It walks up through the level exams (the exam of level N opens level N + 1, the same test-out
// the map's Placement button uses), stops at the first exam that is not passed, and starts the
// learner one level above the last exam passed. The run lives in progress.placement:
//   { state: 'running' | 'done' | 'skipped', lastPassed }   (lastPassed 0 = nothing passed yet)
// course-engine.js parses it and uses placedAt() for the recommended next step.
import { isLessonDone, isLevelUnlocked, ownGet, unlockLevel } from './course-engine.js'

/** The levels whose exams make up the run, in order: 1, 2, ... while the level has an exam and the level after it is playable. */
export function placementLevels(course) {
  const out = []
  for (const level of course.levels) {
    const after = course.levels.find((l) => l.number === level.number + 1)
    if (level.draft || !level.exam || !after || after.draft) break
    out.push(level.number)
  }
  return out
}

/** The level whose exam comes next in a running placement, or null when the run is over (or not running). */
export function nextPlacementLevel(course, placement) {
  if (!placement || placement.state !== 'running') return null
  const want = (placement.lastPassed || 0) + 1
  return placementLevels(course).includes(want) ? want : null
}

/** A new run, waiting on the first exam. */
export const startPlacement = () => ({ state: 'running', lastPassed: 0 })
/** The learner chose "Start from lesson 1": the card never shows again. */
export const skipPlacement = () => ({ state: 'skipped', lastPassed: 0 })
/** Ends a run where it is ("Stop here"): the learner starts above the last exam passed. */
export const stopPlacement = (placement) => ({ state: 'done', lastPassed: placement?.lastPassed || 0 })

/**
 * The run after the exam of `levelNumber` was scored. Only the exam the run is waiting on counts: any other
 * exam (or a retry of one already counted) returns the run unchanged. A pass moves on to the next exam, or ends
 * the run after the last one; anything else ends it.
 */
export function afterPlacementExam(course, placement, levelNumber, passed) {
  const want = nextPlacementLevel(course, placement)
  if (want === null || levelNumber !== want) return placement
  if (!passed) return { state: 'done', lastPassed: placement.lastPassed || 0 }
  const run = { state: 'running', lastPassed: levelNumber }
  return nextPlacementLevel(course, run) === null ? { state: 'done', lastPassed: levelNumber } : run
}

/** The level the learner starts at: one above the last exam passed (level 1 when none was). */
export const placementStart = (placement) => (placement?.lastPassed || 0) + 1

/** Applies a run to progress: stores it, and once it is done opens every level up to the start level. */
export function withPlacement(progress, placement) {
  let next = { ...progress, placement: { state: placement.state, lastPassed: placement.lastPassed || 0 } }
  if (placement.state === 'done' && placementStart(placement) > 1) next = unlockLevel(next, placementStart(placement))
  return next
}

/** What the Course screen shows at the top: 'offer' for a new learner, 'running' during a run, otherwise null. */
export function placementCard(course, progress, experience = '') {
  if (experience === 'new' || experience === 'experienced') return null
  const p = ownGet(progress, 'placement')
  if (p && p.state === 'running') return 'running'
  if (p) return null
  if (course.levels.some((level) => level.number > 1 && isLevelUnlocked(course, progress, level.number))) return null
  if (course.levels.some((level) => level.lessons.some((lesson) => isLessonDone(course, progress, lesson)))) return null
  return 'offer'
}

/** The plain result line once the run is done. */
export function placementMessage(start) {
  return start > 1
    ? `You start at level ${start}. Earlier levels stay open if you want to review.`
    : 'You start at level 1. The first lessons go quickly when you already know some of it.'
}

