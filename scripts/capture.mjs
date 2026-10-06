// Renders the README screenshots and replay GIF frames from the running dev
// server. Usage: npm run dev (in another terminal), then npm run capture.
// Frames are stepped by hand (?capture), so output is identical on every run.

import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright-core';

const url = process.env.URL ?? 'http://localhost:5175/?capture';
const out = new URL('../docs/', import.meta.url);
const frames = new URL('../docs/frames/', import.meta.url);

const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? 'msedge',
  args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(url);
await page.waitForFunction(() => window.fleetGalaxy);
await page.evaluate(() => document.fonts.ready);

const shot = async (name, fn, settle = 2.5) => {
  await page.evaluate(([src, s]) => {
    new Function('g', src)(window.fleetGalaxy);
    window.fleetGalaxy.step(s);
  }, [fn, settle]);
  await page.waitForTimeout(400); // CSS transitions run on the real clock
  await page.screenshot({ path: new URL(name, out).pathname.slice(1) });
  console.log('wrote', name);
};

await shot('hero.png', '', 3);
await shot('rings-patch.png', "g.setGroupMode('ring'); g.setColorMode('patch');", 3);
await shot('site.png', "g.setGroupMode('site'); g.setColorMode('compliance');", 3);
await shot(
  'device.png',
  `const s = g.state;
   const i = s.fleet.devices.findIndex((d, k) => d.compliance === 'noncompliant' && s.facts.age[k] < 3 && (d.complianceReasons || []).length > 1);
   g.selectDevice(i, true);`,
  2,
);
await shot('checkin.png', "g.selectDevice(-1); document.querySelector('#device').hidden = true; g.setColorMode('checkin'); g.frameAll(0.01);", 3);

// Replay GIF: 15 fps, one simulated day per ~1 s of footage.
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });
await page.setViewportSize({ width: 1440, height: 810 });
await page.evaluate(() => {
  const g = window.fleetGalaxy;
  g.setColorMode('compliance');
  g.frameAll(0.01);
  g.step(1);
  g.startReplay();
  g.step(1.7); // let the camera settle
  g.freezeClock(true); // no twinkle or orbit: keeps the GIF small
});
const total = 22 * 15;
for (let f = 0; f < total; f++) {
  await page.evaluate(() => window.fleetGalaxy.step(1 / 15, 15));
  if (f % 2 === 0) await page.screenshot({ path: new URL(`f${String(f).padStart(4, '0')}.png`, frames).pathname.slice(1) });
}
console.log('wrote replay frames');

await browser.close();
