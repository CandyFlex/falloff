// site.mjs: the landing page. Every number and drawing comes from data.js (a real scan) or from the
// library itself (the checkpoint layouts). Copy that contains a figure is assembled here, never typed.
import { iris, plan, fill } from './draw.mjs';
import { samplePlan } from './lib/sample.mjs';
import { $, chrome, edgeKm, vis, name, mi, dist } from './common.mjs';

const { metro, quiet } = window.FALLOFF_SITE;
chrome();

// hero
iris($('#hero-iris'), metro, { animate: true, labels: false });
fill('[data-f=m-cap]', `A real scan: one ${metro.query} in ${metro.place}, searched on Google Maps from ${metro.readings.length} locations out to ${metro.ringRadiiKm.at(-1)} km on ${metro.observed}. Business name withheld.`);

// how it works: the section pins and holds on each stage; three invisible markers set the stage
const how = $('.how');
const howSvg = iris($('#how-iris'), metro, { labels: false, edgeKm: edgeKm(metro) });
howSvg.querySelectorAll('.cell').forEach((c) => { c.style.setProperty('--d', `${metro.readings[+c.dataset.i].ring * 70}ms`); });
const stageWatch = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) how.dataset.stage = e.target.dataset.stage; }), { rootMargin: '-50% 0px -50% 0px' });
document.querySelectorAll('.how-marks span').forEach((m) => stageWatch.observe(m));

// scale: layouts planned live by the library for the same area
const [rmin, rmax] = [metro.ringRadiiKm[0], metro.ringRadiiKm.at(-1)];
const labels = ['A quick read', 'A detailed map', 'Street by street'];
[{ points: 80, growth: 1.55 }, { points: 500, growth: 1.2 }, { points: 2000, growth: 1.1 }].forEach((o, i) => {
  const p = samplePlan({ lat: 25.8, lng: -80.2, rmin, rmax, points: o.points, growth: o.growth });
  const f = document.createElement('figure');
  plan(f, p);
  const spacing = (2 * Math.PI * rmax) / p.method.pointsPerRing.at(-1);
  const c = document.createElement('figcaption');
  const b = document.createElement('b'); b.textContent = `${p.points.length.toLocaleString('en-US')} checkpoints`;
  const sp = document.createElement('span'); sp.textContent = `${labels[i]}. At the outer edge, checkpoints sit about ${spacing < 10 ? spacing.toFixed(1) : Math.round(spacing)} km apart.`;
  c.append(b, sp); f.appendChild(c); $('#plans').appendChild(f);
});

// numbers you can check
fill('[data-f=m-vis]', vis(metro));
fill('[data-f=m-pct]', `${Math.round(metro.metrics.visibility.share * 100)}%`);
fill('[data-f=m-date]', metro.observed);
fill('[data-f=m-audit]', metro.auditOk ? 'Audit passed' : 'Audit failed');
fill('[data-f=m-audit-n]', `${metro.readings.length} checkpoints rechecked`);

// case study teaser
iris($('#t-a'), metro, { labels: false, gap: 1.8 });
iris($('#t-b'), quiet, { labels: false, gap: 1.8 });
