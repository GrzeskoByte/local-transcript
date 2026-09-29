#!/usr/bin/env node
/**
 * Native accuracy + speed bench — measures EXACTLY what the desktop app runs:
 *   preprocessForASR (src/asr/preprocess.ts)
 *   → planSpeechChunks / assembleChunk (src/asr/chunking.ts)
 *   → 16 kHz WAV (src/asr/wav.ts)
 *   → the real native CLI (voxtype, or whisper-cli)
 * and reports word error rate (WER) and wall-clock time per case.
 *
 * Cases: the manifest's fixtures, plus a synthetic long-form "meeting" that joins
 * every speech fixture with 2.5 s pauses (exercises chunk packing + timestamps).
 * `--compare-whole` also runs the previous approach (the whole file in one call)
 * so a chunking change shows up as a WER/time delta instead of a claim.
 *
 * Usage:
 *   npm run bench:native
 *   npm run bench:native -- --model base.en --compare-whole
 *   npm run bench:native -- --model large-v3-turbo --max-wer 0.15 --json bench/native-results.json
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preprocessForASR } from '../src/asr/preprocess.ts';
import { assembleChunk, planSpeechChunks } from '../src/asr/chunking.ts';
import { encodeWav16 } from '../src/asr/wav.ts';
import { aggregateWer, computeWer } from '../src/asr/wer.ts';

const SR = 16000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(HERE, 'fixtures', 'cache');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const MODEL = flag('--model', 'base.en');
const LANGUAGE = flag('--language', 'auto');
const MAX_WER = Number(flag('--max-wer', '0')) || 0;
const JSON_OUT = flag('--json', '');
const COMPARE_WHOLE = argv.includes('--compare-whole');
const ONLY = flag('--only', '');
const PLAN = {};
if (flag('--min-top-up-ms')) PLAN.minTopUpMs = Number(flag('--min-top-up-ms'));
if (flag('--max-chunk-ms')) PLAN.maxChunkMs = Number(flag('--max-chunk-ms'));
const BACKEND = flag('--backend', process.env.WHISPER_CLI_PATH ? 'whisper-cli' : 'voxtype');

function which(bin) {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' }).status === 0;
}

function decode(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1']);
    const parts = [];
    let err = '';
    p.stdout.on('data', (c) => parts.push(c));
    p.stderr.on('data', (c) => (err += c));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg ${code}: ${err}`));
      const b = Buffer.concat(parts);
      resolve(new Float32Array(b.buffer, b.byteOffset, b.length >> 2).slice());
    });
  });
}

/** Run the backend on one WAV; returns plain text (mirrors native_asr.rs parsing). */
function runBackend(wavPath) {
  const args = BACKEND === 'voxtype'
    ? ['--language', LANGUAGE, '--model', MODEL, 'transcribe', wavPath]
    : ['-m', MODEL, '-l', LANGUAGE, '-nt', '-f', wavPath];
  const bin = BACKEND === 'voxtype' ? 'voxtype' : process.env.WHISPER_CLI_PATH || 'whisper-cli';
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`${bin} exited ${r.status}: ${(r.stderr || '').slice(-400)}`);
  const lines = (r.stdout || '').replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim())
    .filter((l) => l && !/ (INFO|WARN|DEBUG) |ERROR |^whisper_|^ggml_|^Loading /.test(l));
  return BACKEND === 'voxtype' ? (lines.pop() ?? '') : lines.join(' ');
}

async function transcribeChunked(audio, tmp) {
  const pre = preprocessForASR(audio);
  if (pre.empty) return { text: '', calls: 0, segments: [] };
  const chunks = planSpeechChunks(pre.audio, SR, PLAN);
  const segments = [];
  for (let i = 0; i < chunks.length; i++) {
    const wav = path.join(tmp, `c${i}.wav`);
    await writeFile(wav, encodeWav16(assembleChunk(pre.audio, chunks[i], SR), SR));
    const text = runBackend(wav);
    if (text) segments.push({ start: chunks[i].start / SR, end: chunks[i].end / SR, text });
  }
  return { text: segments.map((s) => s.text).join(' '), calls: chunks.length, segments };
}

async function transcribeWhole(audio, tmp) {
  const wav = path.join(tmp, 'whole.wav');
  await writeFile(wav, encodeWav16(audio, SR));
  return { text: runBackend(wav), calls: 1 };
}

