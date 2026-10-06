// Apps, configuration profiles and remediations, each with a per-device status.

import type { Deployment, DeploymentStatus } from '../../data/types';
import type { Ctx } from '../collect';
import { GraphError, pool } from '../graph';
import { reportRows, text } from '../report';

/** Keeps a refresh to a few minutes in big tenants: the most widely deployed items first. */
const MAX_APPS = 40;
const MAX_PROFILES = 40;
const MAX_REMEDIATIONS = 40;

const WINDOWS_APP_TYPES = new Set([
  '#microsoft.graph.win32LobApp',
  '#microsoft.graph.winGetApp',
  '#microsoft.graph.windowsMobileMSI',
  '#microsoft.graph.officeSuiteApp',
  '#microsoft.graph.windowsMicrosoftEdgeApp',
  '#microsoft.graph.windowsUniversalAppX',
  '#microsoft.graph.windowsStoreApp',
  '#microsoft.graph.microsoftStoreForBusinessApp',
  '#microsoft.graph.windowsAppX',
  '#microsoft.graph.win32CatalogApp',
]);

export async function collectDeployments(ctx: Ctx): Promise<void> {
  const out: Deployment[] = [];
  const parts: [string, () => Promise<Deployment[]>][] = [
    ['App install status', () => apps(ctx)],
    ['Configuration profile status', () => profiles(ctx)],
    ['Remediations', () => remediations(ctx)],
  ];
  for (const [name, fn] of parts) {
    try {
      out.push(...(await fn()));
    } catch (err) {
      if (!(err instanceof GraphError)) throw err;
      ctx.warn(`${name}: ${err.denied ? 'not available with your permissions or licenses' : 'failed'} (${err.status} ${err.message})`);
    }
  }
  // Drop items that matched no devices in this fleet.
  ctx.fleet.deployments = out.filter((d) => Object.keys(d.status).length > 0);
}

// ---------------------------------------------------------------- apps

function appStatus(raw: string): DeploymentStatus | null {
  const s = raw.toLowerCase().replace(/\s+/g, '');
  if (/^installed|success/.test(s)) return 'success';
  if (/fail|error/.test(s)) return 'failed';
  if (/pending|notinstalled|inprogress|downloading/.test(s)) return 'pending';
  if (/notapplicable|excluded/.test(s)) return 'notApplicable';
  return null;
}

async function apps(ctx: Ctx): Promise<Deployment[]> {
  ctx.progress('Listing assigned apps', undefined, 0.02);
  const list = await ctx.graph.all<{ id: string; displayName: string; '@odata.type'?: string; isAssigned?: boolean }>(
    "beta/deviceAppManagement/mobileApps?$filter=isAssigned eq true&$select=id,displayName,isAssigned",
  );
  const windows = list.filter((a) => WINDOWS_APP_TYPES.has(a['@odata.type'] ?? '')).slice(0, MAX_APPS);
  const out: Deployment[] = [];
  let done = 0;
  await pool(windows, 3, async (app) => {
    const rows = await reportRows(ctx.graph, 'microsoft.graph.retrieveDeviceAppInstallationStatusReport', {
      select: ['DeviceId', 'DeviceName', 'AppInstallState', 'InstallState'],
      filter: `(ApplicationId eq '${app.id}')`,
      orderBy: [],
    });
    const status: Record<string, DeploymentStatus> = {};
    for (const r of rows) {
      const id = String(r.DeviceId ?? '');
      if (!ctx.byId.has(id)) continue;
      const s = appStatus(text(r, 'AppInstallState') || text(r, 'InstallState'));
      if (s) status[id] = s;
    }
    out.push({ id: `app-${app.id}`, kind: 'app', name: app.displayName, status });
    done++;
    ctx.progress('Reading app install status', `${done} of ${windows.length} apps`, 0.05 + (done / windows.length) * 0.4);
  });
  return out;
}

// ---------------------------------------------------------------- profiles

const PROFILE_STATUS: Record<string, DeploymentStatus> = {
  compliant: 'success',
  remediated: 'success',
  nonCompliant: 'failed',
  error: 'failed',
  conflict: 'conflict',
  notApplicable: 'notApplicable',
  unknown: 'pending',
};

