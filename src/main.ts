import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

import {
  categoryOf,
  colorModes,
  computeFacts,
  GROUP_MODES,
  groupOf,
  kpis,
  type ColorMode,
  type Facts,
  type GroupMode,
} from './data/classify';
import { FleetError, parseFleet } from './data/load';
import { generateDemoFleet } from './data/synth';
import type { Fleet } from './data/types';
import { planReplay, REPLAY_DAYS, type ReplayPlan } from './replay';
import { Cores, createDust, createNebula } from './scene/backdrop';
import { computeLayout, type Layout } from './scene/layout';
import { easeInOutCubic, Stars } from './scene/stars';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------- renderer

const canvas = $<HTMLCanvasElement>('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);

const labelRenderer = new CSS2DRenderer({ element: $('labels') });
labelRenderer.setSize(innerWidth, innerHeight);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.5, 9000);
camera.position.set(0, 900, 1500);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.rotateSpeed = 0.55;
controls.zoomSpeed = 0.8;
controls.minDistance = 12;
controls.maxDistance = 2600;
controls.autoRotate = !reducedMotion;
controls.autoRotateSpeed = 0.18;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.95, 0.55, 0.12);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const nebula = createNebula();
scene.add(nebula);
scene.add(createDust());
const cores = new Cores();
scene.add(cores.group);

// ---------------------------------------------------------------- state

interface State {
  fleet: Fleet;
  facts: Facts;
  modes: ColorMode[];
  colorMode: ColorMode['id'];
  groupMode: GroupMode;
  /** Category keys hidden from view (legend toggles). */
  hidden: Set<string>;
  query: string;
  matches: Uint8Array;
  selected: number;
  hover: number;
  layout: Layout;
  stars: Stars;
  labels: CSS2DObject[];
}

let state: State;

interface Replay {
  plan: ReplayPlan;
  t: number;
  playing: boolean;
}
let replay: Replay | null = null;

// ---------------------------------------------------------------- load

