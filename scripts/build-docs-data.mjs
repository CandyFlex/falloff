#!/usr/bin/env node
/**
 * build-docs-data.mjs: generate everything on the showcase page that is a
 * figure, from the data that produced it.
 *
 * It writes three things, all deterministic:
 *
 *   docs/data.js                 the studies (redacted, names never included),
 *                                the verbatim output of
 *                                `falloff audit snapshots/tampered.json`,
 *                                the presets, the pinned constants, the
 *                                constructed scenarios and the test counts
 *   docs/studies/<folder>.html   a copy of each studies/<folder>/report.html,
 *                                because GitHub Pages serves only docs/
 *   docs/method.html             the blocks between <!-- gen:x --> markers,
 *                                rendered from the same data object, so the
 *                                first paint is complete without JavaScript
 *
 * Studies are discovered from studies/ (every folder with a snapshot.json,
 * except private/). No folder name appears in this file. The hero is the
 * most recently observed study.
 *
 * A study that fails audit stops the build. The page never draws a figure
 * its own auditor rejects.
 *
 * The one thing that is not a pure function of the repository is whether
 * the npm package exists. A normal run asks the registry once and records
 * the answer with the date. `--check`, `--offline` and the test suite reuse
 * the answer already recorded in docs/data.js, so they need no network and
 * no clock.
 *
 * Usage:
 *   node scripts/build-docs-data.mjs            ask npm, then write
 *   node scripts/build-docs-data.mjs --offline  write, reusing the recorded npm answer
 *   node scripts/build-docs-data.mjs --check    exit 1 if anything on disk is stale
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { loadStudies } from './studies-index.mjs';
import { samplePlan, PRESETS, RING_GROWTH, GOLDEN_ANGLE, MIN_RING_POINTS, KM_PER_DEG_LAT, KM_PER_DEG_LNG_EQUATOR, VERSION } from '../src/index.mjs';
import { REPOSITORY } from '../src/version.mjs';
import {
  esc, pct, ringPlot, legend, readoutRows, readoutHtml, sentence, accountingGrid, ladder,
  runLab, runPair, labReadout, termHtml, encodePoint, decodePoint, mark, HATCH_DEFS,
  FOUND, ABSENT, UNREACHED,
} from '../docs/figures.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = join(ROOT, 'docs');
const DATA_FILE = join(DOCS, 'data.js');
const INDEX_FILE = join(DOCS, 'method.html');
const REPORTS = join(DOCS, 'studies');

/** Starting state of the lab, and the two constructed scans in "three states". */
export const LAB_DEFAULT = { unreached: 0, radiusKm: 20 };
export const LAB_RANGE = { unreached: [0, 40], radiusKm: [2, 60] };
const PAIR = { found: 33, stopAt: 50 };

/** What each preset is for. Words, not figures; the figures come from samplePlan(). */
const PRESET_USE = {
  tight: 'walk-in trade: coffee, barbers, bakeries',
  mid: 'everyday drive: restaurants, dentists, mechanics',
  regional: 'specialists, venues',
  wide: 'destinations people plan a trip for',
};

/* ---------------- npm ---------------- */

/** Ask the registry. `published` is true only on a clean answer with a version. */
export function askNpm(today = new Date().toISOString().slice(0, 10)) {
  const r = spawnSync('npm', ['view', 'falloff', 'version'], { shell: true, encoding: 'utf8', timeout: 30000 });
  const out = `${r.stdout ?? ''}`.trim();
  const err = `${r.stderr ?? ''}`;
  if (r.status === 0 && /^\d+\.\d+\.\d+/.test(out)) return { published: true, version: out, checked: today, command: 'npm view falloff version', result: out };
  if (/E404/.test(err)) return { published: false, version: null, checked: today, command: 'npm view falloff version', result: '404 Not Found' };
  return null; // no answer (offline, timeout); the caller keeps what was recorded
}

/** The npm answer already recorded in docs/data.js, or "not confirmed". */
export function recordedNpm() {
  if (existsSync(DATA_FILE)) {
    const m = readFileSync(DATA_FILE, 'utf8').match(/^ "npm": (.*),$/m);
    if (m) return JSON.parse(m[1]);
  }
  return { published: false, version: null, checked: null, command: 'npm view falloff version', result: 'not checked' };
}

