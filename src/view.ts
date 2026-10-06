// A View is what the galaxy draws: one star per entity (device or user), with
// everything the renderer and HUD need precomputed. Built per snapshot.

import { computeFacts, GROUP_MODES, groupOf, type Facts, type GroupMode } from './data/classify';
import { presenceOf } from './data/history';
import { buildLenses, type Lens } from './data/lenses';
import { buildPeopleLenses, computePeopleFacts, type PeopleFacts } from './data/people';
import type { Fleet } from './data/types';

export type Entity = 'devices' | 'people';

export interface Grouping {
  id: string;
  label: string;
}

export interface View {
  entity: Entity;
  fleet: Fleet;
  count: number;
  ids: string[];
  names: string[];
  /** Days since last activity; drives distance from the galaxy core. */
  age: Float32Array;
  /** 0 when the entity doesn't exist in this snapshot (time machine). */
  present: Uint8Array;
  lenses: Lens[];
  groupings: Grouping[];
  groupKey(id: string, i: number): string;
  /** Lower-cased search text per entity. */
  hay: string[];
  facts: Facts;
  people: PeopleFacts;
}

const PEOPLE_GROUPS: Grouping[] = [
  { id: 'department', label: 'Department' },
  { id: 'office', label: 'Office' },
];

export function buildView(fleet: Fleet, entity: Entity): View {
  const facts = computeFacts(fleet);
  const people = computePeopleFacts(fleet);
  const presence = presenceOf(fleet);

  if (entity === 'people') {
    const users = fleet.users ?? [];
    const lenses = buildPeopleLenses(fleet, people);
    const byId = new Map(lenses.map((l) => [l.id, l]));
    return {
      entity,
      fleet,
      count: users.length,
      ids: users.map((u) => u.id),
      names: users.map((u) => u.name || u.upn),
      // Never signed in sits far out in the halo, like a long-silent device.
      age: Float32Array.from(people.idle, (x) => (Number.isFinite(x) ? Math.min(x, 9999) : 400)),
      present: presence?.users ?? new Uint8Array(users.length).fill(1),
      lenses,
      groupings: [...PEOPLE_GROUPS, ...lensGroupings(lenses)],
      groupKey: (id, i) => {
        if (id === 'department') return users[i].department || 'No department';
        if (id === 'office') return users[i].office || 'No office';
        const lens = byId.get(id.slice(5));
        return lens ? labelOf(lens, i) : 'Ungrouped';
      },
      hay: users.map((u) => `${u.name ?? ''} ${u.upn} ${u.department ?? ''} ${u.office ?? ''} ${(u.licenses ?? []).join(' ')}`.toLowerCase()),
      facts,
      people,
    };
  }

  const d = fleet.devices;
  const lenses = buildLenses(fleet, facts);
  const byId = new Map(lenses.map((l) => [l.id, l]));
  return {
    entity,
    fleet,
    count: d.length,
    ids: d.map((x) => x.id),
    names: d.map((x) => x.name),
    age: facts.age,
    present: presence?.devices ?? new Uint8Array(d.length).fill(1),
    lenses,
    groupings: [...GROUP_MODES, ...lensGroupings(lenses.filter((l) => !['release'].includes(l.id)))],
    groupKey: (id, i) => {
      if (id.startsWith('lens:')) {
        const lens = byId.get(id.slice(5));
        return lens ? labelOf(lens, i) : 'Ungrouped';
      }
      return groupOf(id as GroupMode, i, fleet, facts);
    },
    hay: d.map((x, i) => `${x.name} ${x.user ?? ''} ${x.serial ?? ''} ${x.model} ${x.manufacturer} ${x.site} ${x.ring} ${facts.release[i]}`.toLowerCase()),
    facts,
    people,
  };
}

function lensGroupings(lenses: Lens[]): Grouping[] {
  return lenses.filter((l) => l.groupable).map((l) => ({ id: `lens:${l.id}`, label: l.label }));
}

function labelOf(lens: Lens, i: number): string {
  const k = lens.keyOf(i);
  return lens.categories.find((c) => c.key === k)?.label ?? k;
}