function loadFleet(fleet: Fleet): void {
  if (replay) stopReplay();
  const facts = computeFacts(fleet);
  const modes = colorModes(facts);

  if (state) {
    scene.remove(state.stars.points);
    state.stars.geometry.dispose();
    state.stars.material.dispose();
    for (const l of state.labels) l.removeFromParent();
  }

  const stars = new Stars(fleet.devices.length);
  scene.add(stars.points);

  state = {
    fleet,
    facts,
    modes,
    colorMode: state?.colorMode ?? 'compliance',
    groupMode: state?.groupMode ?? 'site',
    hidden: new Set(),
    query: '',
    matches: new Uint8Array(fleet.devices.length).fill(1),
    selected: -1,
    hover: -1,
    layout: { positions: new Float32Array(0), radial: new Float32Array(0), groups: [] },
    stars,
    labels: [],
  };
  ($<HTMLInputElement>('search')).value = '';
  closeDevice();

  $('tenant-name').textContent = fleet.tenant;
  $('demo-badge').hidden = !fleet.demo;
  const when = new Date(fleet.generated);
  $('snapshot').textContent = `${fleet.devices.length.toLocaleString()} devices · snapshot ${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} ${when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;

  renderModeButtons();
  renderKpis();
  applyLayout(true);
  applyStyle(true);
}

// ---------------------------------------------------------------- layout + style

function applyLayout(instant = false): void {
  const { fleet, facts, groupMode } = state;
  const keys = fleet.devices.map((_, i) => groupOf(groupMode, i, fleet, facts));
  state.layout = computeLayout(keys, facts.age, fleet.devices.map((d) => d.id));
  state.stars.setPositions(state.layout.positions, instant);
  buildLabels();
  cores.set(state.layout.groups, state.layout.groups.map(() => '#7dd3fc'));
  if (!instant) frameAll(1.8);
}

function currentMode(): ColorMode {
  return state.modes.find((m) => m.id === state.colorMode)!;
}

const tmpColor = new THREE.Color();

function applyStyle(instant = false): void {
  const { fleet, facts, stars, hidden, matches } = state;
  const mode = currentMode();
  const n = fleet.devices.length;
  const colors = new Float32Array(n * 3);
  const sizes = new Float32Array(n);
  const alphas = new Float32Array(n);
  const catIndex = new Map(mode.categories.map((c, i) => [c.key, i]));
  const linear = mode.categories.map((c) => tmpColor.set(c.color).toArray() as [number, number, number]);
  const searching = state.query.length > 0;

  for (let i = 0; i < n; i++) {
    const key = categoryOf(mode.id, i, fleet, facts);
    const ci = catIndex.get(key) ?? mode.categories.length - 1;
    const [r, g, b] = linear[ci] ?? [0.3, 0.3, 0.3];
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
    // The first category is always the healthy one; everything else is bigger.
    const unknown = mode.categories[ci]?.key === 'unknown';
    sizes[i] = ci === 0 ? 1 : unknown ? 1.1 : 1.65;
    let a = 1;
    if (facts.age[i] > 30) a *= 0.6;
    if (hidden.has(key)) a *= 0.04;
    if (searching && !matches[i]) a *= 0.08;
    alphas[i] = a;
  }
  stars.setStyle(colors, sizes, alphas, instant);
  renderLegend();
  tintGroups(colors);
}

/** Core glow and label mix bar follow the current color mode. */
function tintGroups(colors: Float32Array): void {
  const mode = currentMode();
  const tints: string[] = [];
  state.layout.groups.forEach((g, gi) => {
    let r = 0, gg = 0, b = 0;
    const counts = new Map<string, number>();
    for (const i of g.members) {
      r += colors[i * 3]; gg += colors[i * 3 + 1]; b += colors[i * 3 + 2];
      const k = categoryOf(mode.id, i, state.fleet, state.facts);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const m = g.members.length || 1;
    tints.push('#' + tmpColor.setRGB(r / m, gg / m, b / m).getHexString());

    const mix = state.labels[gi]?.element.querySelector('.mix');
    if (mix) {
      mix.innerHTML = mode.categories
        .map((c) => {
          const pct = ((counts.get(c.key) ?? 0) / m) * 100;
          return pct > 0 ? `<i style="width:${pct}%;background:${c.color}"></i>` : '';
        })
        .join('');
    }
  });
  cores.tint(tints);
}

function buildLabels(): void {
  for (const l of state.labels) l.removeFromParent();
  state.labels = state.layout.groups.map((g) => {
    const el = document.createElement('div');
    el.className = 'glabel';
    el.innerHTML = `<div class="n"></div><div class="c">${g.count.toLocaleString()} devices</div><div class="mix"></div>`;
    el.querySelector('.n')!.textContent = g.name;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      flyTo(new THREE.Vector3(...g.center), g.radius * 3.2);
    });
    const obj = new CSS2DObject(el);
    obj.position.set(g.center[0], g.center[1] + g.radius * 0.55, g.center[2]);
    scene.add(obj);
    return obj;
  });
}

// ---------------------------------------------------------------- UI: modes, legend, kpis

function renderModeButtons(): void {
  const cm = $('color-modes');
  cm.innerHTML = '';
  state.modes.forEach((m, i) => {
    const b = document.createElement('button');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(m.id === state.colorMode));
    b.innerHTML = `${m.label} <kbd>${i + 1}</kbd>`;
    b.onclick = () => setColorMode(m.id);
    cm.append(b);
  });

  const gm = $('group-modes');
  gm.innerHTML = '';
  for (const g of GROUP_MODES) {
    const b = document.createElement('button');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(g.id === state.groupMode));
    b.textContent = g.label;
    b.onclick = () => setGroupMode(g.id);
    gm.append(b);
  }
}

function setColorMode(id: ColorMode['id']): void {
  if (replay) stopReplay();
  if (state.colorMode === id) return;
  state.colorMode = id;
  state.hidden.clear();
  renderModeButtons();
  applyStyle();
  refreshDevice();
}

function setGroupMode(id: GroupMode): void {
  if (state.groupMode === id) return;
  state.groupMode = id;
  renderModeButtons();
  applyLayout();
  applyStyle();
  if (replay) replay.plan = planReplay(state.fleet, state.facts, state.layout.radial);
}

function renderLegend(): void {
  const mode = currentMode();
  const counts = new Map<string, number>();
  state.fleet.devices.forEach((_, i) => {
    const k = categoryOf(mode.id, i, state.fleet, state.facts);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  });
  const total = state.fleet.devices.length || 1;
  const ul = $('legend');
  ul.innerHTML = '';
  for (const c of mode.categories) {
    const n = counts.get(c.key) ?? 0;
    const li = document.createElement('li');
    li.style.color = c.color;
    li.className = state.hidden.has(c.key) ? 'off' : '';
    li.innerHTML = `<span class="dot"></span><span class="name"></span><span class="count">${n.toLocaleString()}</span><span class="bar"><i style="width:${(n / total) * 100}%"></i></span>`;
    li.querySelector('.name')!.textContent = c.label;
    li.title = 'Click to isolate · Shift+click to toggle';
    li.onclick = (e) => toggleCategory(c.key, e.shiftKey);
    ul.append(li);
  }
}

function toggleCategory(key: string, additive: boolean): void {
  const all = currentMode().categories.map((c) => c.key);
  const h = state.hidden;
  if (additive) {
    if (h.has(key)) h.delete(key);
    else h.add(key);
  } else {
    const isolated = h.size === all.length - 1 && !h.has(key);
    h.clear();
    if (!isolated) for (const k of all) if (k !== key) h.add(k);
  }
  applyStyle();
}

function renderKpis(): void {
  const k = kpis(state.fleet, state.facts);
  const items: { v: string; unit?: string; l: string; c: string; act: () => void }[] = [
    { v: k.compliantPct.toFixed(1), unit: '%', l: 'Compliant', c: '#7dd3fc', act: () => isolate('compliance', 'noncompliant') },
    { v: k.currentPct.toFixed(1), unit: '%', l: 'On current patch', c: '#6ee7b7', act: () => isolate('patch', 'behind2') },
    { v: k.stale.toLocaleString(), l: 'Silent 14+ days', c: '#f472b6', act: () => isolate('checkin', 'stale') },
    { v: k.win10.toLocaleString(), l: 'Still on Windows 10', c: '#fb3d6b', act: () => isolateWin10() },
  ];
  const el = $('kpis');
  el.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'kpi';
    b.style.setProperty('--c', it.c);
    b.innerHTML = `<div class="v">${it.v}${it.unit ? `<small>${it.unit}</small>` : ''}</div><div class="l">${it.l}</div>`;
    b.onclick = it.act;
    el.append(b);
  }
}

function isolate(mode: ColorMode['id'], key: string): void {
  setColorMode(mode);
  state.hidden.clear();
  for (const c of currentMode().categories) if (c.key !== key) state.hidden.add(c.key);
  applyStyle();
}

function isolateWin10(): void {
  setColorMode('release');
  state.hidden.clear();
  for (const c of currentMode().categories) if (!c.key.startsWith('Win10')) state.hidden.add(c.key);
  applyStyle();
}

// ---------------------------------------------------------------- search

const searchInput = $<HTMLInputElement>('search');
searchInput.addEventListener('input', () => runSearch(searchInput.value));
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = state.matches.findIndex((m) => m === 1);
    if (first >= 0 && state.query) selectDevice(first, true);
  }
  if (e.key === 'Escape') {
    searchInput.value = '';
    runSearch('');
    searchInput.blur();
  }
});

function runSearch(q: string): void {
  state.query = q.trim().toLowerCase();
  const terms = state.query.split(/\s+/).filter(Boolean);
  state.fleet.devices.forEach((d, i) => {
    const hay = `${d.name} ${d.user ?? ''} ${d.model} ${d.manufacturer} ${d.site} ${d.ring} ${state.facts.release[i]}`.toLowerCase();
    state.matches[i] = terms.every((t) => hay.includes(t)) ? 1 : 0;
  });
  applyStyle();
}

// ---------------------------------------------------------------- device panel

const panel = $('device');

function selectDevice(i: number, fly = false): void {
  state.selected = i;
  state.stars.material.uniforms.uSelected.value = i;
  refreshDevice();
  if (fly) {
    const p = state.stars.pos;
    flyTo(new THREE.Vector3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]), 70);
  }
}

function closeDevice(): void {
  if (!state) return;
  state.selected = -1;
  state.stars.material.uniforms.uSelected.value = -1;
  panel.hidden = true;
}

const STATUS_COLORS: Record<string, [string, string]> = {
  compliant: ['Compliant', '#7dd3fc'],
  ingrace: ['In grace period', '#fbbf24'],
  noncompliant: ['Not compliant', '#fb3d6b'],
  unknown: ['Compliance unknown', '#64748b'],
};

const PATCH_LABEL: Record<string, string> = {
  current: 'Current',
  behind1: '1 update behind',
  behind2: '2+ updates behind',
  unknown: 'Unknown',
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function relativeAge(days: number): string {
  if (!Number.isFinite(days)) return 'never';
  if (days < 1 / 24) return 'just now';
  if (days < 1) return `${Math.round(days * 24)} h ago`;
  if (days < 60) return `${Math.round(days)} d ago`;
  return `${Math.round(days / 30)} mo ago`;
}

function refreshDevice(): void {
  const i = state.selected;
  if (i < 0) {
    panel.hidden = true;
    return;
  }
  const d = state.fleet.devices[i];
  const f = state.facts;
  const [label, color] = STATUS_COLORS[d.compliance];
  const reasons = d.complianceReasons?.length
    ? `<ul class="reasons">${d.complianceReasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`
    : '';
  const rows: [string, string][] = [
    ['Last check-in', relativeAge(f.age[i])],
    ['Windows', `${f.release[i]}`],
    ['Build', d.osVersion || '—'],
    ['Patch level', PATCH_LABEL[f.patch[i]]],
    ['Update ring', d.ring],
    ['Site', d.site],
    ['Model', `${d.manufacturer} ${d.model}`],
    ['BitLocker', d.encrypted === undefined ? '—' : d.encrypted ? 'Encrypted' : 'Not encrypted'],
    ['Ownership', d.ownership[0].toUpperCase() + d.ownership.slice(1)],
    ['Enrolled', d.enrolled ? new Date(d.enrolled).toLocaleDateString() : '—'],
  ];
  // Demo and anonymized exports don't carry real Intune device ids.
  const intune = state.fleet.demo || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(d.id)
    ? ''
    : `<a class="btn" target="_blank" rel="noopener" href="https://intune.microsoft.com/#view/Microsoft_Intune_Devices/DeviceSettingsMenuBlade/~/overview/mdmDeviceId/${encodeURIComponent(d.id)}">Open in Intune ↗</a>`;
  panel.innerHTML = `
    <button class="btn icon close" aria-label="Close">×</button>
    <div class="eyebrow">Device</div>
    <h3>${esc(d.name)}</h3>
    <div class="who">${esc(d.user ?? 'No primary user')}</div>
    <div class="status" style="--c:${color}">${label}</div>
    ${reasons}
    <dl class="facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    <div class="actions">
      <button class="btn" data-act="copy">Copy name</button>
      ${intune}
    </div>`;
  panel.hidden = false;
  panel.querySelector('.close')!.addEventListener('click', closeDevice);
  panel.querySelector('[data-act=copy]')!.addEventListener('click', () => {
    navigator.clipboard?.writeText(d.name).then(() => toast(`Copied ${d.name}`));
  });
}

// ---------------------------------------------------------------- picking + tooltip

const tooltip = $('tooltip');
const mouse = { x: 0, y: 0, moved: false, inside: false, downX: 0, downY: 0 };
const proj = new THREE.Vector3();

canvas.addEventListener('pointermove', (e) => {
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  mouse.moved = true;
  mouse.inside = true;
});
canvas.addEventListener('pointerleave', () => {
  mouse.inside = false;
  setHover(-1);
});
canvas.addEventListener('pointerdown', (e) => {
  mouse.downX = e.clientX;
  mouse.downY = e.clientY;
  canvas.classList.add('dragging');
  stopIntro();
});
addEventListener('pointerup', () => canvas.classList.remove('dragging'));
canvas.addEventListener('click', (e) => {
  if (Math.hypot(e.clientX - mouse.downX, e.clientY - mouse.downY) > 5) return;
  const i = pick(e.clientX, e.clientY);
  if (i >= 0) selectDevice(i, true);
  else closeDevice();
});

function pick(x: number, y: number): number {
  const { pos, alpha, count } = state.stars;
  const w = innerWidth, h = innerHeight;
  let best = -1;
  let bestD = 14 * 14;
  let bestZ = Infinity;
  for (let i = 0; i < count; i++) {
    if (alpha[i] < 0.2) continue;
    proj.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).project(camera);
    if (proj.z > 1 || proj.z < -1) continue;
    const sx = (proj.x + 1) * 0.5 * w;
    const sy = (1 - proj.y) * 0.5 * h;
    const d = (sx - x) ** 2 + (sy - y) ** 2;
    // Prefer the nearer star when two overlap on screen.
    if (d < bestD - 4 || (d < bestD + 4 && proj.z < bestZ)) {
      best = i;
      bestD = d;
      bestZ = proj.z;
    }
  }
  return best;
}

function setHover(i: number): void {
  if (state.hover === i) return;
  state.hover = i;
  state.stars.material.uniforms.uHover.value = i;
  canvas.classList.toggle('pointing', i >= 0);
  if (i < 0) {
    tooltip.hidden = true;
    return;
  }
  const d = state.fleet.devices[i];
  const mode = currentMode();
  const key = categoryOf(mode.id, i, state.fleet, state.facts);
  const cat = mode.categories.find((c) => c.key === key);
  tooltip.innerHTML = `<i style="--c:${cat?.color ?? '#888'}"></i><b>${esc(d.name)}</b><span>${esc(cat?.label ?? key)} · ${relativeAge(state.facts.age[i])}</span>`;
  tooltip.hidden = false;
}

// ---------------------------------------------------------------- camera moves

interface Flight {
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  t: number;
  duration: number;
}
let flight: Flight | null = null;
let intro = true;

function flyTo(target: THREE.Vector3, distance: number, duration = 1.4, from?: THREE.Vector3): void {
  const dir = from?.clone() ?? camera.position.clone().sub(controls.target).normalize();
  if (dir.y < 0.25) dir.y = 0.25;
  dir.normalize();
  flight = {
    fromPos: camera.position.clone(),
    toPos: target.clone().add(dir.multiplyScalar(distance)),
    fromTarget: controls.target.clone(),
    toTarget: target.clone(),
    t: 0,
    duration: reducedMotion ? 0.01 : duration,
  };
}

function frameAll(duration = 1.4): void {
  const groups = state.layout.groups;
  let maxR = 0;
  const c = new THREE.Vector3();
  for (const g of groups) c.add(new THREE.Vector3(...g.center));
  c.divideScalar(groups.length || 1);
  for (const g of groups) maxR = Math.max(maxR, c.distanceTo(new THREE.Vector3(...g.center)) + g.radius * 1.6);
  // Fit whichever screen dimension is tighter. The view is oblique, so depth
  // foreshortens and the vertical fit can be looser than the horizontal one.
  const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const tanH = tanV * camera.aspect;
  const portrait = camera.aspect < 1;
  if (portrait) {
    // On a phone, look down from high above so the disc fills the tall screen.
    flyTo(c, Math.max(140, (maxR / tanH) * 0.85), duration, new THREE.Vector3(0, 2.2, 1));
    return;
  }
  const dist = Math.max(140, maxR / tanH * 1.4, (maxR / tanV) * 0.8);
  flyTo(c, dist, duration);
}

function stopIntro(): void {
  intro = false;
}

// ---------------------------------------------------------------- replay

const replayPanel = $('replay');
const replayLive = $('replay-live');

function startReplay(): void {
  if (!state) return;
  closeDevice();
  state.colorMode = 'patch';
  state.hidden.clear();
  renderModeButtons();
  applyStyle();
  const plan = planReplay(state.fleet, state.facts, state.layout.radial);
  replay = { plan, t: 0, playing: true };

  // Rewind: every device that ends up current starts the month one update behind.
  const behind = tmpColor.set('#fde68a').toArray();
  plan.installDay.forEach((day, i) => {
    if (Number.isFinite(day)) state.stars.setColorNow(i, behind[0], behind[1], behind[2]);
  });

  drawReplayChart(plan.curve);
  replayPanel.classList.add('live');
  replayLive.hidden = false;
  $('replay-pause').textContent = 'Pause';
  frameAll(1.6);
}

function stopReplay(): void {
  replay = null;
  replayPanel.classList.remove('live');
  replayLive.hidden = true;
  applyStyle();
}

function drawReplayChart(curve: number[]): void {
  const max = Math.max(1, ...curve);
  const pts = curve.map((v, d) => `${(d / REPLAY_DAYS) * 220},${56 - (v / max) * 50 - 3}`);
  const svg = $('replay-chart');
  svg.querySelector('.line')!.setAttribute('d', `M${pts.join(' L')}`);
  svg.querySelector('.area')!.setAttribute('d', `M0,56 L${pts.join(' L')} L220,56 Z`);
}

function stepReplay(dt: number): void {
  if (!replay || !replay.playing) return;
  const prev = replay.t;
  replay.t = Math.min(REPLAY_DAYS, replay.t + dt / 1.05);
  const now = replay.t;
  const current = tmpColor.set('#6ee7b7').toArray();
  let done = 0;
  replay.plan.installDay.forEach((day, i) => {
    if (day <= now) done++;
    if (day > prev && day <= now) {
      state.stars.setColorNow(i, current[0], current[1], current[2]);
      state.stars.pulse(i, 1);
    }
  });
  $('replay-day').textContent = String(Math.floor(now)).padStart(2, '0');
  $('replay-pct').textContent = `${((done / state.fleet.devices.length) * 100).toFixed(0)}%`;
  const cursor = $('replay-chart').querySelector('.cursor')!;
  const x = String((now / REPLAY_DAYS) * 220);
  cursor.setAttribute('x1', x);
  cursor.setAttribute('x2', x);
  if (now >= REPLAY_DAYS) {
    replay.playing = false;
    $('replay-pause').textContent = 'Replay';
  }
}

$('replay-btn').addEventListener('click', startReplay);
$('replay-stop').addEventListener('click', stopReplay);
$('replay-pause').addEventListener('click', () => {
  if (!replay) return;
  if (replay.t >= REPLAY_DAYS) return startReplay();
  replay.playing = !replay.playing;
  $('replay-pause').textContent = replay.playing ? 'Pause' : 'Resume';
});

// ---------------------------------------------------------------- loading your own file

const fileInput = $<HTMLInputElement>('file-input');
$('load-btn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) readFile(f);
  fileInput.value = '';
});

const drop = $('drop');
let dragDepth = 0;
addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  drop.hidden = false;
});
addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) drop.hidden = true;
});
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  drop.hidden = true;
  const f = e.dataTransfer?.files[0];
  if (f) readFile(f);
});

async function readFile(file: File): Promise<void> {
  try {
    const fleet = parseFleet(await file.text());
    loadFleet(fleet);
    frameAll(2);
    toast(`Loaded ${fleet.devices.length.toLocaleString()} devices from ${fleet.tenant}`);
  } catch (err) {
    toast(err instanceof FleetError ? err.message : `Couldn't read that file: ${(err as Error).message}`, true);
  }
}

