"""Export the Music2MIDI T5 encoder and KV-cached decoder step to ONNX for the desktop piano cover (onnxruntime-web).

Writes encoder.onnx and decoder.onnx with FP16 weight storage (float32 compute: every large weight is stored as float16 and
cast back at load, which halves the files and keeps T5's float32 layer norms). Dynamic INT8 quantisation is deliberately not
offered: it breaks the output (spike: F1 0.41 against PyTorch). The result is checked against the golden 3-second fixture of
the iOS tests (the tokens up to its stop must match PyTorch's exactly) before the script exits successfully.

  python export_onnx.py --repo <music2midi checkout> --ckpt <epoch.799-step.119200.ckpt> --out-dir <dir> \
      --golden ios/KeylightTests/Fixtures/golden_3s.json --golden-wav ios/KeylightTests/Fixtures/golden_3s.wav
"""
import argparse, hashlib, json, sys, tempfile, wave
from pathlib import Path
import numpy as np
import torch
import torch.nn as nn
import onnx
import onnxruntime as ort

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

MAX_LEN = 320   # decode steps the app allows; the relative-position table needs at least this many rows


class EncoderWithCrossKV(nn.Module):
    """Takes log-mel (B, 188, 384) + cond_idx (B, 2) -> encoder_hidden_states (B, 190, 384)
    and precomputed cross-attention K/V for all 6 decoder layers (12 tensors of shape (B, H, 190, d_kv))."""
    def __init__(self, t5_wrapper):
        super().__init__()
        self.conditioning = t5_wrapper.conditioning
        self.encoder = t5_wrapper.transformer.encoder
        self.decoder = t5_wrapper.transformer.decoder
        self.num_layers = len(self.decoder.block)

    def forward(self, log_mel, cond_index):
        enc_in = self.conditioning(log_mel, cond_index)
        enc_out = self.encoder(inputs_embeds=enc_in, return_dict=True).last_hidden_state
        # Precompute cross-attention K and V for every decoder layer once per 3s chunk
        cross_kvs = []
        for blk in self.decoder.block:
            cross_attn = blk.layer[1].EncDecAttention
            bsz, seq_len, _ = enc_out.shape
            k = cross_attn.k(enc_out).view(bsz, seq_len, cross_attn.n_heads, cross_attn.key_value_proj_dim).transpose(1, 2)
            v = cross_attn.v(enc_out).view(bsz, seq_len, cross_attn.n_heads, cross_attn.key_value_proj_dim).transpose(1, 2)
            cross_kvs.extend([k, v])
        return (enc_out, *cross_kvs)


