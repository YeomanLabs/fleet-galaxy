// Generates a believable fictional fleet for the public demo. Seeded, so every
// visitor sees the same galaxy. No real tenant data is involved anywhere.
// Things are correlated on purpose (old models boot slowly, Windows 10 devices
// fail more installs, remote laptops struggle with the VPN) so each lens tells
// a story instead of showing noise.

import { gaussian, mulberry32, pickWeighted } from './rng';
import type { Compliance, Deployment, DeploymentStatus, Device, Fleet, MfaStrength, Risk, User } from './types';

const DAY = 86_400_000;

const SITES = [
  ['Milwaukee HQ', 'MKE', 1080],
  ['Madison', 'MSN', 510],
  ['Chicago', 'CHI', 470],
  ['Minneapolis', 'MSP', 400],
  ['Remote workforce', 'RMT', 560],
  ['Green Bay', 'GRB', 250],
  ['Dallas', 'DAL', 160],
  ['Retail kiosks', 'KSK', 70],
] as const;

interface ModelSpec {
  manufacturer: string;
  model: string;
  kind: 'LT' | 'DT';
  weight: number;
  /** Hardware age range in years. */
  age: [number, number];
  /** Typical Endpoint Analytics startup score. */
  score: number;
}

const MODELS: ModelSpec[] = [
  { manufacturer: 'Dell Inc.', model: 'Latitude 7450', kind: 'LT', weight: 30, age: [0.2, 1.6], score: 88 },
  { manufacturer: 'Dell Inc.', model: 'Latitude 5440', kind: 'LT', weight: 18, age: [1, 2.6], score: 79 },
  { manufacturer: 'HP', model: 'EliteBook 840 G11', kind: 'LT', weight: 16, age: [0.3, 1.8], score: 84 },
  { manufacturer: 'LENOVO', model: 'ThinkPad T14 Gen 5', kind: 'LT', weight: 12, age: [0.3, 1.6], score: 86 },
  { manufacturer: 'Microsoft Corporation', model: 'Surface Laptop 7', kind: 'LT', weight: 8, age: [0.1, 1.2], score: 91 },
  { manufacturer: 'Dell Inc.', model: 'OptiPlex 7020', kind: 'DT', weight: 11, age: [0.5, 2.5], score: 82 },
  { manufacturer: 'Dell Inc.', model: 'Latitude 7420', kind: 'LT', weight: 5, age: [3.6, 5.4], score: 58 },
];
const KIOSK: ModelSpec = { manufacturer: 'Dell Inc.', model: 'OptiPlex Micro 7020', kind: 'DT', weight: 1, age: [1, 6.2], score: 64 };

const RINGS = ['Ring 0 · IT pilot', 'Ring 1 · Early adopters', 'Ring 2 · Broad', 'Ring 3 · Critical systems'];
const RING_WEIGHTS = [
  [0, 2],
  [1, 10],
  [2, 78],
  [3, 10],
] as const;

/** Cumulative update revisions, newest first. 26100 and 26200 share a stream. */
export const REVISIONS: Record<number, number[]> = {
  26100: [6899, 6584, 4946, 4652],
  22631: [6060, 5909, 5768, 5624],
  19045: [6456, 6332, 6218, 6093],
};

const REASONS = [
  ['Firewall disabled', 8],
  ['Secure Boot off', 6],
  ['Antivirus signatures out of date', 10],
  ['Defender real-time protection off', 16],
] as const;

const FIRST = ['alex', 'sam', 'jordan', 'taylor', 'morgan', 'casey', 'riley', 'jamie', 'drew', 'avery', 'quinn', 'reese', 'parker', 'rowan', 'skyler', 'devon', 'emerson', 'hayden', 'kai', 'logan', 'marlo', 'noel', 'oakley', 'peyton', 'sage', 'tatum', 'blair', 'cameron', 'dakota', 'ellis', 'frankie', 'harper', 'indigo', 'jules', 'kendall', 'lennon', 'micah', 'nico', 'remy', 'shay'];
const LAST = ['nguyen', 'patel', 'garcia', 'kowalski', 'schmidt', 'johnson', 'okafor', 'larsen', 'muller', 'rossi', 'kim', 'olsen', 'hernandez', 'novak', 'berg', 'chen', 'dubois', 'fischer', 'haas', 'iverson', 'jansen', 'keller', 'lindqvist', 'moreau', 'nakamura', 'ortiz', 'price', 'reyes', 'sato', 'vogel', 'abara', 'brandt', 'castillo', 'dalton', 'eriksen', 'farah', 'gruber', 'holm', 'ivanova', 'jovic'];

