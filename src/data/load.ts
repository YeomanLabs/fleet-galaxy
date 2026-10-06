// Validates a fleet.json someone dropped on the page. Everything stays in the
// browser: the file is read locally and never uploaded anywhere.

import type {
  Compliance,
  Deployment,
  DeploymentKind,
  DeploymentStatus,
  Device,
  FieldValue,
  Fleet,
  LensDef,
  MfaStrength,
  Ownership,
  Risk,
  User,
} from './types';

const COMPLIANCE: Compliance[] = ['compliant', 'noncompliant', 'ingrace', 'unknown'];
const OWNERSHIP: Ownership[] = ['corporate', 'personal', 'unknown'];
const MFA: MfaStrength[] = ['none', 'weak', 'strong', 'passwordless'];
const RISK: Risk[] = ['none', 'low', 'medium', 'high'];
const KINDS: DeploymentKind[] = ['app', 'profile', 'remediation'];
const STATUSES: DeploymentStatus[] = ['success', 'failed', 'pending', 'notApplicable', 'conflict', 'fixed', 'recurred'];

export class FleetError extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : v == null ? fallback : String(v);
}

function oneOf<T extends string>(v: unknown, list: T[], fallback: T): T;
function oneOf<T extends string>(v: unknown, list: T[], fallback?: undefined): T | undefined;
function oneOf<T extends string>(v: unknown, list: T[], fallback?: T): T | undefined {
  const s = str(v);
  return list.find((x) => x.toLowerCase() === s.toLowerCase()) ?? fallback;
}

function fields(v: unknown): Record<string, FieldValue> | undefined {
  if (!isObj(v)) return undefined;
  const out: Record<string, FieldValue> = {};
  for (const [k, x] of Object.entries(v)) {
    if (x === null || typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x))) out[k] = x;
  }
  return Object.keys(out).length ? out : undefined;
}

const strings = (v: unknown) => (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : undefined);

function parseDevice(r: Obj, i: number): Device | null {
  const lastSync = str(r.lastSync);
  if (!str(r.id) || Number.isNaN(Date.parse(lastSync))) return null;
  return {
    id: str(r.id) || `row-${i}`,
    name: str(r.name, 'Unnamed device'),
    user: r.user ? str(r.user) : undefined,
    serial: r.serial ? str(r.serial) : undefined,
    osVersion: str(r.osVersion),
    manufacturer: str(r.manufacturer, 'Unknown'),
    model: str(r.model, 'Unknown model'),
    site: str(r.site, 'Unassigned') || 'Unassigned',
    ring: str(r.ring, 'Unassigned') || 'Unassigned',
    ownership: oneOf(r.ownership, OWNERSHIP, 'unknown'),
    compliance: oneOf(r.compliance, COMPLIANCE, 'unknown'),
    complianceReasons: strings(r.complianceReasons),
    lastSync,
    enrolled: r.enrolled ? str(r.enrolled) : undefined,
    encrypted: typeof r.encrypted === 'boolean' ? r.encrypted : undefined,
    fields: fields(r.fields),
  };
}

function parseUser(r: Obj, i: number): User | null {
  const upn = str(r.upn);
  if (!upn) return null;
  const last = str(r.lastSignIn);
  return {
    id: str(r.id) || `user-${i}`,
    upn,
    name: r.name ? str(r.name) : undefined,
    department: r.department ? str(r.department) : undefined,
    office: r.office ? str(r.office) : undefined,
    enabled: r.enabled !== false,
    lastSignIn: last && !Number.isNaN(Date.parse(last)) ? last : undefined,
    mfa: oneOf(r.mfa, MFA),
    methods: strings(r.methods),
    licenses: strings(r.licenses),
    risk: oneOf(r.risk, RISK),
    fields: fields(r.fields),
  };
}

function parseDeployment(r: Obj): Deployment | null {
  const kind = oneOf(r.kind, KINDS);
  if (!kind || !str(r.id) || !isObj(r.status)) return null;
  const status: Record<string, DeploymentStatus> = {};
  for (const [id, s] of Object.entries(r.status)) {
    const v = oneOf(s, STATUSES);
    if (v) status[id] = v;
  }
  return { id: str(r.id), kind, name: str(r.name, 'Unnamed'), url: r.url ? str(r.url) : undefined, status };
}

function parseLens(r: Obj): LensDef | null {
  if (!str(r.field) || !str(r.label) || (r.kind !== 'category' && r.kind !== 'number')) return null;
  return {
    field: str(r.field),
    entity: r.entity === 'user' ? 'user' : 'device',
    label: str(r.label),
    group: r.group ? str(r.group) : undefined,
    description: r.description ? str(r.description) : undefined,
    kind: r.kind,
    categories: Array.isArray(r.categories)
      ? r.categories.filter(isObj).map((c) => ({ key: str(c.key), label: str(c.label, str(c.key)), color: c.color ? str(c.color) : undefined }))
      : undefined,
    stops: Array.isArray(r.stops) ? r.stops.map(Number).filter(Number.isFinite) : undefined,
    good: r.good === 'high' || r.good === 'low' ? r.good : undefined,
    unit: r.unit ? str(r.unit) : undefined,
    bucketLabels: strings(r.bucketLabels),
  };
}

const compact = <T>(list: (T | null)[]): T[] => list.filter((x): x is T => x !== null);

export function parseFleet(text: string): Fleet {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new FleetError("That file isn't valid JSON.");
  }
  if (!isObj(raw)) throw new FleetError('Expected a JSON object.');
  if (raw.version !== 1 && raw.version !== 2) throw new FleetError('Unsupported fleet.json version (expected 1 or 2).');
  if (!Array.isArray(raw.devices)) throw new FleetError('fleet.json has no "devices" array.');

  const devices = compact(raw.devices.map((d, i) => (isObj(d) ? parseDevice(d, i) : null)));
  if (!devices.length) throw new FleetError('No usable devices found (each needs an id and a lastSync date).');

  const generated = str(raw.generated);
  return {
    version: raw.version,
    tenant: str(raw.tenant, 'Your tenant') || 'Your tenant',
    generated: Number.isNaN(Date.parse(generated)) ? new Date().toISOString() : generated,
    demo: false,
    rings: strings(raw.rings),
    devices,
    users: Array.isArray(raw.users) ? compact(raw.users.map((u, i) => (isObj(u) ? parseUser(u, i) : null))) : undefined,
    deployments: Array.isArray(raw.deployments) ? compact(raw.deployments.map((d) => (isObj(d) ? parseDeployment(d) : null))) : undefined,
    lenses: Array.isArray(raw.lenses) ? compact(raw.lenses.map((l) => (isObj(l) ? parseLens(l) : null))) : undefined,
  };
}
