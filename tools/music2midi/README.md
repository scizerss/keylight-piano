# Music2MIDI Core ML pipeline, iOS bridge contract and desktop ONNX runner

On-device "song to playable piano cover" engine for Keylight iOS (`ios/Keylight/PianoCover*.swift`) and desktop (section 3),
backed by [ytinyui/music2midi](https://github.com/ytinyui/music2midi) (MIT code; checkpoint licence
confirmation tracked separately before App Store release).

Model binaries (`.mlpackage`, `.mlmodelc`, `.ckpt`, `.onnx`) are excluded from git.

## 1. Building the Core ML models

Pinned upstream artifacts:
- Repo commit: `e0d31d6606a04c6fde35e5a2e753daf155c20dfe`
- Checkpoint: `epoch.799-step.119200.ckpt` (release `0.1.0`)
- Checkpoint SHA-256: `c2423b5e7ff42be0d6fd768d94f8dbc2669b2ecf01e4b082e64b21ea31daade6`

Run on macOS with Python 3.12 and the following dependencies. The verification and fixture commands also need `librosa`.

```bash
python -m pip install torch==2.4.1 torchaudio==2.4.1 transformers==4.44.2 \
  pytorch-lightning==2.4.0 coremltools==9.0 numpy==1.26.4 \
  omegaconf numba more-itertools pretty-midi mir_eval librosa==0.11.0
```

```bash
MUSIC2MIDI_PYTHON=/path/to/music2midi/venv/bin/python \
  tools/music2midi/fetch-and-build.sh
```

This writes FP32 packages to `tools/music2midi/.cache/coreml/`:
- `Music2MidiEncoder.mlpackage` (`log_mel` FP32 `[1, 188, 384]`, `cond_index` INT32 `[1, 2]` -> `cross_k/v_0..5` FP32 `[1, 8, 190, 64]`)
- `Music2MidiDecoder.mlpackage` (`MAX_CACHE = 320`, static FP32 KV I/O `[1, 8, 320, 64]`, FP32 `self_mask` `-1e4`, precomputed relative position bias, FP32 `logits` `[1, 1, 400]`)

`ios/scripts/bundle-models.sh` (invoked by `ios/project.yml` as a pre-build script) compiles each
`.mlpackage` to `.mlmodelc` once with `xcrun coremlcompiler compile --platform iOS --deployment-target 16.4`
into `tools/music2midi/.cache/coreml/compiled/` and copies the compiled bundles into `Keylight.app/`.
An explicit `KEYLIGHT_MODELS_DIR` build setting points Xcode at another export directory. It must
contain both packages and the generated `export_report.json`. Debug builds without a local FP32 cache
can run model-independent tests.

### Parity and simulator measurements

Pass `--verify-songs /path/to/spike/songs --save-golden /path/to/golden` to the fetch script to compare
full-song token streams with PyTorch and regenerate the Swift test fixture. The export report records
exact chunks, positional token agreement and onset/pitch F1 as separate metrics. MAX_CACHE 320 covers
all valid chunks in the density probe (maximum 279 tokens on “Rich”, 301 across all three songs).
The parity command fails if any song falls below 0.99 onset/pitch F1.

The initial INT8 export matched 129 of 193 active chunks (0.9023 macro onset/pitch F1). On the
30-second excerpt, PyTorch chose token 65 at step 25 with a 0.1575 logit lead over token 60. Both
the 320-slot FP16-cache and the 512-slot FP32-cache INT8 exports lost that lead even with PyTorch's
mel input. With unquantized FP16 weights and compute, the first song still scored 0.989071 F1.
FP32 weights and compute reduce the excerpt's mean per-step logit RMSE to about 0.000004 with the
standalone mel front end. Across the three full songs, FP32 matched 65/65, 65/65 and 63/63 active
chunks, each at 1.0 onset/pitch F1. The FP32 pair totals 126.25 MB before Xcode compilation.

The fixture in `ios/KeylightTests/Fixtures` is an excerpt of
[Where You Are Now (ft. Wolf Fly) by Benjamin Orth](https://ccmixter.org/files/Benjamin_Orth/33036),
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). It uses seconds 30–33, resampled to
16 kHz mono and quantized to PCM16, with pop/intermediate conditioning. The expected tokens and log-mel
are from PyTorch. Only the test bundle includes the fixture.