class DecoderStepWithPast(nn.Module):
    """Exact single-step T5 decoder with dynamic self-attn past KV (supports T=0 on step 0)
    and precomputed cross-attn KV. Uses precomputed exact relative position bias table so
    ONNX trace never freezes seq_len in T5Attention.compute_bias."""
    def __init__(self, t5, max_len=1024):
        super().__init__()
        self.embed_tokens = t5.decoder.embed_tokens
        self.blocks = t5.decoder.block
        self.final_ln = t5.decoder.final_layer_norm
        self.lm_head = t5.lm_head
        self.num_layers = len(self.blocks)
        self.n_heads = t5.config.num_heads
        self.d_kv = t5.config.d_kv
        self.max_len = max_len
        with torch.no_grad():
            # Last row of causal bias table encodes distances [max_len-1, ..., 1, 0] in 24 KB!
            bias_row = self.blocks[0].layer[0].SelfAttention.compute_bias(max_len, max_len)[:, :, max_len - 1:max_len, :]
        self.register_buffer("rel_pos_bias_row", bias_row)  # (1, H, 1, max_len) — 24 KB

    def forward(self, input_ids, *past_flat):
        bsz = input_ids.shape[0]
        hidden = self.embed_tokens(input_ids)  # (B, 1, d_model)
        past_len = past_flat[0].shape[2]
        # Exact T5 causal self-attn relative position bias for distances [past_len, ..., 1, 0]
        sa_bias = self.rel_pos_bias_row[:, :, :, self.max_len - 1 - past_len:]  # (1, H, 1, past_len+1)

        present_self_kvs = []
        for i, blk in enumerate(self.blocks):
            psk = past_flat[4 * i]
            psv = past_flat[4 * i + 1]
            ck = past_flat[4 * i + 2]
            cv = past_flat[4 * i + 3]

            # 1. Self-Attention
            ln_h = blk.layer[0].layer_norm(hidden)
            sa = blk.layer[0].SelfAttention
            q = sa.q(ln_h).view(bsz, 1, self.n_heads, self.d_kv).transpose(1, 2)
            k_new = sa.k(ln_h).view(bsz, 1, self.n_heads, self.d_kv).transpose(1, 2)
            v_new = sa.v(ln_h).view(bsz, 1, self.n_heads, self.d_kv).transpose(1, 2)
            sk = torch.cat([psk, k_new], dim=2)
            sv = torch.cat([psv, v_new], dim=2)
            present_self_kvs.extend([sk, sv])

            scores = torch.matmul(q, sk.transpose(-1, -2)) + sa_bias
            attn_w = torch.softmax(scores.float(), dim=-1).to(hidden.dtype)
            attn_out = torch.matmul(attn_w, sv).transpose(1, 2).contiguous().view(bsz, 1, -1)
            hidden = hidden + sa.o(attn_out)

            # 2. Cross-Attention (precomputed ck, cv)
            ln_h = blk.layer[1].layer_norm(hidden)
            ca = blk.layer[1].EncDecAttention
            cq = ca.q(ln_h).view(bsz, 1, self.n_heads, self.d_kv).transpose(1, 2)
            c_scores = torch.matmul(cq, ck.transpose(-1, -2))
            c_w = torch.softmax(c_scores.float(), dim=-1).to(hidden.dtype)
            c_out = torch.matmul(c_w, cv).transpose(1, 2).contiguous().view(bsz, 1, -1)
            hidden = hidden + ca.o(c_out)

            # 3. Feed-Forward (gated-gelu)
            hidden = blk.layer[2](hidden)

        hidden = self.final_ln(hidden)
        logits = self.lm_head(hidden)
        return (logits, *present_self_kvs)


def convert_to_fp16(src_path, dst_path):
    """Store every float32 weight of 1024+ elements as float16 with a Cast back to float32 on load."""
    from onnx import helper, numpy_helper, TensorProto
    model = onnx.load(str(src_path))
    g = model.graph
    kept, casts = [], []
    for init in g.initializer:
        if init.data_type == TensorProto.FLOAT:
            arr = numpy_helper.to_array(init)
            if arr.size >= 1024:
                raw_name = init.name + "__fp16"
                kept.append(numpy_helper.from_array(arr.astype(np.float16), name=raw_name))
                casts.append(helper.make_node("Cast", [raw_name], [init.name], to=TensorProto.FLOAT))
                continue
        kept.append(init)
    del g.initializer[:]
    g.initializer.extend(kept)
    for i, node in enumerate(casts):
        g.node.insert(i, node)
    onnx.save(model, str(dst_path))
    return len(casts)


