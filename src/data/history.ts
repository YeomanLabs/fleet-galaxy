// Time machine data. A history is a list of snapshots (one fleet.json per day)
// aligned so that index i is the same device in every snapshot: devices that
// don't exist yet, or were retired, get a placeholder and a presence flag of 0.

import { hashString, mulberry32 } from './rng';
import { generateDemoFleet, REVISIONS } from './synth';
import type { Compliance, Device, Fleet, MfaStrength, User } from './types';

const DAY = 86_400_000;

export interface Presence {
  devices: Uint8Array;
  users: Uint8Array;
}

const presence = new WeakMap<Fleet, Presence>();

/** Presence flags for an aligned snapshot, or undefined for a standalone fleet. */
export function presenceOf(fleet: Fleet): Presence | undefined {
  return presence.get(fleet);
}

/**
 * Aligns snapshots by device and user id. Returns them oldest first.
 * Placeholders copy the nearest snapshot's record so layout and lenses stay
 * stable when a star fades in or out.
 */
export function alignSnapshots(input: Fleet[]): Fleet[] {
  const fleets = [...input].sort((a, b) => Date.parse(a.generated) - Date.parse(b.generated));
  if (fleets.length < 2) return fleets;

  const align = <T extends { id: string }>(lists: T[][]) => {
    const order: string[] = [];
    const seen = new Set<string>();
    // Latest snapshot's order first, so index i matches loading that file alone.
    for (const list of [...lists].reverse()) for (const x of list) if (!seen.has(x.id)) { seen.add(x.id); order.push(x.id); }
    const maps = lists.map((l) => new Map(l.map((x) => [x.id, x])));
    return maps.map((m, s) => {
      const items: T[] = [];
      const flags = new Uint8Array(order.length);
      order.forEach((id, i) => {
        const own = m.get(id);
        if (own) {
          items.push(own);
          flags[i] = 1;
          return;
        }
        // Nearest snapshot that has it: look forward first (not born yet), then back (retired).
        let found: T | undefined;
        for (let d = 1; !found && d < maps.length; d++) found = maps[s + d]?.get(id) ?? maps[s - d]?.get(id);
        items.push(found!);
      });
      return { items, flags };
    });
  };

  const devs = align(fleets.map((f) => f.devices));
  const users = align(fleets.map((f) => f.users ?? []));
  return fleets.map((f, s) => {
    const out: Fleet = { ...f, devices: devs[s].items, users: users[s].items };
    presence.set(out, { devices: devs[s].flags, users: users[s].flags });
    return out;
  });
}

// ---------------------------------------------------------------- demo history

/** Second Tuesdays: the releases behind REVISIONS[...][2], [1], [0]. */
const PATCH_TUESDAYS = ['2026-07-14', '2026-08-11', '2026-09-08'].map((d) => Date.parse(`${d}T17:00:00Z`));
const RING_START = [0, 2, 5, 10];
const RING_SPREAD = [1.5, 2.5, 6, 5];
const MFA_CAMPAIGN = Date.parse('2026-09-01T00:00:00Z');

/**
 * Sixty days of believable history ending at the demo snapshot. Things move:
 * two Patch Tuesdays roll through the rings, Windows 10 machines upgrade, new
 * laptops enroll, an MFA registration campaign starts on 1 September.
 */
export function generateDemoHistory(days = 60): Fleet[] {
  const gen = demoHistoryDays(days);
  const out: Fleet[] = [];
  for (let r = gen.next(); !r.done; r = gen.next()) if (r.value) out.push(r.value);
  return alignSnapshots(out);
}

/** Same as generateDemoHistory, but yields to the browser between days so the page keeps animating. */
export async function generateDemoHistoryAsync(days = 60): Promise<Fleet[]> {
  const gen = demoHistoryDays(days);
  const out: Fleet[] = [];
  let k = 0;
  for (let r = gen.next(); !r.done; r = gen.next()) {
    if (r.value) out.push(r.value);
    if (++k % 4 === 0) await new Promise((res) => setTimeout(res, 0));
  }
  return alignSnapshots(out);
}

