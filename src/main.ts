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

import { kpis } from './data/classify';
import { mergeCsv } from './data/csv';
import { alignSnapshots, generateDemoHistoryAsync } from './data/history';
import { LENS_GROUP_ORDER, type Lens } from './data/lenses';
import { FleetError, parseFleet } from './data/load';
import { peopleKpis } from './data/people';
import { generateDemoFleet } from './data/synth';
import type { Fleet } from './data/types';
import { planReplay, REPLAY_DAYS, type ReplayPlan } from './replay';
import { Cores, createDust, createNebula } from './scene/backdrop';
import { Constellation } from './scene/constellation';
import { computeLayout, type Layout } from './scene/layout';
import { easeInOutCubic, Stars } from './scene/stars';
import { devicePanel, esc, relativeAge, userPanel } from './ui/panels';
import { native } from './native';
import { initDesktop } from './ui/desktop';
import { buildView, type Entity, type View } from './view';

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
composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.95, 0.55, 0.12));
composer.addPass(new OutputPass());

const nebula = createNebula();
scene.add(nebula);
scene.add(createDust());
const cores = new Cores();
scene.add(cores.group);
const constellation = new Constellation();
scene.add(constellation.lines);

// ---------------------------------------------------------------- state

/** Snapshots oldest first. One entry unless a history is loaded. */
let snapshots: Fleet[] = [];
let t = 0;
let entity: Entity = 'devices';
const views = new Map<string, View>();

const lensChoice: Record<Entity, string> = { devices: 'compliance', people: 'mfa' };
const groupChoice: Record<Entity, string> = { devices: 'site', people: 'department' };

let view: View;
let stars: Stars | null = null;
let layout: Layout = { positions: new Float32Array(0), radial: new Float32Array(0), groups: [] };
let labels: CSS2DObject[] = [];
/** Category keys hidden from view (legend toggles). */
const hidden = new Set<string>();
let query = '';
let matches = new Uint8Array(0);
let selected = -1;
let hover = -1;

interface Replay {
  plan: ReplayPlan;
  t: number;
  playing: boolean;
}
let replay: Replay | null = null;

function getView(e: Entity, at: number): View {
  const key = `${e}:${at}`;
  let v = views.get(key);
  if (!v) {
    v = buildView(snapshots[at], e);
    views.set(key, v);
  }
  return v;
}

function lens(): Lens {
  return view.lenses.find((l) => l.id === lensChoice[entity]) ?? view.lenses[0];
}

const hasPeople = () => (snapshots[t]?.users?.length ?? 0) > 0;

// ---------------------------------------------------------------- loading data

function setSnapshots(list: Fleet[], opts: { keepCamera?: boolean } = {}): void {
  if (replay) stopReplay();
  stopTimeline();
  snapshots = list;
  t = list.length - 1;
  views.clear();
  spark.clear();
  if (entity === 'people' && !hasPeople()) entity = 'devices';
  rebuild();
  renderTimeline();
  if (!opts.keepCamera) frameAll(1.8);
}

/** Full rebuild for the current entity and snapshot: new star cloud, instant layout. */
function rebuild(): void {
  view = getView(entity, t);
  if (!view.groupings.some((g) => g.id === groupChoice[entity])) groupChoice[entity] = view.groupings[0].id;
  if (!view.lenses.some((l) => l.id === lensChoice[entity])) lensChoice[entity] = view.lenses[0].id;

  if (stars) {
    scene.remove(stars.points);
    stars.geometry.dispose();
    stars.material.dispose();
  }
  stars = new Stars(view.count);
  scene.add(stars.points);
  hidden.clear();
  query = '';
  matches = new Uint8Array(view.count).fill(1);
  $<HTMLInputElement>('search').value = '';
  $<HTMLInputElement>('search').placeholder = entity === 'people' ? 'Find a person, department or license' : 'Find a device, user, serial or model';
  closePanel();
  constellation.set([]);

  renderHeader();
  renderEntitySwitch();
  renderControls();
  renderKpis();
  applyLayout(true);
  applyStyle(true);
  $('replay').hidden = entity !== 'devices' || snapshots.length > 1;
}

