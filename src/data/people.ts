// Lenses and facts for the People galaxy: users as stars.

import { fieldLens, inferDef, NONE, type Category, type Lens } from './lenses';
import type { Fleet, User } from './types';

const DAY = 86_400_000;

const cat = (key: string, label: string, color: string, weight = 1): Category => ({ key, label, color, weight });
const NO_DATA: Category = { key: NONE, label: 'No data', color: '#475069', weight: -1 };

export interface PeopleFacts {
  /** Days since last sign-in; Infinity for never. */
  idle: Float32Array;
  /** Device indices per user. */
  devices: number[][];
  primaryLicense: string[];
}

/** License names roughly in order of "what tier is this person on". */
const LICENSE_RANK = ['E5', 'E3', 'Business Premium', 'Business Standard', 'F3', 'F1', 'Business Basic'];

export function primaryLicense(licenses: readonly string[] | undefined): string {
  if (!licenses?.length) return 'Unlicensed';
  const rank = (l: string) => {
    const i = LICENSE_RANK.findIndex((r) => l.includes(r));
    return i < 0 ? 99 : i;
  };
  return [...licenses].sort((a, b) => rank(a) - rank(b))[0];
}

export function computePeopleFacts(fleet: Fleet): PeopleFacts {
  const users = fleet.users ?? [];
  const gen = Date.parse(fleet.generated);
  const byUpn = new Map<string, number[]>();
  fleet.devices.forEach((d, i) => {
    if (!d.user) return;
    const k = d.user.toLowerCase();
    const list = byUpn.get(k);
    if (list) list.push(i);
    else byUpn.set(k, [i]);
  });
  return {
    idle: Float32Array.from(users, (u) => {
      const t = u.lastSignIn ? Date.parse(u.lastSignIn) : NaN;
      return Number.isNaN(t) ? Infinity : Math.max(0, (gen - t) / DAY);
    }),
    devices: users.map((u) => byUpn.get(u.upn.toLowerCase()) ?? []),
    primaryLicense: users.map((u) => primaryLicense(u.licenses)),
  };
}

export function signInBucket(idle: number, enabled: boolean): string {
  if (!enabled) return 'disabled';
  if (!Number.isFinite(idle)) return 'never';
  if (idle < 7) return 'active';
  if (idle < 30) return 'quiet';
  if (idle < 90) return 'dormant30';
  return 'dormant90';
}

const LICENSE_COLORS = ['#a5b4fc', '#7dd3fc', '#5eead4', '#fcd34d', '#f9a8d4', '#fdba74', '#c4b5fd'];

export function buildPeopleLenses(fleet: Fleet, pf: PeopleFacts): Lens[] {
  const u: User[] = fleet.users ?? [];
  const lenses: Lens[] = [
    {
      id: 'mfa', label: 'MFA strength', group: 'Identity', groupable: true,
      description: 'Strongest sign-in method each person has registered.',
      categories: [
        cat('passwordless', 'Passwordless', '#6ee7b7', 0),
        cat('strong', 'Authenticator app', '#7dd3fc', 0),
        cat('weak', 'SMS or voice only', '#fbbf24'),
        cat('none', 'No MFA', '#fb3d6b'),
        NO_DATA,
      ],
      keyOf: (i) => u[i].mfa ?? NONE,
    },
    {
      id: 'signin', label: 'Sign-in activity', group: 'Identity', groupable: true,
      categories: [
        cat('active', 'Active this week', '#a5f3fc', 0),
        cat('quiet', '7 to 30 days', '#60a5fa'),
        cat('dormant30', 'Dormant 30+ days', '#a78bfa'),
        cat('dormant90', 'Dormant 90+ days', '#f472b6'),
        cat('never', 'Never signed in', '#fb923c'),
        cat('disabled', 'Disabled account', '#64748b', 1),
      ],
      keyOf: (i) => signInBucket(pf.idle[i], u[i].enabled),
    },
    {
      id: 'risk', label: 'User risk', group: 'Identity', groupable: true,
      description: 'Entra ID Protection risk level (needs Entra ID P2).',
      categories: [
        cat('none', 'No risk', '#7dd3fc', 0),
        cat('low', 'Low', '#fde68a'),
        cat('medium', 'Medium', '#fb923c'),
        cat('high', 'High', '#fb3d6b'),
        NO_DATA,
      ],
      keyOf: (i) => u[i].risk ?? NONE,
    },
  ];

  const licenses = [...new Set(pf.primaryLicense)].sort((a, b) => (a === 'Unlicensed' ? 1 : b === 'Unlicensed' ? -1 : a.localeCompare(b)));
  lenses.push({
    id: 'license', label: 'License', group: 'Licensing', groupable: true,
    categories: licenses.map((l, i) => cat(l, l, l === 'Unlicensed' ? '#fb3d6b' : LICENSE_COLORS[i % LICENSE_COLORS.length], l === 'Unlicensed' ? 1 : 0)),
    keyOf: (i) => pf.primaryLicense[i],
  });

  lenses.push({
    id: 'devices', label: 'Windows devices', group: 'Licensing', groupable: true,
    description: 'Devices with this person as primary user.',
    categories: [cat('1', 'One device', '#7dd3fc', 0), cat('2', 'Two devices', '#a5b4fc', 0), cat('3', 'Three or more', '#f0abfc'), cat('0', 'No device', '#475069', -1)],
    keyOf: (i) => String(Math.min(pf.devices[i].length, 3)),
  });

  // "Licensed but idle": the license clean-up list.
  lenses.push({
    id: 'waste', label: 'License clean-up', group: 'Licensing', groupable: true,
    description: 'Licensed accounts that are disabled or have not signed in for 30+ days.',
    categories: [cat('ok', 'In use', '#7dd3fc', 0), cat('idle', 'Licensed, idle 30+ days', '#fbbf24'), cat('disabled', 'Licensed, disabled', '#fb3d6b'), cat('none', 'Unlicensed', '#475069', -1)],
    keyOf: (i) => {
      if (!u[i].licenses?.length) return 'none';
      if (!u[i].enabled) return 'disabled';
      return pf.idle[i] >= 30 ? 'idle' : 'ok';
    },
  });

  // Custom user fields.
  const present = new Set<string>();
  for (const x of u) if (x.fields) for (const k of Object.keys(x.fields)) present.add(k);
  for (const k of [...present].sort()) {
    const def = fleet.lenses?.find((l) => l.entity === 'user' && l.field === k) ?? inferDef(k, u);
    if (def) lenses.push({ ...fieldLens(def, u), id: `ufield:${k}` });
  }
  return lenses;
}

export interface PeopleKpis {
  total: number;
  mfaPct: number;
  dormant: number;
  risky: number;
  leaversWithDevices: number;
}

export function peopleKpis(fleet: Fleet, pf: PeopleFacts, present?: Uint8Array): PeopleKpis {
  const u = fleet.users ?? [];
  let mfa = 0, dormant = 0, risky = 0, leavers = 0, total = 0;
  u.forEach((x, i) => {
    if (present && !present[i]) return;
    total++;
    if (x.mfa === 'strong' || x.mfa === 'passwordless') mfa++;
    if (x.enabled && pf.idle[i] >= 30) dormant++;
    if (x.risk === 'medium' || x.risk === 'high') risky++;
    if (!x.enabled && pf.devices[i].length) leavers++;
  });
  return { total, mfaPct: (mfa / (total || 1)) * 100, dormant, risky, leaversWithDevices: leavers };
}
