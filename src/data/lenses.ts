// Lenses are the questions you can ask the galaxy. Each one maps every star to
// a category with a color. They come from four places: built-in device facts,
// well-known fields (Defender, Endpoint Analytics, lifecycle), deployments,
// and any other custom field (described by fleet.lenses, or guessed).

import { checkinBucket, type Facts } from './classify';
import type { DeploymentKind, FieldValue, Fleet, LensDef } from './types';

export interface Category {
  key: string;
  label: string;
  color: string;
  /** 1 = needs attention (bigger star), 0 = fine, -1 = no data (dim). */
  weight: number;
}

export type LensGroup = 'Health' | 'Updates' | 'Deployments' | 'Security' | 'Experience' | 'Lifecycle' | 'Custom';

export interface Lens {
  id: string;
  label: string;
  group: LensGroup | string;
  description?: string;
  categories: Category[];
  keyOf(i: number): string;
  /** Group-by needs a manageable number of buckets. */
  groupable: boolean;
}

export const NONE = '__none';
const NO_DATA: Category = { key: NONE, label: 'No data', color: '#475069', weight: -1 };

const GOOD_RAMP = ['#6ee7b7', '#fde68a', '#fb923c', '#fb3d6b'];
const NEUTRAL_RAMP = ['#a5b4fc', '#7dd3fc', '#5eead4', '#fde68a', '#fdba74', '#f9a8d4'];
const PALETTE = ['#7dd3fc', '#a5b4fc', '#5eead4', '#fcd34d', '#f9a8d4', '#fdba74', '#c4b5fd', '#86efac', '#fca5a5', '#93c5fd', '#fde68a', '#d8b4fe'];

const cat = (key: string, label: string, color: string, weight = 1): Category => ({ key, label, color, weight });

// ---------------------------------------------------------------- built-in field lenses

/** Lenses for well-known field keys. They only appear when the fleet has that data. */
export const KNOWN_FIELDS: LensDef[] = [
  {
    field: 'defender.risk', label: 'Defender risk', group: 'Security', kind: 'category',
    description: 'Machine risk level reported by Microsoft Defender for Endpoint.',
    categories: [
      { key: 'none', label: 'No known risk', color: '#7dd3fc' },
      { key: 'low', label: 'Low', color: '#fde68a' },
      { key: 'medium', label: 'Medium', color: '#fb923c' },
      { key: 'high', label: 'High', color: '#fb3d6b' },
    ],
  },
  {
    field: 'defender.threats', label: 'Active threats', group: 'Security', kind: 'number',
    stops: [1], good: 'low', bucketLabels: ['None', 'Active threats'],
    description: 'Malware Defender has detected and not yet remediated.',
  },
  {
    field: 'defender.signatureAgeDays', label: 'AV signature age', group: 'Security', kind: 'number',
    stops: [1, 3, 7], good: 'low', bucketLabels: ['Under a day', '1 to 3 days', '3 to 7 days', 'Over a week'],
  },
  {
    field: 'defender.realtime', label: 'Real-time protection', group: 'Security', kind: 'category',
    categories: [
      { key: 'true', label: 'On', color: '#7dd3fc' },
      { key: 'false', label: 'Off', color: '#fb3d6b' },
    ],
  },
  {
    field: 'ea.startupScore', label: 'Startup performance', group: 'Experience', kind: 'number',
    stops: [50, 70, 85], good: 'high', bucketLabels: ['Poor (under 50)', 'Fair (50 to 70)', 'Good (70 to 85)', 'Great (85+)'],
    description: 'Endpoint Analytics startup score, 0 to 100.',
  },
  {
    field: 'ea.bootSeconds', label: 'Boot time', group: 'Experience', kind: 'number',
    stops: [30, 60, 120], good: 'low', unit: 's', bucketLabels: ['Under 30 s', '30 to 60 s', '1 to 2 min', 'Over 2 min'],
  },
  {
    field: 'ea.appReliability', label: 'App reliability', group: 'Experience', kind: 'number',
    stops: [50, 70, 85], good: 'high', bucketLabels: ['Poor (under 50)', 'Fair (50 to 70)', 'Good (70 to 85)', 'Great (85+)'],
    description: 'Endpoint Analytics app reliability score: crashes and hangs.',
  },
  {
    field: 'ea.batteryHealth', label: 'Battery health', group: 'Experience', kind: 'number',
    stops: [60, 80], good: 'high', unit: '%', bucketLabels: ['Under 60%', '60 to 80%', 'Over 80%'],
    description: 'Battery capacity left versus design capacity. Desktops show as no data.',
  },
  {
    field: 'lifecycle.win11', label: 'Windows 11 readiness', group: 'Lifecycle', kind: 'category',
    categories: [
      { key: 'onWin11', label: 'On Windows 11', color: '#7dd3fc' },
      { key: 'capable', label: 'Capable, not upgraded', color: '#fde68a' },
      { key: 'notCapable', label: 'Not capable', color: '#fb3d6b' },
    ],
  },
  {
    field: 'lifecycle.ageYears', label: 'Hardware age', group: 'Lifecycle', kind: 'number',
    stops: [2, 3, 4, 5], good: 'low', unit: 'y', bucketLabels: ['Under 2 years', '2 to 3 years', '3 to 4 years', '4 to 5 years', 'Over 5 years'],
  },
  {
    field: 'lifecycle.warrantyDays', label: 'Warranty remaining', group: 'Lifecycle', kind: 'number',
    stops: [0, 90, 365], good: 'high', bucketLabels: ['Expired', 'Under 90 days', '90 days to a year', 'Over a year'],
  },
];

