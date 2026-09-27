#!/usr/bin/env node
/**
 * Accuracy bench for the on-device transcription pipeline.
 *
 * Runs the SAME code the app uses -- `preprocessForASR` (src/asr/preprocess.ts)
 * and `compactSpeech` (src/asr/vad.ts), with the engine's chunking/decoding
 * options (src/asr/pipeline-config.ts) -- over fixtures with known transcripts,
 * then reports word error rate (WER).
 *
 * Why Node: in this sandbox headless Chromium cannot load the ONNX model, so
 * Playwright cannot exercise ASR. Node loads it fine. `--model` defaults to the
 * app's default `Xenova/whisper-base.en`; the *accuracy* number should be
 * produced with `Xenova/whisper-small.en` (or larger).
 *
 * The pipeline is measured twice per case:
 *   raw       = model on the decoded audio untouched
 *   pipeline  = model on preprocessForASR() + compactSpeech() output
 * so a change to the DSP/VAD shows up as a WER delta instead of a claim.
 *
 * Usage:
 *   npm run bench                       # default model, all fixtures
 *   npm run bench -- --model Xenova/whisper-small.en
 *   npm run bench -- --limit 3 --max-wer 0.2
 *   npm run bench -- --pipeline-only --json bench/results.json
 *
 * Fixtures: HF audio is downloaded once into bench/fixtures/cache/ (gitignored).
 * Synthetic cases (silence / low-level noise) need no network and check that
 * Whisper does not hallucinate words into non-speech.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, pipeline } from '@huggingface/transformers';
import { preprocessForASR } from '../src/asr/preprocess.ts';
import { compactSpeech } from '../src/asr/vad.ts';
import {
  ASR_CHUNK_LENGTH_S,
  ASR_NO_REPEAT_NGRAM_SIZE,
  ASR_STRIDE_LENGTH_S,
  resolveAsrRuntime,
} from '../src/asr/pipeline-config.ts';
import { aggregateWer, computeWer } from '../src/asr/wer.ts';

env.logLevel = 'error';
if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.numThreads = 1;

/** Whisper `.en` models are English-only: never pass language/task to them. */
const isEnglishOnlyModel = (id) => /\.en$/i.test(String(id).trim());

const SAMPLE_RATE = 16000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(HERE, 'fixtures', 'cache');

const argv = process.argv.slice(2);
function flag(name, fallback = undefined) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}
const MODEL = flag('--model', 'Xenova/whisper-base.en');
const LANGUAGE = flag('--language', 'english');
const LIMIT = Number(flag('--limit', '0')) || 0;
const MAX_WER = Number(flag('--max-wer', '0')) || 0;
const JSON_OUT = flag('--json', '');
const PIPELINE_ONLY = argv.includes('--pipeline-only');
const OFFLINE = argv.includes('--offline');
const VERBOSE = argv.includes('--verbose');

function mulberry32(seed) {
  let a = seed;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function synthAudio(generator) {
  const frames = Math.round(generator.seconds * SAMPLE_RATE);
  const out = new Float32Array(frames);
  if (generator.type === 'noise') {
    const rand = mulberry32(generator.seed ?? 12345);
    const amplitude = generator.amplitude ?? 0.02;
    for (let i = 0; i < frames; i++) out[i] = (rand() * 2 - 1) * amplitude;
  }
  return out;
}

function decodeWithFfmpeg(file) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-v', 'error', '-i', file,
      '-ac', '1', '-ar', String(SAMPLE_RATE),
      '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1',
    ]);
    const chunks = [];
    let stderr = '';
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => (stderr += c));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
      const buf = Buffer.concat(chunks);
      const out = new Float32Array(buf.length >> 2);
      for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
      resolve(out);
    });
  });
}

async function loadHfCase(testCase, datasets) {
  const dataset = datasets[testCase.dataset];
  if (!dataset) throw new Error(`unknown dataset "${testCase.dataset}"`);
  const query = new URLSearchParams({
    dataset: dataset.name,
    config: dataset.config,
    split: dataset.split,
    offset: String(testCase.row),
    length: '1',
  });
  const res = await fetch(`https://datasets-server.huggingface.co/rows?${query}`);
  if (!res.ok) throw new Error(`rows API HTTP ${res.status}`);
  const payload = await res.json();
  const row = payload.rows?.[0]?.row;
  const src = row?.audio?.[0]?.src;
  if (!row || !src) throw new Error('row has no audio');

  const id = row.id ?? `${testCase.dataset}-${testCase.row}`;
  const file = path.join(CACHE_DIR, `${id}.flac`);
  if (!(await fileExists(file))) {
    if (OFFLINE) throw new Error(`not cached and --offline was given: ${id}`);
    const audio = await fetch(src);
    if (!audio.ok) throw new Error(`audio download HTTP ${audio.status}`);
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(file, Buffer.from(await audio.arrayBuffer()));
  }
  return { id: testCase.id, file, expected: row.text ?? '' };
}

