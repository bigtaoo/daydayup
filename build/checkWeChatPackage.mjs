#!/usr/bin/env node
// WeChat package byte-budget gate (design/04 "Key constraints", design/12 "Bundle
// boundaries"). Same spirit as checkFileLength.mjs: a drift check that runs in `npm run
// check`, so the limit is enforced by CI rather than remembered.
//
// Why it exists: the mini-game's main package is capped at 4 MB, and every art pass adds to
// it. Before this, adding a texture cost nothing visible until someone tried to package the
// game — which is how client/public reached 14 MB while the WeChat target was still
// rendering Graphics placeholders and nobody had a number to point at.
//
// What it fails on:
//   1. a package over its own limit (main / independent subpackage: 4 MB),
//   2. everything together over the 30 MB whole-game ceiling,
//   3. a rule in assetPacks.json naming a package that does not exist (planPackage throws).
//
// The budget half deliberately does NOT look at the built platforms/wechat directory. The
// plan is computed from client/public + the pack table, so it is meaningful without running a
// build first — art lands in the repo long before anyone runs `build:wechat`, and that is
// precisely when the budget should be re-checked.
//
// `--verify-built` adds the other half: that the built project on disk actually MATCHES the
// plan — every planned file present, every subpackage root carrying its generated `game.js`
// entry, and game.json's `subpackages` agreeing with the manifest. It is opt-in rather than
// automatic because a checkout that simply has not been built yet is not a failure, and a
// gate that red-lit on that would get ignored.
//
// Usage: node build/checkWeChatPackage.mjs [--verbose] [--verify-built]
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { planPackage, subpackageEntries } from './wechatAssetSync.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const verbose = process.argv.includes('--verbose');
const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;

const plan = planPackage(repoRoot);
const failures = [];

for (const p of plan.byPack) {
  const status = p.bytes > p.limitBytes ? 'OVER' : 'ok';
  if (status === 'OVER') {
    failures.push(`package '${p.name}' is ${mb(p.bytes)}, over its ${mb(p.limitBytes)} limit`);
  }
  console.log(`  ${status.padEnd(4)} pack '${p.name}': ${p.count} files, ${mb(p.bytes)} / ${mb(p.limitBytes)}`);
}

if (plan.totalBytes > plan.totalLimitBytes) {
  failures.push(`whole game is ${mb(plan.totalBytes)}, over the ${mb(plan.totalLimitBytes)} ceiling`);
}
console.log(`  total: ${mb(plan.totalBytes)} / ${mb(plan.totalLimitBytes)}`);

// Raw bytes are what this gate enforces, deliberately. WeChat's own docs state the 4 MB
// limit without saying whether it is measured before or after the package is compressed;
// community write-ups say after, and DevTools' upload dialog is the only authoritative
// answer (design/04's checklist — it needs the simulator installed). Until someone reads
// that number, failing on raw bytes is the conservative direction. The estimate below is
// printed so the real headroom is visible without the gate depending on it: PNGs are
// already deflated and gain nothing, so the code is the only part compression moves.
if (plan.hasBundle) {
  const bundle = readFileSync(join(repoRoot, 'client', 'wechat', 'js', 'game.js'));
  const saved = bundle.length - gzipSync(bundle).length;
  console.log(`  note: if WeChat measures the COMPRESSED package, main is ~${mb(plan.byPack[0].bytes - saved)} (code gzips ${mb(bundle.length)} -> ${mb(bundle.length - saved)})`);
}

if (!plan.hasBundle) {
  // Not a failure: a fresh checkout has no build output. But the main package's headroom is
  // being reported without the ~0.7 MB bundle in it, and a gate that quietly measured the
  // wrong thing would be worse than no gate.
  console.log('  note: client/wechat/js/game.js not built — main package excludes the bundle');
}

if (process.argv.includes('--verify-built')) {
  const target = join(repoRoot, 'platforms', 'wechat');
  if (!existsSync(target)) {
    failures.push('--verify-built: platforms/wechat does not exist — run `npm run build:wechat` first');
  } else {
    const missing = [];
    for (const f of plan.files) if (!existsSync(join(target, f.dest))) missing.push(f.dest);
    for (const e of subpackageEntries(plan.packs)) {
      // A subpackage root with no `game.js` is the undocumented resource-only case the 分包
      // docs never promise works — the build writes a no-op entry, and this is what notices
      // if it ever stops.
      if (!existsSync(join(target, e.root, 'game.js'))) missing.push(`${e.root}game.js (subpackage entry)`);
    }
    for (const f of ['game.js', 'game.json', 'project.config.json', 'js/game.js']) {
      if (!existsSync(join(target, f))) missing.push(f);
    }
    if (missing.length > 0) {
      failures.push(`--verify-built: ${missing.length} file(s) missing from platforms/wechat: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}`);
    }
    const declared = (JSON.parse(readFileSync(join(target, 'game.json'), 'utf8')).subpackages ?? [])
      .map((x) => `${x.name}@${x.root}`).sort();
    const expected = subpackageEntries(plan.packs).map((x) => `${x.name}@${x.root}`).sort();
    if (declared.join('|') !== expected.join('|')) {
      failures.push(`--verify-built: game.json declares [${declared}] but the manifest says [${expected}]`);
    }
    if (missing.length === 0 && declared.join('|') === expected.join('|')) {
      console.log(`  built project OK: ${plan.files.length} files present, ${expected.length} subpackage(s) declared`);
    }
  }
}

if (verbose) {
  for (const f of [...plan.files].sort((a, b) => b.size - a.size).slice(0, 20)) {
    console.log(`    ${String((f.size / 1024).toFixed(0)).padStart(6)}KB  ${f.dest}`);
  }
}

if (failures.length > 0) {
  // Two different kinds of failure land here and they need opposite advice — a package over
  // budget is an art/boundary decision, a built project that does not match the plan just
  // needs a rebuild. One generic "go shrink your art" banner for both sends the reader the
  // wrong way on half the failures.
  console.error('\nWeChat package check failed:');
  for (const f of failures) console.error(`  - ${f}`);
  if (failures.some((f) => !f.startsWith('--verify-built'))) {
    console.error('\nOver budget: shrink art (tools/png-pipeline/compress.mjs --no-trim) or move');
    console.error('assets into a subpackage — add a rule to client/src/render/assetPacks.json.');
  }
  if (failures.some((f) => f.startsWith('--verify-built'))) {
    console.error('\nBuilt project out of date: run `npm run build:wechat` in client/.');
  }
  process.exit(1);
}

console.log('WeChat package budget OK');
