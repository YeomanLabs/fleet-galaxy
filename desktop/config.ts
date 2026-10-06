// Which data the collector pulls, and the Graph permissions each source needs.
// The app only asks for the scopes of the sources that are switched on.

export type SourceId = 'devices' | 'deployments' | 'security' | 'experience' | 'users' | 'risk';

export interface SourceInfo {
  id: SourceId;
  label: string;
  description: string;
  scopes: string[];
  /** Licensing or setup the tenant needs for this source to return data. */
  needs?: string;
}

export const SOURCES: SourceInfo[] = [
  {
    id: 'devices',
    label: 'Devices, compliance and update rings',
    description: 'Windows devices, compliance state and failing policies, Windows Update rings.',
    scopes: ['DeviceManagementManagedDevices.Read.All', 'DeviceManagementConfiguration.Read.All', 'GroupMember.Read.All', 'Device.Read.All'],
  },
  {
    id: 'deployments',
    label: 'Apps, configuration profiles and remediations',
    description: 'Per-device install and deployment status for assigned apps, profiles and remediation scripts.',
    scopes: ['DeviceManagementApps.Read.All', 'DeviceManagementConfiguration.Read.All', 'DeviceManagementScripts.Read.All'],
  },
  {
    id: 'security',
    label: 'Defender antivirus health',
    description: 'Defender device state, real-time protection, overdue signatures and active malware, as reported to Intune. Reads each device, so it takes a while in big fleets.',
    scopes: ['DeviceManagementManagedDevices.Read.All'],
  },
  {
    id: 'experience',
    label: 'Endpoint Analytics',
    description: 'Startup performance, boot time, app reliability, battery health, Windows 11 readiness.',
    scopes: ['DeviceManagementManagedDevices.Read.All'],
    needs: 'Endpoint Analytics turned on in Intune (battery health needs Advanced Analytics)',
  },
  {
    id: 'users',
    label: 'People: sign-in activity, MFA and licenses',
    description: 'Users with department, office, last sign-in, registered MFA methods and licenses.',
    scopes: ['User.Read.All', 'AuditLog.Read.All', 'LicenseAssignment.Read.All'],
    needs: 'Entra ID P1 for sign-in activity and MFA details, plus a reports reader role for MFA'
  },
  {
    id: 'risk',
    label: 'User risk (Identity Protection)',
    description: 'Risk level for users flagged by Entra ID Protection.',
    scopes: ['IdentityRiskyUser.Read.All'],
    needs: 'Entra ID P2 and a security reader role',
  },
];

export interface Settings {
  sources: Record<SourceId, boolean>;
  /** Blank = Microsoft Graph Command Line Tools (DEFAULT_CLIENT_ID). */
  clientId: string;
  /** Blank = "organizations" (any work account). */
  tenantId: string;
  /** Snapshots loaded into the timeline. */
  historyDays: number;
  /** Snapshots kept on disk. */
  keepDays: number;
}

/**
 * Microsoft Graph Command Line Tools: Microsoft's own public client, present
 * in every tenant (it's what Connect-MgGraph signs in with). Using it means
 * Fleet Galaxy needs no app registration of its own and depends on nothing
 * outside the user's tenant. Organisations can swap in their own client id.
 */
export const DEFAULT_CLIENT_ID = '14d82eec-204b-4c2f-b7e8-296a70dab67e';

export const DEFAULT_SETTINGS: Settings = {
  sources: { devices: true, deployments: true, security: true, experience: true, users: true, risk: false },
  clientId: '',
  tenantId: '',
  historyDays: 60,
  keepDays: 180,
};

export function scopesFor(settings: Settings): string[] {
  const set = new Set<string>(['User.Read']);
  for (const s of SOURCES) if (settings.sources[s.id]) for (const scope of s.scopes) set.add(scope);
  return [...set];
}
