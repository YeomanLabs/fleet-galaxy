import { describe, expect, it } from 'vitest';
import { computeFacts } from '../src/data/classify';
import { mergeCsv, parseCsv } from '../src/data/csv';
import { alignSnapshots, generateDemoHistory, presenceOf } from '../src/data/history';
import { buildLenses, fieldLens, inferDef, NONE } from '../src/data/lenses';
import { parseFleet } from '../src/data/load';
import { buildPeopleLenses, computePeopleFacts, peopleKpis, primaryLicense, signInBucket } from '../src/data/people';
import { generateDemoFleet } from '../src/data/synth';
import type { Device, Fleet } from '../src/data/types';

const base = (id: string, extra: Partial<Device> = {}): Device => ({
  id, name: id.toUpperCase(), osVersion: '10.0.26100.6899', manufacturer: 'Dell Inc.', model: 'Latitude',
  site: 'HQ', ring: 'Broad', ownership: 'corporate', compliance: 'compliant', lastSync: '2026-10-06T00:00:00Z', ...extra,
});
const fleetOf = (devices: Device[], extra: Partial<Fleet> = {}): Fleet => ({ version: 2, tenant: 'T', generated: '2026-10-06T12:00:00Z', devices, ...extra });

describe('lenses', () => {
  const demo = generateDemoFleet();
  const lenses = buildLenses(demo, computeFacts(demo));
  const ids = lenses.map((l) => l.id);

  it('exposes built-in, known-field and deployment lenses for the demo', () => {
    for (const id of ['compliance', 'patch', 'bitlocker', 'field:defender.risk', 'field:ea.startupScore', 'field:lifecycle.warrantyDays', 'deploy:app-teams', 'deploy:rem-defs']) {
      expect(ids).toContain(id);
    }
    // Real hardware age exists, so the enrollment stand-in is skipped.
    expect(ids).not.toContain('field:__enrolledYears');
  });

  it('puts every device in a listed category', () => {
    for (const l of lenses) {
      const keys = new Set(l.categories.map((c) => c.key));
      for (let i = 0; i < demo.devices.length; i += 37) expect(keys.has(l.keyOf(i)), `${l.id} -> ${l.keyOf(i)}`).toBe(true);
    }
  });

  it('buckets numbers with the healthy end first', () => {
    const devs = [5, 40, 90, null].map((v, i) => base(`d${i}`, { fields: { score: v } }));
    const l = fieldLens({ field: 'score', label: 'Score', kind: 'number', stops: [50, 80], good: 'high' }, devs);
    expect(l.categories[0]).toMatchObject({ key: 'b2', weight: 0 });
    expect([0, 1, 2, 3].map((i) => l.keyOf(i))).toEqual(['b0', 'b0', 'b2', NONE]);
  });

  it('guesses sensible lenses for unknown fields', () => {
    const devs = ['a', 'b', 'a'].map((v, i) => base(`d${i}`, { fields: { region: v, flag: i > 0, n: i * 10, id: `x${i}` } }));
    expect(inferDef('region', devs)?.kind).toBe('category');
    expect(inferDef('flag', devs)?.categories?.map((c) => c.key)).toEqual(['true', 'false']);
    expect(inferDef('n', devs)?.kind).toBe('number');
    const many = Array.from({ length: 40 }, (_, i) => base(`d${i}`, { fields: { serialish: `S${i}` } }));
    expect(inferDef('serialish', many)).toBeNull();
  });

  it('marks untargeted devices on deployment lenses', () => {
    const f = fleetOf([base('a'), base('b')], { deployments: [{ id: 'x', kind: 'app', name: 'App', status: { a: 'failed' } }] });
    const l = buildLenses(f, computeFacts(f)).find((x) => x.id === 'deploy:x')!;
    expect([l.keyOf(0), l.keyOf(1)]).toEqual(['failed', 'untargeted']);
  });
});