const DEPARTMENTS: Record<string, readonly (readonly [string, number])[]> = {
  default: [['Sales', 18], ['Engineering', 20], ['Finance', 10], ['Operations', 16], ['Customer Support', 14], ['HR', 5], ['IT', 6], ['Marketing', 8], ['Executive', 2]],
  plant: [['Manufacturing', 52], ['Operations', 18], ['Engineering', 14], ['Quality', 10], ['IT', 3], ['HR', 3]],
  remote: [['Sales', 40], ['Customer Support', 25], ['Engineering', 20], ['Marketing', 10], ['Finance', 5]],
};

const REMEDIATION_BASE = 'https://github.com/YeomanLabs/intune-remediations/tree/main/remediations/';

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function generateDemoFleet(seed = 20261006, generated = '2026-10-06T14:00:00Z'): Fleet {
  const rand = mulberry32(seed);
  const now = Date.parse(generated);
  const devices: Device[] = [];
  const usedNames = new Set<string>();
  const usedUpns = new Map<string, number>();

  const newUpn = () => {
    const f = FIRST[Math.floor(rand() * FIRST.length)];
    const l = LAST[Math.floor(rand() * LAST.length)];
    const base = `${f}.${l}`;
    const n = (usedUpns.get(base) ?? 0) + 1;
    usedUpns.set(base, n);
    return { upn: `${base}${n > 1 ? n : ''}@contoso.com`, name: `${titleCase(f)} ${titleCase(l)}` };
  };

  // People first; devices are handed out to them below.
  interface Person { upn: string; name: string; site: string; dept: string; devices: number }
  const people: Person[] = [];
  const peopleBySite = new Map<string, Person[]>();

  for (const [site, code, count] of SITES) {
    const siteDrift = site === 'Remote workforce' ? 2.2 : site === 'Retail kiosks' ? 1.6 : 1;
    const siteLegacy = site === 'Dallas' ? 0.22 : site === 'Retail kiosks' ? 0.45 : 0.035;
    const deptTable = code === 'GRB' || code === 'DAL' ? DEPARTMENTS.plant : code === 'RMT' ? DEPARTMENTS.remote : DEPARTMENTS.default;
    const sitePeople: Person[] = [];
    peopleBySite.set(site, sitePeople);

    for (let n = 0; n < count; n++) {
      const kiosk = code === 'KSK';
      const spec = kiosk ? KIOSK : pickWeighted(rand, MODELS.map((m) => [m, m.weight] as const));
      const { manufacturer, model, kind } = spec;
      const ring = kiosk ? 3 : pickWeighted(rand, RING_WEIGHTS);
      const hwAge = spec.age[0] + rand() * (spec.age[1] - spec.age[0]);

      // Check-in age: mostly hours, a long tail of travellers and forgotten devices.
      let age = -Math.log(Math.max(rand(), 1e-6)) * 0.35 * siteDrift;
      const tail = rand();
      if (tail < 0.06 * siteDrift) age = 7 + rand() * 40;
      if (tail < 0.018 * siteDrift) age = 30 + rand() * 120;
      if (code === 'RMT' && rand() < 0.08) age += 2 + rand() * 6;

      // Release mix. Older models and some sites hang on to older builds.
      const legacyBias = model === 'Latitude 7420' ? 0.18 : 0;
      const r = rand();
      let build: number;
      if (r < siteLegacy + legacyBias * 0.4) build = 19045;
      else if (r < siteLegacy + legacyBias + 0.09) build = 22631;
      else if (r < 0.62) build = 26100;
      else build = 26200;
      if (model === 'Surface Laptop 7') build = 26100 + (rand() < 0.5 ? 100 : 0);

      // Patch level follows ring cadence and how recently the device checked in.
      const revs = REVISIONS[build === 26200 ? 26100 : build];
      let behind = 0;
      const lag = [0.02, 0.06, 0.16, 0.34][ring];
      if (rand() < lag) behind = 1;
      if (age > 20 || rand() < lag * 0.25) behind = 2 + Math.floor(rand() * 2);
      const revision = revs[Math.min(behind, revs.length - 1)];

      // Defender.
      const realtime = rand() > 0.015;
      const sigAge = Math.max(0.05, Math.min(age, 60) * (0.6 + rand() * 0.5) + (realtime ? 0 : 3 + rand() * 6));
      const threats = rand() < (build === 19045 ? 0.02 : 0.005) ? 1 + Math.floor(rand() * 2) : 0;

      // Compliance falls out of the device's state rather than being random.
      const encrypted = rand() > (kind === 'DT' ? 0.05 : 0.02);
      const reasons: string[] = [];
      if (!encrypted) reasons.push('BitLocker not enabled');
      if ((build === 19045 || behind >= 2) && rand() < 0.55) reasons.push('OS version below minimum');
      if (age > 30) reasons.push('Not checked in within 30 days');
      if (!realtime) reasons.push('Defender real-time protection off');
      if (sigAge > 7 && rand() < 0.5) reasons.push('Antivirus signatures out of date');
      if (rand() < 0.012) reasons.push(pickWeighted(rand, REASONS));
      const unique = [...new Set(reasons)];

      let compliance: Compliance = 'compliant';
      if (unique.length) compliance = age < 3 && rand() < 0.35 ? 'ingrace' : 'noncompliant';
      if (rand() < 0.012) compliance = 'unknown';

      // Defender device state: mostly clean, threats make it critical.
      let defState: string = pickWeighted(rand, [['clean', 93], ['fullScanPending', 2.5], ['rebootPending', 3], ['manualStepsPending', 1], ['offlineScanPending', 0.5]] as const);
      if (threats) defState = rand() < 0.6 ? 'critical' : 'manualStepsPending';

      // Endpoint Analytics: model sets the baseline, neglect drags it down.
      const hasEa = rand() < 0.93 && age < 30;
      const startup = clamp(spec.score + gaussian(rand) * 7 - (build === 19045 ? 6 : 0), 12, 100);
      const boot = Math.max(9, 14 + (100 - startup) * 1.6 + gaussian(rand) * 8);
      const reliability = clamp(84 + gaussian(rand) * 9 - (build === 19045 ? 9 : 0) - (behind >= 2 ? 6 : 0), 8, 100);
      const battery = kind === 'LT' ? clamp(100 - hwAge * 7.5 - rand() * 9 + gaussian(rand) * 3, 31, 100) : null;

      // Lifecycle: three-year warranty, a fifth of new Latitudes bought with five.
      const warrantyYears = model === 'Latitude 7450' && rand() < 0.2 ? 5 : 3;
      const warrantyDays = Math.round((warrantyYears - hwAge) * 365 + gaussian(rand) * 20);
      const win11 = build >= 22000 ? 'onWin11' : kiosk && hwAge > 4.5 ? 'notCapable' : rand() < 0.28 ? 'notCapable' : 'capable';

      let name: string;
      do {
        name = `${code}-${kind}-${String(Math.floor(rand() * 99999)).padStart(5, '0')}`;
      } while (usedNames.has(name));
      usedNames.add(name);

      // Some people also get a desk machine alongside their laptop.
      let user: string | undefined;
      if (!kiosk) {
        const reuse = kind === 'DT' && sitePeople.length > 20 && rand() < 0.35;
        let p: Person;
        if (reuse) {
          p = sitePeople[Math.floor(rand() * sitePeople.length)];
        } else {
          p = { ...newUpn(), site, dept: pickWeighted(rand, deptTable), devices: 0 };
          sitePeople.push(p);
          people.push(p);
        }
        p.devices++;
        user = p.upn;
      }

      const enrolledAgo = Math.max(10, hwAge * 365 - rand() * 45);

      devices.push({
        id: `demo-${devices.length.toString(36).padStart(4, '0')}`,
        name,
        user,
        serial: serialFor(manufacturer, rand),
        osVersion: `10.0.${build}.${revision}`,
        manufacturer,
        model,
        site,
        ring: RINGS[ring],
        ownership: rand() < 0.015 ? 'personal' : 'corporate',
        compliance,
        complianceReasons: compliance === 'compliant' || compliance === 'unknown' ? undefined : unique,
        lastSync: new Date(now - age * DAY).toISOString(),
        enrolled: new Date(now - enrolledAgo * DAY).toISOString(),
        encrypted,
        fields: {
          'defender.state': defState,
          'defender.threats': threats,
          'defender.signaturesOverdue': sigAge > 3,
          'defender.realtime': realtime,
          'ea.startupScore': hasEa ? Math.round(startup) : null,
          'ea.bootSeconds': hasEa ? Math.round(boot) : null,
          'ea.appReliability': hasEa ? Math.round(reliability) : null,
          'ea.batteryHealth': hasEa && battery != null ? Math.round(battery) : null,
          'lifecycle.ageYears': Math.round(hwAge * 10) / 10,
          'lifecycle.warrantyDays': warrantyDays,
          'lifecycle.win11': win11,
        },
      });
    }
  }

  // People without a Windows device: frontline staff on shared kiosks, mobile-only users.
  for (let n = 0; n < 160; n++) {
    const [site] = SITES[Math.floor(rand() * SITES.length)];
    const plant = site === 'Green Bay' || site === 'Dallas' || site === 'Retail kiosks';
    people.push({ ...newUpn(), site, dept: plant ? 'Manufacturing' : pickWeighted(rand, DEPARTMENTS.default), devices: 0 });
  }

  const users = people.map((p, i) => makeUser(p, i, now, rand));
  const deployments = makeDeployments(devices, rand);

  return {
    version: 2,
    tenant: 'Contoso Manufacturing',
    generated,
    demo: true,
    rings: RINGS,
    devices,
    users,
    deployments,
  };
}

