// Validates a fleet.json someone dropped on the page. Everything stays in the
// browser: the file is read locally and never uploaded anywhere.

import type { Compliance, Device, Fleet, Ownership } from './types';

const COMPLIANCE: Compliance[] = ['compliant', 'noncompliant', 'ingrace', 'unknown'];
const OWNERSHIP: Ownership[] = ['corporate', 'personal', 'unknown'];

export class FleetError extends Error {}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : v == null ? fallback : String(v);
}

export function parseFleet(text: string): Fleet {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new FleetError("That file isn't valid JSON.");
  }
  if (!raw || typeof raw !== 'object') throw new FleetError('Expected a JSON object.');
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) throw new FleetError('Unsupported fleet.json version (expected 1).');
  if (!Array.isArray(obj.devices)) throw new FleetError('fleet.json has no "devices" array.');

  const devices: Device[] = [];
  obj.devices.forEach((d: unknown, i: number) => {
    if (!d || typeof d !== 'object') return;
    const r = d as Record<string, unknown>;
    const lastSync = str(r.lastSync);
    if (!str(r.id) || Number.isNaN(Date.parse(lastSync))) return;
    const compliance = str(r.compliance).toLowerCase() as Compliance;
    const ownership = str(r.ownership).toLowerCase() as Ownership;
    devices.push({
      id: str(r.id) || `row-${i}`,
      name: str(r.name, 'Unnamed device'),
      user: r.user ? str(r.user) : undefined,
      osVersion: str(r.osVersion),
      manufacturer: str(r.manufacturer, 'Unknown'),
      model: str(r.model, 'Unknown model'),
      site: str(r.site, 'Unassigned') || 'Unassigned',
      ring: str(r.ring, 'Unassigned') || 'Unassigned',
      ownership: OWNERSHIP.includes(ownership) ? ownership : 'unknown',
      compliance: COMPLIANCE.includes(compliance) ? compliance : 'unknown',
      complianceReasons: Array.isArray(r.complianceReasons) ? r.complianceReasons.map((x) => str(x)) : undefined,
      lastSync,
      enrolled: r.enrolled ? str(r.enrolled) : undefined,
      encrypted: typeof r.encrypted === 'boolean' ? r.encrypted : undefined,
    });
  });

  if (!devices.length) throw new FleetError('No usable devices found (each needs an id and a lastSync date).');

  const generated = str(obj.generated);
  return {
    version: 1,
    tenant: str(obj.tenant, 'Your tenant') || 'Your tenant',
    generated: Number.isNaN(Date.parse(generated)) ? new Date().toISOString() : generated,
    demo: false,
    rings: Array.isArray(obj.rings) ? obj.rings.map((x) => str(x)) : undefined,
    devices,
  };
}
