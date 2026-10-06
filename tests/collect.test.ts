import { describe, expect, it } from 'vitest';
import { anonymize } from '../src/collect/anonymize';
import { collect, type SourceFlags } from '../src/collect/collect';
import { Graph, type FetchLike } from '../src/collect/graph';
import { rowsOf } from '../src/collect/report';
import { remediationStatus } from '../src/collect/sources/deployments';
import { mfaStrength } from '../src/collect/sources/users';
import { skuName } from '../src/collect/skus';
import { parseFleet } from '../src/data/load';

type Handler = (url: string, body: unknown) => unknown | { __status: number; code?: string; message?: string };

/** A tiny fake Graph: first matching route wins. */
function fakeFetch(routes: [RegExp, Handler][], log: string[] = []): FetchLike {
  return async (url, init) => {
    log.push(`${init?.method ?? 'GET'} ${url.replace('https://graph.microsoft.com/', '')}`);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    for (const [re, h] of routes) {
      if (!re.test(url)) continue;
      const out = h(url, body) as { __status?: number; code?: string; message?: string };
      const status = out && typeof out === 'object' && '__status' in out ? out.__status! : 200;
      return {
        ok: status < 400,
        status,
        headers: { get: (n: string) => (n === 'Retry-After' && status === 429 ? '0' : null) },
        json: async () => (status < 400 ? out : { error: { code: out.code ?? 'Err', message: out.message ?? 'error' } }),
        text: async () => JSON.stringify(out),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    throw new Error(`unmocked ${url}`);
  };
}

const denied = () => ({ __status: 403, code: 'Forbidden', message: 'Insufficient privileges' });
const md = (id: string, extra: Record<string, unknown> = {}) => ({
  id, deviceName: id.toUpperCase(), userPrincipalName: `${id}@x.com`, osVersion: '10.0.26100.6899', manufacturer: 'Dell Inc.', model: 'Latitude',
  serialNumber: `SN-${id}`, complianceState: 'compliant', lastSyncDateTime: '2026-10-06T10:00:00Z', enrolledDateTime: '2025-01-01T00:00:00Z',
  isEncrypted: true, managedDeviceOwnerType: 'company', deviceCategoryDisplayName: 'HQ', azureADDeviceId: `aad-${id}`, ...extra,
});

function tenant(overrides: [RegExp, Handler][] = []): [RegExp, Handler][] {
  let throttled = false;
  return [
    ...overrides,
    // Devices, two pages, with one throttle in between.
    [/managedDevices\?\$filter=operatingSystem/, () => ({ value: [md('d1'), md('d2', { complianceState: 'noncompliant' })], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/page2' })],
    [/\/page2$/, () => {
      if (!throttled) { throttled = true; return { __status: 429 }; }
      return { value: [md('d3', { userPrincipalName: 'd1@x.com', complianceState: 'inGracePeriod' }), md('d4', { lastSyncDateTime: null })] };
    }],
    [/organization\?/, () => ({ value: [{ displayName: 'Mock Corp' }] })],
    // Rings: Pilot (device group) before Broad (user group, with an exclusion).
    [/deviceConfigurations\?\$expand=assignments/, () => ({ value: [
      { id: 'r2', displayName: 'Broad', '@odata.type': '#microsoft.graph.windowsUpdateForBusinessConfiguration', qualityUpdatesDeferralPeriodInDays: 7, assignments: [
        { target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: 'gUsers' } },
        { target: { '@odata.type': '#microsoft.graph.exclusionGroupAssignmentTarget', groupId: 'gExcl' } },
      ] },
      { id: 'r1', displayName: 'Pilot', '@odata.type': '#microsoft.graph.windowsUpdateForBusinessConfiguration', qualityUpdatesDeferralPeriodInDays: 0, assignments: [
        { target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: 'gDev' } },
      ] },
      { id: 'x', displayName: 'Other', '@odata.type': '#microsoft.graph.windows10GeneralConfiguration', assignments: [] },
    ] })],
    [/groups\/gDev\//, () => ({ value: [{ id: 'o1', deviceId: 'aad-d1' }] })],
    [/groups\/gUsers\//, () => ({ value: [{ id: 'o2', userPrincipalName: 'D1@x.com' }, { id: 'o3', userPrincipalName: 'd2@x.com' }] })],
    [/groups\/gExcl\//, () => ({ value: [{ id: 'o4', deviceId: 'aad-d2' }] })],
    // Compliance report.
    [/getDevicePoliciesComplianceReport/, () => ({ TotalRowCount: 2, Schema: [{ Column: 'DeviceId' }, { Column: 'PolicyName' }, { Column: 'PolicyStatus' }, { Column: 'PolicyStatus_loc' }], Values: [['d2', 'BitLocker', 4, 'Not compliant'], ['d2', 'Firewall', 2, 'Compliant']] })],
    // Deployments.
    [/mobileApps\?\$filter=isAssigned/, () => ({ value: [{ id: 'a1', displayName: 'Teams', '@odata.type': '#microsoft.graph.win32LobApp' }, { id: 'a2', displayName: 'iOS thing', '@odata.type': '#microsoft.graph.iosVppApp' }] })],
    [/retrieveDeviceAppInstallationStatusReport/, (_u, b) => {
      expect((b as { filter: string }).filter).toBe("(ApplicationId eq 'a1')");
      return { TotalRowCount: 2, Schema: [{ Column: 'DeviceId' }, { Column: 'AppInstallState' }, { Column: 'AppInstallState_loc' }], Values: [['d1', 1, 'Installed'], ['d2', 2, 'Failed'], ['zz', 1, 'Installed']] };
    }],
    [/deviceConfigurations\?\$select=id,displayName/, () => ({ value: [{ id: 'c1', displayName: 'Wi-Fi', '@odata.type': '#microsoft.graph.windowsWifiConfiguration' }] })],
    [/deviceConfigurations\/c1\/deviceStatuses/, () => ({ value: [{ deviceDisplayName: 'D1', userPrincipalName: 'd1@x.com', status: 'compliant' }, { deviceDisplayName: 'D2', status: 'conflict' }, { deviceDisplayName: 'D2', status: 'error' }] })],
    [/deviceHealthScripts\?/, () => ({ value: [{ id: 's1', displayName: 'Stale definitions' }] })],
    [/deviceHealthScripts\/s1\/deviceRunStates/, () => ({ value: [
      { detectionState: 'success', remediationState: 'skipped', managedDevice: { id: 'd1' } },
      { detectionState: 'fail', remediationState: 'success', managedDevice: { id: 'd2' } },
      { detectionState: 'notApplicable', managedDevice: { id: 'd3' } },
    ] })],
    // Security, per device.
    [/beta\/deviceManagement\/managedDevices\/d\d\?/, (u) => ({ windowsActiveMalwareCount: u.includes('/d2?') ? 2 : 0, windowsProtectionState: { deviceState: u.includes('/d2?') ? 'critical' : 'clean', realTimeProtectionEnabled: true, signatureUpdateOverdue: u.includes('/d3?') } })],
    // Endpoint Analytics: performance keyed by name, app health by id; battery denied.
    [/userExperienceAnalyticsDevicePerformance/, () => ({ value: [{ id: 'unrelated-guid', deviceName: 'D1', startupPerformanceScore: 88, coreBootTimeInMs: 20000, groupPolicyBootTimeInMs: 5000 }] })],
    [/userExperienceAnalyticsAppHealthDevicePerformance/, () => ({ value: [{ deviceId: 'd2', deviceAppHealthScore: 61.4 }] })],
    [/BatteryHealthDevicePerformance/, denied],
    [/metricDevices/, () => ({ value: [{ deviceId: 'd1', upgradeEligibility: 'upgraded' }, { deviceId: 'd3', upgradeEligibility: 'notCapable' }] })],
    // People.
    [/users\?\$select=.*signInActivity/, () => ({ value: [
      { id: 'u1', userPrincipalName: 'd1@x.com', displayName: 'Dee One', department: 'IT', accountEnabled: true, userType: 'Member', assignedLicenses: [{ skuId: 'sku-e5' }], signInActivity: { lastSignInDateTime: '2026-10-01T00:00:00Z', lastNonInteractiveSignInDateTime: '2026-10-05T00:00:00Z' } },
      { id: 'u2', userPrincipalName: 'd2@x.com', accountEnabled: false, userType: 'Member', assignedLicenses: [], signInActivity: null },
      { id: 'g1', userPrincipalName: 'guest#EXT#@x.com', userType: 'Guest' },
    ] })],
    [/subscribedSkus/, () => ({ value: [{ skuId: 'sku-e5', skuPartNumber: 'SPE_E5' }] })],
    [/userRegistrationDetails/, () => ({ value: [{ id: 'u1', isPasswordlessCapable: false, isMfaRegistered: true, methodsRegistered: ['microsoftAuthenticatorPush', 'mobilePhone'] }] })],
    [/riskyUsers/, denied],
  ];
}

const ALL: SourceFlags = { devices: true, deployments: true, security: true, experience: true, users: true, risk: true };
const run = async (routes: [RegExp, Handler][], sources: SourceFlags = ALL, log?: string[]) =>
  collect(new Graph({ token: async () => 'tok', fetch: fakeFetch(routes, log), sleep: async () => undefined }), { sources, now: () => new Date('2026-10-06T12:00:00Z') });

describe('collector', () => {
  it('builds a full v2 fleet from Graph, surviving throttling and paging', async () => {
    const log: string[] = [];
    const { fleet, warnings } = await run(tenant(), ALL, log);
    expect(fleet.tenant).toBe('Mock Corp');
    // d4 has no lastSync and is dropped.
    expect(fleet.devices.map((d) => d.id)).toEqual(['d1', 'd2', 'd3']);
    expect(log.filter((l) => l.endsWith('page2'))).toHaveLength(2);

    const [d1, d2, d3] = fleet.devices;
    expect(fleet.rings).toEqual(['Pilot', 'Broad', 'Unassigned']);
    expect(d1.ring).toBe('Pilot'); // in Pilot by device and Broad by user: earliest wins
    expect(d2.ring).toBe('Unassigned'); // in Broad by user, but excluded by device
    expect(d3.ring).toBe('Broad'); // owned by d1@ (user group)

    expect(d2.complianceReasons).toEqual(['BitLocker']);
    expect(d3.compliance).toBe('ingrace');

    const dep = Object.fromEntries((fleet.deployments ?? []).map((d) => [d.name, d.status]));
    expect(dep.Teams).toEqual({ d1: 'success', d2: 'failed' });
    expect(dep['Wi-Fi']).toEqual({ d1: 'success', d2: 'failed' }); // worst of conflict + error
    expect(dep['Stale definitions']).toEqual({ d1: 'success', d2: 'fixed' });
    expect(dep['iOS thing']).toBeUndefined();

    expect(d2.fields).toMatchObject({ 'defender.state': 'critical', 'defender.threats': 2, 'ea.appReliability': 61 });
    expect(d1.fields).toMatchObject({ 'ea.startupScore': 88, 'ea.bootSeconds': 25, 'lifecycle.win11': 'onWin11' });
    expect(d3.fields).toMatchObject({ 'defender.signaturesOverdue': true, 'lifecycle.win11': 'notCapable' });

    expect(fleet.users?.map((u) => u.upn)).toEqual(['d1@x.com', 'd2@x.com']);
    expect(fleet.users?.[0]).toMatchObject({ mfa: 'strong', licenses: ['Microsoft 365 E5'], lastSignIn: '2026-10-05T00:00:00.000Z', risk: 'none' });
    expect(fleet.users?.[1]).toMatchObject({ enabled: false, licenses: [] });

    expect(warnings.some((w) => w.startsWith('Battery health'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('User risk'))).toBe(true);
    // And the output is a valid fleet.json.
    expect(parseFleet(JSON.stringify(fleet)).devices).toHaveLength(3);
  });

  it('skips denied sources instead of failing', async () => {
    const { fleet, warnings } = await run(tenant([
      [/mobileApps/, denied],
      [/deviceHealthScripts/, denied],
      [/beta\/deviceManagement\/managedDevices\/d\d\?/, denied],
      [/users\?\$select=.*signInActivity/, () => ({ __status: 403, code: 'Authentication_RequestFromNonPremiumTenantOrB2CTenant', message: 'Neither tenant is B2C or tenant does not have premium license' })],
      [/users\?\$select=.*\$top=999/, () => ({ value: [{ id: 'u1', userPrincipalName: 'd1@x.com', accountEnabled: true, userType: 'Member', assignedLicenses: [] }] })],
    ]));
    expect(fleet.devices).toHaveLength(3);
    expect(warnings.join('\n')).toMatch(/App install status/);
    expect(warnings.join('\n')).toMatch(/Defender/);
    expect(warnings.join('\n')).toMatch(/Sign-in activity/);
    // Falls back to users without sign-in data.
    expect(fleet.users).toHaveLength(1);
    expect(fleet.users?.[0].lastSignIn).toBeUndefined();
  });

  it('only calls the sources that are switched on', async () => {
    const log: string[] = [];
    await run(tenant(), { devices: true, deployments: false, security: false, experience: false, users: false, risk: false }, log);
    expect(log.some((l) => /mobileApps|users\?|userExperience|beta\/deviceManagement\/managedDevices\//.test(l))).toBe(false);
  });
});

describe('collector helpers', () => {
  it('parses report tables', () => {
    expect(rowsOf({ Schema: [{ Column: 'A' }, { Column: 'B' }], Values: [[1, 'x']] })).toEqual([{ A: 1, B: 'x' }]);
    expect(rowsOf({})).toEqual([]);
  });

  it('maps remediation states', () => {
    expect(remediationStatus('success', 'skipped')).toBe('success');
    expect(remediationStatus('fail', 'success')).toBe('fixed');
    expect(remediationStatus('fail', 'remediationFailed')).toBe('failed');
    expect(remediationStatus('fail', 'skipped')).toBe('recurred');
    expect(remediationStatus('pending', undefined)).toBe('pending');
    expect(remediationStatus('notApplicable', undefined)).toBeNull();
  });

  it('grades MFA strength', () => {
    expect(mfaStrength({ isPasswordlessCapable: true })).toBe('passwordless');
    expect(mfaStrength({ methodsRegistered: ['microsoftAuthenticatorPush'] })).toBe('strong');
    expect(mfaStrength({ methodsRegistered: ['mobilePhone'] })).toBe('weak');
    expect(mfaStrength({ methodsRegistered: [] })).toBe('none');
  });

  it('names licenses', () => {
    expect(skuName('SPE_E3')).toBe('Microsoft 365 E3');
    expect(skuName('SOME_NEW_SKU')).toBe('SOME NEW SKU');
  });

  it('anonymizes consistently and irreversibly', () => {
    const f = parseFleet(JSON.stringify({ version: 2, tenant: 'Real Co', generated: '2026-10-06T00:00:00Z',
      devices: [{ id: 'abc', name: 'PC-1', user: 'pat@real.com', serial: 'S1', lastSync: '2026-10-06T00:00:00Z' }],
      users: [{ id: 'u', upn: 'Pat@real.com', name: 'Pat' }],
      deployments: [{ id: 'x', kind: 'app', name: 'App', status: { abc: 'failed' } }] }));
    const a = anonymize(f, 'salt');
    expect(a.tenant).toBe('Anonymized tenant');
    expect(JSON.stringify(a)).not.toMatch(/real\.com|PC-1|Pat"|S1/);
    expect(a.devices[0].user).toBe(a.users![0].upn); // still linked
    expect(Object.keys(a.deployments![0].status)[0]).toBe(a.devices[0].id);
  });
});