function makeUser(p: { upn: string; name: string; site: string; dept: string; devices: number }, i: number, now: number, rand: () => number): User {
  const frontline = p.dept === 'Manufacturing' || p.site === 'Retail kiosks';
  const it = p.dept === 'IT' || p.dept === 'Executive';

  const mfa: MfaStrength = it
    ? pickWeighted(rand, [['passwordless', 62], ['strong', 36], ['weak', 2]] as const)
    : frontline
      ? pickWeighted(rand, [['passwordless', 4], ['strong', 44], ['weak', 30], ['none', 22]] as const)
      : pickWeighted(rand, [['passwordless', 19], ['strong', 62], ['weak', 13], ['none', 6]] as const);
  const methods = {
    passwordless: ['windowsHelloForBusiness', 'microsoftAuthenticatorPasswordless', 'microsoftAuthenticatorPush'],
    strong: ['microsoftAuthenticatorPush', ...(rand() < 0.3 ? ['softwareOneTimePasscode'] : [])],
    weak: rand() < 0.7 ? ['mobilePhone'] : ['mobilePhone', 'alternateMobilePhone'],
    none: [] as string[],
  }[mfa];

  // Most people signed in today; a tail of dormant accounts and leavers.
  let lastDays: number | null = -Math.log(Math.max(rand(), 1e-6)) * 0.8;
  const t = rand();
  let enabled = true;
  if (t < 0.11) lastDays = 7 + rand() * 23;
  if (t < 0.06) lastDays = 30 + rand() * 60;
  if (t < 0.03) lastDays = 90 + rand() * 200;
  if (t < 0.012) lastDays = null;
  if (rand() < 0.035) {
    enabled = false;
    lastDays = 20 + rand() * 120;
  }

  let risk: Risk = pickWeighted(rand, [['none', 94], ['low', 3.5], ['medium', 1.8], ['high', 0.7]] as const);
  if (mfa === 'none' && risk === 'none' && rand() < 0.12) risk = rand() < 0.5 ? 'medium' : 'low';

  const licenses = it
    ? ['Microsoft 365 E5']
    : frontline
      ? ['Microsoft 365 F3']
      : rand() < 0.02
        ? []
        : ['Microsoft 365 E3', ...(p.dept === 'Engineering' && rand() < 0.3 ? ['Visio Plan 2'] : []), ...(rand() < 0.08 ? ['Power BI Pro'] : [])];

  return {
    id: `user-${i.toString(36).padStart(4, '0')}`,
    upn: p.upn,
    name: p.name,
    department: p.dept,
    office: p.site,
    enabled,
    lastSignIn: lastDays == null ? undefined : new Date(now - lastDays * DAY).toISOString(),
    mfa,
    methods,
    licenses,
    risk,
  };
}