/* ---------------- data ---------------- */

function cliAudit(relFile) {
  const r = spawnSync(process.execPath, ['bin/falloff.mjs', 'audit', relFile], { cwd: ROOT, encoding: 'utf8' });
  return { command: `falloff audit ${relFile}`, exitCode: r.status, output: `${r.stdout}${r.stderr}`.replace(/\r\n/g, '\n').replace(/^\n+|\s+$/g, '') };
}

function countTests() {
  const dir = join(ROOT, 'test');
  const text = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  return { total: (text.match(/^test\(/gm) ?? []).length, tamper: (text.match(/^test\('\[tamper\]/gm) ?? []).length };
}

export async function buildData(npm) {
  const loaded = loadStudies();
  const failed = loaded.filter((s) => !s.audit.ok);
  if (failed.length) throw new Error(`these studies do not pass audit: ${failed.map((s) => s.folder).join(', ')}`);
  const unredacted = loaded.filter((s) => s.snap.target?.name !== 'withheld' || s.snap.readings.some((r) => (r.results ?? []).some((b) => 'name' in b)));
  if (unredacted.length) throw new Error(`these studies are not redacted: ${unredacted.map((s) => s.folder).join(', ')}`);

  const studies = loaded.map(({ folder, snap, meta, audit: a }) => ({
    folder,
    report: `studies/${folder}.html`,
    observed: String(snap.startedAt).slice(0, 10),
    place: meta.place ?? null,
    query: snap.query,
    preset: snap.method.preset,
    radii: snap.method.ringRadiiKm,
    budget: snap.method.budget,
    packSize: snap.method.packSize,
    provider: { id: snap.provider.id, version: snap.provider.version ?? null },
    observation: snap.method.observation ?? null,
    command: snap.command,
    redacted: true,
    audit: { ok: a.ok, warn: a.counts.warn, critical: a.counts.critical },
    summary: a.metrics,
    points: snap.readings.map(encodePoint),
  }));
  const hero = [...studies].sort((a, b) => (a.observed < b.observed ? 1 : -1))[0].folder;

  const tamperedFile = 'snapshots/tampered.json';
  const tamperedSnap = JSON.parse(readFileSync(join(ROOT, tamperedFile), 'utf8'));
  const tampered = { ...cliAudit(tamperedFile), edits: tamperedSnap.tampered?.edits ?? [], source: tamperedSnap.tampered?.source ?? null };

  const presets = Object.keys(PRESETS).map((name) => {
    const plan = samplePlan({ lat: 0, lng: 0, preset: name });
    return { name, rmin: plan.method.rmin, rmax: plan.method.rmax, budget: plan.budget, radii: plan.rings, pointsPerRing: plan.method.pointsPerRing, use: PRESET_USE[name] ?? '' };
  });

  const strip = (res) => ({ ...res, points: res.points.map(encodePoint) });
  const pair = await runPair(PAIR);
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  return {
    generatedBy: 'node scripts/build-docs-data.mjs',
    version: VERSION,
    repository: REPOSITORY,
    node: pkg.engines.node,
    npm,
    hero,
    studies,
    tampered,
    presets,
    constants: { growth: RING_GROWTH, goldenAngle: GOLDEN_ANGLE, minRingPoints: MIN_RING_POINTS, kmPerDegLat: KM_PER_DEG_LAT, kmPerDegLngEquator: KM_PER_DEG_LNG_EQUATOR },
    pair: { params: PAIR, complete: strip(pair.complete), gapped: strip(pair.gapped) },
    lab: { default: LAB_DEFAULT, range: LAB_RANGE, start: strip(await runLab(LAB_DEFAULT)) },
    tests: countTests(),
  };
}

/** One top-level key per line, so a diff of data.js shows which part moved. */
export function dataJs(data) {
  const lines = Object.entries(data).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return `// Generated by \`node scripts/build-docs-data.mjs\`. Do not edit by hand.\n// Business names are withheld: no name and no result list is in this file.\nexport const DATA = {\n${lines.join(',\n')}\n};\n`;
}

/* ---------------- static blocks ---------------- */

const open = (res) => ({ ...res, points: res.points.map(decodePoint) });

function surfaceSentence(st) {
  const o = st.observation;
  if (o?.surface === 'maps-feed') {
    const zoom = parseInt(o.zoom, 10);
    return `Ranks were read from the Google Maps results feed in a ${o.loggedOut ? 'logged-out ' : ''}desktop browser${Number.isFinite(zoom) ? ` at zoom ${zoom}` : ''}, ${o.passes === 1 ? 'in one pass' : `in ${o.passes} passes`}. This was not the Places API, which measures a different surface.`;
  }
  return `Read through the ${st.provider.id} provider.`;
}

/** What "absent" was absent from, in words, for one study. */
function depthWords(st) {
  const d = st.observation?.listDepth;
  return d
    ? d.min === d.max
      ? `every point here captured ${d.min} rows, so absent means absent from ${d.min} rows.`
      : `points here captured between ${d.min} and ${d.max} rows, so absent means absent from a list of that depth.`
    : 'this scan records no capture depth, so how deep the reading went is not known.';
}

function blocks(d) {
  const hero = d.studies.find((s) => s.folder === d.hero);
  const heroPoints = hero.points.map(decodePoint);
  const clone = `git clone ${d.repository}`;
  const out = {};

  // A link that jumps and also copies is two controls in one, and the
  // "Copied" label lands on an element the reader has just scrolled away
  // from. The link jumps; the button next to the command in the install
  // section copies, and announces it.
  out['hero-cta'] = `<a class="btn" href="#install">How to get it</a>
<a class="link" href="#method">Read the method</a>`;

  out['hero-map'] = `${ringPlot({
    points: heroPoints, radii: hero.radii, packSize: hero.packSize, variant: 'hero', id: 'hero-plot',
    title: `Ring map of ${hero.points.length} sample points around a business (name withheld) for the query ${hero.query}, observed ${hero.observed} in ${hero.place}.`,
    desc: sentence(hero.summary),
  })}
${legend(hero.packSize)}
<figcaption>
<p>Observed ${esc(hero.observed)}, ${esc(hero.place)}, query "${esc(hero.query)}". Business name withheld and every id hashed with a salt that is not published. The centre is rounded to 0.01 degrees, about 1 km, and these points are recomputed from the rounded centre, so the geometry still replays; the scan itself was observed at the true coordinates. Withheld is not anonymous: the town, the query and the date are kept.</p>
<p>${esc(surfaceSentence(hero))} North is up. Distance is on a LOG scale here, so the near rings stay readable and the outer rings are closer than the ground: the 60 km ring is about five times the radius of the 2.5 km ring on this page, and twenty-four times it in reality. The report that <code>falloff render</code> writes draws the same points on a LINEAR scale, and says so in its own caption.</p>
</figcaption>`;

  out['hero-readout'] = `<dl class="readout" id="hero-readout">
${readoutHtml(readoutRows(hero.summary))}
</dl>
<p class="status" id="hero-status">Computed at build time from the ${hero.points.length} readings in data.js.</p>
<div class="cmd"><span class="cmd-k">reproduce</span><code>falloff report studies/${esc(hero.folder)}/snapshot.json</code></div>`;

  const glyph = (inner) => `<svg viewBox="-12 -12 24 24" width="44" height="44" aria-hidden="true">${inner}</svg>`;
  out['states'] = `<div class="states">
<div class="state">${glyph(mark(FOUND, true))}${glyph(mark(FOUND, false))}<h3>Found</h3><p>The business appeared in the results at that point, at a recorded rank. Filled means inside the top ${hero.packSize}, hollow means below it.</p></div>
<div class="state">${glyph(mark(ABSENT, false))}<h3>Absent</h3><p>The point was measured and the business was not in the list captured there. That is information, and it is as deep as the capture: ${esc(depthWords(hero))}</p></div>
<div class="state">${glyph(mark(UNREACHED, false))}<h3>Unreached</h3><p>The point was never measured: a timeout, a block, a quota. That is a hole in the data, and the reason is recorded.</p></div>
</div>`;

  const side = (res, heading, note) => {
    const r = open(res);
    const v = r.summary.visibility;
    const t = { f: v.found, a: v.measured - v.found, u: v.unreached };
    return `<div class="scan">
<h3>${esc(heading)}</h3>
${accountingGrid(r.points, r.packSize, `${t.f} found, ${t.a} absent, ${t.u} unreached, in plan order`)}
<p class="scan-note">${esc(note)}</p>
<dl class="readout">
${readoutHtml([
      { k: 'gaps merged into absent', v: `${r.merged.found}/${r.merged.total} points`, note: `${pct(r.merged.share)} visible`, fragile: false },
      { k: 'by falloff', v: `${v.found}/${v.measured} measured`, note: `${pct(v.share)}, ${v.unreached} unreached and excluded`, fragile: false },
    ])}
</dl>
<pre class="term" tabindex="0">${termHtml(r.audit.text, true)}</pre>
</div>`;
  };
  const g = open(d.pair.gapped);
  out['pair'] = `<figure class="pair">
<figcaption class="tag">Constructed scenario. Two scans of the same ${g.total}-point plan, built to make the arithmetic visible. Neither is a real business.</figcaption>
<div class="pair-grid">
${side(d.pair.complete, 'Scan A: every point answered', 'Each cell is one sample point, in plan order from the home point outward.')}
${side(d.pair.gapped, `Scan B: the provider stopped at point ${d.pair.params.stopAt + 1}`, `The last ${g.summary.visibility.unreached} calls threw. Nothing is known about those points.`)}
</div>
</figure>`;

  const lab = open(d.lab.start);
  const range = d.lab.range;
  out['lab'] = `<div class="lab-controls">
<div class="field">
<label for="lab-unreached">Points unreached</label>
<output id="lab-unreached-out" for="lab-unreached">${d.lab.default.unreached} of ${lab.total}</output>
<input type="range" id="lab-unreached" min="${range.unreached[0]}" max="${range.unreached[1]}" step="1" value="${d.lab.default.unreached}">
<p class="hint">Calls that throw. Past a tenth of the plan, the audit refuses to publish.</p>
</div>
<div class="field">
<label for="lab-radius">Visibility radius</label>
<output id="lab-radius-out" for="lab-radius">${d.lab.default.radiusKm} km</output>
<input type="range" id="lab-radius" min="${range.radiusKm[0]}" max="${range.radiusKm[1]}" step="1" value="${d.lab.default.radiusKm}">
<p class="hint">The business is visible inside this disc and nowhere else.</p>
</div>
<p class="hint nojs">The controls need JavaScript and the library to load. Until then the figures show the starting state.</p>
</div>
<div class="lab-plot" id="lab-plot">${ringPlot({ points: lab.points, radii: lab.radii, packSize: lab.packSize, variant: 'lab', id: 'lab-plot-svg', title: 'Ring map of the constructed scan', desc: sentence(lab.summary) })}</div>
<div class="lab-out" id="lab-out" aria-live="polite">${labReadout(lab)}</div>`;

  const cell = (k, v) => `<div class="cell c-${k}"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`;
  const studyRow = (s) => [s]
    .map((s) => {
      const v = s.summary.visibility;
      const shape = s.summary.archetype?.reliable ? s.summary.archetype.archetype : 'not reportable';
      return `<li class="study">
${ringPlot({ points: s.points.map(decodePoint), radii: s.radii, packSize: s.packSize, variant: 'mini', id: `mini-${s.folder}`, title: `Ring map: ${sentence(s.summary)}` })}
${cell('observed', `${esc(s.observed)}<small>${esc(s.place ?? 'place not recorded')}</small>`)}
${cell('query', esc(s.query))}
${cell('preset', esc(s.preset))}
${cell('shape', esc(shape))}
${cell('visible', `${v.found}/${v.measured} measured<small>${esc(pct(v.share))}, ${v.unreached} unreached</small>`)}
<a class="link" href="${esc(s.report)}" aria-label="Report for the ${esc(s.observed)} ${esc(s.query)} study">Open report</a>
</li>`;
    })
    .join('');
  // Grouped by preset, because the share in the last column is a share of the
  // sample points that preset lays down. Five percentages in one column across
  // two presets invite exactly the comparison that does not hold.
  const rows = [...new Set(d.studies.map((s) => s.preset))]
    .sort()
    .map((name) => {
      const group = d.studies.filter((s) => s.preset === name);
      const p = d.presets.find((x) => x.name === name);
      const span = p ? `${p.rmin}-${p.rmax} km, ${p.budget} points` : 'custom geometry';
      return `<li class="study-group">
<h3>Preset <code>${esc(name)}</code> <small>${esc(span)}. Shares compare inside this group only.</small></h3>
<ol class="studies">
${group.map(studyRow).join('\n')}
</ol>
</li>`;
    })
    .join('\n');
  const complete0 = d.studies.filter((s) => s.summary.visibility.found === 0 && s.summary.visibility.unreached === 0);
  const zeroNote = complete0.length
    ? `<p>The ${esc(complete0[0].observed)} scan found the business at ${complete0[0].summary.visibility.found} of ${complete0[0].summary.visibility.measured} measured points, with ${complete0[0].summary.visibility.unreached} unreached. That is a complete measurement of an absence. It is a different thing from a scan that failed.</p>`
    : '';
  const providers = [...new Set(d.studies.map((s) => s.provider.id))];
  out['studies'] = `<p class="lede">${d.studies.length} real scans, each observed on the date shown. Names withheld; coordinates, ranks and dates are in the snapshots.</p>
<p>${providers.length === 1 ? esc(surfaceSentence(d.studies[0])) : `Providers: ${esc(providers.join(', '))}.`} They were observed with an automated browser scan written by this project's author, which is not in this repository; this repository ships no scraper. The reproduce command on each study re-renders the recorded file, and re-observing those points needs your own provider. A scan through another provider is not comparable with these.</p>
<p>Each study is a single pass on one day. Nothing here measures how far a point moves between scans, because no study has been run twice; <code>falloff compare</code> is the command that would. The rows are grouped by preset because an overall share depends on the preset: points are allocated by ring circumference, so the same business scores differently on <code>tight</code> and on <code>mid</code>, and the percentages below are only comparable inside a group.</p>
<ol class="study-groups">
${rows}
</ol>
${zeroNote}`;

  out['audit'] = `<pre class="term term-big" tabindex="0" aria-label="Output of ${esc(d.tampered.command)}"><span class="prompt">$ ${esc(d.tampered.command)}</span>\n\n${termHtml(d.tampered.output)}\n\n<span class="prompt">exit code ${d.tampered.exitCode}</span></pre>
<div class="edits">
<p>What was changed in that file, as recorded inside it:</p>
<ul>
${d.tampered.edits.map((e) => `<li><code>${esc(e)}</code></li>`).join('\n')}
</ul>
<p>${d.tests.tamper} of the ${d.tests.total} tests tamper with data like this and assert that the tool catches it.</p>
</div>`;

  const c = d.constants;
  out['method'] = `${ladder(d.presets)}
<p class="caption">Each tick is a ring at its real radius. Tick height is the number of points on that ring, from ${Math.min(...d.presets.flatMap((p) => p.pointsPerRing))} to ${Math.max(...d.presets.flatMap((p) => p.pointsPerRing))}. Rings crowd near the business because that is where visibility changes.</p>
<div class="method-grid">
<div>
<h3>Pinned constants</h3>
<dl class="pins">
<div><dt>ring growth</dt><dd>${c.growth}</dd></div>
<div><dt>golden angle, rad</dt><dd>${c.goldenAngle}</dd></div>
<div><dt>km per degree of latitude</dt><dd>${c.kmPerDegLat}</dd></div>
<div><dt>km per degree of longitude at the equator</dt><dd>${c.kmPerDegLngEquator}</dd></div>
</dl>
<p class="caption">They are recorded in every snapshot. The audit replays with the values the snapshot recorded, and two snapshots compare only if their pins match.</p>
</div>
<div>
<h3>Presets</h3>
<div class="scroll" tabindex="0" role="region" aria-label="Presets table">
<table>
<thead><tr><th scope="col">preset</th><th scope="col">reach</th><th scope="col">points</th><th scope="col">rings</th><th scope="col">for</th></tr></thead>
<tbody>
${d.presets.map((p) => `<tr><th scope="row">${esc(p.name)}</th><td>${p.rmin}-${p.rmax} km</td><td>${p.budget}</td><td>${p.radii.length}</td><td class="words">${esc(p.use)}</td></tr>`).join('\n')}
</tbody>
</table>
</div>
</div>
</div>`;

  const code = (text) => `<div class="code"><pre tabindex="0"><code>${esc(text)}</code></pre><button type="button" class="copy" data-copy="${esc(text)}">Copy</button></div>`;
  out['install'] = d.npm.published
    ? `<p>${esc(nodeWords(d.node))}. No dependencies. Version ${esc(d.npm.version)} was on npm when this page was built (${esc(d.npm.checked)}).</p>
${code('npm install falloff')}`
    : `<p><strong>The npm package is not published yet.</strong> ${d.npm.checked ? `Checked ${esc(d.npm.checked)}: <code>${esc(d.npm.command)}</code> returned ${esc(d.npm.result)}.` : 'The registry could not be reached when this page was built.'} Until it is, run it from a clone. ${esc(nodeWords(d.node))}, no dependencies.</p>
${code(`${clone}\ncd falloff\nnpm test\nfalloff() { node bin/falloff.mjs "$@"; }`)}
<p class="caption">The last line defines the command for your shell session, so the examples below run as written from the repository root. It is a POSIX shell function; in PowerShell, cmd or anywhere else, run every example as <code>node bin/falloff.mjs &lt;args&gt;</code>.</p>`;

  return out;
}

/** ">=20" as words. Anything else is printed as it is written in package.json. */
function nodeWords(range) {
  const m = /^>=\s*(\d+)$/.exec(range);
  return m ? `Node ${m[1]} or later` : `Node ${range}`;
}

/** Replace every <!-- gen:x -->...<!-- /gen:x --> block. Refuses a template with a missing or repeated marker. */
export function inject(html, parts) {
  let out = html;
  for (const [name, body] of Object.entries(parts)) {
    const a = `<!-- gen:${name} -->`;
    const b = `<!-- /gen:${name} -->`;
    if (out.split(a).length !== 2 || out.split(b).length !== 2) throw new Error(`docs/method.html must contain exactly one ${a} ... ${b}`);
    const i = out.indexOf(a) + a.length;
    out = `${out.slice(0, i)}\n${body}\n${out.slice(out.indexOf(b))}`;
  }
  return out;
}

/** Everything that should be on disk, as { path: text }. */
export async function build(npm = recordedNpm()) {
  const data = await buildData(npm);
  const files = { [DATA_FILE]: dataJs(data) };
  files[INDEX_FILE] = inject(readFileSync(INDEX_FILE, 'utf8'), { defs: HATCH_DEFS, ...blocks(data) });
  for (const s of data.studies) files[join(REPORTS, `${s.folder}.html`)] = readFileSync(join(ROOT, 'studies', s.folder, 'report.html'), 'utf8');
  return { data, files };
}

/** Report copies in docs/studies/ that no study accounts for. */
export function staleReports(files) {
  if (!existsSync(REPORTS)) return [];
  return readdirSync(REPORTS).map((f) => join(REPORTS, f)).filter((f) => !(f in files));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check');
  const offline = check || process.argv.includes('--offline');
  const npm = (offline ? null : askNpm()) ?? recordedNpm();
  const { data, files } = await build(npm);
  if (check) {
    const stale = Object.entries(files).filter(([f, text]) => !existsSync(f) || readFileSync(f, 'utf8') !== text).map(([f]) => f);
    stale.push(...staleReports(files));
    console.log(stale.length ? `stale: ${stale.join(', ')}\nRun: node scripts/build-docs-data.mjs --offline` : `docs are current (${data.studies.length} studies)`);
    process.exit(stale.length ? 1 : 0);
  }
  mkdirSync(REPORTS, { recursive: true });
  for (const f of staleReports(files)) rmSync(f);
  for (const [f, text] of Object.entries(files)) writeFileSync(f, text);
  console.log(`docs/data.js: ${data.studies.length} studies, hero ${data.hero}`);
  console.log(`npm: ${data.npm.published ? `published ${data.npm.version}` : 'not published'} (${data.npm.command}: ${data.npm.result}${data.npm.checked ? `, ${data.npm.checked}` : ''})`);
  console.log(`docs/studies: ${data.studies.length} reports copied; docs/method.html: generated blocks written`);
}
