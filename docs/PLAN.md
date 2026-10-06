# Fleet Galaxy v2 plan

Agreed with the user 2026-10-06. Work top-down; one milestone at a time, committed and pushed when its checks pass.

## Goals

1. **Lenses beyond patching:** deployments (apps, configuration profiles, remediations), security (Defender), experience (Endpoint Analytics), lifecycle, plus arbitrary custom fields.
2. **People galaxy:** users as stars (MFA, sign-in activity, risk, licenses), linked to their devices.
3. **Time machine:** real snapshot history with a timeline scrubber, replacing the simulated replay when history exists.
4. **Desktop app:** download, "Sign in with Microsoft", see your galaxy. No PowerShell, no JSON. Tenant-agnostic.
5. **Download page** on GitHub Pages (landing at `/`, live demo at `/demo/`), installers on GitHub Releases.

## Decisions

- **Standalone sign-in, no YeomanLabs registration** (user's decision 2026-10-06: "not connected to anything else"). Default client is Microsoft Graph Command Line Tools (14d82eec-204b-4c2f-b7e8-296a70dab67e), present in every tenant. Settings accept the org's own app registration (client id + tenant id); scripts/register-app.ps1 creates one single-tenant.
- **Incremental consent.** Each data source (devices, deployments, security, experience, users, risk) is a checkbox; the app only requests the scopes for what's enabled.
- **One collector, in TypeScript** (`src/collect/`), run in the Electron main process with Node fetch. The PowerShell exporter stays as a core-only alternative (devices, rings, compliance) and keeps working.
- **Schema v2** is a superset of v1; v1 files still load.
- **Desktop shell is Electron** (same stack the user already ships in Sidekick): msal-node interactive login via system browser, token cache encrypted with `safeStorage`, snapshots stored in `userData/snapshots/YYYY-MM-DD.json` (one per day, latest wins).
- Installers are unsigned at first (SmartScreen warning); say so on the download page.

## Schema v2 (additions)

```ts
Fleet {
  version: 2
  devices: Device[]            // + serial?, fields?: Record<string, FieldValue>
  users?: User[]               // People galaxy
  deployments?: Deployment[]   // apps / profiles / remediations with per-device status
  lenses?: LensDef[]           // describes custom fields (label, kind, categories or numeric direction)
}
```

Built-in device fields used by lenses: `defender.*` (risk, signatures age, realtime, threats), `ea.*` (startup score, app reliability, battery health), `lifecycle.*` (Win11 eligible, enrolled age). Unknown fields get auto-lenses (category if few distinct strings, numeric ramp otherwise).

## Milestones

- **M1 Lens engine + schema v2 + custom fields.** Generic categorical/numeric lenses, lens picker UI that scales past 4 modes, group-by any categorical field, CSV merge (drop a CSV keyed by device name or serial to add fields, e.g. warranty). Demo fleet gains the new fields. *Check:* unit tests, v1 files still load, screenshots.
- **M2 Deployment, security, experience, lifecycle lenses.** Deployment lens with item picker (app/profile/remediation → success/failed/pending/not applicable). Demo data for all. *Check:* each lens screenshot reads correctly.
- **M3 People galaxy.** Devices/People switch, user lenses (MFA strength, sign-in activity, risk, license), click a user to draw constellation lines to their devices. *Check:* demo screenshots, picking works in both modes.
- **M4 Time machine.** Load a series of snapshots (drop several files, or the desktop app's store), timeline scrubber that animates stars between days, devices appearing and retiring. Demo ships 60 days of synthetic history. Replay becomes "real" when history exists. *Check:* scrub test, perf with 60 × 3,500.
- **M5 Desktop app.** Electron shell around the same UI, sign-in, settings (data sources, own app registration), collector with progress, snapshot store, packaging (NSIS x64). *Check:* signs in to the user's tenant and renders it (user drives the sign-in).
- **M6 Ship.** App registration (ask first), landing/download page, release workflow (Windows + macOS dmg via CI on tag), README rewrite. *Check:* fresh download installs and works.

Then: **i9s** (k9s-style terminal UI) — language still to be chosen by the user.

## Graph sources (for the collector)

| Data | Endpoint | Scope |
| --- | --- | --- |
| Devices | `v1.0/deviceManagement/managedDevices` | DeviceManagementManagedDevices.Read.All |
| Rings | `v1.0/deviceManagement/deviceConfigurations` (WUfB) + group members | DeviceManagementConfiguration.Read.All, GroupMember.Read.All |
| Compliance reasons | `managedDevices/{id}/deviceCompliancePolicyStates` | DeviceManagementConfiguration.Read.All |
| App install status | `beta/deviceManagement/reports/getDeviceInstallStatusReport` | DeviceManagementApps.Read.All |
| Profile status | `v1.0/deviceManagement/deviceConfigurations/{id}/deviceStatuses` | DeviceManagementConfiguration.Read.All |
| Remediations | `beta/deviceManagement/deviceHealthScripts/{id}/deviceRunStates` | DeviceManagementConfiguration.Read.All |
| Defender | `beta/deviceManagement/reports/exportJobs` (`DefenderAgents`) | DeviceManagementManagedDevices.Read.All |
| Endpoint Analytics | `beta/deviceManagement/userExperienceAnalyticsDevicePerformance`, `...BatteryHealthDevicePerformance` | DeviceManagementManagedDevices.Read.All |
| Win11 readiness | `beta/deviceManagement/userExperienceAnalyticsWorkFromAnywhereMetrics/allDevices/metricDevices` | DeviceManagementManagedDevices.Read.All |
| Users | `v1.0/users` (+ `signInActivity`) | User.Read.All, AuditLog.Read.All |
| MFA methods | `v1.0/reports/authenticationMethods/userRegistrationDetails` | AuditLog.Read.All |
| Licenses | `v1.0/subscribedSkus` | Organization.Read.All |
| Risky users | `v1.0/identityProtection/riskyUsers` (P2) | IdentityRiskyUser.Read.All |

Endpoint details must be verified against Microsoft's docs while building the collector; beta endpoints are marked as such in the UI.