function makeDeployments(devices: Device[], rand: () => number): Deployment[] {
  const f = (d: Device, k: string) => d.fields?.[k];
  const age = (d: Device) => (Date.parse('2026-10-06T14:00:00Z') - Date.parse(d.lastSync)) / DAY;
  const isWin10 = (d: Device) => d.osVersion.includes('.19045.');
  const kiosk = (d: Device) => d.site === 'Retail kiosks';
  const laptop = (d: Device) => d.name.includes('-LT-');

  const dep = (
    id: string,
    kind: Deployment['kind'],
    name: string,
    target: (d: Device) => boolean,
    status: (d: Device) => DeploymentStatus,
    url?: string,
  ): Deployment => {
    const s: Record<string, DeploymentStatus> = {};
    for (const d of devices) {
      if (!target(d)) continue;
      // Devices that haven't checked in can't report a result yet.
      s[d.id] = age(d) > 21 && kind !== 'profile' ? 'pending' : status(d);
    }
    return { id, kind, name, status: s, ...(url ? { url } : {}) };
  };
  const roll = (p: number) => rand() < p;

  return [
    dep('app-m365', 'app', 'Microsoft 365 Apps for enterprise', () => true, () => (roll(0.012) ? 'failed' : roll(0.015) ? 'pending' : 'success')),
    dep('app-teams', 'app', 'Microsoft Teams', (d) => !kiosk(d), (d) => (roll(isWin10(d) ? 0.06 : 0.018) ? 'failed' : roll(0.01) ? 'pending' : 'success')),
    dep('app-zoom', 'app', 'Zoom Workplace', (d) => !kiosk(d), (d) => (roll(isWin10(d) ? 0.09 : 0.03) ? 'failed' : 'success')),
    dep('app-gp', 'app', 'GlobalProtect VPN 6.3', laptop, (d) => (roll(d.site === 'Remote workforce' ? 0.11 : 0.015) ? 'failed' : roll(0.02) ? 'pending' : 'success')),
    dep('app-acrobat', 'app', 'Adobe Acrobat Reader', (d) => !kiosk(d), () => (roll(0.015) ? 'failed' : 'success')),
    dep('app-cp', 'app', 'Company Portal', () => true, () => (roll(0.005) ? 'failed' : 'success')),

    dep('cfg-bitlocker', 'profile', 'BitLocker: silent encryption', () => true, (d) => (d.encrypted === false ? 'failed' : roll(0.01) ? 'pending' : 'success')),
    dep('cfg-whfb', 'profile', 'Windows Hello for Business', (d) => !kiosk(d), (d) => (roll(d.site === 'Chicago' ? 0.16 : 0.006) ? 'conflict' : 'success')),
    dep('cfg-wifi', 'profile', 'Wi-Fi: Contoso Corp', (d) => d.site !== 'Remote workforce', () => (roll(0.01) ? 'failed' : 'success')),
    dep('cfg-edge', 'profile', 'Edge security baseline', () => true, () => (roll(0.012) ? 'conflict' : roll(0.005) ? 'failed' : 'success')),
    dep('cfg-win10esu', 'profile', 'Windows 10 ESU activation', isWin10, () => (roll(0.18) ? 'failed' : roll(0.1) ? 'pending' : 'success')),

    dep('rem-defs', 'remediation', 'Defender: stale definitions', () => true,
      (d) => (f(d, 'defender.signaturesOverdue') ? (roll(0.3) ? 'fixed' : 'recurred') : roll(0.05) ? 'fixed' : 'success'),
      `${REMEDIATION_BASE}Defender/StaleDefinitions`),
    dep('rem-escrow', 'remediation', 'BitLocker: escrow recovery key to Entra', () => true,
      (d) => (d.encrypted === false ? 'failed' : roll(0.05) ? 'fixed' : 'success'),
      `${REMEDIATION_BASE}BitLocker/EscrowRecoveryKeyToEntra`),
    dep('rem-reboot', 'remediation', 'Windows Update: stale pending reboot', () => true,
      () => (roll(0.1) ? 'fixed' : roll(0.035) ? 'recurred' : 'success'),
      `${REMEDIATION_BASE}WindowsUpdate/StalePendingReboot`),
    dep('rem-disk', 'remediation', 'Storage: low free space cleanup', () => true,
      (d) => (roll(d.model === 'Latitude 7420' ? 0.3 : 0.06) ? (roll(0.75) ? 'fixed' : 'recurred') : roll(0.004) ? 'failed' : 'success'),
      `${REMEDIATION_BASE}Storage/LowFreeSpaceCleanup`),
    dep('rem-ime', 'remediation', 'Intune agent: IME service health', () => true,
      () => (roll(0.015) ? 'fixed' : roll(0.003) ? 'failed' : 'success'),
      `${REMEDIATION_BASE}IntuneAgent/ImeServiceHealth`),
    dep('rem-kfm', 'remediation', 'OneDrive: KFM policy drift', (d) => !kiosk(d),
      () => (roll(0.03) ? 'fixed' : roll(0.008) ? 'recurred' : 'success'),
      `${REMEDIATION_BASE}OneDrive/KfmPolicyDrift`),
  ];
}

function serialFor(manufacturer: string, rand: () => number): string {
  const pick = (chars: string, n: number) => Array.from({ length: n }, () => chars[Math.floor(rand() * chars.length)]).join('');
  const AN = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  if (manufacturer === 'HP') return `5CG${pick('0123456789', 4)}${pick(AN, 3)}`;
  if (manufacturer === 'LENOVO') return `PF${pick(AN, 6)}`;
  if (manufacturer.startsWith('Microsoft')) return pick('0123456789', 12);
  return pick(AN, 7);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