describe('people', () => {
  const demo = generateDemoFleet();
  const pf = computePeopleFacts(demo);

  it('links people to their devices by UPN', () => {
    const owned = pf.devices.reduce((n, d) => n + d.length, 0);
    expect(owned).toBe(demo.devices.filter((d) => d.user).length);
    expect(pf.devices.some((d) => d.length > 1)).toBe(true);
    expect(pf.devices.some((d) => d.length === 0)).toBe(true);
  });

  it('has a believable identity picture', () => {
    const k = peopleKpis(demo, pf);
    expect(k.mfaPct).toBeGreaterThan(60);
    expect(k.mfaPct).toBeLessThan(90);
    expect(k.leaversWithDevices).toBeGreaterThan(0);
    const lenses = buildPeopleLenses(demo, pf);
    expect(lenses.map((l) => l.id)).toEqual(expect.arrayContaining(['mfa', 'signin', 'risk', 'license', 'devices', 'waste']));
  });

  it('ranks licenses and buckets sign-ins', () => {
    expect(primaryLicense(['Power BI Pro', 'Microsoft 365 E3'])).toBe('Microsoft 365 E3');
    expect(primaryLicense([])).toBe('Unlicensed');
    expect(signInBucket(3, true)).toBe('active');
    expect(signInBucket(Infinity, true)).toBe('never');
    expect(signInBucket(3, false)).toBe('disabled');
  });
});

describe('loader v2', () => {
  it('round-trips the full demo, users and deployments included', () => {
    const demo = generateDemoFleet();
    const f = parseFleet(JSON.stringify(demo));
    expect(f.users).toHaveLength(demo.users!.length);
    expect(f.deployments).toHaveLength(demo.deployments!.length);
    expect(f.devices[0].fields).toEqual(demo.devices[0].fields);
    expect(f.devices[0].serial).toBe(demo.devices[0].serial);
  });
});

describe('csv', () => {
  it('parses quotes, escaped quotes and semicolons', () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi"""\n')).toEqual([['a', 'b'], ['x, y', 'he said "hi"']]);
    expect(parseCsv('a;b\r\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('merges by device name and turns dates into days from the snapshot', () => {
    const f = fleetOf([base('a'), base('b')]);
    const res = mergeCsv([f], 'Device name,Warranty end,Cost center\nA,2027-10-06,4410\nZZZ,2020-01-01,1');
    expect(res).toMatchObject({ entity: 'device', matched: 1, keyColumn: 'Device name' });
    expect(f.devices[0].fields).toEqual({ 'csv.Warranty end': 365, 'csv.Cost center': 4410 });
    expect(f.lenses?.[0]).toMatchObject({ field: 'csv.Warranty end', kind: 'number', good: 'high' });
  });

  it('merges by serial and by UPN', () => {
    const f = fleetOf([base('a', { serial: 'SN1' })], { users: [{ id: 'u', upn: 'Pat@x.com', enabled: true }] });
    expect(mergeCsv([f], 'Serial number,Owner\nsn1,ops').matched).toBe(1);
    expect(mergeCsv([f], 'UPN,Badge\npat@x.com,yes').entity).toBe('user');
    expect(f.users![0].fields).toEqual({ 'csv.Badge': true });
    expect(() => mergeCsv([f], 'foo,bar\n1,2')).toThrow(/key column/);
  });
});

describe('history', () => {
  it('aligns snapshots by id with presence flags', () => {
    const s1 = fleetOf([base('a'), base('b')], { generated: '2026-10-01T00:00:00Z' });
    const s2 = fleetOf([base('c'), base('a')], { generated: '2026-10-02T00:00:00Z' });
    const [x, y] = alignSnapshots([s2, s1]);
    // Latest snapshot's order comes first.
    expect(y.devices.map((d) => d.id)).toEqual(['c', 'a', 'b']);
    expect(x.devices.map((d) => d.id)).toEqual(['c', 'a', 'b']);
    expect([...presenceOf(x)!.devices]).toEqual([0, 1, 1]);
    expect([...presenceOf(y)!.devices]).toEqual([1, 1, 0]);
  });

  it('generates a demo history that changes over time and ends at today', () => {
    const h = generateDemoHistory(30);
    expect(h).toHaveLength(30);
    const today = generateDemoFleet();
    const last = h[h.length - 1];
    // Today's devices keep their indices; retired ones are appended and absent today.
    expect(last.devices.slice(0, today.devices.length).map((d) => d.id)).toEqual(today.devices.map((d) => d.id));
    expect([...presenceOf(last)!.devices.slice(today.devices.length)].every((x) => x === 0)).toBe(true);
    expect(presenceOf(h[0])!.devices.slice(today.devices.length).some((x) => x === 1)).toBe(true);
    const win10 = (f: Fleet) => f.devices.filter((d, i) => presenceOf(f)!.devices[i] && d.osVersion.includes('.19045.')).length;
    expect(win10(h[0])).toBeGreaterThan(win10(last));
    // New laptops enroll during the window.
    const enrolled = (f: Fleet) => presenceOf(f)!.devices.slice(0, today.devices.length).reduce((a, b) => a + b, 0);
    expect(enrolled(h[0])).toBeLessThan(enrolled(last));
  });
});
