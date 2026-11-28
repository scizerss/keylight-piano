"""Dump the PyTorch reference for one song: the 16 kHz mono PCM the model sees and the greedy token sequence of every
3-second chunk (no overlap). scripts/e2e-piano-cover.js feeds the PCM to the desktop pipeline and compares tokens.

  MUSIC2MIDI_PYTHON=... tools/music2midi/dump_reference_tokens.py --repo <music2midi checkout> --ckpt <epoch.799-step.119200.ckpt> \
      --audio song.mp3 --out-dir /some/dir [--genre pop] [--difficulty intermediate] [--max-sec 60]
"""
import argparse, hashlib, json, sys
from pathlib import Path
import numpy as np
import torch
import librosa

PINNED_CKPT_SHA256 = "c2423b5e7ff42be0d6fd768d94f8dbc2669b2ecf01e4b082e64b21ea31daade6"


def sha256_file(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def check_checkpoint(path):
    """torch.load unpickles the checkpoint, so only the pinned file may reach it."""
    got = sha256_file(path)
    if got != PINNED_CKPT_SHA256:
        raise SystemExit(f"Checkpoint SHA-256 mismatch: expected {PINNED_CKPT_SHA256}, got {got}")


GENRES = ["electronic", "pop", "rock", "soundtrack", "world_music", "classical"]
DIFFS = ["beginner", "intermediate", "advanced"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--audio", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--genre", default="pop")
    ap.add_argument("--difficulty", default="intermediate")
    ap.add_argument("--max-sec", type=float, default=None)
    ap.add_argument("--batch-size", type=int, default=8)
    args = ap.parse_args()
    check_checkpoint(args.ckpt)
    sys.path.insert(0, args.repo)
    from music2midi.model import Music2MIDI
    from music2midi.input import ModelInputs

    torch.set_num_threads(4)
    model = Music2MIDI.load_from_checkpoint(args.ckpt, config_path=str(Path(args.repo) / "config.yaml"), map_location="cpu")
    model.eval()
    sr = model.config.model.sample_rate
    y, _ = librosa.load(args.audio, sr=sr, duration=args.max_sec)
    split = int(sr * model.config.dataset.segment_duration)
    total = len(y)
    y = np.pad(y, (0, int(np.ceil(len(y) / split)) * split - len(y)), "constant")
    chunks = np.split(y, len(y) // split)
    cond = torch.tensor([[GENRES.index(args.genre), DIFFS.index(args.difficulty)]] * 1, dtype=torch.long)
    tokens = []
    with torch.no_grad():
        for i in range(0, len(chunks), args.batch_size):
            wav = torch.from_numpy(np.stack(chunks[i:i + args.batch_size]))
            c = cond.repeat(wav.shape[0], 1)
            for t in model.model.generate(ModelInputs(input_waveform=wav, cond_index=c), max_length=1024):
                tokens.append([int(x) for x in t.cpu().numpy()])
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    stem = Path(args.audio).stem
    y[:total].astype("<f4").tofile(out / f"{stem}.pcm16k.f32")
    (out / f"{stem}.reference.json").write_text(json.dumps({
        "audio": Path(args.audio).name, "genre": args.genre, "difficulty": args.difficulty, "sampleRate": sr,
        "samples": int(total), "chunks": len(chunks), "tokens": tokens}))
    print(f"{stem}: {len(chunks)} chunks, {total / sr:.1f} s")


if __name__ == "__main__":
    main()