// ---------------------------------------------------------------- misc UI

let toastTimer = 0;
function toast(msg: string, error = false): void {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast${error ? ' error' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), error ? 6000 : 3000);
}

const help = $<HTMLDialogElement>('help');
$('help-btn').addEventListener('click', () => help.showModal());
help.addEventListener('click', (e) => {
  if (e.target === help) help.close();
});

$('controls-toggle').addEventListener('click', () => $('controls').classList.toggle('open'));

addEventListener('keydown', (e) => {
  if (help.open) return;
  const typing = (e.target as HTMLElement)?.tagName === 'INPUT';
  if (e.key === '/' && !typing) {
    e.preventDefault();
    searchInput.focus();
    return;
  }
  if (typing) return;
  if (e.key >= '1' && e.key <= '4') setColorMode(state.modes[+e.key - 1].id);
  else if (e.key === 'g' || e.key === 'G') {
    const i = GROUP_MODES.findIndex((g) => g.id === state.groupMode);
    setGroupMode(GROUP_MODES[(i + 1) % GROUP_MODES.length].id);
  } else if (e.key === 'r' || e.key === 'R') startReplay();
  else if (e.key === ' ') {
    e.preventDefault();
    controls.autoRotate = !controls.autoRotate;
  } else if (e.key === 'Escape') {
    if (replay) stopReplay();
    closeDevice();
    if (state.hidden.size || state.query) {
      state.hidden.clear();
      searchInput.value = '';
      runSearch('');
    }
  }
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- frame loop

const clock = new THREE.Clock();
let elapsed = 0;
const labelPos = new THREE.Vector3();

function frame(): void {
  tick(Math.min(clock.getDelta(), 0.05));
  requestAnimationFrame(frame);
}

/** Set by capture.mjs so recordings only change where something actually happens. */
let frozenClock = false;

function tick(dt: number): void {
  if (!frozenClock) elapsed += dt;

  if (flight) {
    flight.t = Math.min(1, flight.t + dt / flight.duration);
    const k = easeInOutCubic(flight.t);
    camera.position.lerpVectors(flight.fromPos, flight.toPos, k);
    controls.target.lerpVectors(flight.fromTarget, flight.toTarget, k);
    if (flight.t >= 1) flight = null;
  }

  controls.update();
  state.stars.update(dt, elapsed);
  state.stars.material.uniforms.uScale.value = (renderer.domElement.height / 900) * 230;
  (nebula.material as THREE.ShaderMaterial).uniforms.uTime.value = elapsed;
  stepReplay(dt);

  if (mouse.moved && mouse.inside) {
    mouse.moved = false;
    setHover(pick(mouse.x, mouse.y));
  }
  if (state.hover >= 0) {
    tooltip.style.left = `${mouse.x}px`;
    tooltip.style.top = `${mouse.y}px`;
  }

  // Fade labels that are far away or behind the camera's focus.
  const camDist = camera.position.distanceTo(controls.target);
  state.labels.forEach((l, i) => {
    const g = state.layout.groups[i];
    labelPos.set(...g.center);
    const d = camera.position.distanceTo(labelPos);
    const near = d < g.radius * 1.2;
    const op = near ? 0 : Math.max(0.25, Math.min(1, 1.6 - d / (camDist * 2.2)));
    l.element.style.opacity = String(op);
  });

  composer.render();
  labelRenderer.render(scene, camera);
}

/** Advance the scene by hand: for screenshots and recordings when rAF is paused. */
function step(seconds: number, fps = 30): void {
  const n = Math.round(seconds * fps);
  for (let i = 0; i < n; i++) tick(1 / fps);
}

// ---------------------------------------------------------------- boot

// ?capture freezes the clock so scripts/capture.mjs can drive frames with step().
const capture = new URLSearchParams(location.search).has('capture');

loadFleet(generateDemoFleet());
if (reducedMotion || capture) {
  intro = false;
  frameAll(0.01);
} else {
  // Open on a wide shot, then glide in.
  setTimeout(() => intro && frameAll(3.2), 250);
}
if (!capture) requestAnimationFrame(frame);

// Handy in the console: window.fleetGalaxy.state
Object.assign(window, {
  fleetGalaxy: {
    get state() { return state; },
    camera, controls, loadFleet, generateDemoFleet, frameAll, flyTo, step,
    setColorMode, setGroupMode, selectDevice, startReplay,
    freezeClock(on: boolean) { frozenClock = on; controls.autoRotate = !on; },
  },
});
