# Third-party notices

Keylight for desktop is licensed under GPL-3.0-or-later (see `LICENSE`). It bundles or adapts the following.

## ROLILearn4All — MIT
The SysEx config-packet encoder in `renderer/lights.js` (7-bit packing and checksum) is
adapted from [ROLILearn4All](https://github.com/ClockworkPirate/ROLILearn4All), which in
turn ports the ROLI BLOCKS protocol encoding from the original `blocks.py`.
Copyright (c) 2026 ClockworkPirate and contributors; Copyright (c) 2026 Ehsan Sayyad
(upstream ROLI-for-Live code). Full licence: `LICENSES/ROLILearn4All-MIT.txt`.

## PartykeysProtocol — MIT
The key-light SysEx protocol modules in `renderer/partykeys/` (three ES modules, copied unchanged) and the
25 offline tests in `scripts/partykeys-upstream/` come from the MIT-licensed
[PartykeysProtocol](https://github.com/allen4z/PartykeysProtocol) (https://protocol.partykeys.org/).
`renderer/party-lights.js` is Keylight's own controller on top of them. Full licence:
`LICENSES/PartykeysProtocol-MIT.txt`.

## Basic Pitch — Apache License 2.0
`renderer/models/basic-pitch/` (model weights) and the Basic Pitch code bundled in
`renderer/vendor/transcribe.js` come from [Basic Pitch](https://github.com/spotify/basic-pitch-ts)
by Spotify AB (full text in `renderer/models/basic-pitch/LICENSE`).

## ONNX Runtime Web — MIT
`renderer/vendor/onnxruntime-web/` (onnxruntime-web 1.31.1: `ort.wasm.min.mjs`, `ort-wasm-simd-threaded.mjs`,
`ort-wasm-simd-threaded.wasm`), Copyright (c) Microsoft Corporation, runs the piano cover model in a worker
(`renderer/piano-cover-worker.js`). Licence: `renderer/vendor/onnxruntime-web/LICENSE`; the licences of what it
bundles are in `renderer/vendor/onnxruntime-web/ThirdPartyNotices.txt`. Files and checksums:
`scripts/vendor-onnxruntime.sh`.

## Music2MIDI — MIT code
The piano cover (renderer/piano-cover-core.js and `ios/Keylight/PianoCover*.swift`) reimplements the audio front end and
token format of [Music2MIDI](https://github.com/ytinyui/music2midi) (MIT, pinned commit in `tools/music2midi/`), and the
build scripts in `tools/music2midi/` convert its model. The converted model files are not in this repository: they come
from `tools/music2midi/fetch-and-build-onnx.sh` and are copied into the packaged app by `scripts/package.sh` and
`scripts/package-win.js`. The checkpoint (release 0.1.0) states no licence of its own; the author's confirmation that the
MIT licence covers it is requested before a release ships it (`docs/MUSIC2MIDI-PLAN.md`).

## TensorFlow.js — Apache License 2.0 (parts of tfjs-layers: MIT)
Bundled in `renderer/vendor/transcribe.js` (4.22.0, plus the 3.21.0 copy Basic Pitch
depends on), with seedrandom (MIT), long (Apache-2.0), midi-file and @tonejs/midi (MIT)
and others. Copyright Google LLC; the MIT parts of tfjs-layers: Copyright 2018 Google
LLC, Copyright 2022-2023 CodeSmith LLC.

## music-metadata — MIT
Bundled in `renderer/vendor/metadata.js` (reads tags, cover art and lyrics from audio
files), with strtok3, token-types, file-type, @tokenizer/inflate, uint8array-extras,
@borewit/text-codec, content-type, media-typer, debug and ms (all MIT) and ieee754
(BSD-3-Clause). Copyright Borewit and the respective authors.

## MediaPipe Tasks Vision — Apache License 2.0
`renderer/vendor/mediapipe/` (tasks-vision 0.10.21) and `renderer/models/hand_landmarker.task`
(the hand landmark model, see the
[model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20(Lite_Full)%20with%20Fairness%20Oct%202021.pdf))
by Google LLC. Licence: `renderer/vendor/mediapipe/LICENSE`. Used for camera hand tracking.

The licence of every npm package in the vendor bundles is collected in
`renderer/vendor/LICENSES.txt` (written by `scripts/vendor-licenses.sh` on each
`scripts/build-vendor.sh` run).

## OpenSheetMusicDisplay — BSD 3-Clause
`renderer/vendor/opensheetmusicdisplay.min.js` (2.2.1), Copyright 2019 PhonicScore, draws the
sheet music. It bundles VexFlow 1.2.93 (MIT, Copyright 2010 Mohit Muthanna Cheppudira, with its
music font glyphs), JSZip (used under MIT), pako (MIT and Zlib), loglevel, typescript-collections
and small helper packages. Their licences are collected in
`renderer/vendor/opensheetmusicdisplay.LICENSES.txt`.

## Outfit font — SIL Open Font License 1.1
`renderer/fonts/Outfit-latin.woff2`, Copyright 2021 The Outfit Project Authors.
Licence text in `renderer/fonts/OFL.txt`.

## Ultraleap LeapC structure layouts — Apache License 2.0 (experimental tester builds)

`native/leapc_abi.h` re-declares a few LeapC structures and function types, with the field
order and widths taken from the Apache-2.0 `LeapC.cs` binding in Ultraleap's UnityPlugin
(Copyright Ultraleap, Inc.). The helper loads the user's own installed Ultraleap runtime at
run time; no Ultraleap or ROLI library, driver or SDK is included or redistributed.

## blocksd — ISC

Keylight's JavaScript key renderer uses LittleFoot bytecode and heap transport adapted from blocksd
v0.8.0 by hyperb1iss, under the ISC licence in `LICENSES/blocksd-ISC.txt`.

The Mac app carries [blocksd](https://github.com/hyperb1iss/blocksd) v0.6.0 (Copyright (c) 2025-2026
hyperb1iss (Stefanie Jane)), the daemon that drives the per-key lights, as a frozen program in
`Contents/Resources/blocksd`. blocksd itself is ISC-licensed: `LICENSES/blocksd-ISC.txt`. Keylight applies
one small patch (it adds `button_id` to blocksd's button events) when it builds the daemon
(`scripts/build-blocksd.sh`). It runs as a child process of the app; it is not linked into it.

It also contains CPython 3.13 (Python Software Foundation licence), PyInstaller's bootloader (GPL-2.0-or-later
with the exception that allows distributing the programs it builds under any licence), python-rtmidi with
RtMidi (MIT), pydantic and pydantic-core, typer, rich and their helpers (MIT, BSD, ISC, PSF). The table of
packages with versions and every licence text is in `LICENSES/blocksd-dependencies.md`.

Provenance, not settled: blocksd's own documentation says its protocol code was reverse-engineered
from ROLI's JUCE SDK source (the `roli_blocks_basics` module) and from extracted ROLI Connect installers,
and that its LittleFoot opcode table is based on that source. JUCE is itself dual-licensed (GPL/commercial),
and ROLI Connect is proprietary. We checked that blocksd's repository carries an ISC licence file and ISC
metadata and that its source has no GPL or JUCE copyright headers; we did not compare it with the JUCE
source, and we cannot rule out that parts descend from it. The ISC grant is the blocksd author's to give;
if that ever turns out to be wrong, the daemon can be taken out of the app (Keylight lights keys from
plain MIDI notes without it) or replaced.

## Electron
The app runs on [Electron](https://www.electronjs.org) (MIT), with Chromium and its
components; their licences travel with the app as `electron-LICENSE` and
`electron-LICENSES.chromium.html`. The Windows build's exe icon and version details are
written with [resedit](https://github.com/jet2jet/resedit-js) (MIT), a build tool that
is not bundled.

## blocksd
The key lights on a Mac are driven by [blocksd](https://github.com/hyperb1iss/blocksd) by
hyperb1iss, installed separately (not bundled). The LED command framing follows the
public notes of the LUMI-lights project and the JUCE BLOCKS protocol definitions.

## Songs and artwork
The built-in songs are public-domain compositions; the arrangements in `renderer/songs/`
were written for this project and are distributed under GPL-3.0-or-later. The cover art in
`renderer/covers/` and the app icon were made with AI image tools for this project and,
to the extent anyone holds rights in them, are distributed under GPL-3.0-or-later.

## Online lookups
Imported songs can ask the iTunes Search API (cover art) and LRCLIB (lyrics) for
metadata. The hand-tracking model is downloaded from Google's MediaPipe storage only by
`scripts/build-vendor.sh`. Nothing else is downloaded.

## Android host — Apache License 2.0 components

The Android application uses AndroidX WebKit 1.14.0 and its AndroidX dependencies,
from the Android Open Source Project, under Apache License 2.0. They provide trusted
asset loading and WebView messaging. The full Apache 2.0 text is also bundled at
`renderer/models/basic-pitch/LICENSE`. Android System WebView and the operating system
are installed separately on the user's device; Keylight does not redistribute them.

## Not affiliated with ROLI
Keylight is an independent, unofficial project. It is not affiliated with, endorsed by
or supported by ROLI Ltd or Luminary ROLI. ROLI, LUMI, Piano M, ROLI Learn and BLOCKS
are trademarks of their respective owners and are used only to say which keyboards
Keylight works with. Keylight contains no ROLI software, firmware, artwork, fonts,
sounds or lesson content.

## Sampled piano recordings — CC BY 3.0

The optional Salamander Piano instrument bundles 16 stereo recordings from Salamander
Grand Piano by Alexander Holm, licensed under Creative Commons Attribution 3.0 Unported.
The subset is compressed and transposed between recorded root notes, with one recorded
velocity layer. Attribution, original upstream README, source revision, checksums and the
full licence are in `LICENSES/piano-samples.md`, `LICENSES/piano-samples-upstream.txt` and
`LICENSES/piano-samples-CC-BY-3.0.txt`. These are independently redistributable recordings;
no proprietary ROLI sound pack is included.

The website's example recording (`site-next/audio/piano-example.m4a`) is a 9.6-second phrase arranged from
the same Salamander samples (pitch-shifted, trimmed and mixed by `scripts/build-recording-demo.js`), under the
same CC BY 3.0 licence and credited on the page.

## Mutopia Project songs — Public Domain, CC BY and CC BY-SA

135 piano and keyboard pieces (`renderer/songs/mutopia/`, `renderer/songs/mutopia-sa/`, registered in
`renderer/songs-mutopia.js`) are MIDI files from the [Mutopia Project](https://www.mutopiaproject.org).
The compositions are in the public domain. Each MIDI file was generated from a LilyPond file by a
Mutopia typesetter and carries that piece's licence:

- **Public Domain** (typesetter dedication): 112 pieces. No credit is required; Keylight credits the typesetter anyway.
- **CC BY 3.0** (attribution required): 8 pieces: Liszt's Consolations Nos. 1, 3 and 4 (typeset by Ryan Prince) and further pieces whose typesetters are named in
  `LICENSES/mutopia-songs.md` and shown under each song's title.
  https://creativecommons.org/licenses/by/3.0/
- **CC BY-SA 2.5 / 3.0 / 4.0** (attribution, share-alike): 15 pieces, kept in `renderer/songs/mutopia-sa/`. They are
  separate, attributed data files distributed under their own licences. If you redistribute or adapt those files,
  keep the credit and share them under the same licence.
  https://creativecommons.org/licenses/by-sa/2.5/, https://creativecommons.org/licenses/by-sa/3.0/ and https://creativecommons.org/licenses/by-sa/4.0/

The title, composer, licence, typesetter, source page and file of every piece are in
`LICENSES/mutopia-songs.md`; the app shows the credit under the song's title. The files are provided as-is,
with no warranty. Keylight is not affiliated with the Mutopia Project.
