import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './landing.css';

// ---------------------------------------------------------------- download button

const RELEASES = 'https://github.com/YeomanLabs/fleet-galaxy/releases/latest/download/';
const isMac = /Mac/i.test(navigator.platform) || /Macintosh/i.test(navigator.userAgent);
const primary = document.getElementById('dl-primary') as HTMLAnchorElement;
const alt = document.getElementById('dl-alt') as HTMLAnchorElement;

if (isMac) {
  primary.href = `${RELEASES}Fleet-Galaxy.dmg`;
  primary.querySelector('span')!.textContent = 'Download for macOS';
  alt.href = `${RELEASES}Fleet-Galaxy-Setup.exe`;
  alt.textContent = 'Windows';
}

// Show the current version if a release exists. Silent if offline or rate-limited.
fetch('https://api.github.com/repos/YeomanLabs/fleet-galaxy/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
  .then((r) => (r.ok ? r.json() : null))
  .then((rel: { tag_name?: string } | null) => {
    if (rel?.tag_name) document.getElementById('dl-version')!.textContent = `Version ${rel.tag_name.replace(/^v/, '')} · Free and open source`;
  })
  .catch(() => undefined);

// ---------------------------------------------------------------- starfield

const canvas = document.getElementById('sky') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
interface Star { x: number; y: number; z: number; r: number; tw: number; hue: number }
let stars: Star[] = [];
let w = 0, h = 0, dpr = 1;

function seed(): void {
  dpr = Math.min(devicePixelRatio, 2);
  w = canvas.width = innerWidth * dpr;
  h = canvas.height = innerHeight * dpr;
  canvas.style.width = `${innerWidth}px`;
  canvas.style.height = `${innerHeight}px`;
  const n = Math.round((innerWidth * innerHeight) / 2600);
  stars = Array.from({ length: n }, () => ({
    x: Math.random() * w,
    y: Math.random() * h,
    z: 0.2 + Math.random() * 0.8,
    r: Math.random() < 0.06 ? 1.6 : 0.6 + Math.random() * 0.7,
    tw: Math.random() * Math.PI * 2,
    hue: Math.random(),
  }));
}

function draw(t: number): void {
  ctx.clearRect(0, 0, w, h);
  const scroll = scrollY * dpr;
  for (const s of stars) {
    // Nearer stars drift faster with scroll: cheap parallax.
    const y = (((s.y - scroll * s.z * 0.25) % h) + h) % h;
    const a = 0.35 + 0.65 * s.z * (0.75 + 0.25 * Math.sin(t * 0.0012 * (0.5 + s.z) + s.tw));
    ctx.fillStyle = s.hue > 0.85 ? `rgba(253,230,138,${a})` : s.hue > 0.7 ? `rgba(165,180,252,${a})` : `rgba(220,235,255,${a})`;
    ctx.beginPath();
    ctx.arc(s.x, y, s.r * dpr * s.z, 0, Math.PI * 2);
    ctx.fill();
  }
  if (!reduce) requestAnimationFrame(draw);
}

seed();
requestAnimationFrame(draw);
addEventListener('resize', seed);
if (reduce) addEventListener('scroll', () => requestAnimationFrame(draw), { passive: true });
