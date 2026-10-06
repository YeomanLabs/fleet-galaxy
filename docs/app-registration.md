# Using your own app registration

Fleet Galaxy signs in with a shared, multi-tenant Microsoft Entra app registration published by YeomanLabs. Your tenant admin consents to it once, and the data only ever travels between Microsoft Graph and your computer.

Some organisations don't allow third-party apps. In that case, create your own registration in your tenant. It takes about five minutes, and Fleet Galaxy then has no dependency on YeomanLabs at all.

## Option A: script

From the repo, in PowerShell 7 with the `Microsoft.Graph.Authentication` module:

```powershell
./scripts/register-app.ps1 -GrantConsent
```

It creates a single-tenant public client called "Fleet Galaxy" with the permissions below, grants admin consent (drop `-GrantConsent` to have someone else approve it), and prints the client and tenant IDs.

## Option B: Entra admin center

1. **Entra admin center → Identity → Applications → App registrations → New registration.**
   - Name: `Fleet Galaxy`
   - Supported account types: **Accounts in this organizational directory only**
   - Redirect URI: platform **Public client/native (mobile & desktop)**, URI `http://localhost`
2. **API permissions → Add a permission → Microsoft Graph → Delegated permissions.** Add the ones for the data you want (table below), then **Grant admin consent**.
3. From **Overview**, copy the **Application (client) ID** and **Directory (tenant) ID**.
4. In Fleet Galaxy: account menu → **Settings and data sources → App registration**. Paste both IDs and save, then sign in.

No client secret or certificate is needed: Fleet Galaxy is a public client that uses the authorization code flow with PKCE in your browser.

## Permissions

All delegated and read-only. Fleet Galaxy can only see what the signed-in user's own Intune and Entra roles already allow.

| Permission | Used for | Data source in Settings |
| --- | --- | --- |
| `User.Read` | Signing in | always |
| `DeviceManagementManagedDevices.Read.All` | Devices, Defender status, Endpoint Analytics | Devices; Defender; Endpoint Analytics |
| `DeviceManagementConfiguration.Read.All` | Compliance details, update rings, profile and remediation status | Devices; Apps, profiles and remediations |
| `GroupMember.Read.All` | Which devices are in which update ring | Devices |
| `Device.Read.All` | Matching ring group members to devices | Devices |
| `DeviceManagementApps.Read.All` | App install status | Apps, profiles and remediations |
| `DeviceManagementScripts.Read.All` | Remediation script results | Apps, profiles and remediations |
| `User.Read.All` | People: department, office, licenses | People |
| `AuditLog.Read.All` | Last sign-in and MFA registration details | People |
| `LicenseAssignment.Read.All` | License (SKU) names | People |
| `IdentityRiskyUser.Read.All` | User risk level | User risk |

Some sources also need licensing, roles or setup in the tenant:

- Sign-in activity and MFA details need Entra ID P1. The MFA report also needs the signed-in user to hold Reports Reader, Security Reader, Security Administrator or Global Reader.
- User risk needs Entra ID P2 and a security reader role.
- Endpoint Analytics must be turned on in Intune. Battery health is part of Advanced Analytics (Intune Suite or add-on).
- Remediations need Windows Enterprise E3/E5 (or equivalent) licensing.

If something isn't available, Fleet Galaxy skips that source and says why.

**Deliberately not used:** Intune's bulk report export (`exportJobs`) only accepts ReadWrite permissions, so Fleet Galaxy reads Defender status per device and leaves out Settings Catalog profile status, rather than ask for write access.