async function fileExists(file) {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(HERE, 'manifest.json'), 'utf8'));
  const cases = LIMIT > 0 ? manifest.cases.slice(0, LIMIT) : manifest.cases;

  const runtime = resolveAsrRuntime(false);
  // Node only supports the cpu/cuda ONNX backends; cpu + q8 mirrors the
  // browser WASM fallback (same dtypes), so WER here reflects the slow path.
  const device = 'cpu';
  console.log(`Model:    ${MODEL}`);
  console.log(`Device:   cpu (dtype ${JSON.stringify(runtime.dtype)} — stable CPU path)`);
  console.log(`Language: ${isEnglishOnlyModel(MODEL) ? '(English-only model)' : LANGUAGE}`);
  console.log(`Fixtures: ${cases.length}${PIPELINE_ONLY ? ' (pipeline only)' : ' (raw + pipeline)'}`);

  const asr = await pipeline('automatic-speech-recognition', MODEL, {
    device,
    dtype: runtime.dtype,
  });

  const transcribe = (audio) => {
    const options = {
      chunk_length_s: ASR_CHUNK_LENGTH_S,
      stride_length_s: ASR_STRIDE_LENGTH_S,
      return_timestamps: true,
      no_repeat_ngram_size: ASR_NO_REPEAT_NGRAM_SIZE,
    };
    if (!isEnglishOnlyModel(MODEL) && LANGUAGE && LANGUAGE !== 'auto') {
      options.language = LANGUAGE;
      options.task = 'transcribe';
    }
    return asr(audio, options);
  };

  const rows = [];
  for (const testCase of cases) {
    let fixture;
    try {
      fixture =
        testCase.kind === 'hf'
          ? await loadHfCase(testCase, manifest.datasets)
          : { id: testCase.id, audio: synthAudio(testCase.generator), expected: testCase.expected };
    } catch (err) {
      console.log(`\nSKIP ${testCase.id}: ${err.message}`);
      continue;
    }

    const audio = fixture.audio ?? (await decodeWithFfmpeg(fixture.file));
    const seconds = (audio.length / SAMPLE_RATE).toFixed(1);

    const rawOut = PIPELINE_ONLY ? null : await transcribe(audio);

    const pre = preprocessForASR(audio);
    let pipelineText = '';
    let compacted = false;
    if (!pre.empty) {
      const compaction = compactSpeech(pre.audio, SAMPLE_RATE);
      compacted = compaction.compacted;
      const out = await transcribe(compaction.compacted ? compaction.audio : pre.audio);
      pipelineText = out.text ?? '';
    }

    const pipelineWer = computeWer(fixture.expected, pipelineText);
    const rawWer = rawOut ? computeWer(fixture.expected, rawOut.text ?? '') : null;

    rows.push({ id: fixture.id, seconds, expected: fixture.expected, pipelineText, rawText: rawOut?.text ?? null, pipelineWer, rawWer, compacted });

    if (VERBOSE) {
      console.log(`\n[${fixture.id}] expected: ${fixture.expected || '(none)'}`);
      if (rawWer) console.log(`  raw:      ${rawOut.text}`);
      console.log(`  pipeline: ${pipelineText || '(none)'}${compacted ? '  [VAD compacted]' : ''}`);
    }
  }

  console.log('');
  const header = PIPELINE_ONLY
    ? `${'case'.padEnd(18)}${'sec'.padStart(6)}${'ref'.padStart(5)}${'pipeline WER'.padStart(14)}`
    : `${'case'.padEnd(18)}${'sec'.padStart(6)}${'ref'.padStart(5)}${'raw WER'.padStart(10)}${'pipeline WER'.padStart(14)}  vad`;
  console.log(header);
  console.log('-'.repeat(header.length));
  const pct = (w) => `${(w * 100).toFixed(1)}%`;
  for (const row of rows) {
    if (PIPELINE_ONLY) {
      console.log(
        `${row.id.padEnd(18)}${row.seconds.padStart(6)}${String(row.pipelineWer.refWords).padStart(5)}${pct(row.pipelineWer.wer).padStart(14)}`,
      );
    } else {
      console.log(
        `${row.id.padEnd(18)}${row.seconds.padStart(6)}${String(row.pipelineWer.refWords).padStart(5)}${pct(row.rawWer.wer).padStart(10)}${pct(row.pipelineWer.wer).padStart(14)}  ${row.compacted ? 'yes' : '-'}`,
      );
    }
  }

  const pipelineAgg = aggregateWer(rows.map((r) => ({ reference: r.expected, hypothesis: r.pipelineText })));
  console.log('-'.repeat(header.length));
  console.log(
    `corpus: ${pipelineAgg.refWords} ref words, ${pipelineAgg.substitutions} sub, ${pipelineAgg.deletions} del, ${pipelineAgg.insertions} ins`,
  );
  if (!PIPELINE_ONLY) {
    const rawAgg = aggregateWer(rows.map((r) => ({ reference: r.expected, hypothesis: r.rawText ?? '' })));
    console.log(`raw corpus WER:      ${pct(rawAgg.wer)}`);
  }
  console.log(`pipeline corpus WER: ${pct(pipelineAgg.wer)}`);

  if (JSON_OUT) {
    await writeFile(JSON_OUT, JSON.stringify({ model: MODEL, device, generated: new Date().toISOString(), rows, pipelineAgg }, null, 2));
    console.log(`\nwrote ${JSON_OUT}`);
  }

  if (MAX_WER > 0 && pipelineAgg.wer > MAX_WER) {
    console.error(`\nFAIL: pipeline corpus WER ${pct(pipelineAgg.wer)} exceeds --max-wer ${pct(MAX_WER)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
