/**
 * figures.mjs: every diagram on the showcase page, as pure string renderers.
 *
 * Two callers use this file and they must agree, which is why it is one file:
 *
 *   - scripts/build-docs-data.mjs renders the static page at build time, so
 *     the first paint has every figure and nothing shifts;
 *   - app.mjs re-renders the lab in the browser when a control moves.
 *
 * Nothing here measures anything. Counts, shares and edges come from
 * docs/lib (the byte-for-byte copy of src/). This file only draws them.
 *
 * MARKS. Status is encoded by shape as well as colour, the same encoding
 * src/render.mjs uses in the standalone reports:
 *
 *   filled circle     found, in the top 3
 *   hollow circle     found, below the top 3
 *   small x           absent: measured, not in the captured list
 *   hatched diamond   unreached: not measured
 *
 * An unreached point is visibly a hole in the data, never a pale absence.
 *
 * PROJECTION. The big ring plots use true bearing and a log distance axis.
 * The ring ladder is geometric, so a log axis spaces the rings almost evenly
 * and the near rings do not collapse into a bullseye. The captions say so.
 */
import { scan, samplePlan, audit, formatAudit, summarise, FOUND, ABSENT, UNREACHED, PACK_SIZE } from './lib/index.mjs';
import { haversineKm } from './lib/providers/osm.mjs';

export const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : 'n/a');
const n1 = (v) => String(+Number(v).toFixed(1));
const f1 = (v) => (Number.isFinite(v) ? String(+v.toFixed(1)) : '0');

/* ---------------- marks ---------------- */

/** One mark, drawn at the origin. The caller translates it into place. */
export function mark(status, inPack) {
  if (status === FOUND) {
    return inPack ? '<circle class="m found in-pack" r="7"/>' : '<circle class="m found out-pack" r="6"/>';
  }
  if (status === ABSENT) return '<path class="m absent" d="M-4.5 -4.5L4.5 4.5M-4.5 4.5L4.5 -4.5"/>';
  return '<path class="m unreached" fill="url(#hatch)" d="M0 -8.5L8.5 0L0 8.5L-8.5 0Z"/>';
}

/** The hatch the unreached diamond is filled with. One copy per document. */
export const HATCH_DEFS =
  '<svg class="defs" width="0" height="0" aria-hidden="true" focusable="false"><defs>' +
  '<pattern id="hatch" width="3.2" height="3.2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
  '<rect class="hatch-bg" width="3.2" height="3.2"/><line class="hatch-line" x1="0" y1="0" x2="0" y2="3.2"/>' +
  '</pattern></defs></svg>';

/** The legend, as HTML so it reflows. */
export function legend(packSize = PACK_SIZE) {
  const item = (status, inPack, text) =>
    `<li><svg viewBox="-10 -10 20 20" width="18" height="18" aria-hidden="true">${mark(status, inPack)}</svg><span>${esc(text)}</span></li>`;
  return `<ul class="legend">
${item(FOUND, true, `found, in the top ${packSize}`)}
${item(FOUND, false, `found, below the top ${packSize}`)}
${item(ABSENT, false, 'absent: measured, not in the captured list')}
${item(UNREACHED, false, 'unreached: not measured')}
</ul>`;
}

/* ---------------- ring plot ---------------- */

const R0 = 64; // px radius of the innermost ring
const R1 = 338; // px radius of the outermost ring
const HALF = 384;

/**
 * How far inside its ring a distance label sits.
 *
 * Centred on the ring, a label reads as struck through: the stroke runs
 * through the middle of the digits, and a knockout behind the text only
 * thins the line rather than removing it. Pulled into the gap between rings
 * there is nothing behind it to cross out. Inward rather than outward, so
 * the outermost label does not land on the north marker.
 */
const LABEL_INSET = 17;

function describe(p) {
  const where = p.ring === 0 ? 'home' : `${p.label} (${p.bearing} deg)`;
  if (p.status === FOUND) return `${where}: found, rank ${p.rank}`;
  if (p.status === ABSENT) return `${where}: absent, measured and not in the list captured here`;
  return `${where}: unreached, ${p.error ?? 'no reason recorded'}`;
}

