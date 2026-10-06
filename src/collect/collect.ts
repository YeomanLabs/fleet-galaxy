// Pulls a tenant into a v2 fleet.json. Each data source is independent: if
// one is denied (missing consent, role or license) it's skipped with a
// warning and the rest still load.

import type { Device, Fleet } from '../data/types';
import { Graph, GraphError, pool } from './graph';
import { reportRows, text } from './report';
import { collectDeployments } from './sources/deployments';
import { collectExperience } from './sources/experience';
import { collectSecurity } from './sources/security';
import { collectUsers } from './sources/users';

export type SourceFlags = Record<'devices' | 'deployments' | 'security' | 'experience' | 'users' | 'risk', boolean>;

export interface Progress {
  step: string;
  detail?: string;
  fraction?: number;
}

export interface CollectOptions {
  sources: SourceFlags;
  onProgress?: (p: Progress) => void;
  now?: () => Date;
}

export interface Ctx {
  graph: Graph;
  fleet: Fleet;
  /** managedDevice id -> index */
  byId: Map<string, number>;
  /** Entra device id (azureADDeviceId) -> index */
  byEntraId: Map<string, number>;
  progress: (step: string, detail?: string, fraction?: number) => void;
  warn: (msg: string) => void;
}

interface ManagedDevice {
  id: string;
  deviceName?: string;
  userPrincipalName?: string;
  osVersion?: string;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  complianceState?: string;
  lastSyncDateTime?: string;
  enrolledDateTime?: string;
  isEncrypted?: boolean;
  managedDeviceOwnerType?: string;
  deviceCategoryDisplayName?: string;
  azureADDeviceId?: string;
}

const COMPLIANCE: Record<string, Device['compliance']> = { compliant: 'compliant', noncompliant: 'noncompliant', inGracePeriod: 'ingrace' };

export async function collect(graph: Graph, opts: CollectOptions): Promise<{ fleet: Fleet; warnings: string[] }> {
  const warnings: string[] = [];
  const report = opts.onProgress ?? (() => undefined);
  // Overall progress: each enabled source gets an equal slice.
  const plan = (['devices', 'deployments', 'security', 'experience', 'users'] as const).filter((s) => opts.sources[s] || s === 'devices');
  let slice = 0;
  const progress = (step: string, detail?: string, fraction?: number) =>
    report({ step, detail, fraction: fraction === undefined ? undefined : (slice + Math.min(1, fraction)) / plan.length });

  // ---------------------------------------------------------------- devices (always)
  progress('Reading devices', undefined, 0);
  const select = 'id,deviceName,userPrincipalName,osVersion,manufacturer,model,serialNumber,complianceState,lastSyncDateTime,enrolledDateTime,isEncrypted,managedDeviceOwnerType,deviceCategoryDisplayName,azureADDeviceId';
  const raw = await graph.all<ManagedDevice>(
    `deviceManagement/managedDevices?$filter=operatingSystem eq 'Windows'&$select=${select}&$top=999`,
    (n) => progress('Reading devices', `${n.toLocaleString()} so far`, 0.1),
  );

  let tenant = 'My tenant';
  try {
    const org = await graph.get<{ value: { displayName: string }[] }>('organization?$select=displayName');
    tenant = org.value[0]?.displayName || tenant;
  } catch {
    /* User.Read can read the org name in most tenants; not essential */
  }

  const devices: Device[] = raw
    .filter((d) => d.id && d.lastSyncDateTime)
    .map((d) => ({
      id: d.id,
      name: d.deviceName || 'Unnamed device',
      user: d.userPrincipalName || undefined,
      serial: d.serialNumber || undefined,
      osVersion: d.osVersion ?? '',
      manufacturer: d.manufacturer || 'Unknown',
      model: d.model || 'Unknown model',
      site: d.deviceCategoryDisplayName && d.deviceCategoryDisplayName !== 'Unknown' ? d.deviceCategoryDisplayName : 'Unassigned',
      ring: 'Unassigned',
      ownership: d.managedDeviceOwnerType === 'company' ? 'corporate' : d.managedDeviceOwnerType === 'personal' ? 'personal' : 'unknown',
      compliance: COMPLIANCE[d.complianceState ?? ''] ?? 'unknown',
      lastSync: new Date(d.lastSyncDateTime!).toISOString(),
      enrolled: d.enrolledDateTime ? new Date(d.enrolledDateTime).toISOString() : undefined,
      encrypted: typeof d.isEncrypted === 'boolean' ? d.isEncrypted : undefined,
    }));

  const fleet: Fleet = { version: 2, tenant, generated: (opts.now?.() ?? new Date()).toISOString(), devices };
  const ctx: Ctx = {
    graph,
    fleet,
    byId: new Map(devices.map((d, i) => [d.id, i])),
    byEntraId: new Map(raw.filter((d) => d.azureADDeviceId).map((d) => [d.azureADDeviceId!, devices.findIndex((x) => x.id === d.id)])),
    progress,
    warn: (m) => warnings.push(m),
  };

  await guarded(ctx, 'Update rings', () => collectRings(ctx));
  await guarded(ctx, 'Compliance details', () => collectComplianceReasons(ctx));
  slice++;

  const run = async (flag: keyof SourceFlags, name: string, fn: () => Promise<void>) => {
    if (!opts.sources[flag]) return;
    await guarded(ctx, name, fn);
    slice++;
  };
  await run('deployments', 'Apps, profiles and remediations', () => collectDeployments(ctx));
  await run('security', 'Defender', () => collectSecurity(ctx));
  await run('experience', 'Endpoint Analytics', () => collectExperience(ctx));
  await run('users', 'People', () => collectUsers(ctx, { risk: opts.sources.risk }));

  progress('Done', `${graph.calls.toLocaleString()} Graph requests`, 1);
  return { fleet, warnings };
}