For simulator timings, place 180-second `m4a` clips of the three spike tracks into the ignored
`ios/KeylightTests/Fixtures/CoverBenchmark/` folder and run
`KeylightTests/PianoCoverTests/testBenchmarksWhenSongsAreProvided`. Each `COVER_BENCH` line includes
wall time (with model load) and the highest process footprint sampled at chunk boundaries.
The simulator uses CPU-only Core ML. iPhones and iPads default to `.cpuAndGPU` until token parity
has been measured on a real iPhone. The FP16 export fell below the 0.99 F1 gate.
Launch the test host with `-KeylightMuted 1`.

## 2. iOS HostBridge contract (for the JS slice)

Use `nativeRequest(op, args, 0)` to disable the 30 s bridge timeout, and `onNativeEvent(fn)`
from `renderer/ios-midi.js`. Audio stays on disk in `IncomingStore` and is never passed over the
WKWebView bridge.

### Requests

`incomingChoose` opens the native Files picker. A selected file is staged in
`IncomingStore` and delivered through the same `incoming` event as a shared file.

#### `coverStart`
Starts an asynchronous piano-cover job for a file staged in `IncomingStore` (share sheet, Files
import, or mic recording).

Request payload:
```json
{
  "id": 12,
  "op": "coverStart",
  "token": "<IncomingStore token>",
  "genre": "pop",
  "difficulty": "intermediate",
  "overlap": 0
}
```
- `token` (required): valid `IncomingStore` token (8–64 chars `[A-Za-z0-9-]`). Returns an error
  (`"File not found"`) if unknown or already released with `incomingDone`.
- `genre` (optional, default `"pop"`): one of `"electronic"`, `"pop"`, `"rock"`, `"soundtrack"`,
  `"world_music"`, `"classical"`.
- `difficulty` (optional, default `"intermediate"`): one of `"beginner"`, `"intermediate"`,
  `"advanced"`.
- `overlap` (optional, default `0`): integer percentage `0` (3.0 s hop), `25` (2.25 s hop), or `50`
  (1.5 s hop).

Response:
```json
{ "id": 12, "result": "<jobId UUID string>" }
```
Only one cover runs at a time. A second start returns `"busy"` until the first job finishes cleanup.
New imports use intermediate conditioning for the canonical notes. Easy, Medium and Full arrange
those same notes without running the model again. Saved songs record the conditioning separately
as `coverModelDifficulty`; older covers without it have unknown conditioning.

Keep the `IncomingStore` token alive until `coverDone` / `coverError` / `coverCancel` finishes;
only call `incomingDone` afterwards.

#### `coverCancel`
Cancels an active job immediately (per-token cancellation inside the decoder loop and between
chunks; deletes any temporary decode files).

Request payload:
```json
{ "id": 13, "op": "coverCancel", "jobId": "<jobId UUID string>" }
```
Response:
```json
{ "id": 13, "result": true }
```
No `coverDone` or `coverError` event is emitted for a cancelled job. All active jobs are also
cancelled automatically on `HostBridge.teardown()` and `pageWillLoad()`.

### Events (delivered to `onNativeEvent`)

The bridge retains terminal events during MIDI bursts. The renderer cancels a job after 120 seconds
without an event for that job. A memory warning ends active inference with `coverError` and releases
the models before a retry can start.

#### `coverProgress`
Emitted at start (`done: 0`) and after every decoded chunk:
```json
{ "kind": "coverProgress", "jobId": "<jobId>", "done": 14, "total": 65 }
```

#### `coverDone`
Emitted once when stitching completes:
```json
{
  "kind": "coverDone",
  "jobId": "<jobId>",
  "duration": 194.2,
  "notes": [
    { "pitch": 60, "start": 0.45, "dur": 0.35 }
  ]
}
```
- `pitch`: MIDI pitch `0..127`
- `start`: onset time in seconds (`>= 0`)
- `dur`: duration in seconds (`> 0`)
- `duration`: duration of the source audio in seconds, including trailing silence.
- Raw notes are already silence-gated (`-55 dBFS`), runaway-guarded, held-note-closed at chunk ends,
  and seam-stitched; feed them into `renderer/arranger.js` next.

#### `coverError`
Emitted if model loading, audio decoding, or inference fails (never emitted for user cancellation):
```json
{ "kind": "coverError", "jobId": "<jobId>", "message": "That file has no audio track" }
```

