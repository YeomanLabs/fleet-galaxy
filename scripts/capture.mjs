// Renders the README screenshots and the time-machine GIF frames from the
// running dev server. Usage: npm run dev (in another terminal), then
// npm run capture. Frames are stepped by hand (?capture), so output is
// identical on every run.

import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright-core';

const url = process.env.URL ?? 'http://localhost:5175/demo/?capture';
const out = new URL('../public/shots/', import.meta.url);
const frames = new URL('../.frames/', import.meta.url);
const path = (u) => decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, '$1');

const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? 'msedge',
  args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(url);
await page.waitForFunction(() => window.fleetGalaxy);
await page.evaluate(async () => {
  await document.fonts.ready;
  await window.fleetGalaxy.historyReady;
});

const shot = async (name, fn, settle = 2.5) => {
  await page.evaluate(([src, s]) => {
    new Function('g', src)(window.fleetGalaxy);
    window.fleetGalaxy.step(s);
  }, [fn, settle]);
  await page.waitForTimeout(500); // CSS transitions run on the real clock
  await page.evaluate(() => window.fleetGalaxy.step(0.05));
  await page.screenshot({ path: path(new URL(name, out)) });
  console.log('wrote', name);
};

await shot('hero.png', 'g.frameAll(0.01);', 3);
await shot('rings-patch.png', "g.setGroup('ring'); g.setLens('patch');", 3);
await shot('deployment.png', "g.setGroup('site'); g.setLens('deploy:app-gp');", 3);
await shot(
  'device.png',
  `const v = g.view;
   const deps = v.fleet.deployments;
   let best = -1, most = 0;
   for (let i = 0; i < v.count; i++) {
     if (!v.fleet.devices[i].user || v.facts.age[i] > 3) continue;
     const n = deps.filter((d) => ['failed', 'conflict', 'recurred'].includes(d.status[v.ids[i]])).length;
     if (n > most) { most = n; best = i; }
   }
   g.select(best, true);`,
  2,
);
await shot('people.png', "g.select(-1); document.querySelector('#device').hidden = true; g.setEntity('people'); g.setLens('mfa'); g.frameAll(0.01);", 3);
await shot('experience.png', "g.setEntity('devices'); g.setGroup('model'); g.setLens('field:ea.startupScore'); g.frameAll(0.01);", 3);

// Time machine GIF: Windows release lens, 60 days, three frames a day.
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });
await page.setViewportSize({ width: 1440, height: 810 });
await page.evaluate(() => {
  const g = window.fleetGalaxy;
  g.setGroup('site');
  g.setLens('release');
  g.goTo(0, 0.01);
  g.frameAll(0.01);
  g.step(2);
  g.freezeClock(true); // no twinkle or orbit: keeps the GIF small
});
const days = await page.evaluate(() => window.fleetGalaxy.snapshots.length);
let f = 0;
for (let d = 1; d < days; d++) {
  await page.evaluate((day) => window.fleetGalaxy.goTo(day, 0.28), d);
  for (let k = 0; k < 3; k++) {
    await page.evaluate(() => window.fleetGalaxy.step(0.1, 30));
    await page.screenshot({ path: path(new URL(`f${String(f++).padStart(4, '0')}.png`, frames)) });
  }
}
console.log(`wrote ${f} timeline frames`);

await browser.close();