// ---------------------------------------------------------------- deployments

const DEPLOYMENT_CATEGORIES: Record<DeploymentKind, Category[]> = {
  app: [
    cat('success', 'Installed', '#7dd3fc', 0),
    cat('failed', 'Failed', '#fb3d6b'),
    cat('pending', 'Pending', '#fde68a'),
    cat('notApplicable', 'Not applicable', '#64748b', -1),
  ],
  profile: [
    cat('success', 'Succeeded', '#7dd3fc', 0),
    cat('conflict', 'Conflict', '#f0abfc'),
    cat('failed', 'Error', '#fb3d6b'),
    cat('pending', 'Pending', '#fde68a'),
    cat('notApplicable', 'Not applicable', '#64748b', -1),
  ],
  remediation: [
    cat('success', 'Without issues', '#7dd3fc', 0),
    cat('fixed', 'Issue fixed', '#6ee7b7', 0),
    cat('recurred', 'Issue recurred', '#fb923c'),
    cat('failed', 'Failed', '#fb3d6b'),
    cat('pending', 'Not run yet', '#fde68a'),
  ],
};
const UNTARGETED: Category = { key: 'untargeted', label: 'Not targeted', color: '#2c3350', weight: -1 };

export const DEPLOYMENT_KIND_LABEL: Record<DeploymentKind, string> = {
  app: 'App',
  profile: 'Configuration profile',
  remediation: 'Remediation',
};

// ---------------------------------------------------------------- building

/** Anything with custom fields: devices, users. */
export type HasFields = { fields?: Record<string, FieldValue> };

function fieldOf(d: HasFields, key: string): FieldValue | undefined {
  return d.fields?.[key];
}

/** Builds a lens for one field from its definition. */
export function fieldLens(def: LensDef, devices: readonly HasFields[]): Lens {
  const id = `field:${def.field}`;
  const base = { id, label: def.label, group: def.group ?? 'Custom', description: def.description };

  if (def.kind === 'category') {
    const listed = def.categories ?? [];
    const known = new Set(listed.map((c) => c.key));
    // Values that appear in the data but weren't described still get a color.
    const extra = [...new Set(devices.map((d) => fieldOf(d, def.field)).filter((v) => v != null).map(String))]
      .filter((k) => !known.has(k))
      .sort();
    const categories: Category[] = [
      ...listed.map((c, i) => cat(c.key, c.label, c.color ?? PALETTE[i % PALETTE.length], i === 0 ? 0 : 1)),
      ...extra.map((k, i) => cat(k, k, PALETTE[(listed.length + i) % PALETTE.length], listed.length ? 1 : 0)),
      NO_DATA,
    ];
    if (!listed.length) for (const c of categories) if (c.weight > 0) c.weight = 0;
    return {
      ...base,
      categories,
      groupable: categories.length <= 17,
      keyOf: (i) => {
        const v = fieldOf(devices[i], def.field);
        return v == null ? NONE : String(v);
      },
    };
  }

  const values = devices.map((d) => fieldOf(d, def.field)).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const stops = def.stops?.length ? [...def.stops].sort((a, b) => a - b) : quantileStops(values);
  const n = stops.length + 1;
  const labels = def.bucketLabels?.length === n ? def.bucketLabels : rangeLabels(stops, def.unit);
  // Healthy end first so it gets the small, quiet stars.
  const order = def.good === 'high' ? [...Array(n).keys()].reverse() : [...Array(n).keys()];
  const ramp = def.good ? spread(GOOD_RAMP, n) : spread(NEUTRAL_RAMP, n);
  const categories: Category[] = order.map((b, rank) => cat(`b${b}`, labels[b], ramp[rank], def.good ? (rank === 0 ? 0 : 1) : 0));
  categories.push(NO_DATA);
  return {
    ...base,
    categories,
    groupable: true,
    keyOf: (i) => {
      const v = fieldOf(devices[i], def.field);
      if (typeof v !== 'number' || !Number.isFinite(v)) return NONE;
      let b = 0;
      while (b < stops.length && v >= stops[b]) b++;
      return `b${b}`;
    },
  };
}

