// The Music2MIDI ONNX graphs behind the runner contract of renderer/piano-cover-core.js. Shared by the desktop worker and the
// node token-parity test; `ort` is whichever onnxruntime-web module the caller imported.
//
// encoder.onnx: log_mel [B,188,384] f32, cond_index [B,2] i64 -> encoder_hidden_states and cross_k_i / cross_v_i (i = 0..5)
// decoder.onnx: input_ids [B,1] i64, past_self_k_i / past_self_v_i [B,8,T,64], cross_k_i, cross_v_i
//               -> logits [B,1,400], present_self_k_i / present_self_v_i [B,8,T+1,64]
//
// runner.begin(mels: Float32Array[B] of 188*384, cond: [genre, difficulty]) -> { step(tokens: number[B]) -> Float32Array[B] of 400, close() }
// One place for the session options, so the worker, the node parity test and the e2e profile run the same graph setup.
// The decoder's cache grows every step, so a memory pattern planned for one shape never fits the next: planning it again each step cost about half the step time.
export const SESSION_OPTIONS = { executionProviders: ['wasm'], graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false }
export const LAYERS = 6
const HEADS = 8, HEAD_DIM = 64, FRAME_VALUES = 188 * 384, VOCAB = 400

// `breathe` is awaited before every decoder step. In a worker the awaits of one job are all microtasks, so a Cancel message would
// wait for the whole job unless something lets the event loop run: the worker passes yieldToEvents.
export function createOrtRunner(ort, { encoder, decoder }, { breathe = async () => {} } = {}) {
  return {
    async begin(mels, cond) {
      await breathe()
      const batch = mels.length
      const logMel = new Float32Array(batch * FRAME_VALUES)
      mels.forEach((mel, b) => logMel.set(mel, b * FRAME_VALUES))
      const condIndex = new BigInt64Array(batch * 2)
      for (let b = 0; b < batch; b++) { condIndex[b * 2] = BigInt(cond[0]); condIndex[b * 2 + 1] = BigInt(cond[1]) }
      const out = await encoder.run({
        log_mel: new ort.Tensor('float32', logMel, [batch, 188, 384]),
        cond_index: new ort.Tensor('int64', condIndex, [batch, 2])
      })
      out.encoder_hidden_states?.dispose?.()
      const cross = []
      for (let i = 0; i < LAYERS; i++) cross.push(out['cross_k_' + i], out['cross_v_' + i])
      let past = []
      for (let i = 0; i < LAYERS * 2; i++) past.push(new ort.Tensor('float32', new Float32Array(0), [batch, HEADS, 0, HEAD_DIM]))
      return {
        async step(tokens) {
          await breathe()
          const ids = BigInt64Array.from(tokens, BigInt)
          const feeds = { input_ids: new ort.Tensor('int64', ids, [batch, 1]) }
          for (let i = 0; i < LAYERS; i++) {
            feeds['past_self_k_' + i] = past[2 * i]
            feeds['past_self_v_' + i] = past[2 * i + 1]
            feeds['cross_k_' + i] = cross[2 * i]
            feeds['cross_v_' + i] = cross[2 * i + 1]
          }
          const result = await decoder.run(feeds)
          for (let i = 0; i < LAYERS; i++) { past[2 * i] = result['present_self_k_' + i]; past[2 * i + 1] = result['present_self_v_' + i] }
          const logits = result.logits.data
          return Array.from({ length: batch }, (_, b) => logits.subarray(b * VOCAB, (b + 1) * VOCAB))
        },
        close() { past = []; for (const tensor of cross) tensor.dispose?.() }
      }
    }
  }
}

// One turn of the event loop through a MessageChannel: unlike setTimeout it is not held back to 4 ms after a few nested calls.
export function makeYielder() {
  const { port1, port2 } = new MessageChannel()
  let pending = null
  port1.onmessage = () => { const done = pending; pending = null; done?.() }
  port1.unref?.()      // node: an idle yielder must not keep the process alive
  return () => new Promise((resolve) => { pending = resolve; port2.postMessage(0) })
}
