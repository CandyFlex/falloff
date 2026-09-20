// common.mjs: shared by the landing page and the case study.
export const $ = (s) => document.querySelector(s);
export const mi = (km) => (km * 0.621371).toFixed(km < 16 ? 1 : 0);
export const dist = (km) => `${km} km (${mi(km)} mi)`;
export const edgeKm = (s) => s.metrics.reachEdge?.dKm ?? null;
export const vis = (s) => `${s.metrics.visibility.found} of ${s.metrics.visibility.measured}`;
export const name = (r) => (r.isTarget ? 'The business we checked' : 'Competitor ' + Number(r.label.replace('Business ', '')));

export function chrome() {
  $('.theme').addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('falloff-theme', root.dataset.theme); } catch {}
  });
  const { install } = window.FALLOFF_SITE;
  document.querySelectorAll('[data-install]').forEach((b) => { b.dataset.copy = install.command; b.querySelector('code').textContent = install.command; });
  document.querySelectorAll('[data-f=install-note]').forEach((n) => { n.textContent = install.note; });
  document.querySelectorAll('[data-install]').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); b.querySelector('.copied').textContent = 'Copied'; setTimeout(() => { b.querySelector('.copied').textContent = ''; }, 1600); } catch {}
  }));
}
