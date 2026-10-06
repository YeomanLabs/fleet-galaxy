// Turns raw devices into the categories the galaxy colors and groups by.
// Everything here is pure so it can be tested without a GPU.

import type { Device, Fleet } from './types';

const DAY = 86_400_000;

const RELEASES: Record<number, string> = {
  19044: 'Win10 21H2',
  19045: 'Win10 22H2',
  22621: 'Win11 22H2',
  22631: 'Win11 23H2',
  26100: 'Win11 24H2',
  26200: 'Win11 25H2',
  28000: 'Win11 26H1',
};

/** Builds that share one cumulative update stream (same revision numbers). */
const SERVICING_FAMILY: Record<number, number> = { 26200: 26100, 22631: 22621 };

export function parseBuild(osVersion: string): { build: number; revision: number } {
  const parts = osVersion.split('.').map((p) => parseInt(p, 10));
  // Accept both "10.0.26100.6899" and "26100.6899".
  const [build, revision] = parts.length >= 4 ? [parts[2], parts[3]] : [parts[0], parts[1]];
  return { build: build || 0, revision: revision || 0 };
}

export function releaseName(osVersion: string): string {
  const { build } = parseBuild(osVersion);
  return RELEASES[build] ?? (build ? `Build ${build}` : 'Unknown');
}

export function isWindows10(osVersion: string): boolean {
  const { build } = parseBuild(osVersion);
  return build > 0 && build < 22000;
}

export function ageDays(device: Device, fleet: Fleet): number {
  const t = Date.parse(device.lastSync);
  if (Number.isNaN(t)) return Infinity;
  return Math.max(0, (Date.parse(fleet.generated) - t) / DAY);
}

export type PatchLevel = 'current' | 'behind1' | 'behind2' | 'unknown';

/**
 * Ranks each device's revision against the revisions the rest of the fleet runs.
 * Real exports carry no release calendar, so "current" means the newest revision
 * that a meaningful share of the same servicing family is on. Stray preview or
 * out-of-band builds below that share don't count as their own rank.
 */
export function patchLevels(devices: readonly Device[]): PatchLevel[] {
  const families = new Map<number, Map<number, number>>();
  const parsed = devices.map((d) => {
    const { build, revision } = parseBuild(d.osVersion);
    const family = SERVICING_FAMILY[build] ?? build;
    if (build && revision) {
      const revs = families.get(family) ?? new Map<number, number>();
      revs.set(revision, (revs.get(revision) ?? 0) + 1);
      families.set(family, revs);
    }
    return { family, revision, ok: build > 0 && revision > 0 };
  });

  const significant = new Map<number, number[]>();
  for (const [family, revs] of families) {
    let total = 0;
    for (const n of revs.values()) total += n;
    const floor = Math.max(3, total * 0.005);
    const keep = [...revs].filter(([, n]) => n >= floor).map(([r]) => r).sort((a, b) => b - a);
    significant.set(family, keep);
  }

  return parsed.map(({ family, revision, ok }) => {
    if (!ok) return 'unknown';
    const keep = significant.get(family) ?? [];
    const newer = keep.filter((r) => r > revision).length;
    return newer === 0 ? 'current' : newer === 1 ? 'behind1' : 'behind2';
  });
}

export interface Category {
  key: string;
  label: string;
  color: string;
}

export interface ColorMode {
  id: 'compliance' | 'checkin' | 'release' | 'patch';
  label: string;
  categories: Category[];
}

/** Per-device facts computed once per fleet, shared by color modes, layout and the HUD. */
export interface Facts {
  age: Float32Array;
  patch: PatchLevel[];
  release: string[];
}

export function computeFacts(fleet: Fleet): Facts {
  return {
    age: Float32Array.from(fleet.devices, (d) => Math.min(ageDays(d, fleet), 9999)),
    patch: patchLevels(fleet.devices),
    release: fleet.devices.map((d) => releaseName(d.osVersion)),
  };
}

export function checkinBucket(age: number): string {
  if (age < 1) return 'day';
  if (age < 7) return 'week';
  if (age < 30) return 'month';
  return 'stale';
}