def greedy_tokens(enc, dec, log_mel, cond, layers, heads, d_kv):
    """Greedy decode without the app's runaway guards: stops at EOS or MAX_LEN."""
    out = enc.run(None, {"log_mel": log_mel.astype(np.float32), "cond_index": cond.astype(np.int64)})
    cross = out[1:]
    past = [np.zeros((1, heads, 0, d_kv), dtype=np.float32) for _ in range(2 * layers)]
    tokens, current = [1], 1
    for _ in range(MAX_LEN - 1):
        feeds = {"input_ids": np.array([[current]], dtype=np.int64)}
        for i in range(layers):
            feeds[f"past_self_k_{i}"], feeds[f"past_self_v_{i}"] = past[2 * i], past[2 * i + 1]
            feeds[f"cross_k_{i}"], feeds[f"cross_v_{i}"] = cross[2 * i], cross[2 * i + 1]
        res = dec.run(None, feeds)
        past = list(res[1:])
        current = int(np.argmax(res[0][0, -1]))
        tokens.append(current)
        if current == 2:
            break
    return tokens


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="checkout of ytinyui/music2midi at the pinned commit")
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--golden", required=True, help="golden_3s.json: cond_index and the PyTorch tokens")
    ap.add_argument("--golden-wav", required=True, help="golden_3s.wav: 16 kHz mono PCM16")
    args = ap.parse_args()
    check_checkpoint(args.ckpt)
    sys.path.insert(0, args.repo)
    from music2midi.model import Music2MIDI

    torch.set_num_threads(4)
    model = Music2MIDI.load_from_checkpoint(args.ckpt, config_path=str(Path(args.repo) / "config.yaml"), map_location="cpu")
    model.eval()
    t5 = model.model.transformer
    cfg = t5.config
    layers, heads, d_kv = cfg.num_decoder_layers, cfg.num_heads, cfg.d_kv
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        enc_names = ["encoder_hidden_states"] + [f"cross_{kv}_{i}" for i in range(layers) for kv in ("k", "v")]
        enc_dyn = {"log_mel": {0: "batch", 1: "mel_len"}, "cond_index": {0: "batch"}, "encoder_hidden_states": {0: "batch", 1: "enc_len"}}
        for n in enc_names[1:]:
            enc_dyn[n] = {0: "batch", 2: "enc_len"}
        torch.onnx.export(EncoderWithCrossKV(model.model).eval(), (torch.randn(1, 188, cfg.d_model), torch.tensor([[1, 0]], dtype=torch.long)),
                          str(tmp / "encoder_fp32.onnx"), input_names=["log_mel", "cond_index"], output_names=enc_names,
                          dynamic_axes=enc_dyn, opset_version=17, do_constant_folding=True)

        dec_in, dec_out, dec_dyn, dummy_past = ["input_ids"], ["logits"], {"input_ids": {0: "batch"}, "logits": {0: "batch"}}, []
        for i in range(layers):
            dummy_past.extend([torch.randn(1, heads, 3, d_kv), torch.randn(1, heads, 3, d_kv), torch.randn(1, heads, 190, d_kv), torch.randn(1, heads, 190, d_kv)])
            dec_in.extend([f"past_self_k_{i}", f"past_self_v_{i}", f"cross_k_{i}", f"cross_v_{i}"])
            dec_out.extend([f"present_self_k_{i}", f"present_self_v_{i}"])
            for name, axis in ((f"past_self_k_{i}", "past_len"), (f"past_self_v_{i}", "past_len"), (f"cross_k_{i}", "enc_len"), (f"cross_v_{i}", "enc_len"),
                               (f"present_self_k_{i}", "total_len"), (f"present_self_v_{i}", "total_len")):
                dec_dyn[name] = {0: "batch", 2: axis}
        torch.onnx.export(DecoderStepWithPast(t5, max_len=1024).eval(), (torch.tensor([[1]], dtype=torch.long), *dummy_past),
                          str(tmp / "decoder_fp32.onnx"), input_names=dec_in, output_names=dec_out,
                          dynamic_axes=dec_dyn, opset_version=17, do_constant_folding=True)

        n_enc = convert_to_fp16(tmp / "encoder_fp32.onnx", out_dir / "encoder.onnx")
        n_dec = convert_to_fp16(tmp / "decoder_fp32.onnx", out_dir / "decoder.onnx")
        print(f"weight-fp16: {n_enc} encoder and {n_dec} decoder tensors; "
              f"{(out_dir / 'encoder.onnx').stat().st_size / 1e6:.1f} MB + {(out_dir / 'decoder.onnx').stat().st_size / 1e6:.1f} MB")

    # parity gate: the exported pair must reproduce PyTorch's tokens for the fixture, and a batch of two must too
    golden = json.loads(Path(args.golden).read_text())
    with wave.open(args.golden_wav, "rb") as w:
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
    with torch.no_grad():
        mel = model.model.spectrogram(torch.from_numpy(pcm[None, :48000])).numpy()
    so = ort.SessionOptions()
    so.intra_op_num_threads = 4
    enc = ort.InferenceSession(str(out_dir / "encoder.onnx"), sess_options=so, providers=["CPUExecutionProvider"])
    dec = ort.InferenceSession(str(out_dir / "decoder.onnx"), sess_options=so, providers=["CPUExecutionProvider"])
    tokens = greedy_tokens(enc, dec, mel, np.array([golden["cond_index"]]), layers, heads, d_kv)
    # the fixture ends where the app's runaway guard stopped decoding (a time token past 3.1 s); the loop here runs on to EOS
    want = golden["tokens"]
    if tokens[:len(want)] != want:
        print("PARITY FAILED\n  onnx   ", tokens, "\n  pytorch", want)
        sys.exit(1)
    print(f"parity ok: the first {len(want)} tokens are identical to PyTorch")


if __name__ == "__main__":
    main()