function renderHeader(): void {
  const fleet = snapshots[t];
  $('tenant-name').textContent = fleet.tenant;
  $('demo-badge').hidden = !fleet.demo;
  const when = new Date(fleet.generated);
  const n = countPresent();
  const noun = entity === 'people' ? 'people' : 'devices';
  $('snapshot').textContent = `${n.toLocaleString()} ${noun} · snapshot ${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} ${when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

function countPresent(): number {
  let n = 0;
  for (let i = 0; i < view.count; i++) n += view.present[i];
  return n;
}

// ---------------------------------------------------------------- layout + style

function groupKeys(v: View): string[] {
  const g = groupChoice[entity];
  return Array.from({ length: v.count }, (_, i) => v.groupKey(g, i));
}

function applyLayout(instant = false, duration = 1.6): void {
  layout = computeLayout(groupKeys(view), view.age, view.ids);
  stars!.setPositions(layout.positions, instant, duration, duration < 1 ? 0.1 : 0.35);
  buildLabels();
  cores.set(layout.groups, layout.groups.map(() => '#7dd3fc'));
}

const tmpColor = new THREE.Color();

function applyStyle(instant = false, duration = 0.6): void {
  const l = lens();
  const n = view.count;
  const colors = new Float32Array(n * 3);
  const sizes = new Float32Array(n);
  const alphas = new Float32Array(n);
  const index = new Map(l.categories.map((c, i) => [c.key, i]));
  const linear = l.categories.map((c) => tmpColor.set(c.color).toArray() as [number, number, number]);
  const searching = query.length > 0;

  for (let i = 0; i < n; i++) {
    const key = l.keyOf(i);
    const ci = index.get(key) ?? l.categories.length - 1;
    const c = l.categories[ci];
    const [r, g, b] = linear[ci] ?? [0.3, 0.3, 0.3];
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
    sizes[i] = c.weight > 0 ? 1.65 : c.weight < 0 ? 0.85 : 1;
    let a = c.weight < 0 ? 0.45 : 1;
    if (view.age[i] > 30) a *= 0.6;
    if (hidden.has(key)) a *= 0.04;
    if (searching && !matches[i]) a *= 0.08;
    if (!view.present[i]) a = 0;
    alphas[i] = a;
  }
  stars!.setStyle(colors, sizes, alphas, instant, duration);
  renderLegend();
  tintGroups(colors);
}

/** Core glow and label mix bar follow the current lens. */
function tintGroups(colors: Float32Array): void {
  const l = lens();
  const tints: string[] = [];
  layout.groups.forEach((g, gi) => {
    let r = 0, gg = 0, b = 0, m = 0;
    const counts = new Map<string, number>();
    for (const i of g.members) {
      if (!view.present[i]) continue;
      m++;
      r += colors[i * 3]; gg += colors[i * 3 + 1]; b += colors[i * 3 + 2];
      const k = l.keyOf(i);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const d = m || 1;
    tints.push('#' + tmpColor.setRGB(r / d, gg / d, b / d).getHexString());
    const el = labels[gi]?.element;
    if (!el) return;
    el.querySelector('.c')!.textContent = `${m.toLocaleString()} ${entity === 'people' ? 'people' : 'devices'}`;
    el.querySelector('.mix')!.innerHTML = l.categories
      .map((c) => {
        const pct = ((counts.get(c.key) ?? 0) / d) * 100;
        return pct > 0 ? `<i style="width:${pct}%;background:${c.color}"></i>` : '';
      })
      .join('');
  });
  cores.tint(tints);
}

function buildLabels(): void {
  for (const l of labels) l.removeFromParent();
  labels = layout.groups.map((g) => {
    const el = document.createElement('div');
    el.className = 'glabel';
    el.innerHTML = '<div class="n"></div><div class="c"></div><div class="mix"></div>';
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

// ---------------------------------------------------------------- entity switch

function renderEntitySwitch(): void {
  const el = $('entity');
  el.hidden = !hasPeople();
  for (const b of el.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-selected', String(b.dataset.entity === entity));
}

$('entity').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (b?.dataset.entity) setEntity(b.dataset.entity as Entity);
});

function setEntity(e: Entity): void {
  if (e === entity || (e === 'people' && !hasPeople())) return;
  if (replay) stopReplay();
  entity = e;
  spark.clear();
  rebuild();
  renderTimeline();
  frameAll(1.4);
}

// ---------------------------------------------------------------- controls: lenses, groups, legend

const QUICK: Record<Entity, string[]> = {
  devices: ['compliance', 'checkin', 'release', 'patch'],
  people: ['mfa', 'signin', 'risk', 'license'],
};
const SHORT: Record<string, string> = {
  compliance: 'Compliance', checkin: 'Check-in', release: 'Windows', patch: 'Patch level',
  mfa: 'MFA', signin: 'Sign-in', risk: 'Risk', license: 'License',
};

function renderControls(): void {
  const l = lens();
  const btn = $('lens-btn');
  btn.querySelector('.g')!.textContent = String(l.group);
  btn.querySelector('.l')!.textContent = l.label;
  $('lens-desc').textContent = l.description ?? '';
  $('lens-desc').hidden = !l.description;

  const quick = $('color-modes');
  quick.innerHTML = '';
  QUICK[entity].forEach((id, i) => {
    if (!view.lenses.some((x) => x.id === id)) return;
    const b = document.createElement('button');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(id === l.id));
    b.innerHTML = `${SHORT[id]} <kbd>${i + 1}</kbd>`;
    b.onclick = () => setLens(id);
    quick.append(b);
  });

  const chips = $('group-modes');
  chips.innerHTML = '';
  const builtIn = view.groupings.filter((g) => !g.id.startsWith('lens:'));
  for (const g of builtIn) {
    const b = document.createElement('button');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(g.id === groupChoice[entity]));
    b.textContent = g.label;
    b.onclick = () => setGroup(g.id);
    chips.append(b);
  }
  const sel = $<HTMLSelectElement>('group-more');
  const byLens = view.groupings.filter((g) => g.id.startsWith('lens:'));
  sel.innerHTML = `<option value="">By lens…</option>${byLens.map((g) => `<option value="${esc(g.id)}">${esc(g.label)}</option>`).join('')}`;
  sel.value = groupChoice[entity].startsWith('lens:') ? groupChoice[entity] : '';
  sel.classList.toggle('active', sel.value !== '');
}

$<HTMLSelectElement>('group-more').addEventListener('change', (e) => {
  const v = (e.target as HTMLSelectElement).value;
  if (v) setGroup(v);
});

function setLens(id: string): void {
  if (replay) stopReplay();
  if (lensChoice[entity] === id && lens().id === id) return;
  lensChoice[entity] = id;
  hidden.clear();
  renderControls();
  applyStyle();
  refreshPanel();
  renderTimelineMetric();
}

function setGroup(id: string): void {
  if (groupChoice[entity] === id) return;
  groupChoice[entity] = id;
  renderControls();
  applyLayout();
  applyStyle();
  frameAll(1.8);
  if (replay) replay.plan = planReplay(view.fleet, view.facts, layout.radial);
}

function renderLegend(): void {
  const l = lens();
  const counts = new Map<string, number>();
  let total = 0;
  for (let i = 0; i < view.count; i++) {
    if (!view.present[i]) continue;
    total++;
    const k = l.keyOf(i);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const ul = $('legend');
  ul.innerHTML = '';
  for (const c of l.categories) {
    const n = counts.get(c.key) ?? 0;
    if (!n && c.weight < 0) continue;
    const li = document.createElement('li');
    li.style.color = c.color;
    li.className = hidden.has(c.key) ? 'off' : '';
    li.innerHTML = `<span class="dot"></span><span class="name"></span><span class="count">${n.toLocaleString()}</span><span class="bar"><i style="width:${(n / (total || 1)) * 100}%"></i></span>`;
    li.querySelector('.name')!.textContent = c.label;
    li.title = 'Click to isolate · Shift+click to toggle';
    li.onclick = (e) => toggleCategory(c.key, e.shiftKey);
    ul.append(li);
  }
}

function toggleCategory(key: string, additive: boolean): void {
  const all = lens().categories.map((c) => c.key);
  if (additive) {
    if (hidden.has(key)) hidden.delete(key);
    else hidden.add(key);
  } else {
    const isolated = hidden.size === all.length - 1 && !hidden.has(key);
    hidden.clear();
    if (!isolated) for (const k of all) if (k !== key) hidden.add(k);
  }
  applyStyle();
}

function isolate(lensId: string, keep: (key: string) => boolean): void {
  setLens(lensId);
  hidden.clear();
  for (const c of lens().categories) if (!keep(c.key)) hidden.add(c.key);
  applyStyle();
}

// ---------------------------------------------------------------- lens picker

const pop = $('lens-pop');
const lensSearch = $<HTMLInputElement>('lens-search');

$('lens-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (pop.hidden) openLensPicker();
  else pop.hidden = true;
});
addEventListener('click', (e) => {
  if (!pop.hidden && !pop.contains(e.target as Node)) pop.hidden = true;
});
lensSearch.addEventListener('input', renderLensList);
lensSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') pop.hidden = true;
  if (e.key === 'Enter') pop.querySelector<HTMLButtonElement>('.lens-item')?.click();
});

function openLensPicker(): void {
  pop.hidden = false;
  lensSearch.value = '';
  renderLensList();
  lensSearch.focus();
}

function renderLensList(): void {
  const q = lensSearch.value.trim().toLowerCase();
  const list = $('lens-list');
  const order = entity === 'people' ? ['Identity', 'Licensing', 'Custom'] : LENS_GROUP_ORDER;
  const groups = new Map<string, Lens[]>();
  for (const l of view.lenses) {
    if (q && !`${l.label} ${l.group} ${l.description ?? ''}`.toLowerCase().includes(q)) continue;
    const g = String(l.group);
    groups.set(g, [...(groups.get(g) ?? []), l]);
  }
  const names = [...groups.keys()].sort((a, b) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99 || a.localeCompare(b));
  list.innerHTML = names.length ? '' : '<p class="muted">No lenses match.</p>';
  for (const g of names) {
    const h = document.createElement('h5');
    h.textContent = g;
    list.append(h);
    for (const l of groups.get(g)!) {
      let attention = 0, total = 0;
      for (let i = 0; i < view.count; i++) {
        if (!view.present[i]) continue;
        const w = l.categories.find((c) => c.key === l.keyOf(i))?.weight ?? 0;
        if (w >= 0) total++;
        if (w > 0) attention++;
      }
      const b = document.createElement('button');
      b.className = 'lens-item';
      b.setAttribute('aria-current', String(l.id === lens().id));
      const pct = total ? Math.round((attention / total) * 100) : 0;
      b.innerHTML = `<span class="lbl"></span>${l.description && l.group === 'Deployments' ? `<span class="sub">${esc(l.description)}</span>` : ''}<span class="att${pct >= 10 ? ' hot' : ''}" title="${attention.toLocaleString()} need attention">${attention ? `${pct}%` : '—'}</span>`;
      b.querySelector('.lbl')!.textContent = l.label;
      b.onclick = () => {
        pop.hidden = true;
        setLens(l.id);
      };
      list.append(b);
    }
  }
}

// ---------------------------------------------------------------- KPIs

function renderKpis(): void {
  type Item = { v: string; unit?: string; l: string; c: string; act: () => void };
  let items: Item[];
  if (entity === 'people') {
    const k = peopleKpis(view.fleet, view.people, view.present);
    items = [
      { v: k.mfaPct.toFixed(1), unit: '%', l: 'Strong MFA', c: '#6ee7b7', act: () => isolate('mfa', (x) => x === 'weak' || x === 'none') },
      { v: k.dormant.toLocaleString(), l: 'Dormant 30+ days', c: '#a78bfa', act: () => isolate('signin', (x) => x === 'dormant30' || x === 'dormant90') },
      { v: k.risky.toLocaleString(), l: 'Risky users', c: '#fb923c', act: () => isolate('risk', (x) => x === 'medium' || x === 'high') },
      { v: k.leaversWithDevices.toLocaleString(), l: 'Disabled, still own a device', c: '#fb3d6b', act: () => isolate('signin', (x) => x === 'disabled') },
    ];
  } else {
    const k = kpis(view.fleet, view.facts, view.present);
    items = [
      { v: k.compliantPct.toFixed(1), unit: '%', l: 'Compliant', c: '#7dd3fc', act: () => isolate('compliance', (x) => x === 'noncompliant') },
      { v: k.currentPct.toFixed(1), unit: '%', l: 'On current patch', c: '#6ee7b7', act: () => isolate('patch', (x) => x === 'behind2') },
      { v: k.stale.toLocaleString(), l: 'Silent 14+ days', c: '#f472b6', act: () => isolate('checkin', (x) => x === 'stale') },
      { v: k.win10.toLocaleString(), l: 'Still on Windows 10', c: '#fb3d6b', act: () => isolate('release', (x) => x.startsWith('Win10')) },
    ];
  }
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

// ---------------------------------------------------------------- search

const searchInput = $<HTMLInputElement>('search');
searchInput.addEventListener('input', () => runSearch(searchInput.value));
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = matches.findIndex((m, i) => m === 1 && view.present[i] === 1);
    if (first >= 0 && query) select(first, true);
  }
  if (e.key === 'Escape') {
    searchInput.value = '';
    runSearch('');
    searchInput.blur();
  }
});

function runSearch(q: string): void {
  query = q.trim().toLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);
  for (let i = 0; i < view.count; i++) matches[i] = terms.every((x) => view.hay[i].includes(x)) ? 1 : 0;
  applyStyle();
}

// ---------------------------------------------------------------- detail panel

const panel = $('device');

function select(i: number, fly = false): void {
  selected = i;
  stars!.material.uniforms.uSelected.value = i;
  refreshPanel();
  if (entity === 'devices') {
    const owner = ownerOf(i);
    constellation.set(owner ? view.people.devices[owner.index] : []);
  }
  if (fly) {
    const p = stars!.pos;
    flyTo(new THREE.Vector3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]), 70);
  }
}

function closePanel(): void {
  selected = -1;
  if (stars) stars.material.uniforms.uSelected.value = -1;
  panel.hidden = true;
  constellation.set([]);
}

function ownerOf(i: number) {
  const upn = view.fleet.devices[i]?.user?.toLowerCase();
  if (!upn || !view.fleet.users) return null;
  const index = view.fleet.users.findIndex((u) => u.upn.toLowerCase() === upn);
  return index < 0 ? null : { index, user: view.fleet.users[index] };
}

function refreshPanel(): void {
  if (selected < 0) {
    panel.hidden = true;
    return;
  }
  const i = selected;
  panel.innerHTML = entity === 'people' ? userPanel(view, i) : devicePanel(view, i, ownerOf(i));
  panel.hidden = false;
  panel.querySelector('.close')!.addEventListener('click', closePanel);
  panel.querySelector('[data-act=copy]')?.addEventListener('click', () => {
    const text = entity === 'people' ? view.fleet.users![i].upn : view.fleet.devices[i].name;
    navigator.clipboard?.writeText(text).then(() => toast(`Copied ${text}`));
  });
  // Device panel: jump to the owner, or to a deployment's lens.
  panel.querySelector<HTMLElement>('[data-user]')?.addEventListener('click', (e) => {
    const u = Number((e.currentTarget as HTMLElement).dataset.user);
    setEntity('people');
    select(u, true);
  });
  for (const li of panel.querySelectorAll<HTMLElement>('[data-lens]')) li.addEventListener('click', () => setLens(li.dataset.lens!));
  // Person panel: jump to a device, or light up all of them.
  for (const li of panel.querySelectorAll<HTMLElement>('[data-device]')) {
    li.addEventListener('click', () => {
      setEntity('devices');
      select(Number(li.dataset.device), true);
    });
  }
  panel.querySelector('[data-act=constellation]')?.addEventListener('click', () => {
    const devs = view.people.devices[i];
    setEntity('devices');
    select(devs[0], false);
    const c = new THREE.Vector3();
    for (const d of devs) c.add(new THREE.Vector3(stars!.pos[d * 3], stars!.pos[d * 3 + 1], stars!.pos[d * 3 + 2]));
    c.divideScalar(devs.length);
    let r = 0;
    for (const d of devs) r = Math.max(r, c.distanceTo(new THREE.Vector3(stars!.pos[d * 3], stars!.pos[d * 3 + 1], stars!.pos[d * 3 + 2])));
    flyTo(c, Math.max(90, r * 2.6));
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
  intro = false;
});
addEventListener('pointerup', () => canvas.classList.remove('dragging'));
canvas.addEventListener('click', (e) => {
  if (Math.hypot(e.clientX - mouse.downX, e.clientY - mouse.downY) > 5) return;
  const i = pick(e.clientX, e.clientY);
  if (i >= 0) select(i, true);
  else closePanel();
});

function pick(x: number, y: number): number {
  if (!stars) return -1;
  const { pos, alpha, count } = stars;
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
  if (hover === i) return;
  hover = i;
  if (stars) stars.material.uniforms.uHover.value = i;
  canvas.classList.toggle('pointing', i >= 0);
  if (i < 0) {
    tooltip.hidden = true;
    return;
  }
  const l = lens();
  const key = l.keyOf(i);
  const c = l.categories.find((x) => x.key === key);
  const when = entity === 'people' ? (Number.isFinite(view.people.idle[i]) ? `signed in ${relativeAge(view.people.idle[i])}` : 'never signed in') : relativeAge(view.age[i]);
  tooltip.innerHTML = `<i style="--c:${c?.color ?? '#888'}"></i><b>${esc(view.names[i])}</b><span>${esc(c?.label ?? key)} · ${when}</span>`;
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
  const groups = layout.groups;
  if (!groups.length) return;
  let maxR = 0;
  const c = new THREE.Vector3();
  for (const g of groups) c.add(new THREE.Vector3(...g.center));
  c.divideScalar(groups.length);
  for (const g of groups) maxR = Math.max(maxR, c.distanceTo(new THREE.Vector3(...g.center)) + g.radius * 1.6);
  // Fit whichever screen dimension is tighter. The view is oblique, so depth
  // foreshortens and the vertical fit can be looser than the horizontal one.
  const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const tanH = tanV * camera.aspect;
  if (camera.aspect < 1) {
    // On a phone, look down from high above so the disc fills the tall screen.
    flyTo(c, Math.max(140, (maxR / tanH) * 0.85), duration, new THREE.Vector3(0, 2.2, 1));
    return;
  }
  flyTo(c, Math.max(140, (maxR / tanH) * 1.4, (maxR / tanV) * 0.8), duration);
}

// ---------------------------------------------------------------- time machine

const timeline = $('timeline');
const range = $<HTMLInputElement>('tl-range');
let playing = false;
let playClock = 0;
const DAY_SECONDS = 0.55;

function renderTimeline(): void {
  timeline.hidden = snapshots.length < 2;
  document.body.classList.toggle('has-timeline', snapshots.length > 1);
  if (snapshots.length < 2) return;
  range.max = String(snapshots.length - 1);
  range.value = String(t);
  renderTimelineDate();
  renderTimelineMetric();
}

function renderTimelineDate(): void {
  const d = new Date(snapshots[t].generated);
  $('tl-date').textContent = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  $<HTMLButtonElement>('tl-play').innerHTML = playing
    ? '<svg viewBox="0 0 16 16"><rect x="3.5" y="3" width="3" height="10" rx="1"/><rect x="9.5" y="3" width="3" height="10" rx="1"/></svg>'
    : '<svg viewBox="0 0 16 16"><path d="M4.5 2.5v11l9-5.5z"/></svg>';
}

function goTo(at: number, duration = 0.7): void {
  at = Math.max(0, Math.min(snapshots.length - 1, at));
  if (at === t) return;
  const before = view.present;
  t = at;
  view = getView(entity, t);
  const next = computeLayout(groupKeys(view), view.age, view.ids);
  layout = next;
  stars!.setPositions(next.positions, false, duration, 0.1);
  // Group membership can change over time; rebuild labels only when the set does.
  if (labels.length !== next.groups.length || labels.some((l, i) => l.element.querySelector('.n')!.textContent !== next.groups[i].name)) buildLabels();
  else labels.forEach((l, i) => l.position.set(next.groups[i].center[0], next.groups[i].center[1] + next.groups[i].radius * 0.55, next.groups[i].center[2]));
  cores.set(next.groups, next.groups.map(() => '#7dd3fc'));
  if (query) runSearch(query);
  else applyStyle(false, duration * 0.8);
  // New arrivals flash as they appear.
  for (let i = 0; i < view.count; i++) if (view.present[i] && !before[i]) stars!.pulse(i, 1);
  renderHeader();
  renderKpis();
  refreshPanel();
  range.value = String(t);
  renderTimelineDate();
  renderTimelineMetric();
}

function stopTimeline(): void {
  playing = false;
  if (snapshots.length > 1) renderTimelineDate();
}

$('tl-play').addEventListener('click', () => {
  if (playing) return stopTimeline();
  if (t >= snapshots.length - 1) goTo(0, 0.9);
  playing = true;
  playClock = 0;
  intro = false;
  renderTimelineDate();
});
range.addEventListener('input', () => {
  stopTimeline();
  goTo(Number(range.value), 0.35);
});

// Sparkline: share of stars needing attention under the current lens, per day.
const spark = new Map<string, number[]>();
let sparkJob = 0;

function attentionShare(v: View, lensId: string): number {
  const l = v.lenses.find((x) => x.id === lensId);
  if (!l) return NaN;
  const w = new Map(l.categories.map((c) => [c.key, c.weight]));
  let total = 0, bad = 0;
  for (let i = 0; i < v.count; i++) {
    if (!v.present[i]) continue;
    const x = w.get(l.keyOf(i)) ?? 0;
    if (x < 0) continue;
    total++;
    if (x > 0) bad++;
  }
  return total ? (bad / total) * 100 : 0;
}

function renderTimelineMetric(): void {
  if (snapshots.length < 2) return;
  const l = lens();
  const now = attentionShare(view, l.id);
  const attention = l.categories.some((c) => c.weight > 0);
  $('tl-metric').innerHTML = attention ? `<b>${now.toFixed(1)}%</b> need attention · ${esc(l.label)}` : esc(l.label);
  const key = `${entity}:${l.id}`;
  const series = spark.get(key);
  if (series) return drawSpark(series);
  drawSpark([]);
  // Building 60 views takes a moment; do it in slices so the page stays smooth.
  const job = ++sparkJob;
  const out: number[] = [];
  const e = entity;
  const stepJob = (k: number) => {
    if (job !== sparkJob) return;
    const end = Math.min(snapshots.length, k + 4);
    for (; k < end; k++) out.push(attentionShare(getView(e, k), l.id));
    if (k < snapshots.length) setTimeout(() => stepJob(k), 0);
    else {
      spark.set(key, out);
      if (key === `${entity}:${lens().id}`) drawSpark(out);
    }
  };
  setTimeout(() => stepJob(0), 30);
}

function drawSpark(series: number[]): void {
  const svg = $('tl-spark');
  const W = 600, H = 34;
  if (!series.length) {
    svg.querySelector('.line')!.setAttribute('d', '');
    svg.querySelector('.area')!.setAttribute('d', '');
    return;
  }
  const vals = series.map((v) => (Number.isFinite(v) ? v : 0));
  const max = Math.max(...vals), min = Math.min(...vals);
  const span = Math.max(max - min, 1);
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * W).toFixed(1)},${(H - 3 - ((v - min) / span) * (H - 8)).toFixed(1)}`);
  svg.querySelector('.line')!.setAttribute('d', `M${pts.join(' L')}`);
  svg.querySelector('.area')!.setAttribute('d', `M0,${H} L${pts.join(' L')} L${W},${H} Z`);
}

