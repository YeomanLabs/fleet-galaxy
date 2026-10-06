// Generates a believable fictional fleet for the public demo. Seeded, so every
// visitor sees the same galaxy. No real tenant data is involved anywhere.

import { gaussian, mulberry32, pickWeighted } from './rng';
import type { Compliance, Device, Fleet } from './types';

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

type ModelSpec = readonly [manufacturer: string, model: string, kind: 'LT' | 'DT', weight: number];

const MODELS: readonly ModelSpec[] = [
  ['Dell Inc.', 'Latitude 7450', 'LT', 30],
  ['Dell Inc.', 'Latitude 5440', 'LT', 18],
  ['HP', 'EliteBook 840 G11', 'LT', 16],
  ['LENOVO', 'ThinkPad T14 Gen 5', 'LT', 12],
  ['Microsoft Corporation', 'Surface Laptop 7', 'LT', 8],
  ['Dell Inc.', 'OptiPlex 7020', 'DT', 11],
  ['Dell Inc.', 'Latitude 7420', 'LT', 5],
];

const RINGS = ['Ring 0 · IT pilot', 'Ring 1 · Early adopters', 'Ring 2 · Broad', 'Ring 3 · Critical systems'];
const RING_WEIGHTS = [
  [0, 2],
  [1, 10],
  [2, 78],
  [3, 10],
] as const;

/** Cumulative update revisions, newest first. 26100 and 26200 share a stream. */
const REVISIONS: Record<number, number[]> = {
  26100: [6899, 6584, 4946, 4652],
  22631: [6060, 5909, 5768, 5624],
  19045: [6456, 6332, 6218, 6093],
};

const REASONS = [
  ['BitLocker not enabled', 26],
  ['OS version below minimum', 22],
  ['Defender real-time protection off', 16],
  ['Not checked in within 30 days', 18],
  ['Firewall disabled', 8],
  ['Secure Boot off', 6],
  ['Antivirus signatures out of date', 10],
] as const;

const FIRST = ['alex', 'sam', 'jordan', 'taylor', 'morgan', 'casey', 'riley', 'jamie', 'drew', 'avery', 'quinn', 'reese', 'parker', 'rowan', 'skyler', 'devon', 'emerson', 'hayden', 'kai', 'logan', 'marlo', 'noel', 'oakley', 'peyton', 'sage', 'tatum', 'blair', 'cameron', 'dakota', 'ellis'];
const LAST = ['nguyen', 'patel', 'garcia', 'kowalski', 'schmidt', 'johnson', 'okafor', 'larsen', 'muller', 'rossi', 'kim', 'olsen', 'hernandez', 'novak', 'berg', 'chen', 'dubois', 'fischer', 'haas', 'iverson', 'jansen', 'keller', 'lindqvist', 'moreau', 'nakamura', 'ortiz', 'price', 'reyes', 'sato', 'vogel'];

export function generateDemoFleet(seed = 20261006, generated = '2026-10-06T14:00:00Z'): Fleet {
  const rand = mulberry32(seed);
  const now = Date.parse(generated);
  const devices: Device[] = [];
  const usedNames = new Set<string>();

  for (const [site, code, count] of SITES) {
    // Each site gets a "personality" so the galaxies differ visibly.
    const siteDrift = site === 'Remote workforce' ? 2.2 : site === 'Retail kiosks' ? 1.6 : 1;
    const siteLegacy = site === 'Dallas' ? 0.22 : site === 'Retail kiosks' ? 0.45 : 0.035;

    for (let n = 0; n < count; n++) {
      const kiosk = code === 'KSK';
      const [manufacturer, model, kind] = kiosk
        ? (['Dell Inc.', 'OptiPlex Micro 7020', 'DT', 1] as const)
        : pickWeighted(rand, MODELS.map((m) => [m, m[3]] as const));
      const ring = kiosk ? 3 : pickWeighted(rand, RING_WEIGHTS);

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

      // Compliance falls out of the device's state rather than being random.
      const encrypted = rand() > (kind === 'DT' ? 0.05 : 0.02);
      const reasons: string[] = [];
      if (!encrypted) reasons.push('BitLocker not enabled');
      if (build === 19045 || behind >= 2) {
        if (rand() < 0.55) reasons.push('OS version below minimum');
      }
      if (age > 30) reasons.push('Not checked in within 30 days');
      if (rand() < 0.025) reasons.push(pickWeighted(rand, REASONS));
      const unique = [...new Set(reasons)];

      let compliance: Compliance = 'compliant';
      if (unique.length) compliance = age < 3 && rand() < 0.35 ? 'ingrace' : 'noncompliant';
      if (rand() < 0.012) compliance = 'unknown';

      let name: string;
      do {
        name = `${code}-${kind}-${String(Math.floor(rand() * 99999)).padStart(5, '0')}`;
      } while (usedNames.has(name));
      usedNames.add(name);

      const user = kiosk
        ? undefined
        : `${FIRST[Math.floor(rand() * FIRST.length)]}.${LAST[Math.floor(rand() * LAST.length)]}@contoso.com`;
      const enrolledAgo = 30 + Math.abs(gaussian(rand)) * 500;

      devices.push({
        id: `demo-${devices.length.toString(36).padStart(4, '0')}`,
        name,
        user,
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
      });
    }
  }

  return {
    version: 1,
    tenant: 'Contoso Manufacturing',
    generated,
    demo: true,
    rings: RINGS,
    devices,
  };
}
