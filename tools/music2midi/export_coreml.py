#!/usr/bin/env python3
"""Export Music2MIDI (T5 6+6, d_model=384, vocab=400) to FP32 Core ML packages for iOS 16.4+.

Outputs in --out-dir:
  - Music2MidiEncoder.mlpackage  (log_mel FP32 [1,188,384], cond_index INT32 [1,2] -> cross_k/v_0..5 FP32 [1,8,190,64])
  - Music2MidiDecoder.mlpackage  (static FP32 KV cache MAX_CACHE=320, self_mask -1e4, precomputed T5 rel-pos bias)

Optional flags:
  --verify-songs <dir>    Verify end-to-end PCM -> pure log-mel -> Core ML -> tokens parity vs PyTorch on all 3 spike songs.
  --save-golden <dir>     Write 3 s golden fixture (golden_3s.wav, golden_3s_mel.bin, golden_3s.json) for KeylightTests.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import wave
from pathlib import Path

import coremltools as ct
import numpy as np
import torch
import torch.nn as nn

# Measured across all 3 spike songs (01_pop, 02_rock_rich, 03_pop_harmony across beginner/intermediate/advanced):
# max valid EOS length was 301 (03_pop_harmony pop/int) and 279 (02_rock_rich rock/int); 0 valid chunks > 320.
MAX_CACHE = 320
SAMPLE_RATE = 16_000
CHUNK_SAMPLES = 48_000
N_FFT = 2048
HOP_LENGTH = 256
N_MELS = 384
F_MIN = 20.0
EOS_TOKEN = 2
BOS_TOKEN = 1
TIME_OFFSET = 133
TIME_COUNT = 200
MAX_TIME_IDX = 62
MAX_TOKENS_PER_TIME = 32
MAX_REPEATS = 8
SILENCE_DBFS = -55.0

PINNED_CKPT_SHA256 = "c2423b5e7ff42be0d6fd768d94f8dbc2669b2ecf01e4b082e64b21ea31daade6"


def hz_to_mel_htk(f: np.ndarray | float) -> np.ndarray | float:
    return 2595.0 * np.log10(1.0 + np.asarray(f, dtype=np.float64) / 700.0)


def mel_to_hz_htk(m: np.ndarray | float) -> np.ndarray | float:
    return 700.0 * (10.0 ** (np.asarray(m, dtype=np.float64) / 2595.0) - 1.0)


def build_htk_mel_fb(
    sr: int = SAMPLE_RATE,
    n_fft: int = N_FFT,
    n_mels: int = N_MELS,
    f_min: float = F_MIN,
    f_max: float = SAMPLE_RATE / 2.0,
) -> np.ndarray:
    n_freqs = n_fft // 2 + 1
    all_freqs = np.linspace(0.0, sr / 2.0, n_freqs, dtype=np.float64)
    m_pts = np.linspace(hz_to_mel_htk(f_min), hz_to_mel_htk(f_max), n_mels + 2, dtype=np.float64)
    f_pts = mel_to_hz_htk(m_pts)
    f_diff = f_pts[1:] - f_pts[:-1]
    slopes = f_pts[None, :] - all_freqs[:, None]
    down = -slopes[:, :-2] / f_diff[:-1]
    up = slopes[:, 2:] / f_diff[1:]
    return np.maximum(0.0, np.minimum(down, up)).astype(np.float32)


_MEL_FB = build_htk_mel_fb()
_HANN_WIN = (0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(N_FFT, dtype=np.float64) / N_FFT)).astype(np.float32)


def pure_log_mel(wav_1d: np.ndarray) -> np.ndarray:
    """Pure NumPy reproduction of torchaudio.transforms.MelSpectrogram matching PianoCoverMel.swift."""
    pad = N_FFT // 2
    x = np.pad(wav_1d.astype(np.float32), (pad, pad), mode="reflect")
    n_frames = 1 + (len(x) - N_FFT) // HOP_LENGTH
    frames = np.lib.stride_tricks.as_strided(
        x, shape=(n_frames, N_FFT), strides=(x.strides[0] * HOP_LENGTH, x.strides[0])
    )
    spec = np.fft.rfft(frames * _HANN_WIN[None, :], axis=-1)
    power = (spec.real ** 2 + spec.imag ** 2).astype(np.float32)
    mel = power @ _MEL_FB
    return np.log(np.maximum(mel, 1e-6)).astype(np.float32)


def rms_dbfs(wav_1d: np.ndarray) -> float:
    rms = float(np.sqrt(np.mean(wav_1d.astype(np.float64) ** 2)))
    return float("-inf") if rms <= 0.0 else 20.0 * float(np.log10(rms))


class EncoderWithCrossKV(nn.Module):
    def __init__(self, t5_wrapper):
        super().__init__()
        self.conditioning = t5_wrapper.conditioning
        self.encoder = t5_wrapper.transformer.encoder
        self.decoder = t5_wrapper.transformer.decoder

    def forward(self, log_mel, cond_index):
        enc_in = self.conditioning(log_mel, cond_index)
        enc_out = self.encoder(inputs_embeds=enc_in, return_dict=True).last_hidden_state
        cross_kvs = []
        for blk in self.decoder.block:
            ca = blk.layer[1].EncDecAttention
            bsz, seq_len, _ = enc_out.shape
            k = ca.k(enc_out).view(bsz, seq_len, ca.n_heads, ca.key_value_proj_dim).transpose(1, 2)
            v = ca.v(enc_out).view(bsz, seq_len, ca.n_heads, ca.key_value_proj_dim).transpose(1, 2)
            cross_kvs.extend([k, v])
        return tuple(cross_kvs)


class StaticKVDecoderStep(nn.Module):
    """Exact T5 decoder step with STATIC KV cache [1, H, MAX_CACHE, D] for Core ML / iOS 16.4+.
    Uses FP16-safe -1e4 causal masking and a precomputed relative position bias table."""

    def __init__(self, t5, max_cache: int = MAX_CACHE):
        super().__init__()
        self.embed_tokens = t5.decoder.embed_tokens
        self.blocks = t5.decoder.block
        self.final_ln = t5.decoder.final_layer_norm
        self.lm_head = t5.lm_head
        self.num_layers = len(self.blocks)
        self.n_heads = t5.config.num_heads
        self.d_kv = t5.config.d_kv
        self.max_cache = max_cache
        with torch.no_grad():
            sa0 = self.blocks[0].layer[0].SelfAttention
            bias_table = sa0.compute_bias(max_cache, max_cache)
        self.register_buffer("rel_pos_bias_table", bias_table)

    def forward(self, input_ids, step_pos, self_mask, *kvs_flat):
        hidden = self.embed_tokens(input_ids)
        pos_bias = self.rel_pos_bias_table[:, :, step_pos, :]
        sa_bias = pos_bias + self_mask

        idx_range = torch.arange(self.max_cache, device=input_ids.device).view(1, 1, self.max_cache, 1)
        write_mask = (idx_range == step_pos.view(1, 1, 1, 1)).to(hidden.dtype)
        keep_mask = 1.0 - write_mask

        new_self_kvs = []
        for i, blk in enumerate(self.blocks):
            sk = kvs_flat[4 * i]
            sv = kvs_flat[4 * i + 1]
            ck = kvs_flat[4 * i + 2]
            cv = kvs_flat[4 * i + 3]

            ln_h = blk.layer[0].layer_norm(hidden)
            sa = blk.layer[0].SelfAttention
            q = sa.q(ln_h).view(1, 1, self.n_heads, self.d_kv).transpose(1, 2)
            k_new = sa.k(ln_h).view(1, 1, self.n_heads, self.d_kv).transpose(1, 2)
            v_new = sa.v(ln_h).view(1, 1, self.n_heads, self.d_kv).transpose(1, 2)

            sk = sk * keep_mask + k_new * write_mask
            sv = sv * keep_mask + v_new * write_mask
            new_self_kvs.extend([sk, sv])

            scores = torch.matmul(q, sk.transpose(-1, -2)) + sa_bias
            attn_w = torch.softmax(scores.float(), dim=-1).to(hidden.dtype)
            attn_out = torch.matmul(attn_w, sv).transpose(1, 2).contiguous().view(1, 1, -1)
            hidden = hidden + sa.o(attn_out)

            ln_h = blk.layer[1].layer_norm(hidden)
            ca = blk.layer[1].EncDecAttention
            cq = ca.q(ln_h).view(1, 1, self.n_heads, self.d_kv).transpose(1, 2)
            c_scores = torch.matmul(cq, ck.transpose(-1, -2))
            c_w = torch.softmax(c_scores.float(), dim=-1).to(hidden.dtype)
            c_out = torch.matmul(c_w, cv).transpose(1, 2).contiguous().view(1, 1, -1)
            hidden = hidden + ca.o(c_out)

            hidden = blk.layer[2](hidden)

        hidden = self.final_ln(hidden)
        logits = self.lm_head(hidden)
        return (logits, *new_self_kvs)


def check_runaway(tokens: list[int], max_cache: int) -> bool:
    """Returns True if the latest token triggers any of the 5 runaway stops."""
    nt = tokens[-1]
    if nt == EOS_TOKEN:
        return True
    if len(tokens) >= max_cache:
        return True
    # 8 consecutive identical tokens
    if len(tokens) - 1 >= MAX_REPEATS and all(t == nt for t in tokens[-MAX_REPEATS:]):
        return True
    last_time = -1
    at_time = 0
    for t in tokens[1:]:
        if TIME_OFFSET <= t < TIME_OFFSET + TIME_COUNT:
            ti = t - TIME_OFFSET
            if ti > MAX_TIME_IDX or ti < last_time:
                return True
            if ti != last_time:
                last_time = ti
                at_time = 0
        else:
            at_time += 1
            if at_time > MAX_TOKENS_PER_TIME:
                return True
    return False


def dir_size_mb(p: Path) -> float:
    return round(sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) / 1e6, 2)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def export_models(ckpt_path: Path, repo_dir: Path, out_dir: Path, max_cache: int):
    sys.path.insert(0, str(repo_dir))
    from music2midi.model import Music2MIDI

    out_dir.mkdir(parents=True, exist_ok=True)
    model = Music2MIDI.load_from_checkpoint(
        str(ckpt_path),
        config_path=str(repo_dir / "config.yaml"),
        map_location="cpu",
    )
    model.eval()
    t5 = model.model.transformer
    cfg = t5.config
    L, H, D = cfg.num_decoder_layers, cfg.num_heads, cfg.d_kv

    enc_mod = EncoderWithCrossKV(model.model).eval()
    dec_mod = StaticKVDecoderStep(t5, max_cache=max_cache).eval()

    d_mel = torch.randn(1, 188, cfg.d_model)
    d_cond = torch.tensor([[1, 1]], dtype=torch.long)
    with torch.no_grad():
        tr_enc = torch.jit.trace(enc_mod, (d_mel, d_cond))
    enc_outs = [
        ct.TensorType(name=f"cross_{kv}_{i}", dtype=np.float32)
        for i in range(L)
        for kv in ("k", "v")
    ]
    encoder = ct.convert(
        tr_enc,
        inputs=[
            ct.TensorType(name="log_mel", shape=(1, 188, cfg.d_model), dtype=np.float32),
            ct.TensorType(name="cond_index", shape=(1, 2), dtype=np.int32),
        ],
        outputs=enc_outs,
        minimum_deployment_target=ct.target.iOS16,
        compute_precision=ct.precision.FLOAT32,
    )
    enc_path = out_dir / "Music2MidiEncoder.mlpackage"
    encoder.save(str(enc_path))

    d_ids = torch.tensor([[BOS_TOKEN]], dtype=torch.long)
    d_pos = torch.tensor([3], dtype=torch.long)
    d_mask = torch.zeros(1, 1, 1, max_cache)
    d_flat = []
    dec_ins = [
        ct.TensorType(name="input_ids", shape=(1, 1), dtype=np.int32),
        ct.TensorType(name="step_pos", shape=(1,), dtype=np.int32),
        ct.TensorType(name="self_mask", shape=(1, 1, 1, max_cache), dtype=np.float32),
    ]
    dec_outs = [ct.TensorType(name="logits", dtype=np.float32)]
    for i in range(L):
        d_flat.extend([
            torch.zeros(1, H, max_cache, D),
            torch.zeros(1, H, max_cache, D),
            torch.randn(1, H, 190, D),
            torch.randn(1, H, 190, D),
        ])
        dec_ins.extend([
            ct.TensorType(name=f"self_k_{i}", shape=(1, H, max_cache, D), dtype=np.float32),
            ct.TensorType(name=f"self_v_{i}", shape=(1, H, max_cache, D), dtype=np.float32),
            ct.TensorType(name=f"cross_k_{i}", shape=(1, H, 190, D), dtype=np.float32),
            ct.TensorType(name=f"cross_v_{i}", shape=(1, H, 190, D), dtype=np.float32),
        ])
        dec_outs.extend([
            ct.TensorType(name=f"out_self_k_{i}", dtype=np.float32),
            ct.TensorType(name=f"out_self_v_{i}", dtype=np.float32),
        ])

    with torch.no_grad():
        tr_dec = torch.jit.trace(dec_mod, (d_ids, d_pos, d_mask, *d_flat))
    decoder = ct.convert(
        tr_dec,
        inputs=dec_ins,
        outputs=dec_outs,
        minimum_deployment_target=ct.target.iOS16,
        compute_precision=ct.precision.FLOAT32,
    )
    dec_path = out_dir / "Music2MidiDecoder.mlpackage"
    decoder.save(str(dec_path))

    print(
        f"Exported MAX_CACHE={max_cache}: "
        f"encoder={dir_size_mb(enc_path)} MB, decoder={dir_size_mb(dec_path)} MB, "
        f"total={round(dir_size_mb(enc_path) + dir_size_mb(dec_path), 2)} MB"
    )
    return model, enc_path, dec_path


def run_coreml_chunk(m_enc, m_dec, wav_1d: np.ndarray, cond: list[int], max_cache: int, L: int, H: int, D: int):
    mel = pure_log_mel(wav_1d)[None, :, :]  # (1, 188, 384) float32
    cond_np = np.array([cond], dtype=np.int32)
    ckv = m_enc.predict({"log_mel": mel, "cond_index": cond_np})

    feed = {
        "input_ids": np.zeros((1, 1), dtype=np.int32),
        "step_pos": np.zeros((1,), dtype=np.int32),
        "self_mask": np.full((1, 1, 1, max_cache), -1e4, dtype=np.float32),
    }
    for i in range(L):
        for kind in ("k", "v"):
            feed[f"self_{kind}_{i}"] = np.zeros((1, H, max_cache, D), dtype=np.float32)
            feed[f"cross_{kind}_{i}"] = ckv[f"cross_{kind}_{i}"]

    toks = [BOS_TOKEN]
    for step in range(max_cache - 1):
        feed["input_ids"][0, 0] = toks[-1]
        feed["step_pos"][0] = step
        feed["self_mask"][0, 0, 0, step] = 0
        o = m_dec.predict(feed)
        toks.append(int(np.argmax(o["logits"][0, -1])))
        if check_runaway(toks, max_cache):
            break
        for i in range(L):
            for kind in ("k", "v"):
                feed[f"self_{kind}_{i}"] = o[f"out_self_{kind}_{i}"]
    return np.array(toks, dtype=np.int32), mel[0]


def run_pytorch_chunk(model, wav_1d: np.ndarray, cond: list[int], max_cache: int):
    t5 = model.model.transformer
    with torch.no_grad():
        ta_mel = model.model.spectrogram(torch.from_numpy(wav_1d)[None, :])
        enc_in = model.model.conditioning(ta_mel, torch.tensor([cond], dtype=torch.long))
        raw = t5.generate(inputs_embeds=enc_in, max_length=max_cache)[0].numpy().astype(np.int32)
    # Apply identical runaway truncation to PyTorch sequence so fair comparison on valid & runaway chunks
    toks = [int(raw[0])]
    for t in raw[1:]:
        toks.append(int(t))
        if check_runaway(toks, max_cache):
            break
    return np.array(toks, dtype=np.int32), ta_mel[0].numpy().astype(np.float32)


def verify_songs(model, enc_path: Path, dec_path: Path, songs_dir: Path, max_cache: int, cond: list[int]):
    import librosa

    cfg = model.model.transformer.config
    L, H, D = cfg.num_decoder_layers, cfg.num_heads, cfg.d_kv
    m_enc = ct.models.MLModel(str(enc_path))
    m_dec = ct.models.MLModel(str(dec_path))

    song_files = sorted(songs_dir.glob("*.mp3"))
    if not song_files:
        raise SystemExit(f"No MP3 files in {songs_dir}")
    results = []
    for sp in song_files:
        y, _ = librosa.load(str(sp), sr=SAMPLE_RATE)
        pad = (CHUNK_SAMPLES - len(y) % CHUNK_SAMPLES) % CHUNK_SAMPLES
        y = np.pad(y, (0, pad))
        chunks = [y[i:i + CHUNK_SAMPLES] for i in range(0, len(y), CHUNK_SAMPLES)]

        t0 = time.perf_counter()
        exact = 0
        tok_match = 0
        tok_total = 0
        silent = 0
        mel_max_diff = 0.0
        pt_all = []
        cm_all = []

        for c in chunks:
            if rms_dbfs(c) < SILENCE_DBFS:
                silent += 1
                continue
            pt_toks, pt_mel = run_pytorch_chunk(model, c, cond, max_cache)
            cm_toks, cm_mel = run_coreml_chunk(m_enc, m_dec, c, cond, max_cache, L, H, D)
            mel_max_diff = max(mel_max_diff, float(np.max(np.abs(pt_mel - cm_mel))))
            if np.array_equal(pt_toks, cm_toks):
                exact += 1
            n_min = min(len(pt_toks), len(cm_toks))
            tok_match += int(np.sum(pt_toks[:n_min] == cm_toks[:n_min]))
            tok_total += max(len(pt_toks), len(cm_toks))
            pt_all.append(pt_toks)
            cm_all.append(cm_toks)

        elapsed = time.perf_counter() - t0
        pt_notes = model.model.tokenizer.decode(pt_all, mode="sequential", duration_per_batch=3.0) if pt_all else np.zeros((0, 4))
        cm_notes = model.model.tokenizer.decode(cm_all, mode="sequential", duration_per_batch=3.0) if cm_all else np.zeros((0, 4))
        ps = {(round(float(n[0]), 2), int(n[2])) for n in pt_notes}
        cs = {(round(float(n[0]), 2), int(n[2])) for n in cm_notes}
        f1 = 2 * len(ps & cs) / max(len(ps) + len(cs), 1)
        active = len(chunks) - silent
        row = {
            "song": sp.name,
            "chunks_total": len(chunks),
            "chunks_active": active,
            "chunks_silent": silent,
            "exact_chunks": f"{exact}/{active}",
            "token_match_pct": round(100.0 * tok_match / max(tok_total, 1), 3),
            "onset_pitch_f1": round(f1, 4),
            "pt_notes": int(len(pt_notes)),
            "coreml_notes": int(len(cm_notes)),
            "mel_max_abs_diff": float(f"{mel_max_diff:.2e}"),
            "verify_wall_s": round(elapsed, 2),
        }
        results.append(row)
        print(json.dumps(row))
    return results


def save_golden_fixture(model, enc_path: Path, dec_path: Path, song_path: Path, fixture_dir: Path, max_cache: int, offset: float = 30.0):
    import librosa

    fixture_dir.mkdir(parents=True, exist_ok=True)
    # Use PCM16 so Swift and Python share identical input samples.
    y, _ = librosa.load(str(song_path), sr=SAMPLE_RATE, offset=offset, duration=3.0)
    y = y[:CHUNK_SAMPLES]
    if len(y) < CHUNK_SAMPLES:
        y = np.pad(y, (0, CHUNK_SAMPLES - len(y)))
    pcm16 = np.clip(np.round(y * 32767.0), -32768, 32767).astype(np.int16)
    wav_path = fixture_dir / "golden_3s.wav"
    with wave.open(str(wav_path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm16.tobytes())

    # Exact float32 samples decoded from the saved int16 WAV (same formula as AVAudioConverter / CoreAudio int16 -> float32: s / 32768.0)
    wav_f32 = (pcm16.astype(np.float32) / 32768.0).astype(np.float32)

    cfg = model.model.transformer.config
    L, H, D = cfg.num_decoder_layers, cfg.num_heads, cfg.d_kv
    m_enc = ct.models.MLModel(str(enc_path))
    m_dec = ct.models.MLModel(str(dec_path))

    cond = [1, 1]  # pop / intermediate
    pt_toks, pt_mel = run_pytorch_chunk(model, wav_f32, cond, max_cache)
    cm_toks, cm_mel = run_coreml_chunk(m_enc, m_dec, wav_f32, cond, max_cache, L, H, D)
    assert np.array_equal(pt_toks, cm_toks), (
        f"Golden 3s Core ML vs PyTorch mismatch: len {len(cm_toks)} vs {len(pt_toks)}"
    )

    mel_path = fixture_dir / "golden_3s_mel.bin"
    pt_mel.astype("<f4").tofile(str(mel_path))

    meta = {
        "sample_rate": SAMPLE_RATE,
        "chunk_samples": CHUNK_SAMPLES,
        "max_cache": max_cache,
        "genre": "pop",
        "difficulty": "intermediate",
        "source_offset_seconds": offset,
        "cond_index": cond,
        "rms_dbfs": round(rms_dbfs(wav_f32), 4),
        "mel_shape": list(pt_mel.shape),
        "mel_pure_vs_torchaudio_max_abs_diff": float(f"{np.max(np.abs(pt_mel - cm_mel)):.2e}"),
        "tokens": [int(t) for t in pt_toks.tolist()],
        "exact_pytorch_coreml_match": True,
    }
    json_path = fixture_dir / "golden_3s.json"
    json_path.write_text(json.dumps(meta, indent=2) + "\n")
    print(f"Saved golden 3s fixture to {fixture_dir} ({len(pt_toks)} tokens, mel diff {meta['mel_pure_vs_torchaudio_max_abs_diff']})")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--ckpt", type=Path, required=True, help="Path to epoch.799-step.119200.ckpt")
    p.add_argument("--repo", type=Path, required=True, help="Path to ytinyui/music2midi checkout")
    p.add_argument("--out-dir", type=Path, required=True, help="Directory for .mlpackage exports")
    p.add_argument("--max-cache", type=int, choices=(320, 384), default=MAX_CACHE)
    p.add_argument("--verify-songs", type=Path, default=None, help="Directory of spike MP3s to verify end-to-end parity")
    p.add_argument("--save-golden", type=Path, default=None, help="Directory to write 3 s golden Swift test fixture")
    p.add_argument("--golden-song", type=Path, default=None, help="Source MP3 for 3 s golden fixture")
    args = p.parse_args()

    got = sha256_file(args.ckpt)
    if got != PINNED_CKPT_SHA256:
        raise SystemExit(f"Checkpoint SHA-256 mismatch: expected {PINNED_CKPT_SHA256}, got {got}")
    torch.set_num_threads(2)

    model, enc_path, dec_path = export_models(args.ckpt, args.repo, args.out_dir, args.max_cache)

    report = {
        "max_cache": args.max_cache,
        "precision": "float32",
        "encoder_mb": dir_size_mb(enc_path),
        "decoder_mb": dir_size_mb(dec_path),
        "total_mb": round(dir_size_mb(enc_path) + dir_size_mb(dec_path), 2),
    }

    if args.verify_songs:
        report["parity_pop_intermediate"] = verify_songs(
            model, enc_path, dec_path, args.verify_songs, args.max_cache, cond=[1, 1]
        )

    (args.out_dir / "export_report.json").write_text(json.dumps(report, indent=2) + "\n")

    if args.verify_songs and any(row["onset_pitch_f1"] < 0.99 for row in report["parity_pop_intermediate"]):
        raise SystemExit("At least one song scored below 0.99 onset/pitch F1. See export_report.json.")

    if args.save_golden:
        song = args.golden_song or (args.verify_songs / "01_pop_where_you_are_now.mp3" if args.verify_songs else None)
        if song is None or not song.exists():
            raise SystemExit("--save-golden requires --golden-song or --verify-songs containing 01_pop_where_you_are_now.mp3")
        save_golden_fixture(model, enc_path, dec_path, song, args.save_golden, args.max_cache)

if __name__ == "__main__":
    main()
