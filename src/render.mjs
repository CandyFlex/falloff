/**
 * render.mjs: a snapshot as one standalone HTML page.
 *
 * Pure: a snapshot and its audit result in, a string out. No scripts in the
 * page, no external requests, inline CSS with light and dark from
 * `prefers-color-scheme` (the only link element is an empty inline icon, so
 * a browser does not go looking for a favicon). It can be attached to an email or committed next
 * to the snapshot and it will read the same in ten years.
 *
 * THE RULES THE PAGE KEEPS.
 *
 *   - No figure is computed here. Every number on the page comes from
 *     `summarise()` on the readings or from the audit result passed in. The
 *     renderer formats; it does not measure.
 *   - Every figure is printed with its denominator (`37/80 measured`) and the
 *     unreached count beside it. A figure that cannot be reported says
 *     "not reportable" and why, instead of showing a dash or a zero.
 *   - Found, absent and unreached never share a mark. Status is encoded by
 *     SHAPE and by colour, so the map survives greyscale printing and
 *     colour-blind readers: filled circle (found, in the top 3), hollow
 *     circle (found, below the top 3), small x (absent), hatched diamond
 *     (unreached). An unreached point is visibly a hole in the data, not a
 *     pale version of "absent".
 *   - The map is drawn in kilometre space on a linear scale, so distance on
 *     the page is distance on the ground. The inner rings crowd because the
 *     geometry samples densely near the business; the ring table below the
 *     map carries the same data without the crowding.
 *   - A fragile edge is labelled fragile where it is printed.
 *   - A redacted snapshot prints "name withheld" wherever a name would be,
 *     and shows the redaction block.
 *   - Every string from the snapshot is HTML-escaped.
 */

import { FOUND, ABSENT, UNREACHED, PACK_SIZE } from './schema.mjs';
import { summarise } from './metrics.mjs';
import { audit as runAudit, verdictLine } from './audit.mjs';

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** A number for display, or 'n/a'. Never NaN, never undefined. */
const num = (v, digits = 1) => (Number.isFinite(v) ? String(+v.toFixed(digits)) : 'n/a');
const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : 'n/a');
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '0');

