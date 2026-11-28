// TV picture delay calibration, phone side.
// Pure module: no imports, no DOM, no native work.
// The phone flashes a pattern on the TV, the user taps the phone once per flash,
// and the tap times turn into a single delay number for the TV picture.

// The period is longer than twice the largest delay (600 ms), so a tap is always matched to the flash it belongs to:
// with 750 ms a delay above 375 ms was matched to the next flash and read as about 0 ms.
export const CALIB = {
  count: 14, // flashes in one run
  periodMs: 1400, // milliseconds between flashes
  leadMs: 1500, // gap before the first flash, so the TV page is ready
  dropFirst: 4, // first taps are ignored, the user is still finding the beat
  minTaps: 8, // fewer kept taps than this and the run is not usable
  maxIqrMs: 90, // middle half spread above this means uneven taps
  earlyTapToleranceMs: 100,
  minDelayMs: 0,
  maxDelayMs: 600
};

// Median of an already sorted array. It is never empty here.
function median(sorted) {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

// Build the flash schedule that goes to the TV page. now is the TV link’s monotonic time in ms.
export function makeSchedule(now) {
  return {
    startAt: now + CALIB.leadMs,
    periodMs: CALIB.periodMs,
    count: CALIB.count
  };
}

// Turn recorded tap times into a picture delay.
export function resultFromTaps(schedule, tapTimes) {
  // 1. Keep only real numbers, sorted, working on a copy of what was passed in.
  const taps = (Array.isArray(tapTimes) ? tapTimes : [])
    .filter((t) => typeof t === 'number' && Number.isFinite(t))
    .sort((a, b) => a - b);

  // A tap must pair with a real flash, once per flash, including the warm-up taps.
  const offsets = [];
  let previous = -1;
  for (const t of taps) {
    const k = Math.round((t - schedule.startAt) / schedule.periodMs);
    if (k < 0 || k >= schedule.count) return { ok: false, reason: 'out-of-range' };
    if (k === previous) return { ok: false, reason: 'duplicate' };
    previous = k;
    offsets.push(t - (schedule.startAt + k * schedule.periodMs));
  }

  // 3. Drop the first taps: the user is still settling into the beat.
  const kept = offsets.slice(CALIB.dropFirst);

  // 4. Too little left to work with.
  if (kept.length < CALIB.minTaps) return { ok: false, reason: 'too-few' };

  // 5. Spread of the middle half. A wide spread means the taps were uneven.
  const s = kept.slice().sort((a, b) => a - b);
  const n = s.length;
  const q1 = median(s.slice(0, Math.floor(n / 2)));
  const q3 = median(s.slice(Math.ceil(n / 2)));
  if (q3 - q1 > CALIB.maxIqrMs) return { ok: false, reason: 'uneven' };

  const delay = median(s);
  if (delay < -CALIB.earlyTapToleranceMs || delay > CALIB.maxDelayMs) return { ok: false, reason: 'out-of-range' };
  return { ok: true, delayMs: Math.max(CALIB.minDelayMs, Math.round(delay)) };
}
