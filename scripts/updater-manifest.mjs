/**
 * Build the Tauri updater manifest (latest.json) from the repo's PUBLISHED
 * per-platform releases (`v<version>-windows|macos|ubuntu`, drafts ignored).
 * The newest version wins; only platforms already published at that version
 * are listed, each pointing at its signed update artifact:
 *   windows: NSIS -setup.exe   macos: .app.tar.gz   linux: .AppImage
 *
 * Usage (CI, see .github/workflows/update-manifest.yml):
 *   gh api --paginate repos/OWNER/REPO/releases > releases.json
 *   node scripts/updater-manifest.mjs releases.json latest.json
 * Signatures are downloaded from each release's `<artifact>.sig` asset.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const TAG = /^v(\d+)\.(\d+)\.(\d+)-(windows|macos|ubuntu)$/;

/** Update artifact name suffix → Tauri platform key. */
export const ARTIFACTS = [
  { match: /_windows_x64-setup\.exe$/, key: 'windows-x86_64' },
  { match: /_windows_arm64-setup\.exe$/, key: 'windows-aarch64' },
  { match: /_macos_arm64\.app\.tar\.gz$/, key: 'darwin-aarch64' },
  { match: /_macos_x64\.app\.tar\.gz$/, key: 'darwin-x86_64' },
  { match: /_linux_amd64\.AppImage$/, key: 'linux-x86_64' },
  { match: /_linux_arm64\.AppImage$/, key: 'linux-aarch64' },
];

function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Pick the newest published version and its update artifacts.
 * Returns { version, notes, pubDate, entries: [{ key, url, sigUrl }] } or null.
 */
export function planManifest(releases) {
  const published = [];
  for (const r of releases) {
    const m = TAG.exec(r.tag_name ?? '');
    if (!m || r.draft) continue;
    published.push({ r, v: [+m[1], +m[2], +m[3]], platform: m[4] });
  }
  if (published.length === 0) return null;
  const newest = published.reduce((a, b) => (cmp(b.v, a.v) > 0 ? b : a)).v;
  const current = published.filter((p) => cmp(p.v, newest) === 0);
  const entries = [];
  for (const { r } of current) {
    const assets = r.assets ?? [];
    for (const a of assets) {
      const art = ARTIFACTS.find((x) => x.match.test(a.name));
      if (!art) continue;
      const sig = assets.find((s) => s.name === `${a.name}.sig`);
      if (!sig) continue;
      entries.push({ key: art.key, url: a.browser_download_url, sigUrl: sig.browser_download_url });
    }
  }
  const dates = current.map((p) => p.r.published_at).filter(Boolean).sort();
  return {
    version: newest.join('.'),
    notes: `Local Transcriber ${newest.join('.')}. Release notes: https://github.com/GrzeskoByte/local-transcript/releases`,
    pubDate: dates[dates.length - 1] ?? new Date().toISOString(),
    entries,
  };
}

/** Final latest.json object, given the plan and fetched signature texts. */
export function buildManifest(plan, signatures) {
  const platforms = {};
  for (const e of plan.entries) {
    const signature = signatures[e.sigUrl];
    if (signature) platforms[e.key] = { signature: signature.trim(), url: e.url };
  }
  return { version: plan.version, notes: plan.notes, pub_date: plan.pubDate, platforms };
}

async function main() {
  const [releasesPath, outPath] = process.argv.slice(2);
  if (!releasesPath || !outPath) {
    console.error('usage: updater-manifest.mjs <releases.json> <latest.json>');
    process.exit(2);
  }
  // `gh api --paginate` concatenates JSON arrays: `[...][...]`.
  const raw = readFileSync(releasesPath, 'utf8').trim().replace(/\]\s*\[/g, ',');
  const plan = planManifest(JSON.parse(raw));
  if (!plan) {
    console.error('No published release found.');
    process.exit(1);
  }
  const signatures = {};
  for (const e of plan.entries) {
    const res = await fetch(e.sigUrl);
    if (!res.ok) throw new Error(`Could not download ${e.sigUrl}: ${res.status}`);
    signatures[e.sigUrl] = await res.text();
  }
  const manifest = buildManifest(plan, signatures);
  if (Object.keys(manifest.platforms).length === 0) {
    console.error(`v${plan.version} has no signed update artifacts (TAURI_SIGNING_PRIVATE_KEY unset?).`);
    process.exit(1);
  }
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`latest.json → v${manifest.version}: ${Object.keys(manifest.platforms).join(', ')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
