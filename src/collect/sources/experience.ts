// Endpoint Analytics and Windows 11 readiness. Each dataset is optional:
// battery health needs Advanced Analytics, and Endpoint Analytics has to be
// switched on, so one missing dataset doesn't skip the others.

import type { FieldValue } from '../../data/types';
import type { Ctx } from '../collect';
import { GraphError } from '../graph';

export async function collectExperience(ctx: Ctx): Promise<void> {
  const parts: [string, () => Promise<number>][] = [
    ['Startup performance', () => startup(ctx)],
    ['App reliability', () => appHealth(ctx)],
    ['Battery health', () => battery(ctx)],
    ['Windows 11 readiness', () => readiness(ctx)],
  ];
  let any = 0;
  for (const [i, [name, fn]] of parts.entries()) {
    ctx.progress(`Reading ${name.toLowerCase()}`, undefined, i / parts.length);
    try {
      const n = await fn();
      any += n;
      if (!n) ctx.warn(`${name}: no data matched your devices.`);
    } catch (err) {
      if (!(err instanceof GraphError)) throw err;
      ctx.warn(`${name}: ${err.denied ? 'not available (needs Endpoint Analytics' + (name === 'Battery health' ? ' with Advanced Analytics' : '') + ')' : 'failed'} (${err.status} ${err.message})`);
    }
  }
  if (!any) ctx.warn('Endpoint Analytics returned nothing. Is it turned on in Intune?');
}

function set(ctx: Ctx, i: number, key: string, v: FieldValue): void {
  const d = ctx.fleet.devices[i];
  d.fields = { ...d.fields, [key]: v };
}

/**
 * Matches Endpoint Analytics rows to devices. Some datasets document their id
 * as the Intune device id and some don't, so try the id first and fall back to
 * a unique device name.
 */
function matcher(ctx: Ctx) {
  const byName = new Map<string, number | null>();
  ctx.fleet.devices.forEach((d, i) => {
    const k = d.name.toLowerCase();
    byName.set(k, byName.has(k) ? null : i);
  });
  return (id: string | undefined, name: string | undefined): number | undefined => {
    if (id && ctx.byId.has(id)) return ctx.byId.get(id);
    const n = name ? byName.get(name.toLowerCase()) : undefined;
    return n ?? undefined;
  };
}

async function startup(ctx: Ctx): Promise<number> {
  const rows = await ctx.graph.all<{ id?: string; deviceName?: string; startupPerformanceScore?: number; coreBootTimeInMs?: number; groupPolicyBootTimeInMs?: number }>(
    'deviceManagement/userExperienceAnalyticsDevicePerformance',
  );
  const match = matcher(ctx);
  let n = 0;
  for (const r of rows) {
    const i = match(r.id, r.deviceName);
    if (i === undefined) continue;
    n++;
    if (typeof r.startupPerformanceScore === 'number' && r.startupPerformanceScore >= 0) set(ctx, i, 'ea.startupScore', Math.round(r.startupPerformanceScore));
    const ms = (r.coreBootTimeInMs ?? 0) + (r.groupPolicyBootTimeInMs ?? 0);
    if (ms > 0) set(ctx, i, 'ea.bootSeconds', Math.round(ms / 1000));
  }
  return n;
}

async function appHealth(ctx: Ctx): Promise<number> {
  const rows = await ctx.graph.all<{ deviceId?: string; deviceDisplayName?: string; deviceAppHealthScore?: number }>(
    'deviceManagement/userExperienceAnalyticsAppHealthDevicePerformance',
  );
  const match = matcher(ctx);
  let n = 0;
  for (const r of rows) {
    const i = match(r.deviceId, r.deviceDisplayName);
    if (i === undefined || typeof r.deviceAppHealthScore !== 'number' || r.deviceAppHealthScore < 0) continue;
    n++;
    set(ctx, i, 'ea.appReliability', Math.round(r.deviceAppHealthScore));
  }
  return n;
}

async function battery(ctx: Ctx): Promise<number> {
  const rows = await ctx.graph.all<{ deviceId?: string; deviceName?: string; maxCapacityPercentage?: number }>(
    'beta/deviceManagement/userExperienceAnalyticsBatteryHealthDevicePerformance',
  );
  const match = matcher(ctx);
  let n = 0;
  for (const r of rows) {
    const i = match(r.deviceId, r.deviceName);
    if (i === undefined || typeof r.maxCapacityPercentage !== 'number' || r.maxCapacityPercentage <= 0) continue;
    n++;
    set(ctx, i, 'ea.batteryHealth', Math.round(r.maxCapacityPercentage));
  }
  return n;
}

const ELIGIBILITY: Record<string, string> = { upgraded: 'onWin11', capable: 'capable', notCapable: 'notCapable' };

async function readiness(ctx: Ctx): Promise<number> {
  const rows = await ctx.graph.all<{ deviceId?: string; deviceName?: string; upgradeEligibility?: string }>(
    "deviceManagement/userExperienceAnalyticsWorkFromAnywhereMetrics('allDevices')/metricDevices?$select=deviceId,deviceName,upgradeEligibility",
  );
  const match = matcher(ctx);
  let n = 0;
  for (const r of rows) {
    const i = match(r.deviceId, r.deviceName);
    const v = ELIGIBILITY[r.upgradeEligibility ?? ''];
    if (i === undefined || !v) continue;
    n++;
    set(ctx, i, 'lifecycle.win11', v);
  }
  return n;
}