function stepTimeline(dt: number): void {
  if (!playing) return;
  playClock += dt;
  if (playClock < DAY_SECONDS) return;
  playClock = 0;
  if (t >= snapshots.length - 1) return stopTimeline();
  goTo(t + 1, DAY_SECONDS * 0.95);
}

// ---------------------------------------------------------------- simulated replay (single snapshot)

const replayPanel = $('replay');
const replayLive = $('replay-live');

function startReplay(): void {
  if (!stars || entity !== 'devices' || snapshots.length > 1) return;
  closePanel();
  lensChoice.devices = 'patch';
  hidden.clear();
  renderControls();
  applyStyle();
  const plan = planReplay(view.fleet, view.facts, layout.radial);
  replay = { plan, t: 0, playing: true };

  // Rewind: every device that ends up current starts the month one update behind.
  const behind = tmpColor.set('#fde68a').toArray();
  plan.installDay.forEach((day, i) => {
    if (Number.isFinite(day)) stars!.setColorNow(i, behind[0], behind[1], behind[2]);
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
  if (!replay || !replay.playing || !stars) return;
  const prev = replay.t;
  replay.t = Math.min(REPLAY_DAYS, replay.t + dt / 1.05);
  const now = replay.t;
  const current = tmpColor.set('#6ee7b7').toArray();
  let done = 0;
  replay.plan.installDay.forEach((day, i) => {
    if (day <= now) done++;
    if (day > prev && day <= now) {
      stars!.setColorNow(i, current[0], current[1], current[2]);
      stars!.pulse(i, 1);
    }
  });
  $('replay-day').textContent = String(Math.floor(now)).padStart(2, '0');
  $('replay-pct').textContent = `${((done / view.count) * 100).toFixed(0)}%`;
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

// ---------------------------------------------------------------- loading your own files

const fileInput = $<HTMLInputElement>('file-input');
$('load-btn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files?.length) readFiles([...fileInput.files]);
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
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length) readFiles(files);
});

/**
 * One fleet.json loads a snapshot; several load a history for the time
 * machine; a .csv adds custom fields to whatever is loaded.
 */
async function readFiles(files: File[]): Promise<void> {
  const csvs = files.filter((f) => /\.(csv|txt)$/i.test(f.name));
  const jsons = files.filter((f) => !csvs.includes(f));
  try {
    if (jsons.length) {
      const fleets: Fleet[] = [];
      for (const f of jsons) fleets.push(parseFleet(await f.text()));
      const tenants = new Set(fleets.map((f) => f.tenant));
      if (tenants.size > 1) throw new FleetError(`Those files come from different tenants (${[...tenants].join(', ')}).`);
      setSnapshots(fleets.length > 1 ? alignSnapshots(fleets) : fleets);
      const last = snapshots[snapshots.length - 1];
      toast(fleets.length > 1
        ? `Loaded ${fleets.length} snapshots from ${last.tenant}. Press play on the timeline.`
        : `Loaded ${last.devices.length.toLocaleString()} devices from ${last.tenant}`);
    }
    for (const f of csvs) {
      const res = mergeCsv(snapshots, await f.text());
      views.clear();
      spark.clear();
      const want: Entity = res.entity === 'user' ? 'people' : 'devices';
      if (want !== entity && (want === 'devices' || hasPeople())) entity = want;
      rebuild();
      renderTimeline();
      const firstLens = `${res.entity === 'user' ? 'ufield' : 'field'}:${res.fields[0]}`;
      if (view.lenses.some((l) => l.id === firstLens)) setLens(firstLens);
      toast(`Added ${res.fields.length} field${res.fields.length === 1 ? '' : 's'} from ${f.name} to ${res.matched.toLocaleString()} ${res.entity === 'user' ? 'people' : 'devices'} (matched on "${res.keyColumn}").`);
    }
  } catch (err) {
    toast(err instanceof FleetError ? err.message : `Couldn't read that file: ${(err as Error).message}`, true);
  }
}

// ---------------------------------------------------------------- misc UI

let toastTimer = 0;
function toast(msg: string, error = false): void {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast${error ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), error ? 6000 : 3500);
}

