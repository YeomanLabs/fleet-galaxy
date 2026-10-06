#Requires -Version 7.2
#Requires -Modules Microsoft.Graph.Authentication

<#
.SYNOPSIS
    Creates an Entra ID app registration for Fleet Galaxy.

.DESCRIPTION
    Creates a public client (no secret) with a http://localhost redirect for
    the desktop app's sign-in, and the read-only Microsoft Graph delegated
    permissions it uses. Permissions are looked up by name, so nothing here
    is hard-coded GUIDs.

    Optional: by default Fleet Galaxy signs in through Microsoft Graph
    Command Line Tools. Create a dedicated registration if your organisation
    prefers one it controls (named, scoped, assignable to specific users).

    Signing in to create the app needs Application.ReadWrite.All (or an
    Application Administrator / Cloud Application Administrator role).

.EXAMPLE
    ./register-app.ps1                 # single-tenant, for your own org
.EXAMPLE
    ./register-app.ps1 -GrantConsent   # also grant tenant-wide admin consent
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string] $DisplayName = 'Fleet Galaxy',
    [switch] $GrantConsent
)

$ErrorActionPreference = 'Stop'

$scopes = @(
    'User.Read'
    'DeviceManagementManagedDevices.Read.All'
    'DeviceManagementConfiguration.Read.All'
    'DeviceManagementApps.Read.All'
    'DeviceManagementScripts.Read.All'
    'GroupMember.Read.All'
    'Device.Read.All'
    'User.Read.All'
    'AuditLog.Read.All'
    'LicenseAssignment.Read.All'
    'IdentityRiskyUser.Read.All'
)

$needed = @('Application.ReadWrite.All')
if ($GrantConsent) { $needed += 'DelegatedPermissionGrant.ReadWrite.All' }
Connect-MgGraph -Scopes $needed -NoWelcome

$graphAppId = '00000003-0000-0000-c000-000000000000'
$graphSp = (Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=appId eq '$graphAppId'&`$select=id,oauth2PermissionScopes" -OutputType PSObject).value[0]

$access = foreach ($name in $scopes) {
    $scope = $graphSp.oauth2PermissionScopes | Where-Object value -EQ $name
    if (-not $scope) { throw "Microsoft Graph has no delegated permission named $name" }
    @{ id = $scope.id; type = 'Scope' }
}

$body = @{
    displayName            = $DisplayName
    signInAudience         = 'AzureADMyOrg'
    isFallbackPublicClient = $true
    publicClient           = @{ redirectUris = @('http://localhost') }
    requiredResourceAccess = @(@{ resourceAppId = $graphAppId; resourceAccess = @($access) })
    info                   = @{ marketingUrl = 'https://github.com/YeomanLabs/fleet-galaxy' }
}

if (-not $PSCmdlet.ShouldProcess($DisplayName, 'Create app registration')) { return }
$app = Invoke-MgGraphRequest -Method POST -Uri 'https://graph.microsoft.com/v1.0/applications' -Body ($body | ConvertTo-Json -Depth 6) -ContentType 'application/json' -OutputType PSObject
$sp = Invoke-MgGraphRequest -Method POST -Uri 'https://graph.microsoft.com/v1.0/servicePrincipals' -Body (@{ appId = $app.appId } | ConvertTo-Json) -ContentType 'application/json' -OutputType PSObject

if ($GrantConsent) {
    $grant = @{ clientId = $sp.id; consentType = 'AllPrincipals'; resourceId = $graphSp.id; scope = ($scopes -join ' ') }
    Invoke-MgGraphRequest -Method POST -Uri 'https://graph.microsoft.com/v1.0/oauth2PermissionGrants' -Body ($grant | ConvertTo-Json) -ContentType 'application/json' | Out-Null
    Write-Host 'Granted tenant-wide admin consent.' -ForegroundColor Green
}

$tenant = (Get-MgContext).TenantId
Write-Host ''
Write-Host "Created '$DisplayName'" -ForegroundColor Green
Write-Host "  Client ID: $($app.appId)"
Write-Host "  Tenant ID: $tenant"
Write-Host ''
Write-Host 'In Fleet Galaxy, open Settings and paste the Client ID and Tenant ID.'
