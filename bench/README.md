# bench — accuracy harness

Measures transcription accuracy as **word error rate (WER)** so accuracy changes
are a number, not an opinion. Modelled on the `bench/` suite in
[omarchy-meeting-recorder](https://github.com/jankeesvw/omarchy-meeting-recorder).

Two harnesses:

### `npm run bench:native` — the app's real pipeline (use this)

`bench/native.mjs` runs **exactly what the desktop app runs** and the real CLI:

- `src/asr/preprocess.ts` — gain + in-place silence attenuation
- `src/asr/chunking.ts` — speech-only chunks (≤24 s, cut at pauses, long
  silences removed) for text-only backends such as voxtype
- `src/asr/wav.ts` → `voxtype transcribe` (or `whisper-cli` via `--backend` /
  `WHISPER_CLI_PATH`)

It adds a long-form "meeting" case (every fixture joined with 2.5 s pauses) and
prints its per-chunk timestamps. `--compare-whole` also runs the previous
approach (whole file in one call) so a change is a WER/time delta, not a claim.

```bash
npm run bench:native                                  # base.en, all fixtures
npm run bench:native -- --model large-v3-turbo --compare-whole
npm run bench:native -- --only long-form-meeting --max-chunk-ms 20000 --verbose
npm run bench:native -- --max-wer 0.15 --json bench/native-results.json
```

Measured on voxtype 1.0.1 (Intel iGPU, Vulkan), chunked vs whole-file:
silence/noise 0% vs 100% WER (no hallucination); speech clips equal or better;
long-form 10.6% vs 9.9% (base.en) and 5.3% vs 5.3% (large-v3-turbo). A 28 s
chunk budget lost trailing words at the window edge (16.6%), hence 24 s.

### `npm run bench` — DSP/VAD research harness (transformers.js)

`bench/run.mjs` scores `preprocessForASR` + `compactSpeech` (`src/asr/vad.ts`)
with Hugging Face `Xenova/*` models in Node. It is useful for comparing DSP/VAD
ideas, but it is **not** the app's transcription path (the app is native-CLI
only). Each case is scored twice: `raw` and `pipeline` (after preprocess + VAD).

## Why Node, not Playwright

In this sandbox headless Chromium cannot load the ONNX model at all, so ASR is
not testable through the app's e2e suite. Node loads it fine. `bench/run.mjs` is
ESM and imports the TypeScript DSP modules directly using Node's built-in
type stripping (Node 22.6+; default on in Node 23+).

The bench runs on `device: 'cpu'` with `q8` dtypes, the stable CPU path for the
Xenova repos. WebGPU (fp32 encoder + q4 decoder) is faster but not reachable in
this environment, and dtype affects accuracy — treat absolute numbers here as
the CPU path, and use them for *relative* comparisons of models and DSP changes.

## Usage

```bash
npm run bench                                        # default model, all fixtures
npm run bench -- --model Xenova/whisper-small.en     # the accuracy comparison
npm run bench -- --limit 3                            # quick subset
npm run bench -- --pipeline-only                      # skip the raw baseline run
npm run bench -- --max-wer 0.2                         # non-zero exit if exceeded
npm run bench -- --json bench/results.json            # machine-readable output
npm run bench -- --offline                            # cached fixtures only
```

## Fixtures

Defined in `manifest.json`:

- **synthetic** (`silence-8s`, `noise-5s`) — generated in-process, no network.
  Expected transcript is empty, so any output counts as inserted
  (hallucinated) words. This is the regression guard for Whisper inventing text
  into pauses.
- **hf** (`librispeech-0..4`) — rows from
  [`hf-internal-testing/librispeech_asr_dummy`](https://huggingface.co/datasets/hf-internal-testing/librispeech_asr_dummy).
  Ground-truth text comes from the dataset row, not from this repo. Audio is
  downloaded once into `bench/fixtures/cache/` (gitignored) and decoded with
  `ffmpeg` (`-ac 1 -ar 16000 -f f32le`), mirroring `src/audio/decode.ts`.

To add fixtures, add `synthetic` cases or another `hf` dataset + row numbers to
`manifest.json`. Prefer sentences/conditions the app actually meets.

## Interpreting

- Corpus WER is pooled (`aggregateWer`), not an average of per-case rates.
- Lower is better; substitutions + deletions + insertions over reference words.
- A change is only an improvement if corpus WER drops **and** no case
  regresses badly. Keep `--json` output to compare runs.

Scoring itself is unit-tested in `src/asr/wer.test.ts`.
