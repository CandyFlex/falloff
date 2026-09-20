#!/usr/bin/env node
/**
 * sync-docs.mjs: copy the browser-safe part of src/ into docs/lib/, byte for byte.
 *
 * The showcase page does not get its own reimplementation of the sampler,
 * the metrics or the auditor. It imports the real modules, so anything it
 * shows is what the package does. GitHub Pages serves only docs/, so the
 * modules have to live there too; this script is how they get there, and
 * `test/docs-sync.test.mjs` fails when the copy drifts.
 *
 * "Browser-safe" is a directory rule, not a judgment call: everything under
 * src/ except src/node/. Modules outside src/node/ import no node: builtins
 * (the test checks that as well).
 *
 * Usage:
 *   node scripts/sync-docs.mjs           copy, and remove stale files in docs/lib/
 *   node scripts/sync-docs.mjs --check   exit 1 if docs/lib/ differs; change nothing
 *
 * It only ever touches docs/lib/. Nothing else under docs/ is read or written.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SRC = join(ROOT, 'src');
export const LIB = join(ROOT, 'docs', 'lib');
const EXCLUDE_DIRS = new Set(['node']);

/** Every file under `dir`, as forward-slash paths relative to it. */
export function walk(dir, skip = new Set(), base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (dir === base && skip.has(name)) continue;
      out.push(...walk(full, skip, base));
    } else {
      out.push(relative(base, full).split(sep).join('/'));
    }
  }
  return out;
}

/** The files that belong in docs/lib/. */
export function browserSafeFiles() {
  return walk(SRC, EXCLUDE_DIRS).filter((f) => f.endsWith('.mjs'));
}

/** Compare without writing. @returns {{missing: string[], different: string[], stale: string[]}} */
export function diff() {
  const want = browserSafeFiles();
  const have = walk(LIB);
  const missing = [];
  const different = [];
  for (const f of want) {
    const dst = join(LIB, f);
    if (!existsSync(dst)) missing.push(f);
    else if (!readFileSync(join(SRC, f)).equals(readFileSync(dst))) different.push(f);
  }
  const stale = have.filter((f) => !want.includes(f));
  return { missing, different, stale };
}

function sync() {
  const { missing, different, stale } = diff();
  for (const f of [...missing, ...different]) {
    const dst = join(LIB, f);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, readFileSync(join(SRC, f)));
  }
  for (const f of stale) rmSync(join(LIB, f));
  return { copied: missing.length + different.length, removed: stale.length, total: browserSafeFiles().length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--check')) {
    const d = diff();
    const n = d.missing.length + d.different.length + d.stale.length;
    for (const f of d.missing) console.error(`  missing in docs/lib: ${f}`);
    for (const f of d.different) console.error(`  differs from src:    ${f}`);
    for (const f of d.stale) console.error(`  not in src:          ${f}`);
    console.log(n ? `docs/lib is out of sync (${n} file(s)). Run: node scripts/sync-docs.mjs` : `docs/lib matches src (${browserSafeFiles().length} files)`);
    process.exit(n ? 1 : 0);
  }
  const r = sync();
  console.log(`docs/lib: ${r.total} files, ${r.copied} copied, ${r.removed} removed`);
}