/**
 * A ring plot of one scan.
 *
 * @param {object} o
 * @param {Array}  o.points   [{ ring, dKm, bearing, status, rank, label, error? }]
 * @param {number[]} o.radii  ring radii in km, inner to outer
 * @param {number} o.packSize
 * @param {string} o.variant  'hero' | 'lab' | 'mini'
 * @param {string} o.id       unique prefix for title and desc ids
 * @param {string} o.title    accessible name
 * @param {string} [o.desc]   accessible description
 */
export function ringPlot({ points, radii, packSize = PACK_SIZE, variant = 'hero', id, title, desc }) {
  const rmin = radii[0];
  const rmax = radii[radii.length - 1];
  const px = (d) => (d <= 0 ? 0 : R0 + (R1 - R0) * (Math.log(d / rmin) / Math.log(rmax / rmin)));
  const mini = variant === 'mini';
  const order = { [ABSENT]: 0, [UNREACHED]: 1, [FOUND]: 2 };

  const groups = [];
  const labels = [];
  for (let k = 0; k <= radii.length; k++) {
    const onRing = points.filter((p) => p.ring === k);
    const r = k === 0 ? 0 : px(radii[k - 1]);
    // Sightings are drawn last on each ring so an absence never hides one.
    const drawn = [...onRing].sort((a, b) => (order[a.status] ?? 0) - (order[b.status] ?? 0));
    const step = onRing.length ? 170 / onRing.length : 0;
    const marks = drawn
      .map((p) => {
        const a = ((p.bearing ?? 0) * Math.PI) / 180;
        const x = r * Math.sin(a);
        const y = -r * Math.cos(a);
        const seq = onRing.indexOf(p);
        const t = mini ? '' : `<title>${esc(describe(p))}</title>`;
        const m = mark(p.status, p.status === FOUND && p.rank <= packSize);
        // Small multiples carry no tooltip and no animation hooks, which keeps the page light.
        if (mini) return `<g transform="translate(${Math.round(x)} ${Math.round(y)}) scale(2.3)">${m}</g>`;
        return `<g transform="translate(${f1(x)} ${f1(y)})"><g class="pt" data-status="${esc(p.status)}"${variant === 'hero' ? ` style="--j:${Math.round(seq * step)}"` : ''}>${m}${t}</g></g>`;
      })
      .join('');
    const circle = k === 0 ? '' : `<circle class="ring" r="${f1(r)}"/>`;
    groups.push(`<g class="ring-g" style="--i:${k}">${circle}${marks}</g>`);

    if (k > 0 && !mini) {
      // Each label sits on its own ring, in the gap between two points that
      // is nearest north. The golden-angle stagger leaves no straight axis
      // free of points, so a column of labels would collide with them.
      const b = onRing.map((p) => p.bearing).sort((x, y) => x - y);
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < b.length; i++) {
        const next = i + 1 < b.length ? b[i + 1] : b[0] + 360;
        const mid = ((b[i] + next) / 2) % 360;
        const dist = Math.min(mid, 360 - mid);
        if (dist < bestDist) {
          bestDist = dist;
          best = mid;
        }
      }
      const a = (best * Math.PI) / 180;
      const last = k === radii.length;
      const lr = Math.max(34, r - LABEL_INSET);
      labels.push(
        `<text class="ring-label${k % 2 === 0 ? ' even' : ''}" style="--i:${k}" x="${f1(lr * Math.sin(a))}" y="${f1(-lr * Math.cos(a))}">${esc(n1(radii[k - 1]))}${last ? ' km' : ''}</text>`,
      );
    }
  }

  const north = mini ? '' : `<g class="north"><path d="M0 ${-(R1 + 8)}V${-(R1 + 20)}"/><text x="0" y="${-(R1 + 26)}">N</text></g>`;
  const home = '<g class="home"><circle r="13"/><path d="M-20 0H-13M13 0H20M0 -20V-13M0 13V20"/></g>';
  const names = desc ? `${id}-t ${id}-d` : `${id}-t`;

  return `<svg class="plot plot-${variant}" viewBox="${-HALF} ${-HALF} ${HALF * 2} ${HALF * 2}" role="img" aria-labelledby="${names}">
<title id="${id}-t">${esc(title)}</title>${desc ? `<desc id="${id}-d">${esc(desc)}</desc>` : ''}
${groups.join('\n')}
${home}
${north}
<g class="ring-labels">${labels.join('')}</g>
</svg>`;
}

