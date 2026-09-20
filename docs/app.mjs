/**
 * app.mjs: the page's behaviour. Everything here is optional.
 *
 * The page is complete as served: every figure is already in the HTML. This
 * module adds the theme toggle, the copy buttons, a live recompute of the
 * hero figures from data.js, and the lab. If data.js or the library fails
 * to load, the static figures stay and the page says which ones they are.
 */

const root = document.documentElement;

/* ---------------- theme ---------------- */

// One pattern, not two. The label stays "Dark mode" and `aria-pressed` says
// whether it is on; a label that flips to "Light" while aria-pressed also
// flips has a screen reader announcing "Light, pressed", which is the
// opposite of what is on screen.
const themeBtn = document.getElementById('theme');
const dark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
function labelTheme() {
  themeBtn.setAttribute('aria-pressed', String(dark()));
}
themeBtn.addEventListener('click', () => {
  root.dataset.theme = dark() ? 'light' : 'dark';
  try {
    localStorage.setItem('falloff-theme', root.dataset.theme);
  } catch {
    /* private mode or blocked storage: the choice lasts for this view */
  }
  labelTheme();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', labelTheme);
labelTheme();

/* ---------------- copy ---------------- */

// The result is announced in a live region rather than written over the
// button's own label, so it reaches a screen reader and does not depend on
// the button still being on screen.
const say = document.getElementById('copy-status');
for (const el of document.querySelectorAll('button[data-copy]')) {
  el.addEventListener('click', async () => {
    const was = el.textContent;
    let msg;
    try {
      await navigator.clipboard.writeText(el.dataset.copy);
      msg = 'Copied to the clipboard.';
      el.textContent = 'Copied';
    } catch {
      msg = 'The clipboard is not available. Select the command above instead.';
      el.textContent = 'Select it above';
    }
    if (say) say.textContent = msg;
    setTimeout(() => {
      el.textContent = was;
      if (say) say.textContent = '';
    }, 2500);
  });
}

/* ---------------- data, hero recompute, lab ---------------- */

const status = document.getElementById('hero-status');

try {
  const [{ DATA }, fig] = await Promise.all([import('./data.js'), import('./figures.mjs')]);

  // The hero figures again, this time computed here from the readings.
  const hero = DATA.studies.find((s) => s.folder === DATA.hero);
  const readings = hero.points.map(fig.decodePoint);
  const live = fig.readoutHtml(fig.readoutRows(fig.summarise(readings, hero.packSize)));
  const built = fig.readoutHtml(fig.readoutRows(hero.summary));
  document.getElementById('hero-readout').innerHTML = live;
  status.textContent =
    live === built
      ? `Recomputed in this browser from ${readings.length} readings by the library in docs/lib. Same figures as the build.`
      : `Recomputed in this browser from ${readings.length} readings. These differ from the build, so trust these and rebuild the page.`;

  // The lab.
  const u = document.getElementById('lab-unreached');
  const r = document.getElementById('lab-radius');
  const uOut = document.getElementById('lab-unreached-out');
  const rOut = document.getElementById('lab-radius-out');
  const plot = document.getElementById('lab-plot');
  const out = document.getElementById('lab-out');
  const total = DATA.lab.start.total;
  let turn = 0;

  async function run() {
    const mine = ++turn;
    const params = { unreached: Number(u.value), radiusKm: Number(r.value) };
    uOut.textContent = `${params.unreached} of ${total}`;
    rOut.textContent = `${params.radiusKm} km`;
    const res = await fig.runLab(params);
    if (mine !== turn) return; // a newer input won
    plot.innerHTML = fig.ringPlot({ points: res.points, radii: res.radii, packSize: res.packSize, variant: 'lab', id: 'lab-plot-svg', title: 'Ring map of the constructed scan', desc: fig.sentence(res.summary) });
    out.innerHTML = fig.labReadout(res);
  }
  u.addEventListener('input', run);
  r.addEventListener('input', run);
  root.classList.add('lab-live');
} catch (err) {
  status.textContent = 'The data or the library did not load, so these are the figures computed when the page was built.';
  console.warn('falloff page: live figures unavailable', err);
}
