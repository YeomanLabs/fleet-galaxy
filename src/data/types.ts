// The fleet.json contract. Export-FleetGalaxy.ps1 writes it, the demo generator
// produces it, and load.ts validates anything dropped onto the page against it.

export type Compliance = 'compliant' | 'noncompliant' | 'ingrace' | 'unknown';
export type Ownership = 'corporate' | 'personal' | 'unknown';

export interface Device {
  id: string;
  name: string;
  user?: string;
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
}

export interface Fleet {
  version: 1;
  tenant: string;
  /** ISO 8601, when the export ran. Ages are measured from here, not from "now". */
  generated: string;
  demo?: boolean;
  /** Ring names in rollout order, earliest first. Optional; inferred otherwise. */
  rings?: string[];
  devices: Device[];
}
