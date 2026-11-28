// Words for the iPhone/iPad app (Illuminated Studio): sentence case, no middle-dot strings, no ALL-CAPS eyebrows.
// The app puts class "ios" on <html>; every other platform keeps its existing copy. Safe to import in Node (tests): no globals are touched at load.
const studio = () => typeof document !== 'undefined' && !!document.documentElement && document.documentElement.classList.contains('ios')

// the joint between two facts in one line: "8 lessons, about 84 min" in the app, "8 lessons · about 84 min" elsewhere
export const dot = () => (studio() ? ', ' : ' · ')

// a label written in capitals in the source ("LEVEL 1"): sentence case in the app
export const caps = (text) => {
  const t = String(text)
  return studio() && t ? t[0] + t.slice(1).toLowerCase() : t
}

// the same, for a label built with .toUpperCase(): untouched in the app
export const up = (text) => (studio() ? String(text) : String(text).toUpperCase())

// Three stars in the app, five elsewhere. Progress is saved as 0 to 5 everywhere: only what is shown changes.
export const starSlots = () => (studio() ? 3 : 5)
export const starsShown = (n) => (studio() ? Math.ceil(Math.max(0, Math.min(5, n || 0)) * 3 / 5) : n)