### Diagnostics (`diagnosticsLog`)
Each finished, cancelled, or failed cover run appends a `kind: "pianoCover"` entry to
`DiagnosticsLog` with fixed numeric/enum telemetry only (no titles or paths):
```json
{
  "kind": "pianoCover",
  "message": "Piano cover finished",
  "cover": {
    "elapsedMs": 14200,
    "chunksDone": 65,
    "chunksTotal": 65,
    "peakMemoryMB": 210,
    "thermalState": "nominal",
    "computeUnits": "cpuAndGPU",
    "cancelled": false,
    "backgrounded": false
  }
}
```

### Playing saved covers

The library keeps one song ID. Keyboard changes rebuild the chart in memory, keeping the playhead,
play/pause state and loop. Explicit difficulty changes save the chart and its metadata together.
Stars and best accuracy use the song ID, arrangement version, difficulty and key range. A mid-song
change starts fresh judgements at the current position. Replay from the start to earn a best score
on the new chart. Older unscoped bests stay in storage without being attributed to a specific chart.

`scripts/fixtures/cover-pop-intermediate.mid` is the Music2MIDI pop/intermediate transcription of
[Where You Are Now (ft. Wolf Fly) by Benjamin Orth](https://ccmixter.org/files/Benjamin_Orth/33036),
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). The arranger runs its invariants on this
fixture when the local spike MIDI collection is unavailable.

## 3. Desktop (Mac and Windows): ONNX in a worker

The Electron app runs the same model as ONNX with [onnxruntime-web](https://www.npmjs.com/package/onnxruntime-web) 1.31.1
(WebAssembly with SIMD and threads, vendored in `renderer/vendor/onnxruntime-web/` by `scripts/vendor-onnxruntime.sh`, which
pins the npm integrity and the SHA-256 of every copied file) inside a dedicated Web Worker. No native addon, and
`ELECTRON_RUN_AS_NODE` stays off.

```bash
MUSIC2MIDI_PYTHON=/path/to/music2midi/venv/bin/python tools/music2midi/fetch-and-build-onnx.sh
```

Python 3.12 with torch 2.4.1, transformers 4.44.2, pytorch-lightning 2.4.0, omegaconf, onnx 1.23.2 and onnxruntime 1.32.0.
It downloads the pinned checkpoint (same SHA-256 as section 1), exports the encoder and the KV-cached decoder step, stores the
large weights as float16 (`encoder.onnx` 30.2 MB, `decoder.onnx` 30.8 MB, float32 compute), checks that the golden fixture
(`ios/KeylightTests/Fixtures/golden_3s.json`) decodes to PyTorch's exact tokens, and writes `manifest.json` with size and
SHA-256 of both files. Everything lands in `tools/music2midi/.cache/onnx/` (ignored by git). With the pinned toolchain the output
is byte for byte the pair pinned in the script. **Never use dynamic INT8 quantisation**: it breaks the output (F1 0.41 against
PyTorch in the spike). The files are not in git.

`scripts/package.sh` and `scripts/package-win.js` check the cache against its manifest and copy it to
`resources/music2midi-models/` of the packaged app (`scripts/cover-models.js`); a build without the cache keeps Basic Pitch for
songs. The app serves the three files as `keylight://app/cover-models/<name>` (`renderer/app-scheme.cjs`), the worker verifies
size and SHA-256 before it creates the sessions, and a checkout runs from the cache folder (`KEYLIGHT_COVER_MODELS` points
elsewhere).

### Pieces

- `renderer/piano-cover-core.js`: log-mel front end, silence gate, chunk plan, batched greedy decode, token reader with
  held-note closing and the five runaway stops, seam stitching (overlap 0, 25 or 50). Mirrors the Swift files; node-tested.
- `renderer/piano-cover-runner.js`: the ONNX graphs behind the runner contract. `renderer/piano-cover-worker.js`: the worker.
- `renderer/piano-cover-desktop.js`: the same job API as the iOS HostBridge (`coverStart`, `coverCancel`, `coverProgress`,
  `coverDone`, `coverError`; one job at a time; cancel lands before the next token) on top of the worker, so
  `renderer/piano-cover-import.js` drives iPhone, Mac and Windows alike. Audio is decoded with Web Audio at 16 kHz and averaged to mono.
- `scripts/e2e-piano-cover.js`: timed run in headless Electron with PyTorch token parity
  (`tools/music2midi/dump_reference_tokens.py` writes the reference).

Decoder step cost is memory bound, so the worker decodes 8 chunks side by side (`batch`) with 4 WebAssembly threads; sessions use
`enableMemPattern: false` because the cache shape changes every step. Electron needs `--enable-features=SharedArrayBuffer`
(set in `main.js`) for the threads. Without it onnxruntime-web falls back to one thread.
