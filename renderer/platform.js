// Which computer Keylight runs on, for the few words and steps that differ. The page has
// no Node (contextIsolation), so it asks the browser. ?platform=win (or mac) shows the
// other one's page, for screenshots and checks on one machine.
const query = new URLSearchParams(location.search)
const forced = query.get('platform')
const reported = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || ''
export const IS_ANDROID = forced ? forced === 'android' : /Android/i.test(navigator.userAgent)
// The iPhone/iPad app (ios/): its WKWebView host sets __keylightIOS before the page loads (iPadOS reports a Mac user agent).
export const IS_IOS = forced ? forced === 'ios' : !IS_ANDROID && (!!globalThis.__keylightIOS || /iPhone|iPad|iPod/i.test(navigator.userAgent))
// ?shot=1 (the simulator's -KeylightScreenshotMode launch argument, DEBUG builds): a deterministic still frame for store screenshots,
// with a lit chord on Home and every animation and transition off. html.shot is what the stylesheets and the motion code read.
export const SHOT_MODE = query.get('shot') === '1'
if (SHOT_MODE && typeof document !== 'undefined' && document.documentElement) document.documentElement.classList.add('shot')
export const IS_IOS_BETA = IS_IOS && query.get('appBeta') === '1'
export const IOS_PAYWALL_ENABLED = IS_IOS && query.get('appPaywall') === '1'
// Either phone/tablet app: a native host does MIDI, export, links and the clipboard over the same bridge (android-midi.js).
export const IS_NATIVE_HOST = IS_ANDROID || IS_IOS
export const IS_WIN = forced ? forced === 'win' : !IS_NATIVE_HOST && /^win/i.test(reported)

// "Reset your progress on this Mac?" and the like
export const THIS_COMPUTER = IS_NATIVE_HOST ? 'this device' : IS_WIN ? 'this computer' : 'this Mac'
// where main.js saves takes: app.getPath('videos')/Keylight
export const TAKES_FOLDER = IS_NATIVE_HOST ? 'a location you choose' : IS_WIN ? 'Videos › Keylight' : 'Movies › Keylight'

// A touch screen is the way in (a phone or tablet, with no mouse): hints then say "tap" and drop the computer-key shortcuts.
// A Bluetooth keyboard changes nothing here; the shortcuts overlay appears once a real key has been pressed (see android.js).
export const TOUCH = IS_NATIVE_HOST || (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches)

// Apple platforms (iPhone/iPad app, Mac): the page uses the system font (tokens.css `html.apple`); Windows and Android keep their own stack.
export const IS_APPLE = IS_IOS || (!IS_NATIVE_HOST && !IS_WIN && /Mac/i.test(reported || (typeof navigator !== 'undefined' ? navigator.userAgent : '')))
if (typeof document !== 'undefined' && document.documentElement && IS_APPLE) document.documentElement.classList.add('apple')
