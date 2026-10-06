// The fleet.json contract. Export-FleetGalaxy.ps1 and the desktop app write it,
// the demo generator produces it, and load.ts validates anything dropped onto
// the page against it. Version 2 is a superset of version 1.

export type Compliance = 'compliant' | 'noncompliant' | 'ingrace' | 'unknown';
export type Ownership = 'corporate' | 'personal' | 'unknown';
export type FieldValue = string | number | boolean | null;

export interface Device {
  id: string;
  name: string;
  user?: string;
  serial?: string;
  /** Full Windows build, e.g. "10.0.26100.6899". */
  osVersion: string;
  manufacturer: string;
  model: string;
  /** Free-form grouping: office, region, device category. */
  site: string;
  /** Update ring name; "Unassigned" when unknown. */
  ring: string;
  ownership: Ownership;
  compliance: Compliance;
  /** Names of the compliance policies or settings that failed. */
  complianceReasons?: string[];
  /** ISO 8601. */
  lastSync: string;
  /** ISO 8601. */
  enrolled?: string;
  encrypted?: boolean;
  /**
   * Everything else, keyed by dotted name. Well-known keys (defender.*, ea.*,
   * lifecycle.*) get built-in lenses; anything else gets an automatic one.
   */
  fields?: Record<string, FieldValue>;
}

export type MfaStrength = 'none' | 'weak' | 'strong' | 'passwordless';
export type Risk = 'none' | 'low' | 'medium' | 'high';

export interface User {
  id: string;
  upn: string;
  name?: string;
  department?: string;
  office?: string;
  enabled: boolean;
  /** ISO 8601; absent when the user has never signed in (or the tenant has no P1). */
  lastSignIn?: string;
  mfa?: MfaStrength;
  /** Registered methods, e.g. ["microsoftAuthenticatorPush", "sms"]. */
  methods?: string[];
  /** License (SKU) display names. */
  licenses?: string[];
  risk?: Risk;
  /** Matches Device.user (UPN), so devices can be linked without ids. */
  fields?: Record<string, FieldValue>;
}

export type DeploymentKind = 'app' | 'profile' | 'remediation';
export type DeploymentStatus = 'success' | 'failed' | 'pending' | 'notApplicable' | 'conflict' | 'fixed' | 'recurred';

export interface Deployment {
  id: string;
  kind: DeploymentKind;
  name: string;
  /** Optional link, e.g. the script's source. */
  url?: string;
  /** Device id -> status. Devices not listed aren't targeted. */
  status: Record<string, DeploymentStatus>;
}

export interface LensCategoryDef {
  key: string;
  label: string;
  color?: string;
}

/** Describes a custom field so it gets a proper lens instead of a guessed one. */
export interface LensDef {
  /** The field key, e.g. "csv.warranty" or "defender.risk". */
  field: string;
  entity?: 'device' | 'user';
  label: string;
  group?: string;
  description?: string;
  kind: 'category' | 'number';
  /** Category lenses: listed healthiest first. */
  categories?: LensCategoryDef[];
  /** Number lenses: bucket edges, ascending. */
  stops?: number[];
  /** Number lenses: which end is healthy. */
  good?: 'high' | 'low';
  unit?: string;
  /** Number lenses: one label per bucket (stops.length + 1), lowest first. */
  bucketLabels?: string[];
}

export interface Fleet {
  version: 1 | 2;
  tenant: string;
  /** ISO 8601, when the export ran. Ages are measured from here, not from "now". */
  generated: string;
  demo?: boolean;
  /** Ring names in rollout order, earliest first. Optional; inferred otherwise. */
  rings?: string[];
  devices: Device[];
  users?: User[];
  deployments?: Deployment[];
  lenses?: LensDef[];
}