const help = $<HTMLDialogElement>('help');
$('help-btn').addEventListener('click', () => help.showModal());
help.addEventListener('click', (e) => {
  if (e.target === help) help.close();
});

$('controls-toggle').addEventListener('click', () => $('controls').classList.toggle('open'));

addEventListener('keydown', (e) => {
  if (help.open) return;
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName);
  if (e.key === '/' && !typing) {
    e.preventDefault();
    searchInput.focus();
    return;
  }
  if (typing) return;
  const quick = QUICK[entity];
  if (e.key >= '1' && e.key <= '4' && quick[+e.key - 1]) setLens(quick[+e.key - 1]);
  else if (e.key === 'l' || e.key === 'L') {
    e.preventDefault();
    openLensPicker();
  } else if (e.key === 'g' || e.key === 'G') {
    const builtIn = view.groupings.filter((g) => !g.id.startsWith('lens:'));
    const i = builtIn.findIndex((g) => g.id === groupChoice[entity]);
    setGroup(builtIn[(i + 1) % builtIn.length].id);
  } else if (e.key === 'p' || e.key === 'P') setEntity(entity === 'devices' ? 'people' : 'devices');
  else if (e.key === 'r' || e.key === 'R') startReplay();
  else if (e.key === 'ArrowLeft' && snapshots.length > 1) { stopTimeline(); goTo(t - 1, 0.4); }
  else if (e.key === 'ArrowRight' && snapshots.length > 1) { stopTimeline(); goTo(t + 1, 0.4); }
  else if (e.key === ' ') {
    e.preventDefault();
    if (snapshots.length > 1) $('tl-play').click();
    else controls.autoRotate = !controls.autoRotate;
  } else if (e.key === 'Escape') {
    if (replay) stopReplay();
    closePanel();
    if (hidden.size || query) {
      hidden.clear();
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
/** Set by capture.mjs so recordings only change where something actually happens. */
let frozenClock = false;

function frame(): void {
  tick(Math.min(clock.getDelta(), 0.05));
  requestAnimationFrame(frame);
}

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
  if (stars) {
    stars.update(dt, elapsed);
    stars.material.uniforms.uScale.value = (renderer.domElement.height / 900) * 230;
    constellation.update(stars.pos, elapsed);
  }
  (nebula.material as THREE.ShaderMaterial).uniforms.uTime.value = elapsed;
  stepReplay(dt);
  stepTimeline(dt);

  if (mouse.moved && mouse.inside) {
    mouse.moved = false;
    setHover(pick(mouse.x, mouse.y));
  }
  if (hover >= 0) {
    tooltip.style.left = `${mouse.x}px`;
    tooltip.style.top = `${mouse.y}px`;
  }

  // Fade labels that are far away or that the camera is inside.
  const camDist = camera.position.distanceTo(controls.target);
  labels.forEach((l, i) => {
    const g = layout.groups[i];
    if (!g) return;
    labelPos.set(...g.center);
    const d = camera.position.distanceTo(labelPos);
    const op = d < g.radius * 1.2 ? 0 : Math.max(0.25, Math.min(1, 1.6 - d / (camDist * 2.2)));
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
const params = new URLSearchParams(location.search);
const capture = params.has('capture');

setSnapshots([generateDemoFleet()], { keepCamera: true });
if (reducedMotion || capture) {
  intro = false;
  frameAll(0.01);
} else {
  // Open on a wide shot, then glide in.
  setTimeout(() => intro && frameAll(3.2), 250);
}
/** Upgrades the single demo snapshot to its 60-day history, after first paint so the page opens fast. */
function loadDemoHistory(delay: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(async () => {
      const history = await generateDemoHistoryAsync();
      // Skip it if someone loaded their own data in the meantime.
      if (snapshots.length === 1 && snapshots[0].demo) {
        const keepSelected = selected;
        setSnapshots(history, { keepCamera: true });
        if (keepSelected >= 0) select(keepSelected);
      }
      resolve();
    }, delay);
  });
}

const api = native();
let historyReady: Promise<void> = Promise.resolve();
if (api) {
  // Desktop app: the demo galaxy stays as a backdrop until the user's own snapshots load.
  void initDesktop(api, {
    loadSnapshots(jsons) {
      try {
        const fleets = jsons.map((j) => parseFleet(j));
        setSnapshots(fleets.length > 1 ? alignSnapshots(fleets) : fleets);
      } catch (err) {
        toast(`Couldn't read saved snapshots: ${(err as Error).message}`, true);
      }
    },
    loadDemo() {
      setSnapshots([generateDemoFleet()]);
      historyReady = loadDemoHistory(300);
    },
    toast,
    openFiles: () => fileInput.click(),
  });
} else {
  historyReady = loadDemoHistory(capture ? 0 : 600);
}
if (!capture) requestAnimationFrame(frame);

// Handy in the console and for scripts/capture.mjs: window.fleetGalaxy
Object.assign(window, {
  fleetGalaxy: {
    get view() { return view; },
    get snapshots() { return snapshots; },
    get t() { return t; },
    get layout() { return layout; },
    get stars() { return stars; },
    get historyReady() { return historyReady; },
    camera, controls, frameAll, flyTo, step, goTo, setEntity, setLens, setGroup, select, startReplay, readFiles,
    loadFleet: (f: Fleet) => setSnapshots([f]),
    play() { if (!playing) $('tl-play').click(); },
    freezeClock(on: boolean) { frozenClock = on; controls.autoRotate = !on; },
  },
});