/* ---------------- figures as text ---------------- */

/**
 * The six headline figures, each with its denominator. Same wording as the
 * standalone report, so the page and the report cannot disagree in tone.
 * @returns {Array<{k: string, v: string, note: string, fragile: boolean}>}
 */
export function readoutRows(s) {
  const v = s.visibility;
  const p = s.pack;
  const rows = [];
  rows.push({
    k: 'visible',
    v: v.measured ? `${v.found}/${v.measured} measured` : 'not reportable',
    note: v.measured ? `${pct(v.share)}, ${v.unreached} unreached and excluded` : `no point was measured, ${v.unreached} unreached`,
  });
  rows.push({
    k: `in the top ${p.packSize}`,
    v: p.measured ? `${p.inPack}/${p.measured} measured` : 'not reportable',
    note: p.measured ? pct(p.share) : 'no point was measured',
  });
  // "at least" when the edge is the outermost ring scanned, because the scan
  // cannot see past it, and the fragility reason rather than a bare margin.
  const edge = (k, e, why, beyond) => {
    if (!e) {
      return {
        k,
        v: 'not reportable',
        note: beyond?.length ? `${why}, counting out from the centre; rings at ${beyond.join(', ')} km do meet it` : `${why}, counting out from the centre`,
      };
    }
    const notes = [`${e.hits}/${e.measured} on that ring, needs ${e.need}`];
    if (e.censored) notes.push('the outermost ring scanned, so the true edge is at least this far');
    if (e.fragile) notes.push(`a re-scan could move this edge: ${e.note}`);
    return { k, v: `${e.censored ? 'at least ' : ''}${n1(e.dKm)} km`, note: notes.join('. '), fragile: e.fragile };
  };
  rows.push(edge('reach edge', s.reachEdge, 'no reportable ring has it at half or more of its measured points', s.reachQualifyingRingsKm));
  rows.push(edge('top-3 edge', s.packEdge, 'no reportable ring has it in the top 3 at half or more of its measured points', s.packQualifyingRingsKm));
  rows.push(
    s.goneBy
      ? { k: 'gone by', v: `${n1(s.goneBy.dKm)} km`, note: `0/${s.goneBy.measured} on that ring, and nothing beyond it` }
      : s.nonMonotonic
        ? { k: 'gone by', v: 'not reportable', note: `sightings resume at ${s.resumesAtKm.join(', ')} km, so there is no distance past which it stops` }
        : { k: 'gone by', v: 'not reportable', note: 'no reportable ring inside the scan has zero sightings' },
  );
  const c = s.archetype?.counts;
  rows.push(
    s.archetype?.reliable
      ? { k: 'shape', v: s.archetype.archetype, note: `inner ${c.inner.found}/${c.inner.measured}, middle ${c.mid.found}/${c.mid.measured}, outer ${c.outer.found}/${c.outer.measured}. A label for the curve, not a diagnosis` }
      : { k: 'shape', v: 'not reportable', note: s.archetype?.note ?? 'too few reportable rings' },
  );
  return rows.map((r) => ({ fragile: false, ...r }));
}

export function readoutHtml(rows) {
  return rows
    .map(
      (r) =>
        `<div class="row"><dt>${esc(r.k)}</dt><dd><span class="v">${esc(r.v)}</span>${r.fragile ? ' <span class="flag">fragile</span>' : ''}<span class="n">${esc(r.note)}</span></dd></div>`,
    )
    .join('\n');
}

/** One-sentence description of a scan, for a plot's <desc>. */
export function sentence(s) {
  const v = s.visibility;
  const parts = [`Found at ${v.found} of ${v.measured} measured points, ${v.unreached} unreached.`];
  if (s.reachEdge) parts.push(`Visible at most points out to ${n1(s.reachEdge.dKm)} km.`);
  if (s.goneBy) parts.push(`No sighting on the ${n1(s.goneBy.dKm)} km ring.`);
  return parts.join(' ');
}

/* ---------------- the accounting grid ---------------- */