/** Runs one source; permission and license failures become warnings instead of errors. */
async function guarded(ctx: Ctx, name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof GraphError) {
      ctx.warn(`${name}: ${err.denied ? 'not available with your permissions or licenses' : 'failed'} (${err.status} ${err.code || ''} ${err.message}`.trim() + ')');
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------- update rings

interface DeviceConfig {
  id: string;
  displayName: string;
  '@odata.type'?: string;
  qualityUpdatesDeferralPeriodInDays?: number;
  featureUpdatesDeferralPeriodInDays?: number;
  assignments?: { target?: { '@odata.type'?: string; groupId?: string } }[];
}

async function collectRings(ctx: Ctx): Promise<void> {
  ctx.progress('Detecting update rings', undefined, 0.2);
  const configs = await ctx.graph.all<DeviceConfig>('deviceManagement/deviceConfigurations?$expand=assignments');
  const rings = configs
    .filter((c) => c['@odata.type'] === '#microsoft.graph.windowsUpdateForBusinessConfiguration')
    .sort((a, b) => (a.qualityUpdatesDeferralPeriodInDays ?? 0) - (b.qualityUpdatesDeferralPeriodInDays ?? 0) || (a.featureUpdatesDeferralPeriodInDays ?? 0) - (b.featureUpdatesDeferralPeriodInDays ?? 0));
  if (!rings.length) return;

  const devices = ctx.fleet.devices;
  const byUpn = new Map<string, number[]>();
  devices.forEach((d, i) => {
    if (!d.user) return;
    const k = d.user.toLowerCase();
    byUpn.set(k, [...(byUpn.get(k) ?? []), i]);
  });

  // Earliest ring wins on overlap, matching how most admins read ring membership.
  const ringOf = new Array<string | null>(devices.length).fill(null);
  const excluded = new Set<string>();
  let allDevicesRing: string | null = null;

  for (const ring of rings) {
    for (const a of ring.assignments ?? []) {
      const type = a.target?.['@odata.type'];
      const groupId = a.target?.groupId;
      if (type === '#microsoft.graph.allDevicesAssignmentTarget') {
        allDevicesRing ??= ring.displayName;
        continue;
      }
      if (!groupId || (type !== '#microsoft.graph.groupAssignmentTarget' && type !== '#microsoft.graph.exclusionGroupAssignmentTarget')) continue;
      const members = await ctx.graph.all<{ deviceId?: string; userPrincipalName?: string }>(`groups/${groupId}/transitiveMembers?$select=id,deviceId,userPrincipalName&$top=999`);
      const hit: number[] = [];
      for (const m of members) {
        if (m.deviceId) {
          const i = ctx.byEntraId.get(m.deviceId);
          if (i !== undefined && i >= 0) hit.push(i);
        } else if (m.userPrincipalName) {
          hit.push(...(byUpn.get(m.userPrincipalName.toLowerCase()) ?? []));
        }
      }
      for (const i of hit) {
        if (type === '#microsoft.graph.exclusionGroupAssignmentTarget') excluded.add(`${ring.displayName}|${i}`);
        else if (ringOf[i] === null) ringOf[i] = ring.displayName;
      }
    }
  }

  devices.forEach((d, i) => {
    let r = ringOf[i];
    if (r && excluded.has(`${r}|${i}`)) r = null;
    d.ring = r ?? allDevicesRing ?? 'Unassigned';
  });
  ctx.fleet.rings = [...rings.map((r) => r.displayName), 'Unassigned'];
}

// ---------------------------------------------------------------- compliance reasons

const FAILING = /non.?compliant|not compliant|error|conflict|grace/i;

/**
 * Which compliance policies each red device fails. The documented route is the
 * DevicePoliciesComplianceReport action (read-only scope). If that doesn't
 * give readable statuses, fall back to the older per-device endpoint, which
 * Microsoft no longer documents but many tenants still answer.
 */
async function collectComplianceReasons(ctx: Ctx): Promise<void> {
  const bad = ctx.fleet.devices.filter((d) => d.compliance === 'noncompliant' || d.compliance === 'ingrace');
  if (!bad.length) return;
  ctx.progress('Reading compliance details', undefined, 0.3);

  try {
    const rows = await reportRows(ctx.graph, 'getDevicePoliciesComplianceReport', {
      select: ['DeviceId', 'PolicyName', 'PolicyStatus'],
      filter: '',
      orderBy: [],
    });
    const hasText = rows.some((r) => /[a-z]/i.test(text(r, 'PolicyStatus')));
    if (hasText) {
      const reasons = new Map<string, string[]>();
      for (const r of rows) {
        const id = String(r.DeviceId ?? '');
        if (!FAILING.test(text(r, 'PolicyStatus')) || !ctx.byId.has(id)) continue;
        reasons.set(id, [...(reasons.get(id) ?? []), String(r.PolicyName ?? 'Unnamed policy')]);
      }
      for (const d of bad) {
        const list = reasons.get(d.id);
        if (list?.length) d.complianceReasons = [...new Set(list)];
      }
      return;
    }
  } catch (err) {
    if (err instanceof GraphError && err.denied) throw err;
    /* fall through to the per-device endpoint */
  }

  let done = 0;
  let gone = false;
  await pool(bad, 6, async (d) => {
    if (gone) return;
    try {
      const states = await ctx.graph.all<{ displayName?: string; state?: string }>(`deviceManagement/managedDevices/${d.id}/deviceCompliancePolicyStates`);
      const names = states.filter((x) => ['nonCompliant', 'error', 'conflict'].includes(x.state ?? '')).map((x) => x.displayName ?? 'Unnamed policy');
      if (names.length) d.complianceReasons = names;
    } catch (err) {
      if (err instanceof GraphError && err.denied) throw err;
      if (err instanceof GraphError && (err.status === 404 || err.status === 400)) gone = true;
    }
    done++;
    if (done % 10 === 0) ctx.progress('Reading compliance details', `${done} of ${bad.length} devices`, 0.3 + (done / bad.length) * 0.7);
  });
  if (gone) ctx.warn('Compliance details: neither the compliance report nor the per-device endpoint returned policy names, so red devices show no reasons.');
}