/** Guesses a definition for a field nobody described. Returns null if it can't be a lens. */
export function inferDef(field: string, devices: readonly HasFields[]): LensDef | null {
  const vals = devices.map((d) => fieldOf(d, field)).filter((v) => v != null) as (string | number | boolean)[];
  if (!vals.length) return null;
  const label = prettyField(field);
  if (vals.every((v) => typeof v === 'boolean')) {
    return { field, label, kind: 'category', categories: [{ key: 'true', label: 'Yes' }, { key: 'false', label: 'No' }] };
  }
  if (vals.every((v) => typeof v === 'number')) return { field, label, kind: 'number' };
  const distinct = new Set(vals.map(String));
  if (distinct.size <= 16) return { field, label, kind: 'category' };
  return null;
}

export function prettyField(field: string): string {
  const last = field.split('.').pop() ?? field;
  const words = last.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function quantileStops(values: number[]): number[] {
  const v = [...new Set(values)].sort((a, b) => a - b);
  if (v.length <= 1) return [];
  if (v.length <= 5) return v.slice(1);
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.floor(p * (sorted.length - 1))];
  return [...new Set([q(0.25), q(0.5), q(0.75)].map((x) => round(x)))];
}

function round(x: number): number {
  const m = Math.abs(x) >= 100 ? 1 : Math.abs(x) >= 10 ? 10 : 100;
  return Math.round(x * m) / m;
}

function rangeLabels(stops: number[], unit = ''): string[] {
  const u = unit ? ` ${unit}` : '';
  if (!stops.length) return ['All'];
  const labels = [`Under ${stops[0]}${u}`];
  for (let i = 1; i < stops.length; i++) labels.push(`${stops[i - 1]} to ${stops[i]}${u}`);
  labels.push(`${stops[stops.length - 1]}${u} and up`);
  return labels;
}

/** Picks n colors spread across a ramp, keeping both ends. */
function spread(ramp: string[], n: number): string[] {
  if (n <= 1) return [ramp[0]];
  return Array.from({ length: n }, (_, i) => ramp[Math.round((i / (n - 1)) * (ramp.length - 1))]);
}

const RELEASE_COLORS = ['#a5b4fc', '#5eead4', '#fcd34d', '#fb7185', '#f0abfc', '#93c5fd', '#fdba74'];

/** Newest release first, Windows 10 last. */
export function releaseOrder(a: string, b: string): number {
  const num = (s: string) => {
    const m = /Win(\d+) (\d\d)H(\d)/.exec(s);
    return m ? +m[1] * 1000 + +m[2] * 10 + +m[3] : 0;
  };
  return num(b) - num(a) || a.localeCompare(b);
}