/** Every reading of a scan as one cell, in plan order, ten to a row. */
export function accountingGrid(points, packSize, label) {
  const cols = 10;
  const rows = Math.ceil(points.length / cols);
  const cells = points
    .map((p, i) => `<g transform="translate(${10 + 20 * (i % cols)} ${10 + 20 * Math.floor(i / cols)})">${mark(p.status, p.status === FOUND && p.rank <= packSize)}</g>`)
    .join('');
  return `<svg class="acct" viewBox="0 0 ${cols * 20} ${rows * 20}" role="img" aria-label="${esc(label)}">${cells}</svg>`;
}

/* ---------------- the ring ladder ---------------- */

/**
 * Four presets on one linear distance axis. Each tick is a ring at its real
 * radius; its height is the number of points on that ring. Text lives in
 * HTML so it stays readable when the diagram is 328 px wide.
 */
export function ladder(presets) {
  const max = Math.max(...presets.map((p) => p.rmax));
  const most = Math.max(...presets.flatMap((p) => p.pointsPerRing));
  const H = 40;
  const lanes = presets
    .map((p) => {
      const ticks = p.radii
        .map((km, i) => `<line class="tick" x1="${f1((km / max) * 1000)}" x2="${f1((km / max) * 1000)}" y1="${H}" y2="${f1(H - (p.pointsPerRing[i] / most) * (H - 4))}"/>`)
        .join('');
      const label = `${p.name}: ${p.radii.length} rings at ${p.radii.map(n1).join(', ')} km, with ${p.pointsPerRing.join(', ')} points`;
      return `<div class="lane">
<p class="lane-name"><b>${esc(p.name)}</b> <span>${esc(n1(p.rmin))}-${esc(n1(p.rmax))} km, ${p.budget} points, ${p.radii.length} rings</span></p>
<svg viewBox="0 0 1000 ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}"><line class="base" x1="0" x2="1000" y1="${H}" y2="${H}"/><line class="reach" x1="${f1((p.rmin / max) * 1000)}" x2="${f1((p.rmax / max) * 1000)}" y1="${H}" y2="${H}"/>${ticks}</svg>
</div>`;
    })
    .join('\n');
  const stepKm = 20;
  const marks = [];
  for (let km = 0; km <= max; km += stepKm) marks.push(`<span style="left:${f1((km / max) * 100)}%">${km}</span>`);
  return `<div class="ladder">
${lanes}
<div class="axis" aria-hidden="true">${marks.join('')}</div>
<p class="axis-unit" aria-hidden="true">km from the business, linear scale</p>
</div>`;
}

/* ---------------- constructed scenarios ---------------- */

/** A centre for constructed scans. It is a coordinate, not a business. */
const CENTRE = { name: 'constructed scenario', id: 'constructed-target', lat: 25.81, lng: -80.2 };

