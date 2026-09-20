// draw.mjs: the SVG drawings for the landing page and the case study. Everything is drawn from real scan data.
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};
const rad = (deg) => (deg - 90) * Math.PI / 180;
const polar = (r, deg) => [r * Math.cos(rad(deg)), r * Math.sin(rad(deg))];

function sectorPath(r0, r1, a0, a1) {
  const large = a1 - a0 > 180 ? 1 : 0;
  const [x0, y0] = polar(r1, a0), [x1, y1] = polar(r1, a1), [x2, y2] = polar(r0, a1), [x3, y3] = polar(r0, a0);
  return `M${x0.toFixed(2)},${y0.toFixed(2)}A${r1},${r1} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)}L${x2.toFixed(2)},${y2.toFixed(2)}A${r0},${r0} 0 ${large} 0 ${x3.toFixed(2)},${y3.toFixed(2)}Z`;
}

/* The iris: one cell per sample point. Rings are equal-width bands (the ladder is geometric,
   so this is a log-distance axis). Found = filled, stronger the higher the rank. Absent = open
   cell. Unreached = hatched. `points` lets the same geometry show any business in the field. */
export function iris(host, study, { points = null, gap = 1.2, labels = true, animate = false, hole = 14, size = 200, edgeKm = null } = {}) {
  const R = study.ringRadiiKm.length;
  const band = (size / 2 - hole) / R;
  const svg = el('svg', { viewBox: `${-size / 2 - (labels ? 26 : 0)} ${-size / 2} ${size + (labels ? 52 : 0)} ${size}`, role: 'img', class: 'iris' });
  const defs = el('defs', {}, svg);
  const pat = el('pattern', { id: 'hatch' + Math.random().toString(36).slice(2, 7), width: 3, height: 3, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
  el('line', { x1: 0, y1: 0, x2: 0, y2: 3, class: 'hatch-line' }, pat);
  const vals = points ?? study.readings.map((r) => (r.status === 'found' ? r.rank : r.status === 'absent' ? 0 : -1));
  study.readings.forEach((r, i) => {
    const v = vals[i];
    let node;
    if (r.ring === 0) {
      node = el('circle', { r: hole - gap, cx: 0, cy: 0 }, svg);
    } else {
      const n = study.pointsPerRing[r.ring - 1];
      const span = 360 / n, r0 = hole + (r.ring - 1) * band + gap / 2, r1 = hole + r.ring * band - gap / 2;
      const pad = (gap / ((r0 + r1) / 2)) * (180 / Math.PI) / 2;
      node = el('path', { d: sectorPath(r0, r1, r.bearing - span / 2 + pad, r.bearing + span / 2 - pad) }, svg);
    }
    node.setAttribute('data-i', String(i));
    node.setAttribute('class', 'cell ' + (v > 0 ? 'found' : v === 0 ? 'absent' : 'unreached'));
    if (v > 0) node.style.setProperty('--k', String(Math.max(0.42, 1 - (v - 1) * 0.065)));
    if (v === -1) node.setAttribute('fill', `url(#${pat.id})`);
    if (animate) node.style.setProperty('--d', `${r.ring * 140 + (r.index ?? 0) * 12}ms`);
    const t = el('title', {}, node);
    t.textContent = `${r.ring === 0 ? 'centre' : r.dKm + ' km'}: ${v > 0 ? 'found, rank ' + v : v === 0 ? 'absent' : 'unreached'}`;
  });
  if (edgeKm != null) {
    const ei = study.ringRadiiKm.indexOf(edgeKm);
    if (ei > -1) {
      const er = hole + (ei + 1) * band;
      el('circle', { r: er, cx: 0, cy: 0, class: 'edge' }, svg);
      const [tx, ty] = polar(er + 3, 315);
      const t = el('text', { x: tx, y: ty, class: 'edge-label', 'text-anchor': 'end' }, svg); t.textContent = edgeKm + ' km';
    }
  }
  if (labels) {
    study.ringRadiiKm.forEach((km, i) => {
      if (i % 2 === (R - 1) % 2) {
        const t = el('text', { x: hole + (i + 0.5) * band, y: -2, class: 'ring-label', 'text-anchor': 'middle' }, svg);
        t.textContent = km;
      }
    });
    const u = el('text', { x: size / 2 + 4, y: -2, class: 'ring-label' }, svg); u.textContent = 'km';
  }
  if (animate) svg.classList.add('draw');
  host.appendChild(svg);
  return svg;
}

/* The profile: share of measured points where the business was found, ring by ring. */
export function profile(host, studies, { w = 640, h = 260 } = {}) {
  const m = { l: 44, r: 16, t: 16, b: 34 };
  const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, role: 'img', class: 'profile' });
  const radii = studies[0].ringRadiiKm;
  const x = (i) => m.l + ((i + 1) / radii.length) * (w - m.l - m.r);
  const y = (s) => m.t + (1 - s) * (h - m.t - m.b);
  [0, 0.5, 1].forEach((s) => {
    el('line', { x1: m.l, x2: w - m.r, y1: y(s), y2: y(s), class: 'grid' }, svg);
    const t = el('text', { x: m.l - 8, y: y(s) + 4, 'text-anchor': 'end', class: 'axis' }, svg); t.textContent = Math.round(s * 100) + '%';
  });
  radii.forEach((km, i) => { const t = el('text', { x: x(i), y: h - 10, 'text-anchor': 'middle', class: 'axis' }, svg); t.textContent = km + (i === radii.length - 1 ? ' km' : ''); });
  studies.forEach((s, si) => {
    const rings = s.metrics.rings.filter((r) => r.ring > 0);
    const pts = [[m.l, y(s.metrics.rings[0].visibleShare ?? 0)], ...rings.map((r, i) => [x(i), y(r.visibleShare ?? 0)])];
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('');
    el('path', { d: d + `L${pts.at(-1)[0]},${y(0)}L${m.l},${y(0)}Z`, class: 'area s' + si }, svg);
    el('path', { d, class: 'line s' + si }, svg);
    pts.forEach((p) => el('circle', { cx: p[0], cy: p[1], r: 3, class: 'dot s' + si }, svg));
  });
  host.appendChild(svg);
  return svg;
}

