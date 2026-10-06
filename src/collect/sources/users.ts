// People: Entra users with sign-in activity, MFA registration, licenses and
// (optionally) Identity Protection risk.

import type { MfaStrength, Risk, User } from '../../data/types';
import type { Ctx } from '../collect';
import { GraphError } from '../graph';
import { skuName } from '../skus';

interface GraphUser {
  id: string;
  userPrincipalName: string;
  displayName?: string;
  department?: string | null;
  officeLocation?: string | null;
  accountEnabled?: boolean;
  userType?: string | null;
  assignedLicenses?: { skuId: string }[];
  signInActivity?: { lastSignInDateTime?: string | null; lastSuccessfulSignInDateTime?: string | null; lastNonInteractiveSignInDateTime?: string | null } | null;
}

const STRONG = ['microsoftAuthenticatorPush', 'softwareOneTimePasscode', 'hardwareOneTimePasscode', 'fido2', 'windowsHelloForBusiness', 'passKeyDeviceBound', 'passKeyDeviceBoundAuthenticator', 'passKeyDeviceBoundWindowsHello', 'microsoftAuthenticatorPasswordless', 'temporaryAccessPass'];
const WEAK = ['mobilePhone', 'alternateMobilePhone', 'officePhone', 'email', 'sms', 'voiceMobile'];

export function mfaStrength(r: { isPasswordlessCapable?: boolean; isMfaRegistered?: boolean; methodsRegistered?: string[] }): MfaStrength {
  const m = r.methodsRegistered ?? [];
  if (r.isPasswordlessCapable) return 'passwordless';
  if (m.some((x) => STRONG.includes(x))) return 'strong';
  if (m.some((x) => WEAK.includes(x)) || r.isMfaRegistered) return 'weak';
  return 'none';
}

export async function collectUsers(ctx: Ctx, opts: { risk: boolean }): Promise<void> {
  const base = 'id,userPrincipalName,displayName,department,officeLocation,accountEnabled,userType,assignedLicenses';
  let raw: GraphUser[];
  let hasSignIns = true;
  ctx.progress('Reading people', undefined, 0.05);
  try {
    // signInActivity caps pages at 500 and needs Entra ID P1.
    raw = await ctx.graph.all<GraphUser>(`users?$select=${base},signInActivity&$top=500`, (n) => ctx.progress('Reading people', `${n.toLocaleString()} so far`, 0.2));
  } catch (err) {
    if (!(err instanceof GraphError) || !err.denied) throw err;
    hasSignIns = false;
    ctx.warn('Sign-in activity: not available (needs Entra ID P1 and AuditLog.Read.All). People load without last sign-in.');
    raw = await ctx.graph.all<GraphUser>(`users?$select=${base}&$top=999`, (n) => ctx.progress('Reading people', `${n.toLocaleString()} so far`, 0.2));
  }
  const members = raw.filter((u) => u.userType !== 'Guest');

  // License names.
  const skus = new Map<string, string>();
  try {
    const list = await ctx.graph.all<{ skuId: string; skuPartNumber: string }>('subscribedSkus?$select=skuId,skuPartNumber');
    for (const s of list) skus.set(s.skuId, skuName(s.skuPartNumber));
  } catch (err) {
    if (!(err instanceof GraphError)) throw err;
    ctx.warn('License names: not available (needs LicenseAssignment.Read.All). Licenses show as IDs.');
  }

  // MFA registration (doesn't include disabled users).
  ctx.progress('Reading MFA registration', undefined, 0.5);
  const mfa = new Map<string, { mfa: MfaStrength; methods: string[] }>();
  try {
    const rows = await ctx.graph.all<{ id: string; isPasswordlessCapable?: boolean; isMfaRegistered?: boolean; methodsRegistered?: string[] }>(
      'reports/authenticationMethods/userRegistrationDetails',
    );
    for (const r of rows) mfa.set(r.id, { mfa: mfaStrength(r), methods: r.methodsRegistered ?? [] });
  } catch (err) {
    if (!(err instanceof GraphError)) throw err;
    ctx.warn(`MFA registration: ${err.denied ? 'not available (needs Entra ID P1, AuditLog.Read.All and a reports reader role)' : 'failed'} (${err.status} ${err.message})`);
  }

  // Risk (P2).
  const risk = new Map<string, Risk>();
  if (opts.risk) {
    ctx.progress('Reading user risk', undefined, 0.8);
    try {
      const rows = await ctx.graph.all<{ id: string; riskLevel?: string }>('identityProtection/riskyUsers?$select=id,riskLevel&$top=500');
      for (const r of rows) if (['low', 'medium', 'high', 'none'].includes(r.riskLevel ?? '')) risk.set(r.id, r.riskLevel as Risk);
    } catch (err) {
      if (!(err instanceof GraphError)) throw err;
      ctx.warn(`User risk: ${err.denied ? 'not available (needs Entra ID P2 and a security reader role)' : 'failed'} (${err.status} ${err.message})`);
    }
  }

  ctx.fleet.users = members.map((u): User => {
    const s = u.signInActivity;
    // Most recent of interactive and non-interactive sign-ins.
    const times = [s?.lastSignInDateTime, s?.lastSuccessfulSignInDateTime, s?.lastNonInteractiveSignInDateTime].filter((x): x is string => !!x).map(Date.parse).filter(Number.isFinite);
    const last = times.length ? new Date(Math.max(...times)).toISOString() : undefined;
    const reg = mfa.get(u.id);
    return {
      id: u.id,
      upn: u.userPrincipalName,
      name: u.displayName || undefined,
      department: u.department || undefined,
      office: u.officeLocation || undefined,
      enabled: u.accountEnabled !== false,
      lastSignIn: hasSignIns ? last : undefined,
      mfa: reg?.mfa,
      methods: reg?.methods,
      licenses: (u.assignedLicenses ?? []).map((l) => skus.get(l.skuId) ?? l.skuId),
      risk: opts.risk ? (risk.get(u.id) ?? 'none') : undefined,
    };
  });
}
