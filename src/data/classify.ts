// Turns raw devices into the categories the galaxy colors and groups by.
// Everything here is pure so it can be tested without a GPU.

import { presenceOf } from './history';
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
export function patchLevels(devices: readonly Device[], present?: Uint8Array): PatchLevel[] {
  const families = new Map<number, Map<number, number>>();
  const parsed = devices.map((d, i) => {
    const { build, revision } = parseBuild(d.osVersion);
    const family = SERVICING_FAMILY[build] ?? build;
    // Placeholders for devices that don't exist in this snapshot mustn't vote.
    if (build && revision && (!present || present[i])) {
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

/** Per-device facts computed once per fleet, shared by color modes, layout and the HUD. */
export interface Facts {
  age: Float32Array;
  patch: PatchLevel[];
  release: string[];
}

export function computeFacts(fleet: Fleet): Facts {
  return {
    age: Float32Array.from(fleet.devices, (d) => Math.min(ageDays(d, fleet), 9999)),
    patch: patchLevels(fleet.devices, presenceOf(fleet)?.devices),
    release: fleet.devices.map((d) => releaseName(d.osVersion)),
  };
}

export function checkinBucket(age: number): string {
  if (age < 1) return 'day';
  if (age < 7) return 'week';
  if (age < 30) return 'month';
  return 'stale';
}

/** Built-in groupings; any groupable lens can also be used as "lens:<id>". */
export type GroupMode = 'site' | 'model' | 'release' | 'ring' | 'manufacturer' | `lens:${string}`;

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
    default:
      return 'Ungrouped';
  }
}

export interface Kpis {
  total: number;
  compliantPct: number;
  stale: number;
  currentPct: number;
  win10: number;
}

export function kpis(fleet: Fleet, facts: Facts, present?: Uint8Array): Kpis {
  let total = 0;
  let compliant = 0;
  let stale = 0;
  let current = 0;
  let win10 = 0;
  fleet.devices.forEach((d, i) => {
    if (present && !present[i]) return;
    total++;
    if (d.compliance === 'compliant') compliant++;
    if (facts.age[i] >= 14) stale++;
    if (facts.patch[i] === 'current') current++;
    if (isWindows10(d.osVersion)) win10++;
  });
  const n = total || 1;
  return {
    total,
    compliantPct: (compliant / n) * 100,
    stale,
    currentPct: (current / n) * 100,
    win10,
  };
}
