// Places every device as a star. Each group becomes a spiral galaxy; where a
// star sits inside it carries meaning: devices that checked in recently orbit
// the bright core, and the longer a device has been silent the further it
// drifts out into the halo.

import { gaussian, hashString, mulberry32 } from '../data/rng';

export interface GroupInfo {
  name: string;
  count: number;
  center: [number, number, number];
  radius: number;
  /** Indices of member devices. */
  members: number[];
}

export interface Layout {
  positions: Float32Array;
  /** 0 at the core, 1 at the disc edge, above 1 out in the halo. */
  radial: Float32Array;
  groups: GroupInfo[];
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

export function radiusFor(count: number): number {
  return 14 + Math.sqrt(count) * 3.6;
}

/** Where along the radius a device sits, from its check-in age in days. */
export function radialFraction(ageDays: number, u: number): number {
  if (ageDays < 7) return 0.08 + Math.sqrt(u) * 0.82;
  // Silent for a week or more: out past the disc edge, further with time.
  const t = Math.min(1, Math.log1p(ageDays - 7) / Math.log1p(120));
  return 0.95 + t * 0.75 + u * 0.12;
}

export function computeLayout(groupKeys: string[], ages: Float32Array, ids: string[]): Layout {
  const byGroup = new Map<string, number[]>();
  groupKeys.forEach((k, i) => {
    const list = byGroup.get(k);
    if (list) list.push(i);
    else byGroup.set(k, [i]);
  });

  const groups: GroupInfo[] = [...byGroup]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([name, members]) => ({ name, count: members.length, center: [0, 0, 0], radius: radiusFor(members.length), members }));

  placeGroups(groups);

  const positions = new Float32Array(ids.length * 3);
  const radial = new Float32Array(ids.length);

  for (const g of groups) {
    const gr = mulberry32(hashString(g.name));
    const arms = g.count > 400 ? 3 : 2;
    const twist = 3.4 + gr() * 1.6;
    // Tilt each disc a little so the scene reads as 3D from any angle.
    const tiltX = (gr() - 0.5) * 0.7;
    const tiltZ = (gr() - 0.5) * 0.7;
    const spin = gr() * Math.PI * 2;
    const cx = Math.cos(tiltX), sx = Math.sin(tiltX), cz = Math.cos(tiltZ), sz = Math.sin(tiltZ);

    for (const i of g.members) {
      const r = mulberry32(hashString(ids[i]));
      const rf = radialFraction(ages[i], r());
      const arm = Math.floor(r() * arms);
      const inHalo = rf > 1;
      const spread = inHalo ? Math.PI : 0.16 + (1 - Math.min(rf, 1)) * 0.3;
      const angle = spin + (arm / arms) * Math.PI * 2 + rf * twist + gaussian(r) * spread;
      const dist = rf * g.radius;
      const bulge = Math.exp(-rf * 6) * 0.35;
      const thickness = inHalo ? 0.35 : 0.05 + bulge;
      let x = Math.cos(angle) * dist;
      let z = Math.sin(angle) * dist;
      let y = gaussian(r) * thickness * g.radius;

      // Rotate around X then Z.
      const y1 = y * cx - z * sx;
      const z1 = y * sx + z * cx;
      const x2 = x * cz - y1 * sz;
      const y2 = x * sz + y1 * cz;
      x = x2; y = y2; z = z1;

      positions[i * 3] = g.center[0] + x;
      positions[i * 3 + 1] = g.center[1] + y;
      positions[i * 3 + 2] = g.center[2] + z;
      radial[i] = rf;
    }
  }

  return { positions, radial, groups };
}

/** Phyllotaxis spiral by area, then a few passes to push overlapping galaxies apart. */
function placeGroups(groups: GroupInfo[]): void {
  let area = 0;
  groups.forEach((g, i) => {
    const pad = g.radius * 1.35;
    area += pad * pad;
    const d = i === 0 ? 0 : Math.sqrt(area) * 0.8;
    const a = i * GOLDEN * 1.0 + 0.6;
    const h = mulberry32(hashString(g.name + ':y'))();
    g.center = [Math.cos(a) * d, (h - 0.5) * g.radius * 0.8, Math.sin(a) * d];
  });

  for (let pass = 0; pass < 40; pass++) {
    let moved = false;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i], b = groups[j];
        const dx = b.center[0] - a.center[0];
        const dz = b.center[2] - a.center[2];
        const dist = Math.hypot(dx, dz) || 0.001;
        const min = (a.radius + b.radius) * 1.22;
        if (dist < min) {
          const push = (min - dist) / 2;
          const ux = dx / dist, uz = dz / dist;
          // The biggest galaxy stays anchored at the origin.
          const wa = i === 0 ? 0 : 1, wb = 1;
          a.center[0] -= ux * push * wa; a.center[2] -= uz * push * wa;
          b.center[0] += ux * push * wb; b.center[2] += uz * push * wb;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
}