/** mulberry32, so the "random" failures are the same on every run. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fixed shuffle of 0..n-1. Its first k entries are the k points that fail, so raising k only adds gaps. */
function failureOrder(n, seed = 20260919) {
  const rnd = prng(seed);
  const idx = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

function pack(snapshot, a) {
  const s = summarise(snapshot.readings, snapshot.method.packSize);
  const v = s.visibility;
  return {
    points: snapshot.readings.map((r) => ({ ring: r.ring, dKm: r.dKm, bearing: r.bearing, label: r.label, status: r.status, rank: r.rank, error: r.error })),
    radii: snapshot.method.ringRadiiKm,
    packSize: snapshot.method.packSize,
    total: snapshot.readings.length,
    summary: s,
    // What a tool prints when it files a gap under "not visible".
    merged: { found: v.found, total: snapshot.readings.length, share: v.found / snapshot.readings.length },
    audit: { ok: a.ok, counts: a.counts, text: formatAudit(a) },
  };
}

/**
 * The lab: the real scan() over a synthetic world where the answer is known.
 * The business is visible inside a disc of `radiusKm` and nowhere else;
 * `unreached` of the calls throw. Runs the library, not a model of it.
 */
export async function runLab({ unreached, radiusKm, preset = 'mid' }) {
  let call = 0;
  let failAt = new Set();
  const provider = {
    id: 'synthetic-disc',
    version: '1',
    pacingMs: 0,
    pins: { radiusKm, unreached },
    async query({ lat, lng }) {
      const i = call++;
      if (failAt.has(i)) throw new Error('injected failure');
      const d = haversineKm(CENTRE.lat, CENTRE.lng, lat, lng);
      return { results: d <= radiusKm ? [{ id: CENTRE.id, name: CENTRE.name }] : [{ id: 'someone-else', name: 'someone else' }] };
    },
  };
  // The budget is the preset's; read it from the plan so nothing is typed.
  const n = samplePlan({ lat: CENTRE.lat, lng: CENTRE.lng, preset }).points.length;
  failAt = new Set(failureOrder(n).slice(0, Math.max(0, Math.min(unreached, n))));
  const { snapshot, audit: a } = await scan({
    target: CENTRE,
    query: 'anything',
    preset,
    provider,
    command: `constructed scenario: disc ${radiusKm} km, ${unreached} calls fail`,
  });
  return pack(snapshot, a);
}

/**
 * Two scans with the same sightings. In the first every other point answered
 * and the business was not there. In the second the provider stopped
 * answering at `stopAt`, as a quota does.
 */
export async function runPair({ found, stopAt, preset = 'mid' }) {
  const one = async (failFrom) => {
    let call = 0;
    const provider = {
      id: 'synthetic-sequence',
      version: '1',
      pacingMs: 0,
      pins: { found, failFrom },
      async query() {
        const i = call++;
        if (failFrom != null && i >= failFrom) throw new Error('quota exhausted');
        return { results: i < found ? [{ id: CENTRE.id, name: CENTRE.name }] : [{ id: 'someone-else', name: 'someone else' }] };
      },
    };
    const { snapshot, audit: a } = await scan({ target: CENTRE, query: 'anything', preset, provider, command: 'constructed scenario: two scans, one number' });
    return pack(snapshot, a);
  };
  return { complete: await one(null), gapped: await one(stopAt) };
}

export { audit, summarise, FOUND, ABSENT, UNREACHED };

/* ---------------- data.js point encoding ---------------- */

const CODE = { [FOUND]: 'f', [ABSENT]: 'a', [UNREACHED]: 'u' };
const STATUS = { f: FOUND, a: ABSENT, u: UNREACHED };

/** A reading as a short array: [ring, dKm, bearing, label, status, rank, error]. Names and result lists are never included. */
export function encodePoint(r) {
  const row = [r.ring, r.dKm, r.bearing, r.label, CODE[r.status], r.rank ?? null];
  if (r.status === UNREACHED) row.push(r.error ?? null);
  return row;
}

export function decodePoint([ring, dKm, bearing, label, code, rank, error]) {
  return { ring, dKm, bearing, label, status: STATUS[code], rank: rank ?? null, error: error ?? null };
}

/* ---------------- the lab readout ---------------- */

/** The lab's right-hand column for one result of runLab(). */
export function labReadout(res) {
  const s = res.summary;
  const v = s.visibility;
  const rows = [
    {
      k: 'visible, by falloff',
      v: v.measured ? `${v.found}/${v.measured} measured` : 'not reportable',
      note: v.measured ? `${pct(v.share)}, ${v.unreached} unreached and excluded` : `no point was measured, ${v.unreached} unreached`,
    },
    {
      k: 'visible, gaps merged into absent',
      v: `${res.merged.found}/${res.merged.total} points`,
      note: `${pct(res.merged.share)}, the gaps counted as not visible`,
    },
    ...readoutRows(s).filter((r) => r.k === 'reach edge' || r.k === 'gone by'),
  ];
  return `<dl class="readout">\n${readoutHtml(rows)}\n</dl>\n<pre class="term" tabindex="0" aria-label="Audit of the constructed scan">${termHtml(res.audit.text, true)}</pre>`;
}

/**
 * Auditor output for a <pre>. FAIL and PASS are set in bold; nothing is coloured.
 * `flush` drops the CLI's two-space indent, for narrow blocks that wrap.
 */
export function termHtml(text, flush = false) {
  const body = text.replace(/^\n+|\s+$/g, '');
  return esc(flush ? body.replace(/^ {2}/gm, '') : body).replace(/^(\s*)(FAIL|PASS)\b/gm, '$1<b>$2</b>');
}
