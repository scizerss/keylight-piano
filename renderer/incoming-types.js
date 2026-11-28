// The file types "Open in Keylight" can bring in, by extension, with the MIME type to give the File. ios/Keylight/IncomingFiles.swift
// holds the same list (IncomingStore.extensions); scripts/test-song-import.js checks that the two agree and that the importer
// accepts every one of them.
export const INCOMING_MIME = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff', aifc: 'audio/aiff',
  flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', caf: 'audio/x-caf',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
  mid: 'audio/midi', midi: 'audio/midi', kar: 'audio/midi',
  xml: 'application/xml', musicxml: 'application/vnd.recordare.musicxml+xml', mxl: 'application/vnd.recordare.musicxml',
  lrc: 'text/plain'
}
export const incomingMime = (name) => INCOMING_MIME[String(name).split('.').pop().toLowerCase()] || ''