export const fmt = {
  vis: (s) => `${s.metrics.visibility.found}/${s.metrics.visibility.measured}`,
  edge: (s) => (s.metrics.reachEdge ? `${s.metrics.reachEdge.censored ? '≥ ' : ''}${s.metrics.reachEdge.dKm} km` : 'none'),
  gone: (s) => (s.metrics.goneBy ? `${s.metrics.goneBy.dKm} km` : 'n/a'),
  top3: (s) => `${s.metrics.pack.inPack}/${s.metrics.pack.measured}`,
};
export const fill = (sel, text) => document.querySelectorAll(sel).forEach((n) => { n.textContent = text; });

/* The plan: only the sample points, no readings. Same log-distance axis as the iris, so an
   80-point plan and a 2,000-point plan of the same area can sit side by side. */
export function plan(host, p, { size = 200, hole = 10 } = {}) {
  const svg = el('svg', { viewBox: `${-size / 2} ${-size / 2} ${size} ${size}`, role: 'img', class: 'plan' });
  const rmin = p.method.rmin, rmax = p.method.rmax, R = size / 2 - 3;
  const dot = Math.max(0.55, Math.min(2.4, 26 / Math.sqrt(p.points.length)));
  p.points.forEach((pt) => {
    const r = pt.ring === 0 ? 0 : hole + (Math.log(pt.dKm / rmin) / Math.log(rmax / rmin)) * (R - hole);
    const [x, y] = pt.ring === 0 ? [0, 0] : polar(r, pt.bearing);
    el('circle', { cx: x.toFixed(2), cy: y.toFixed(2), r: pt.ring === 0 ? dot * 1.6 : dot, class: pt.ring === 0 ? 'home' : 'pt' }, svg);
  });
  host.appendChild(svg);
  return svg;
}