/**
 * Classic device configuration profiles. Their deviceStatuses carry no device
 * id, so rows are matched by device name (and user where names repeat).
 * Settings Catalog policies need the report export API, which requires a
 * ReadWrite scope, so they're left out on purpose.
 */
async function profiles(ctx: Ctx): Promise<Deployment[]> {
  ctx.progress('Listing configuration profiles', undefined, 0.48);
  const configs = await ctx.graph.all<{ id: string; displayName: string; '@odata.type'?: string }>('deviceManagement/deviceConfigurations?$select=id,displayName');
  const windows = configs.filter((c) => /windows|win10|win32|sharedPC|editionUpgrade|wifi|vpn|edge/i.test(c['@odata.type'] ?? '') && !/windowsUpdateForBusiness/i.test(c['@odata.type'] ?? '')).slice(0, MAX_PROFILES);

  const byName = new Map<string, number[]>();
  ctx.fleet.devices.forEach((d, i) => {
    const k = d.name.toLowerCase();
    byName.set(k, [...(byName.get(k) ?? []), i]);
  });

  const out: Deployment[] = [];
  let done = 0;
  await pool(windows, 4, async (cfg) => {
    const rows = await ctx.graph.all<{ deviceDisplayName?: string; userPrincipalName?: string; status?: string }>(
      `deviceManagement/deviceConfigurations/${cfg.id}/deviceStatuses`,
    );
    const status: Record<string, DeploymentStatus> = {};
    for (const r of rows) {
      const hits = byName.get((r.deviceDisplayName ?? '').toLowerCase()) ?? [];
      const i = hits.length === 1 ? hits[0] : hits.find((h) => ctx.fleet.devices[h].user?.toLowerCase() === r.userPrincipalName?.toLowerCase());
      const s = PROFILE_STATUS[r.status ?? ''];
      if (i === undefined || !s) continue;
      const id = ctx.fleet.devices[i].id;
      // A device can report once per user; keep the worst result.
      if (!status[id] || rank(s) > rank(status[id])) status[id] = s;
    }
    out.push({ id: `cfg-${cfg.id}`, kind: 'profile', name: cfg.displayName, status });
    done++;
    ctx.progress('Reading profile status', `${done} of ${windows.length} profiles`, 0.5 + (done / windows.length) * 0.25);
  });
  return out;
}

const RANK: DeploymentStatus[] = ['notApplicable', 'success', 'fixed', 'pending', 'recurred', 'conflict', 'failed'];
const rank = (s: DeploymentStatus) => RANK.indexOf(s);

// ---------------------------------------------------------------- remediations

/** detectionState + remediationState -> one status. */
export function remediationStatus(detection?: string, remediation?: string): DeploymentStatus | null {
  if (detection === 'notApplicable') return null;
  if (remediation === 'success') return 'fixed';
  if (remediation === 'remediationFailed' || remediation === 'scriptError' || detection === 'scriptError') return 'failed';
  if (detection === 'success') return 'success';
  if (detection === 'fail') return 'recurred';
  return 'pending';
}

async function remediations(ctx: Ctx): Promise<Deployment[]> {
  ctx.progress('Listing remediations', undefined, 0.76);
  const scripts = (await ctx.graph.all<{ id: string; displayName: string; isGlobalScript?: boolean }>('beta/deviceManagement/deviceHealthScripts?$select=id,displayName,isGlobalScript')).slice(0, MAX_REMEDIATIONS);
  const out: Deployment[] = [];
  let done = 0;
  await pool(scripts, 3, async (script) => {
    const rows = await ctx.graph.all<{ detectionState?: string; remediationState?: string; managedDevice?: { id?: string } }>(
      `beta/deviceManagement/deviceHealthScripts/${script.id}/deviceRunStates?$expand=managedDevice($select=id)`,
    );
    const status: Record<string, DeploymentStatus> = {};
    for (const r of rows) {
      const id = r.managedDevice?.id;
      if (!id || !ctx.byId.has(id)) continue;
      const s = remediationStatus(r.detectionState, r.remediationState);
      if (s) status[id] = s;
    }
    out.push({ id: `rem-${script.id}`, kind: 'remediation', name: script.displayName, status });
    done++;
    ctx.progress('Reading remediation results', `${done} of ${scripts.length} scripts`, 0.78 + (done / scripts.length) * 0.22);
  });
  return out;
}