async function loadCases() {
  const manifest = JSON.parse(await readFile(path.join(HERE, 'manifest.json'), 'utf8'));
  const cases = [];
  for (const c of manifest.cases) {
    if (c.kind === 'synthetic') {
      const n = Math.round(c.generator.seconds * SR);
      const audio = new Float32Array(n);
      if (c.generator.type === 'noise') {
        let a = c.generator.seed ?? 1;
        for (let i = 0; i < n; i++) {
          a = (a * 1664525 + 1013904223) >>> 0;
          audio[i] = ((a / 4294967296) * 2 - 1) * (c.generator.amplitude ?? 0.02);
        }
      }
      cases.push({ id: c.id, audio, expected: c.expected ?? '' });
      continue;
    }
    const ds = manifest.datasets[c.dataset];
    const q = new URLSearchParams({ dataset: ds.name, config: ds.config, split: ds.split, offset: String(c.row), length: '1' });
    try {
      const row = (await (await fetch(`https://datasets-server.huggingface.co/rows?${q}`)).json()).rows?.[0]?.row;
      const file = path.join(CACHE_DIR, `${row.id ?? c.id}.flac`);
      try { await readFile(file); } catch {
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(file, Buffer.from(await (await fetch(row.audio[0].src)).arrayBuffer()));
      }
      cases.push({ id: c.id, audio: await decode(file), expected: row.text ?? '' });
    } catch (e) {
      console.warn(`skip ${c.id}: ${e.message}`);
    }
  }
  // Long-form "meeting": every speech case, 2.5 s pauses between them.
  const speech = cases.filter((c) => c.expected);
  if (speech.length > 1) {
    const pause = new Float32Array(Math.round(2.5 * SR));
    const parts = speech.flatMap((c) => [pause, c.audio]);
    const len = parts.reduce((n, p) => n + p.length, 0);
    const audio = new Float32Array(len);
    let o = 0;
    for (const p of parts) { audio.set(p, o); o += p.length; }
    cases.push({ id: 'long-form-meeting', audio, expected: speech.map((c) => c.expected).join(' ') });
  }
  return cases;
}

const bin = BACKEND === 'voxtype' ? 'voxtype' : process.env.WHISPER_CLI_PATH || 'whisper-cli';
if (!which(bin) && !process.env.WHISPER_CLI_PATH) {
  console.error(`No ${bin} on PATH — install voxtype or whisper.cpp (or set WHISPER_CLI_PATH).`);
  process.exit(2);
}
const tmp = await mkdtemp(path.join(os.tmpdir(), 'lt-native-bench-'));
const cases = await loadCases();
console.log(`backend=${BACKEND} model=${MODEL} language=${LANGUAGE} cases=${cases.length}\n`);
const rows = [];
try {
  for (const c of cases.filter((x) => !ONLY || x.id === ONLY)) {
    const t0 = performance.now();
    const chunked = await transcribeChunked(c.audio, tmp);
    const ms = performance.now() - t0;
    const wer = computeWer(c.expected, chunked.text);
    const row = { id: c.id, seconds: +(c.audio.length / SR).toFixed(1), calls: chunked.calls, wallMs: Math.round(ms), wer: wer.wer, text: chunked.text };
    if (COMPARE_WHOLE) {
      const t1 = performance.now();
      const whole = await transcribeWhole(c.audio, tmp);
      row.wholeWallMs = Math.round(performance.now() - t1);
      row.wholeWer = computeWer(c.expected, whole.text).wer;
      row.wholeText = whole.text;
    }
    rows.push({ ...row, pair: { reference: c.expected, hypothesis: chunked.text } });
    const cmp = COMPARE_WHOLE ? `   whole-file: WER ${(row.wholeWer * 100).toFixed(1)}% ${(row.wholeWallMs / 1000).toFixed(1)}s` : '';
    console.log(`${c.id.padEnd(20)} ${String(row.seconds).padStart(6)}s  ${String(row.calls).padStart(2)} calls  WER ${(row.wer * 100).toFixed(1).padStart(5)}%  ${(ms / 1000).toFixed(1).padStart(6)}s${cmp}`);
    if (argv.includes('--verbose')) console.log(`   REF:     ${c.expected}\n   CHUNKED: ${chunked.text}${COMPARE_WHOLE ? `\n   WHOLE:   ${row.wholeText}` : ''}`);
    if (c.id === 'long-form-meeting') for (const s of chunked.segments) console.log(`   [${s.start.toFixed(1)}–${s.end.toFixed(1)}s] ${s.text.slice(0, 80)}`);
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}
const agg = aggregateWer(rows.length ? rows.filter((r) => r.id !== 'long-form-meeting').map((r) => r.pair) : []);
console.log(`\naggregate WER (fixtures): ${(agg.wer * 100).toFixed(2)}%`);
if (JSON_OUT) await writeFile(JSON_OUT, JSON.stringify({ backend: BACKEND, model: MODEL, aggregateWer: agg.wer, rows: rows.map(({ pair, ...r }) => r) }, null, 2));
if (MAX_WER && agg.wer > MAX_WER) {
  console.error(`FAIL: aggregate WER ${(agg.wer * 100).toFixed(2)}% > ${(MAX_WER * 100).toFixed(2)}%`);
  process.exit(1);
}
