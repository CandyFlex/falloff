// case-study.mjs: the case study page. Every figure is assembled from data.js (two real scans).
import { iris, fill } from './draw.mjs';
import { $, chrome, edgeKm, vis, name, mi, dist } from './common.mjs';

const { metro, quiet } = window.FALLOFF_SITE;
chrome();
const town = (s) => s.place.split(',')[0];

fill('[data-f=query-q]', `"${metro.query}"`);
fill('[data-f=places]', `${metro.place} and ${quiet.place}`);
fill('[data-f=points]', `${metro.readings.length} each, out to ${metro.ringRadiiKm.at(-1)} km`);
fill('[data-f=observed]', metro.observed);

// the two scans
iris($('#pl-a'), metro, { labels: false });
iris($('#pl-b'), quiet, { labels: false });
for (const [k, s] of [['m', metro], ['q', quiet]]) {
  const e = edgeKm(s);
  fill(`[data-f=${k}-place]`, s.place);
  fill(`[data-f=${k}-edge]`, e != null ? `${e} km` : 'n/a');
  fill(`[data-f=${k}-edge-mi]`, e != null ? `${mi(e)} miles of reach` : '');
  fill(`[data-f=${k}-story]`, `${s.field.length} businesses turned up on Google Maps for this search in the area. This one was shown at ${vis(s)} spots.`);
}

// one shared distance scale
{
  const max = metro.ringRadiiKm.at(-1), W = 1000, x = (km) => 8 + Math.sqrt(km / max) * (W - 16);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} 96`);
  const add = (tag, at, text) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(at)) n.setAttribute(k, v); if (text) n.textContent = text; svg.appendChild(n); return n; };
  add('line', { x1: 8, x2: W - 8, y1: 56, y2: 56, class: 'axis' });
  metro.ringRadiiKm.forEach((km, i) => { add('line', { x1: x(km), x2: x(km), y1: 50, y2: 62, class: 'tick' }); if (i % 2 === 1) add('text', { x: x(km), y: 86, class: 'tlabel', 'text-anchor': 'middle' }, `${km} km`); });
  [[quiet, 'b'], [metro, 'a']].filter(([s]) => edgeKm(s) != null).sort((p, q) => edgeKm(q[0]) - edgeKm(p[0])).forEach(([s, c]) => {
    add('line', { x1: 8, x2: x(edgeKm(s)), y1: 56, y2: 56, class: 'span ' + c });
    add('circle', { cx: x(edgeKm(s)), cy: 56, r: 8, class: 'dot ' + c });
    add('text', { x: x(edgeKm(s)), y: 30, class: 'mlabel', 'text-anchor': 'middle' }, `${town(s)}, ${edgeKm(s)} km`);
  });
  $('#ruler').appendChild(svg);
}

// how to read it, built from the ring tables
const ringLine = (s) => s.metrics.rings.filter((r) => r.ring > 0).map((r) => `${r.found} of ${r.measured} at ${r.dKm} km`).join(', ');
const top3 = (s) => `${s.metrics.pack.inPack} of the ${s.metrics.visibility.found} places it appeared`;
fill('[data-f=read-1]', `In ${town(metro)}, the business reached ${dist(edgeKm(metro))}, and it ranked in the top three at ${top3(metro)}. Ring by ring: ${ringLine(metro)}.`);
fill('[data-f=read-2]', `In ${town(quiet)}, the business carried out to ${dist(edgeKm(quiet))}, but it ranked in the top three at only ${top3(quiet)}. Ring by ring: ${ringLine(quiet)}.`);

// limits, from the scans' own flags
const frag = [metro, quiet].filter((s) => s.metrics.reachEdge?.fragile).map(town);
fill('[data-f=fragile]', frag.length
  ? `Falloff flags the reach figure for ${frag.join(' and ')} as fragile: the next ring out is close enough to the halfway mark that a second scan could move the line by one ring.`
  : 'Neither reach figure was flagged as fragile, but a second scan on another day could still move a line by one ring.');

// competitors
const host = $('#vs-iris'), list = $('#vs-list');
function draw(key) {
  const s = window.FALLOFF_SITE[key];
  const target = s.field.find((r) => r.isTarget);
  const picks = [target, ...s.field.filter((r) => !r.isTarget).slice(0, 5)].sort((p, q) => q.found - p.found);
  const top = Math.max(...picks.map((r) => r.found));
  const show = (r) => {
    host.replaceChildren(); iris(host, s, { points: r.points, labels: false });
    list.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === r.label)));
  };
  list.replaceChildren(...picks.map((r) => {
    const li = document.createElement('li'); const b = document.createElement('button');
    b.type = 'button'; b.dataset.id = r.label; if (r.isTarget) b.className = 't';
    const n = document.createElement('span'); n.className = 'who'; n.textContent = name(r);
    const bar = document.createElement('span'); bar.className = 'bar'; bar.style.setProperty('--w', String(r.found / top));
    const v = document.createElement('span'); v.className = 'val'; v.textContent = `${r.found} of ${r.measured}`;
    b.append(n, bar, v); b.addEventListener('click', () => show(r)); li.appendChild(b); return li;
  }));
  show(target);
  fill('[data-f=vs-cap]', `${s.place}: the business we checked and the 5 competitors seen most widely, out of ${s.field.length} that appeared. Each bar is how many of the ${target.measured} checkpoints that business showed up at.`);
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.place === key)));
}
document.querySelectorAll('.seg button').forEach((b) => { b.textContent = window.FALLOFF_SITE[b.dataset.place].place; b.addEventListener('click', () => draw(b.dataset.place)); });
draw('metro');

// the reports, verbatim
$('#report-a').textContent = metro.report.replace(/\s+$/, '');
$('#report-b').textContent = quiet.report.replace(/\s+$/, '');
