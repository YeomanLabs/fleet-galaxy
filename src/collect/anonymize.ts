// Pseudonymizes a fleet for sharing: device names, serials, people and the
// tenant name are replaced. A random salt per export keeps the hashes
// consistent inside one file (devices still link to their people) without
// being reversible by guessing names.

import { hashString } from '../data/rng';
import type { Fleet } from '../data/types';

export function anonymize(fleet: Fleet, salt = Math.random().toString(36).slice(2)): Fleet {
  const h = (s: string, n = 6) => {
    const a = hashString(`${salt}:${s}`).toString(36);
    const b = hashString(`${s}:${salt}`).toString(36);
    return (a + b).toUpperCase().slice(0, n);
  };
  const upn = (u: string) => `user-${h(u.toLowerCase(), 8).toLowerCase()}@anonymized.invalid`;

  return {
    ...fleet,
    tenant: 'Anonymized tenant',
    devices: fleet.devices.map((d) => ({
      ...d,
      id: h(d.id, 16),
      name: `DEV-${h(d.id)}`,
      user: d.user ? upn(d.user) : undefined,
      serial: undefined,
    })),
    users: fleet.users?.map((u) => ({
      ...u,
      id: h(u.id, 16),
      upn: upn(u.upn),
      name: undefined,
    })),
    deployments: fleet.deployments?.map((dep) => ({
      ...dep,
      status: Object.fromEntries(Object.entries(dep.status).map(([id, s]) => [h(id, 16), s])),
    })),
  };
}