const RELEASE_COLORS = ['#a5b4fc', '#5eead4', '#fcd34d', '#fb7185', '#f0abfc', '#93c5fd', '#fdba74'];

export function colorModes(facts: Facts): ColorMode[] {
  const releases = [...new Set(facts.release)].sort(releaseOrder);
  return [
    {
      id: 'compliance',
      label: 'Compliance',
      categories: [
        { key: 'compliant', label: 'Compliant', color: '#7dd3fc' },
        { key: 'ingrace', label: 'In grace period', color: '#fbbf24' },
        { key: 'noncompliant', label: 'Not compliant', color: '#fb3d6b' },
        { key: 'unknown', label: 'Unknown', color: '#64748b' },
      ],
    },
    {
      id: 'checkin',
      label: 'Check-in',
      categories: [
        { key: 'day', label: 'Under 24 hours', color: '#a5f3fc' },
        { key: 'week', label: '1 to 7 days', color: '#60a5fa' },
        { key: 'month', label: '7 to 30 days', color: '#a78bfa' },
        { key: 'stale', label: 'Over 30 days', color: '#f472b6' },
      ],
    },
    {
      id: 'release',
      label: 'Windows',
      categories: releases.map((r, i) => ({
        key: r,
        label: r,
        color: r.startsWith('Win10') ? '#fb3d6b' : RELEASE_COLORS[i % RELEASE_COLORS.length],
      })),
    },
    {
      id: 'patch',
      label: 'Patch level',
      categories: [
        { key: 'current', label: 'Current', color: '#6ee7b7' },
        { key: 'behind1', label: '1 update behind', color: '#fde68a' },
        { key: 'behind2', label: '2+ behind', color: '#fb923c' },
        { key: 'unknown', label: 'Unknown', color: '#64748b' },
      ],
    },
  ];
}

/** Newest release first, Windows 10 last. */
function releaseOrder(a: string, b: string): number {
  const num = (s: string) => {
    const m = /Win(\d+) (\d\d)H(\d)/.exec(s);
    return m ? +m[1] * 1000 + +m[2] * 10 + +m[3] : 0;
  };
  return num(b) - num(a) || a.localeCompare(b);
}

export function categoryOf(mode: ColorMode['id'], i: number, fleet: Fleet, facts: Facts): string {
  switch (mode) {
    case 'compliance':
      return fleet.devices[i].compliance;
    case 'checkin':
      return checkinBucket(facts.age[i]);
    case 'release':
      return facts.release[i];
    case 'patch':
      return facts.patch[i];
  }
}

export type GroupMode = 'site' | 'model' | 'release' | 'ring' | 'manufacturer';

export const GROUP_MODES: { id: GroupMode; label: string }[] = [
  { id: 'site', label: 'Site' },
  { id: 'ring', label: 'Update ring' },
  { id: 'release', label: 'Windows release' },
  { id: 'manufacturer', label: 'Manufacturer' },
  { id: 'model', label: 'Model' },
];

export function groupOf(mode: GroupMode, i: number, fleet: Fleet, facts: Facts): string {
  const d = fleet.devices[i];
  switch (mode) {
    case 'site':
      return d.site || 'Unassigned';
    case 'model':
      return d.model || 'Unknown model';
    case 'release':
      return facts.release[i];
    case 'ring':
      return d.ring || 'Unassigned';
    case 'manufacturer':
      return d.manufacturer || 'Unknown';
  }
}

export interface Kpis {
  total: number;
  compliantPct: number;
  stale: number;
  currentPct: number;
  win10: number;
}

export function kpis(fleet: Fleet, facts: Facts): Kpis {
  const n = fleet.devices.length || 1;
  let compliant = 0;
  let stale = 0;
  let current = 0;
  let win10 = 0;
  fleet.devices.forEach((d, i) => {
    if (d.compliance === 'compliant') compliant++;
    if (facts.age[i] >= 14) stale++;
    if (facts.patch[i] === 'current') current++;
    if (isWindows10(d.osVersion)) win10++;
  });
  return {
    total: fleet.devices.length,
    compliantPct: (compliant / n) * 100,
    stale,
    currentPct: (current / n) * 100,
    win10,
  };
}