export function buildLenses(fleet: Fleet, facts: Facts): Lens[] {
  const d = fleet.devices;
  const releases = [...new Set(facts.release)].sort(releaseOrder);
  const lenses: Lens[] = [
    {
      id: 'compliance', label: 'Compliance', group: 'Health', groupable: true,
      categories: [
        cat('compliant', 'Compliant', '#7dd3fc', 0),
        cat('ingrace', 'In grace period', '#fbbf24'),
        cat('noncompliant', 'Not compliant', '#fb3d6b'),
        cat('unknown', 'Unknown', '#64748b', -1),
      ],
      keyOf: (i) => d[i].compliance,
    },
    {
      id: 'checkin', label: 'Last check-in', group: 'Health', groupable: true,
      categories: [
        cat('day', 'Under 24 hours', '#a5f3fc', 0),
        cat('week', '1 to 7 days', '#60a5fa'),
        cat('month', '7 to 30 days', '#a78bfa'),
        cat('stale', 'Over 30 days', '#f472b6'),
      ],
      keyOf: (i) => checkinBucket(facts.age[i]),
    },
    {
      id: 'release', label: 'Windows release', group: 'Updates', groupable: true,
      categories: releases.map((r, i) =>
        cat(r, r, r.startsWith('Win10') ? '#fb3d6b' : RELEASE_COLORS[i % RELEASE_COLORS.length], r.startsWith('Win10') ? 1 : 0),
      ),
      keyOf: (i) => facts.release[i],
    },
    {
      id: 'patch', label: 'Patch level', group: 'Updates', groupable: true,
      categories: [
        cat('current', 'Current', '#6ee7b7', 0),
        cat('behind1', '1 update behind', '#fde68a'),
        cat('behind2', '2+ behind', '#fb923c'),
        cat('unknown', 'Unknown', '#64748b', -1),
      ],
      keyOf: (i) => facts.patch[i],
    },
  ];

  if (d.some((x) => x.encrypted !== undefined)) {
    lenses.push({
      id: 'bitlocker', label: 'BitLocker', group: 'Health', groupable: true,
      categories: [cat('true', 'Encrypted', '#7dd3fc', 0), cat('false', 'Not encrypted', '#fb3d6b'), NO_DATA],
      keyOf: (i) => (d[i].encrypted === undefined ? NONE : String(d[i].encrypted)),
    });
  }

  // Fields: described ones (fleet.lenses beats built-in), then guessed ones.
  const present = new Set<string>();
  for (const x of d) if (x.fields) for (const k of Object.keys(x.fields)) present.add(k);
  const defs = new Map<string, LensDef>();
  for (const def of KNOWN_FIELDS) if (present.has(def.field)) defs.set(def.field, def);
  for (const def of fleet.lenses ?? []) if ((def.entity ?? 'device') === 'device' && present.has(def.field)) defs.set(def.field, def);
  for (const k of [...present].sort()) {
    if (defs.has(k)) continue;
    const def = inferDef(k, d);
    if (def) defs.set(k, def);
  }
  for (const def of defs.values()) lenses.push(fieldLens(def, d));

  // Hardware age falls back to time since enrollment when no real age is known.
  if (!present.has('lifecycle.ageYears') && d.some((x) => x.enrolled)) {
    const def: LensDef = {
      field: '__enrolledYears', label: 'Time since enrollment', group: 'Lifecycle', kind: 'number',
      stops: [1, 2, 3, 4], good: 'low', bucketLabels: ['Under a year', '1 to 2 years', '2 to 3 years', '3 to 4 years', 'Over 4 years'],
      description: 'A stand-in for hardware age when the export has none.',
    };
    const gen = Date.parse(fleet.generated);
    const years = d.map((x) => ({ fields: { __enrolledYears: x.enrolled ? (gen - Date.parse(x.enrolled)) / (365.25 * 86_400_000) : null } }));
    lenses.push(fieldLens(def, years));
  }

  // One lens per deployment.
  const index = new Map(d.map((x, i) => [x.id, i]));
  for (const dep of fleet.deployments ?? []) {
    const statuses = new Array<string>(d.length).fill(UNTARGETED.key);
    for (const [id, s] of Object.entries(dep.status)) {
      const i = index.get(id);
      if (i !== undefined) statuses[i] = s;
    }
    lenses.push({
      id: `deploy:${dep.id}`,
      label: dep.name,
      group: 'Deployments',
      description: DEPLOYMENT_KIND_LABEL[dep.kind],
      categories: [...DEPLOYMENT_CATEGORIES[dep.kind], UNTARGETED],
      groupable: true,
      keyOf: (i) => statuses[i],
    });
  }

  return lenses;
}

export const LENS_GROUP_ORDER = ['Health', 'Updates', 'Deployments', 'Security', 'Experience', 'Lifecycle', 'Custom'];