/** Pins and other values, verbatim. Objects as compact JSON. */
function verbatim(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function isRedacted(snap) {
  return Boolean(snap.redaction) || snap.target?.name === 'withheld';
}

/* ---------------- map ---------------- */

const SIZE = 640;
const C = SIZE / 2;
const R_MAX_PX = 276;

function pointXY(r, scale) {
  if (r.ring === 0 || r.bearing == null || !Number.isFinite(r.dKm)) return { x: C, y: C };
  const a = (r.bearing * Math.PI) / 180;
  return { x: C + r.dKm * scale * Math.sin(a), y: C - r.dKm * scale * Math.cos(a) };
}

function pointTitle(r) {
  const depth = Number.isInteger(r.listDepth) ? ` of ${r.listDepth} captured` : '';
  const what =
    r.status === FOUND
      ? `found, rank ${r.rank}${depth}`
      : r.status === ABSENT
        ? `absent: measured, not in the ${Number.isInteger(r.listDepth) ? `${r.listDepth} row(s)` : 'list'} captured here`
        : `unreached: ${r.error ?? 'no reason'}`;
  return `${r.label}: ${what}`;
}

/** One reading as one SVG element carrying data-status. */
function pointMark(r, scale, packSize) {
  const { x, y } = pointXY(r, scale);
  const X = f2(x);
  const Y = f2(y);
  const title = `<title>${esc(pointTitle(r))}</title>`;
  if (r.status === FOUND) {
    const inPack = r.rank <= packSize;
    return inPack
      ? `<circle class="pt found in-pack" data-status="found" data-rank="${esc(r.rank)}" cx="${X}" cy="${Y}" r="4.6">${title}</circle>`
      : `<circle class="pt found out-pack" data-status="found" data-rank="${esc(r.rank)}" cx="${X}" cy="${Y}" r="4">${title}</circle>`;
  }
  if (r.status === ABSENT) {
    const d = 3;
    return `<path class="pt absent" data-status="absent" d="M${f2(x - d)} ${f2(y - d)}L${f2(x + d)} ${f2(y + d)}M${f2(x - d)} ${f2(y + d)}L${f2(x + d)} ${f2(y - d)}">${title}</path>`;
  }
  const d = 5.5;
  return `<path class="pt unreached" data-status="unreached" d="M${X} ${f2(y - d)}L${f2(x + d)} ${Y}L${X} ${f2(y + d)}L${f2(x - d)} ${Y}Z">${title}</path>`;
}

function mapSvg(snap, packSize) {
  const readings = snap.readings ?? [];
  const radii = [...new Set(readings.filter((r) => r.ring > 0 && Number.isFinite(r.dKm)).map((r) => r.dKm))].sort((a, b) => a - b);
  const rmax = Math.max(snap.method?.rmax ?? 0, ...radii, 1);
  const scale = R_MAX_PX / rmax;

  const rings = radii
    .map((km, i) => {
      const rpx = km * scale;
      // Labels alternate above and below the centre so neighbours do not collide.
      const above = i % 2 === 0;
      const ly = above ? C - rpx - 3 : C + rpx + 11;
      return (
        `<circle class="ring" cx="${C}" cy="${C}" r="${f2(rpx)}"/>` +
        `<text class="ring-label" x="${C}" y="${f2(ly)}" text-anchor="middle">${esc(num(km))} km</text>`
      );
    })
    .join('');

  // Draw absences first and sightings last, so a sighting is never hidden.
  const order = { [ABSENT]: 0, [UNREACHED]: 1, [FOUND]: 2 };
  const marks = [...readings]
    .sort((a, b) => (order[a.status] ?? 0) - (order[b.status] ?? 0))
    .map((r) => pointMark(r, scale, packSize))
    .join('');

  const who = isRedacted(snap) ? 'a business (name withheld)' : snap.target?.name;
  const label = `Map of ${readings.length} sample points around ${who} for the query ${snap.query}. North is up. Rings are distances in km.`;

  return `<svg class="map" viewBox="0 0 ${SIZE} ${SIZE}" role="img" aria-label="${esc(label)}">
<defs><pattern id="hatch" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="hatch-bg" width="3" height="3"/><line class="hatch-line" x1="0" y1="0" x2="0" y2="3"/></pattern></defs>
<g class="rings">${rings}</g>
<g class="north"><path d="M${C} 14L${C - 5} 26L${C + 5} 26Z"/><text x="${C + 10}" y="25">N</text></g>
<g class="home"><circle cx="${C}" cy="${C}" r="9"/><path d="M${C - 13} ${C}H${C - 9}M${C + 9} ${C}H${C + 13}M${C} ${C - 13}V${C - 9}M${C} ${C + 9}V${C + 13}"/></g>
<g class="points">${marks}</g>
</svg>`;
}

function legend(packSize) {
  const item = (svg, text) => `<li><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${svg}</svg><span>${esc(text)}</span></li>`;
  return `<ul class="legend">
${item('<circle class="pt found in-pack" cx="8" cy="8" r="4.6"/>', `found, in the top ${packSize}`)}
${item('<circle class="pt found out-pack" cx="8" cy="8" r="4"/>', `found, below the top ${packSize}`)}
${item('<path class="pt absent" d="M5 5L11 11M5 11L11 5"/>', 'absent: measured, not in the captured list')}
${item('<path class="pt unreached" d="M8 2.5L13.5 8L8 13.5L2.5 8Z"/>', 'unreached: not measured')}
${item('<g class="home"><circle cx="8" cy="8" r="5"/></g>', 'ring around the home point')}
</ul>`;
}

/* ---------------- figures ---------------- */

function figures(s, preset) {
  const v = s.visibility;
  const p = s.pack;
  const un = (n) => `${n} unreached, excluded`;
  const rows = [];

  rows.push([
    'visible',
    v.measured ? `${v.found}/${v.measured} measured` : 'not reportable: no point was measured',
    v.measured
      ? `${pct(v.share)} of the sample points on preset ${preset ?? 'unrecorded'}; not comparable with a scan on another preset (${un(v.unreached)})`
      : un(v.unreached),
  ]);
  rows.push([
    `in the top ${p.packSize}`,
    p.measured ? `${p.inPack}/${p.measured} measured` : 'not reportable: no point was measured',
    p.measured
      ? `${pct(p.share)} of the sample points on preset ${preset ?? 'unrecorded'}; not comparable with a scan on another preset`
      : un(p.unreached),
  ]);

  const edgeRow = (name, e, why, beyond) => {
    if (!e) {
      const note = beyond?.length
        ? `rings at ${beyond.join(', ')} km do meet the threshold, but not in an unbroken run out from the centre`
        : '';
      return [name, `not reportable: ${why}`, note];
    }
    const value = `${e.censored ? 'at least ' : ''}${num(e.dKm)} km${e.fragile ? ' [fragile]' : ''}`;
    const notes = [`${e.hits}/${e.measured} measured on that ring, needs ${e.need}`];
    if (e.censored) notes.push('this is the outermost ring scanned, so the scan cannot say how much further it reaches');
    if (e.fragile) notes.push(`a re-scan could move this edge: ${e.note}`);
    if (e.nonMonotonic) notes.push(`rings further out also meet the threshold (${e.qualifyingRingsBeyond.join(', ')} km)`);
    return [name, value, notes.join('. ')];
  };
  rows.push(
    edgeRow(
      'reach edge',
      s.reachEdge,
      'no reportable ring has the business at half or more of its measured points, counting out from the centre',
      s.reachQualifyingRingsKm,
    ),
  );
  rows.push(
    edgeRow(
      'top-3 edge',
      s.packEdge,
      'no reportable ring has the business in the top 3 at half or more of its measured points, counting out from the centre',
      s.packQualifyingRingsKm,
    ),
  );

  rows.push(
    s.goneBy
      ? ['gone by', `${num(s.goneBy.dKm)} km`, `0/${s.goneBy.measured} measured on that ring, and no reportable ring beyond it has a sighting`]
      : [
          'gone by',
          s.nonMonotonic
            ? 'not reportable: sightings resume further out'
            : 'not reportable: no reportable ring inside the scan has zero sightings',
          s.nonMonotonic ? `sightings resume at ${s.resumesAtKm.join(', ')} km, so there is no distance past which the business stops` : '',
        ],
  );
  const c = s.archetype?.counts;
  rows.push(
    s.archetype?.reliable
      ? [
          'shape',
          s.archetype.archetype,
          `inner ring ${c.inner.found}/${c.inner.measured} at ${num(c.inner.dKm)} km, middle ${c.mid.found}/${c.mid.measured} at ${num(c.mid.dKm)} km, outer ${c.outer.found}/${c.outer.measured} at ${num(c.outer.dKm)} km, over ${s.archetype.rings} reportable rings. A descriptive label for the curve, not a diagnosis`,
        ]
      : ['shape', `not reportable: ${s.archetype?.note ?? 'too few reportable rings'}`, ''],
  );

  return `<table class="figures"><tbody>
${rows.map(([k, val, note]) => `<tr><th scope="row">${esc(k)}</th><td class="val">${esc(val)}</td><td class="note">${esc(note)}</td></tr>`).join('\n')}
</tbody></table>`;
}

function ringTable(s) {
  const W = 120;
  const rows = s.rings.map((r) => {
    const share = Number.isFinite(r.visibleShare) ? r.visibleShare : 0;
    const bar = `<svg class="bar" viewBox="0 0 ${W} 10" width="${W}" height="10" role="img" aria-label="${esc(r.measured ? `${r.found} of ${r.measured}` : 'nothing measured')}"><rect class="bar-bg" x="0" y="0" width="${W}" height="10"/><rect class="bar-fg" x="0" y="0" width="${f2(share * W)}" height="10"/></svg>`;
    return `<tr><th scope="row">${r.ring === 0 ? 'home' : `${esc(num(r.dKm))} km`}</th><td>${r.found}/${r.measured}</td><td>${r.inPack}/${r.measured}</td><td>${r.unreached}</td><td>${bar}</td><td class="note">${esc(r.note ?? '')}</td></tr>`;
  });
  return `<table class="rings-table">
<thead><tr><th scope="col">ring</th><th scope="col">found / measured</th><th scope="col">in top 3 / measured</th><th scope="col">unreached</th><th scope="col">share found</th><th scope="col">reportable</th></tr></thead>
<tbody>
${rows.join('\n')}
</tbody></table>`;
}

function auditBlock(a) {
  const items = a.findings.length
    ? a.findings
        .map((f) => `<li><span class="lvl ${f.level === 'CRITICAL' ? 'crit' : 'warn'}">${f.level === 'CRITICAL' ? 'FAIL' : 'WARN'}</span> <span class="fid">${esc(f.id)}</span> ${esc(f.message)}${f.detail ? ` (${esc(f.detail)})` : ''}</li>`)
        .join('\n')
    : '<li>no findings</li>';
  return `<ul class="findings">
${items}
</ul>
<p class="verdict ${a.ok ? 'pass' : 'fail'}">${esc(verdictLine(a))}</p>
<p class="caption">A pass means the file is internally consistent: the geometry replays from the pins it records, every planned point has exactly one reading, and the ranks agree with the lists that were captured. It is not a certificate that the readings are true. See "what the audit cannot know" in the README.</p>`;
}

function kvTable(obj, cls) {
  const rows = Object.entries(obj ?? {}).map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(verbatim(v))}</td></tr>`);
  return `<table class="kv ${cls}"><tbody>
${rows.join('\n')}
</tbody></table>`;
}

/* ---------------- page ---------------- */

const CSS = `
:root{--bg:#f7f6f2;--panel:#ffffff;--ink:#16181a;--muted:#5b6166;--line:#d5d3cb;--accent:#0b6b57;--crit:#a3261c;--warn:#7a5200;--hatch:#16181a}
@media (prefers-color-scheme: dark){:root{--bg:#101214;--panel:#181b1e;--ink:#eceae4;--muted:#a3a9ae;--line:#33383d;--accent:#4fd1b0;--crit:#ff8d80;--warn:#f0c060;--hatch:#eceae4}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:920px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:1.6rem;line-height:1.2;margin:0 0 4px}
h2{font-size:1.05rem;margin:40px 0 12px;padding-top:16px;border-top:1px solid var(--line)}
p{margin:0 0 12px}
.meta,.note,.caption{color:var(--muted);font-size:.9rem}
code,pre,.fid,.lvl{font-family:ui-monospace,"Cascadia Mono","SF Mono",Consolas,monospace}
.val,td,.ring-label{font-variant-numeric:tabular-nums}
table{border-collapse:collapse;width:100%;font-size:.9rem}
th,td{text-align:left;padding:6px 10px 6px 0;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600}
.rings-table th[scope=row]{white-space:nowrap}
.sub{margin:20px 0 4px;font-weight:600;color:var(--ink)}
.figures th{width:11rem}
.figures .val{white-space:nowrap;font-weight:600}
.scroll{overflow-x:auto}
.map{display:block;width:100%;max-width:640px;height:auto;aspect-ratio:1/1;background:var(--panel);border:1px solid var(--line)}
.ring{fill:none;stroke:var(--line);stroke-width:1}
.ring-label{font-size:10px;fill:var(--muted);paint-order:stroke;stroke:var(--panel);stroke-width:3px}
.north path{fill:var(--muted)}.north text{font-size:11px;fill:var(--muted)}
.home circle{fill:none;stroke:var(--ink);stroke-width:1.2}.home path{stroke:var(--ink);stroke-width:1.2}
.pt.found.in-pack{fill:var(--accent);stroke:var(--panel);stroke-width:1}
.pt.found.out-pack{fill:var(--panel);stroke:var(--accent);stroke-width:1.8}
.pt.absent{fill:none;stroke:var(--muted);stroke-width:1.4;stroke-linecap:round}
.pt.unreached{fill:url(#hatch);stroke:var(--ink);stroke-width:1.2}
.hatch-bg{fill:var(--panel)}.hatch-line{stroke:var(--hatch);stroke-width:1.2}
.legend{list-style:none;display:flex;flex-wrap:wrap;gap:6px 20px;padding:0;margin:12px 0 0;font-size:.9rem}
.legend li{display:flex;align-items:center;gap:6px}
.bar{display:block}.bar-bg{fill:var(--line)}.bar-fg{fill:var(--accent)}
.findings{list-style:none;padding:0;margin:0 0 12px;font-size:.9rem}
.findings li{padding:4px 0;border-bottom:1px solid var(--line)}
.lvl{font-weight:700}.lvl.crit{color:var(--crit)}.lvl.warn{color:var(--warn)}
.verdict{font-weight:700;font-family:ui-monospace,Consolas,monospace}
.verdict.pass{color:var(--accent)}.verdict.fail{color:var(--crit)}
.banner{border:1px solid var(--crit);color:var(--crit);padding:10px 12px;margin:16px 0;font-weight:600}
.kv th{width:14rem;font-weight:400;color:var(--muted)}
.kv td{word-break:break-word}
pre{background:var(--panel);border:1px solid var(--line);padding:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;font-size:.9rem;margin:0}
`;

/**
 * Render a snapshot.
 * @param {object} snap          a falloff/snapshot@1
 * @param {object} [auditResult] the result of audit(snap); computed if omitted
 * @returns {string} a complete HTML document
 */
export function renderReport(snap, auditResult) {
  if (!snap || !Array.isArray(snap.readings)) throw new Error('render: not a snapshot (no readings array)');
  const a = auditResult ?? runAudit(snap);
  const packSize = snap.method?.packSize ?? PACK_SIZE;
  const s = summarise(snap.readings, packSize);
  const m = snap.method ?? {};
  const depth = m.observation?.listDepth ?? null;
  const redacted = isRedacted(snap);
  const name = redacted ? 'name withheld' : snap.target?.name ?? 'unnamed';
  const observed = String(snap.startedAt ?? '').slice(0, 10) || 'date not recorded';
  const provider = `${snap.provider?.id ?? 'unknown provider'}${snap.provider?.version ? ` (${snap.provider.version})` : ''}`;

  const pins = [
    `preset ${verbatim(m.preset)}`,
    `${verbatim(m.rmin)}-${verbatim(m.rmax)} km`,
    `${verbatim(m.rings)} rings`,
    `${verbatim(m.budget)} points`,
    `top ${verbatim(m.packSize)}`,
    `growth ${verbatim(m.growth)}`,
    `golden angle ${verbatim(m.goldenAngle)}`,
    `${verbatim(m.kmPerDegLat ?? 'default')} km per degree of latitude`,
  ].join(', ');

  const title = `${name}: "${snap.query}", observed ${observed}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="icon" href="data:,">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header>
<h1>${esc(name)}</h1>
<p class="meta">query "${esc(snap.query)}", observed ${esc(observed)}, via ${esc(provider)}</p>
<p class="meta">${esc(pins)}</p>
${
    snap.redaction
      ? `<p class="meta">Business name withheld, and every id hashed with a salt that is not published. The centre is rounded to 0.01 degrees, about 1 km, and the sample points are recomputed from it, so the geometry still replays; the scan was observed at the true coordinates. ${esc(snap.redaction.warning ?? '')}</p>`
      : redacted
        ? '<p class="meta">Business name withheld. This file carries no redaction block, so nothing else was changed.</p>'
        : ''
  }
${a.ok ? '' : '<p class="banner">This snapshot does not pass audit. The figures below are not publishable.</p>'}
</header>

<section aria-labelledby="h-fig">
<h2 id="h-fig">Figures</h2>
<div class="scroll">${figures(s, m.preset)}</div>
<p class="caption">Unreached points were never measured. They are left out of every denominator and counted beside it.</p>
<p class="caption">${depth ? `Absent means the business was not in the list captured at that point. Those lists held between ${esc(depth.min)} and ${esc(depth.max)} rows.` : 'Absent means the point was measured and the business was not seen there. This snapshot records no capture depth.'}</p>
</section>

<section aria-labelledby="h-map">
<h2 id="h-map">Map</h2>
${mapSvg(snap, packSize)}
${legend(packSize)}
<p class="caption">Linear scale in km, north up, outer ring ${esc(num(m.rmax))} km. Hover a point for its label, status and rank.</p>
</section>

<section aria-labelledby="h-rings">
<h2 id="h-rings">By ring</h2>
<div class="scroll">${ringTable(s)}</div>
</section>

<section aria-labelledby="h-audit">
<h2 id="h-audit">Audit</h2>
${auditBlock(a)}
</section>

<section aria-labelledby="h-method">
<h2 id="h-method">Method</h2>
<p class="caption">Every pin, verbatim from the snapshot. Two snapshots are comparable only if these match.</p>
<div class="scroll">${kvTable(m, 'method')}</div>
${snap.provider?.pins ? `<p class="caption sub">Provider pins</p><div class="scroll">${kvTable(snap.provider.pins, 'provider-pins')}</div>` : ''}
${snap.provenance ? `<p class="caption sub">Provenance</p><div class="scroll">${kvTable(snap.provenance, 'provenance')}</div>` : ''}
${snap.redaction ? `<p class="caption sub">Redaction</p><div class="scroll">${kvTable(snap.redaction, 'redaction')}</div>` : ''}
</section>

<section aria-labelledby="h-repro">
<h2 id="h-repro">Reproduce</h2>
<pre>${esc(snap.command ?? 'no command recorded')}</pre>
</section>
</main>
</body>
</html>
`;
}
