import { describe, expect, it } from 'vitest';
import { checkinBucket, computeFacts, kpis, parseBuild, patchLevels, releaseName } from '../src/data/classify';
import { FleetError, parseFleet } from '../src/data/load';
import { generateDemoFleet } from '../src/data/synth';
import type { Device } from '../src/data/types';
import { planReplay, ringOrder } from '../src/replay';
import { computeLayout, radialFraction } from '../src/scene/layout';

const dev = (osVersion: string, extra: Partial<Device> = {}): Device => ({
  id: Math.random().toString(36),
  name: 'X',
  osVersion,
  manufacturer: 'Dell Inc.',
  model: 'Latitude',
  site: 'HQ',
  ring: 'Broad',
  ownership: 'corporate',
  compliance: 'compliant',
  lastSync: '2026-10-06T00:00:00Z',
  ...extra,
});

describe('demo fleet', () => {
  const fleet = generateDemoFleet();

  it('is deterministic', () => {
    expect(generateDemoFleet()).toEqual(fleet);
  });

  it('has a believable shape', () => {
    expect(fleet.devices.length).toBe(3500);
    expect(new Set(fleet.devices.map((d) => d.name)).size).toBe(3500);
    const k = kpis(fleet, computeFacts(fleet));
    expect(k.compliantPct).toBeGreaterThan(75);
    expect(k.compliantPct).toBeLessThan(95);
    expect(k.win10).toBeGreaterThan(20);
    expect(k.stale).toBeGreaterThan(20);
  });

  it('round-trips through the loader', () => {
    const parsed = parseFleet(JSON.stringify(fleet));
    expect(parsed.devices).toHaveLength(fleet.devices.length);
    expect(parsed.demo).toBe(false);
  });
});

describe('classify', () => {
  it('parses both build formats', () => {
    expect(parseBuild('10.0.26100.6899')).toEqual({ build: 26100, revision: 6899 });
    expect(parseBuild('26100.6899')).toEqual({ build: 26100, revision: 6899 });
    expect(releaseName('10.0.19045.1')).toBe('Win10 22H2');
    expect(releaseName('10.0.99999.1')).toBe('Build 99999');
    expect(releaseName('')).toBe('Unknown');
  });

  it('ranks patch levels per servicing family, ignoring stray revisions', () => {
    const devices = [
      ...Array.from({ length: 20 }, () => dev('10.0.26100.6899')),
      ...Array.from({ length: 10 }, () => dev('10.0.26200.6584')), // 25H2 shares 24H2's stream
      ...Array.from({ length: 10 }, () => dev('10.0.26100.4946')),
      dev('10.0.26100.7001'), // a lone preview build doesn't become "current"
      ...Array.from({ length: 5 }, () => dev('10.0.19045.6456')),
      dev(''),
    ];
    const levels = patchLevels(devices);
    expect(levels[0]).toBe('current');
    expect(levels[20]).toBe('behind1');
    expect(levels[30]).toBe('behind2');
    expect(levels[40]).toBe('current');
    expect(levels[41]).toBe('current'); // Win10 ranks against Win10
    expect(levels[46]).toBe('unknown');
  });

  it('buckets check-in age', () => {
    expect(checkinBucket(0.5)).toBe('day');
    expect(checkinBucket(3)).toBe('week');
    expect(checkinBucket(20)).toBe('month');
    expect(checkinBucket(90)).toBe('stale');
  });
});

describe('loader', () => {
  it('rejects junk with a readable message', () => {
    expect(() => parseFleet('nope')).toThrow(FleetError);
    expect(() => parseFleet('{"version":3,"devices":[]}')).toThrow(/version/);
    expect(() => parseFleet('{"version":1,"devices":[{"id":"a"}]}')).toThrow(/No usable devices/);
  });

  it('normalises sloppy values', () => {
    const f = parseFleet(
      '﻿' +
        JSON.stringify({
          version: 1,
          devices: [{ id: 'a', lastSync: '2026-10-01T00:00:00Z', compliance: 'NonCompliant', ownership: 'weird', site: '' }],
        }),
    );
    expect(f.tenant).toBe('Your tenant');
    expect(f.devices[0]).toMatchObject({ compliance: 'noncompliant', ownership: 'unknown', site: 'Unassigned' });
  });
});

describe('layout', () => {
  it('pushes silent devices outward', () => {
    expect(radialFraction(0.1, 1)).toBeLessThan(1);
    expect(radialFraction(10, 0)).toBeGreaterThan(0.9);
    expect(radialFraction(100, 0)).toBeGreaterThan(radialFraction(10, 0));
  });

  it('gives every device a finite position and keeps galaxies apart', () => {
    const fleet = generateDemoFleet();
    const facts = computeFacts(fleet);
    const l = computeLayout(fleet.devices.map((d) => d.site), facts.age, fleet.devices.map((d) => d.id));
    expect(l.positions.every(Number.isFinite)).toBe(true);
    for (let i = 0; i < l.groups.length; i++) {
      for (let j = i + 1; j < l.groups.length; j++) {
        const a = l.groups[i], b = l.groups[j];
        const d = Math.hypot(a.center[0] - b.center[0], a.center[2] - b.center[2]);
        expect(d).toBeGreaterThan(a.radius + b.radius);
      }
    }
  });
});

describe('replay', () => {
  it('infers ring order from numbers in names', () => {
    const f = generateDemoFleet();
    expect(ringOrder({ ...f, rings: undefined })).toEqual(f.rings);
  });

  it('only rolls the update out to devices that end up current, pilot first', () => {
    const fleet = generateDemoFleet();
    const facts = computeFacts(fleet);
    const plan = planReplay(fleet, facts, new Float32Array(fleet.devices.length));
    fleet.devices.forEach((_, i) => {
      expect(Number.isFinite(plan.installDay[i])).toBe(facts.patch[i] === 'current');
    });
    const avg = (ring: string) => {
      const days = fleet.devices.flatMap((d, i) => (d.ring === ring && Number.isFinite(plan.installDay[i]) ? [plan.installDay[i]] : []));
      return days.reduce((a, b) => a + b, 0) / days.length;
    };
    expect(avg(fleet.rings![0])).toBeLessThan(avg(fleet.rings![2]));
    expect(plan.curve.at(-1)).toBeCloseTo((plan.participants / fleet.devices.length) * 100);
  });
});
