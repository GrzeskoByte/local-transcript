# bench — accuracy harness

Measures transcription accuracy as **word error rate (WER)** so accuracy changes
are a number, not an opinion. Modelled on the `bench/` suite in
[omarchy-meeting-recorder](https://github.com/jankeesvw/omarchy-meeting-recorder).

It runs the **same code the app runs**:

- `src/asr/preprocess.ts` — gain + in-place silence attenuation
- `src/asr/vad.ts` — speech-only compaction
- `src/asr/pipeline-config.ts` — chunking / `no_repeat_ngram_size` / dtype config

Each case is scored twice: `raw` (model on untouched audio) and `pipeline`
(after preprocess + VAD), so a DSP/VAD change shows up as a WER delta.

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
