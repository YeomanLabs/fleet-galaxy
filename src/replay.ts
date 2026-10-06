// "Patch Tuesday replay": a simulated rollout of the newest cumulative update,
// built from each device's ring, its check-in habits and its final patch level.
// fleet.json carries no install history, so this is a projection, and the UI
// labels it as one.

import { hashString, mulberry32 } from './data/rng';
import type { Facts } from './data/classify';
import type { Fleet } from './data/types';

export const REPLAY_DAYS = 21;

/** Day each ring starts receiving the update, and over how many days it lands, by rollout order. */
const RING_START = [0, 2, 5, 10, 13, 15];
const RING_SPREAD = [1.5, 2.5, 6, 5, 4, 4];

export interface ReplayPlan {
  /** Day the device installs the update, or Infinity if it never does. */
  installDay: Float32Array;
  /** How many devices take part (ended up current). */
  participants: number;
  /** Cumulative percent of the fleet on the update, one sample per day. */
  curve: number[];
}

export function ringOrder(fleet: Fleet): string[] {
  if (fleet.rings?.length) return fleet.rings;
  // Infer: names usually carry a number ("Ring 0", "Wave 2"), otherwise smallest first.
  const counts = new Map<string, number>();
  for (const d of fleet.devices) counts.set(d.ring, (counts.get(d.ring) ?? 0) + 1);
  return [...counts.keys()].sort((a, b) => {
    const na = /\d+/.exec(a), nb = /\d+/.exec(b);
    if (na && nb) return +na[0] - +nb[0];
    return (counts.get(a) ?? 0) - (counts.get(b) ?? 0);
  });
}

export function planReplay(fleet: Fleet, facts: Facts, radial: Float32Array): ReplayPlan {
  const order = ringOrder(fleet);
  const n = fleet.devices.length;
  const installDay = new Float32Array(n).fill(Infinity);
  let participants = 0;

  fleet.devices.forEach((d, i) => {
    if (facts.patch[i] !== 'current') return;
    participants++;
    const r = mulberry32(hashString(d.id + ':replay'));
    const idx = order.indexOf(d.ring);
    const k = Math.min(idx < 0 ? 2 : idx, RING_START.length - 1);
    const start = RING_START[k];
    // Devices that check in less often pick the update up later.
    const habit = Math.min(4, facts.age[i] * 0.6);
    // Inner stars go first so the wave ripples outward through each galaxy.
    const ripple = Math.min(radial[i], 1) * 1.6;
    installDay[i] = Math.min(REPLAY_DAYS - 0.5, start + ripple + Math.pow(r(), 1.6) * RING_SPREAD[k] + habit);
  });

  const curve: number[] = [];
  for (let day = 0; day <= REPLAY_DAYS; day++) {
    let done = 0;
    for (let i = 0; i < n; i++) if (installDay[i] <= day) done++;
    curve.push((done / (n || 1)) * 100);
  }
  return { installDay, participants, curve };
}