function* demoHistoryDays(days: number): Generator<Fleet, void> {
  const final = generateDemoFleet();
  const end = Date.parse(final.generated);
  const rings = final.rings ?? [];
  // Per-device plan, fixed across days.
  const plans = final.devices.map((d) => {
    const r = mulberry32(hashString(d.id + ':history'));
    const [, , build, rev] = d.osVersion.split('.').map(Number);
    const family = build === 26200 ? 26100 : build;
    const finalIdx = Math.max(0, REVISIONS[family]?.indexOf(rev) ?? 0);
    const ring = Math.max(0, rings.indexOf(d.ring));
    // Install delay for each release, in days after its Patch Tuesday.
    const delay = [0, 1, 2].map(() => RING_START[ring] + Math.pow(r(), 1.6) * RING_SPREAD[ring] + r() * 0.8);
    // A share of today's Windows 11 machines were on Windows 10 at the start.
    const wasWin10 = build >= 22000 && (d.site === 'Dallas' ? r() < 0.45 : r() < 0.07);
    const upgradeAt = end - (5 + r() * (days - 10)) * DAY;
    // Match today's verdict where today's data has one, so the last day doesn't flicker.
    const failsOsToday = d.complianceReasons?.includes('OS version below minimum') ?? false;
    const osApplies = build === 19045 || finalIdx >= 2;
    const osPolicy = osApplies ? failsOsToday : mulberry32(hashString(d.id + ':os'))() < 0.55;
    return { seed: hashString(d.id), osPolicy, build, family, finalIdx, delay, wasWin10, upgradeAt, enrolled: d.enrolled ? Date.parse(d.enrolled) : 0, lastSync: Date.parse(d.lastSync) };
  });

  const userPlans = (final.users ?? []).map((u) => {
    const r = mulberry32(hashString(u.id + ':history'));
    const signedUpAt = MFA_CAMPAIGN + r() * (end - MFA_CAMPAIGN);
    // A third of today's MFA users registered during the campaign.
    const registeredLate = (u.mfa === 'strong' || u.mfa === 'passwordless') && r() < 0.33;
    const before: MfaStrength = r() < 0.6 ? 'weak' : 'none';
    return { seed: hashString(u.id), signedUpAt, registeredLate, before, last: u.lastSignIn ? Date.parse(u.lastSignIn) : NaN };
  });

  // Machines that were already silent when the window opens and get retired
  // during it: they fade out over the timeline, as real clean-ups do.
  const start = end - (days - 1) * DAY;
  const rr = mulberry32(4242);
  const retired = Array.from({ length: Math.round(final.devices.length * 0.045) }, (_, n) => {
    const src = final.devices[Math.floor(rr() * final.devices.length)];
    const silentSince = start - (10 + rr() * 80) * DAY;
    return {
      retireAt: start + (2 + rr() * (days - 6)) * DAY,
      device: {
        ...src,
        id: `demo-retired-${n.toString(36).padStart(3, '0')}`,
        name: src.name.replace(/\d{5}$/, String(Math.floor(rr() * 99999)).padStart(5, '0')),
        user: undefined,
        osVersion: rr() < 0.5 ? '10.0.19045.6093' : src.osVersion.replace(/\.\d+$/, '.4652'),
        compliance: 'noncompliant' as Compliance,
        complianceReasons: ['Not checked in within 30 days'],
        lastSync: new Date(silentSince).toISOString(),
        fields: { ...src.fields, 'lifecycle.win11': 'notCapable', 'lifecycle.ageYears': 5 + Math.round(rr() * 20) / 10 },
      } satisfies Device,
    };
  });

  for (let k = 0; k < days - 1; k++) {
    const at = end - (days - 1 - k) * DAY;
    const iso = new Date(at).toISOString();

    const devices: Device[] = [];
    for (const r of retired) if (at < r.retireAt) devices.push(r.device);
    final.devices.forEach((d, i) => {
      const p = plans[i];
      if (p.enrolled > at) return;
      const jitter = mulberry32(p.seed ^ Math.imul(k + 1, 0x9e3779b1));

      // Silent since its final sync, or still checking in normally back then.
      const lastSync = at >= p.lastSync ? p.lastSync : at - jitter() * jitter() * 1.6 * DAY;
      const age = (at - lastSync) / DAY;

      const onWin10 = p.wasWin10 && at < p.upgradeAt;
      const build = onWin10 ? 19045 : p.build;
      const family = onWin10 ? 19045 : p.family;
      // Newest release the device has installed by now (index 0 = September).
      let idx = 3;
      for (let j = 2; j >= 0; j--) {
        const release = 2 - j; // PATCH_TUESDAYS index
        if (j >= p.finalIdx && at >= PATCH_TUESDAYS[release] + p.delay[release] * DAY && lastSync >= PATCH_TUESDAYS[release]) idx = j;
      }
      if (at >= end - 0.5 * DAY) idx = p.finalIdx;
      const revs = REVISIONS[family];
      const revision = revs[Math.min(idx, revs.length - 1)];

      const reasons = (d.complianceReasons ?? []).filter((x) => x !== 'Not checked in within 30 days' && x !== 'OS version below minimum');
      if (age > 30) reasons.push('Not checked in within 30 days');
      // "Behind" is relative to what had been released by that day.
      const newest = PATCH_TUESDAYS.filter((pt) => at >= pt).length;
      const behind = idx - (3 - newest);
      if ((build === 19045 || behind >= 2) && p.osPolicy) reasons.push('OS version below minimum');
      const compliance: Compliance = d.compliance === 'unknown' ? 'unknown' : reasons.length ? (age < 3 && jitter() < 0.35 ? 'ingrace' : 'noncompliant') : 'compliant';

      const back = (end - at) / DAY;
      const fields = { ...d.fields };
      fields['defender.signaturesOverdue'] = Math.min(age, 60) * (0.6 + jitter() * 0.5) + (fields['defender.realtime'] === false ? 4 : 0) > 3;
      fields['lifecycle.ageYears'] = Math.round(((fields['lifecycle.ageYears'] as number) - back / 365) * 10) / 10;
      fields['lifecycle.warrantyDays'] = (fields['lifecycle.warrantyDays'] as number) + Math.round(back);
      fields['lifecycle.win11'] = build >= 22000 ? 'onWin11' : fields['lifecycle.win11'] === 'notCapable' ? 'notCapable' : 'capable';

      devices.push({
        ...d,
        osVersion: `10.0.${build}.${revision}`,
        lastSync: new Date(lastSync).toISOString(),
        compliance,
        complianceReasons: compliance === 'compliant' || compliance === 'unknown' ? undefined : [...new Set(reasons)],
        fields,
      });
    });

    const users: User[] = (final.users ?? []).map((u, i) => {
      const p = userPlans[i];
      const jitter = mulberry32(p.seed ^ Math.imul(k + 1, 0x9e3779b1));
      let last = p.last;
      let enabled = u.enabled;
      if (!u.enabled && at < p.last + DAY) enabled = true; // left the company later
      if (!Number.isNaN(p.last) && at < p.last) last = at - jitter() * jitter() * 2 * DAY;
      const mfa = p.registeredLate && at < p.signedUpAt ? p.before : u.mfa;
      return { ...u, enabled, mfa, lastSignIn: Number.isNaN(last) ? undefined : new Date(last).toISOString() };
    });

    // Deployment results are today's; devices that don't exist yet are hidden anyway.
    yield { ...final, generated: iso, devices, users };
  }

  yield final;
}
