#Requires -Version 7.2
#Requires -Modules Microsoft.Graph.Authentication

<#
.SYNOPSIS
    Exports your Intune-managed Windows devices to a fleet.json for Fleet Galaxy.

.DESCRIPTION
    Read-only. Pulls Windows managed devices from Microsoft Graph and writes the
    fleet.json format Fleet Galaxy loads. Nothing is uploaded anywhere: you drop
    the file onto the page and it's read in your browser.

    Update rings are detected from your Windows Update for Business ring policies
    and their group assignments, ordered by quality update deferral (shortest
    first). Pass -RingGroups to map rings yourself, or -SkipRings to leave them out.

.PARAMETER OutFile
    Where to write the file. Default: .\fleet.json

.PARAMETER SiteSource
    How to group devices into "sites":
      Category   - the Intune device category (default)
      NamePrefix - a regex capture from the device name, see -SitePattern
      None       - everything in one galaxy

.PARAMETER SitePattern
    Regex with one capture group, applied to the device name when
    -SiteSource NamePrefix. Default: '^([A-Za-z]+)-' (MKE-LT-001 -> MKE).

.PARAMETER SiteNames
    Optional hashtable mapping captured prefixes or categories to display
    names, e.g. @{ MKE = 'Milwaukee HQ'; CHI = 'Chicago' }.

.PARAMETER RingGroups
    Ordered hashtable of ring name -> Entra group id, earliest ring first.
    Overrides auto-detection. Groups can contain devices or users.

.PARAMETER IncludeReasons
    Also fetch which compliance policies each non-compliant device fails.
    One extra Graph call per non-compliant device.

.PARAMETER Anonymize
    Replace device names with stable hashes and drop users, so you can share
    screenshots or the file itself.

.EXAMPLE
    ./Export-FleetGalaxy.ps1 -Anonymize

.EXAMPLE
    ./Export-FleetGalaxy.ps1 -SiteSource NamePrefix -SiteNames @{ MKE = 'Milwaukee'; MSN = 'Madison' } -IncludeReasons
#>
[CmdletBinding()]
param(
    [string] $OutFile = './fleet.json',
    [ValidateSet('Category', 'NamePrefix', 'None')]
    [string] $SiteSource = 'Category',
    [string] $SitePattern = '^([A-Za-z]+)-',
    [hashtable] $SiteNames = @{},
    [System.Collections.IDictionary] $RingGroups,
    [switch] $SkipRings,
    [switch] $IncludeReasons,
    [switch] $Anonymize,
    [string] $TenantName
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ---------------------------------------------------------------- connect

$scopes = @('DeviceManagementManagedDevices.Read.All')
$needRings = -not $SkipRings
if ($needRings) { $scopes += 'GroupMember.Read.All' }
if ($needRings -and -not $RingGroups) { $scopes += 'DeviceManagementConfiguration.Read.All' }
if ($IncludeReasons) { $scopes += 'DeviceManagementConfiguration.Read.All' }
$scopes = $scopes | Select-Object -Unique

$ctx = Get-MgContext
$missing = if ($ctx) { $scopes | Where-Object { $_ -notin $ctx.Scopes } } else { $scopes }
if ($missing) {
    Write-Host "Connecting to Microsoft Graph (read-only scopes: $($scopes -join ', '))" -ForegroundColor Cyan
    Connect-MgGraph -Scopes $scopes -NoWelcome
}

function Invoke-GraphPaged([string] $Uri) {
    $results = [System.Collections.Generic.List[object]]::new()
    while ($Uri) {
        $page = Invoke-MgGraphRequest -Method GET -Uri $Uri -OutputType PSObject
        if ($page.PSObject.Properties['value']) { foreach ($v in $page.value) { $results.Add($v) } }
        $Uri = if ($page.PSObject.Properties['@odata.nextLink']) { $page.'@odata.nextLink' } else { $null }
    }
    # .ToArray(): @() over a generic List throws on some PowerShell 7.6 builds.
    , $results.ToArray()
}

function Get-Prop($Object, [string] $Name) {
    if ($null -ne $Object -and $Object.PSObject.Properties[$Name]) { $Object.$Name } else { $null }
}

if (-not $TenantName) {
    try {
        $org = Invoke-MgGraphRequest -Method GET -Uri 'https://graph.microsoft.com/v1.0/organization?$select=displayName' -OutputType PSObject
        $TenantName = $org.value[0].displayName
    } catch {
        $TenantName = 'My tenant'
    }
}

# ---------------------------------------------------------------- devices

Write-Host 'Fetching Windows managed devices...' -ForegroundColor Cyan
$select = 'id,deviceName,userPrincipalName,osVersion,manufacturer,model,complianceState,lastSyncDateTime,enrolledDateTime,isEncrypted,managedDeviceOwnerType,deviceCategoryDisplayName,azureADDeviceId'
$devices = Invoke-GraphPaged "https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?`$filter=operatingSystem eq 'Windows'&`$select=$select"
Write-Host "  $($devices.Count) devices"

# ---------------------------------------------------------------- rings

# Maps Entra device id / UPN -> ring name. First (earliest) ring wins on overlap.
$ringByDevice = @{}
$ringByUser = @{}
$ringOrder = [System.Collections.Generic.List[string]]::new()

function Add-RingMembers([string] $Ring, [string] $GroupId, [bool] $Exclude) {
    $members = Invoke-GraphPaged "https://graph.microsoft.com/v1.0/groups/$GroupId/transitiveMembers?`$select=id,deviceId,userPrincipalName"
    foreach ($m in $members) {
        $deviceId = Get-Prop $m 'deviceId'
        $upn = Get-Prop $m 'userPrincipalName'
        if ($deviceId) {
            if ($Exclude) { $script:ringByDevice[$deviceId] = "!$Ring" }
            elseif (-not $script:ringByDevice.ContainsKey($deviceId)) { $script:ringByDevice[$deviceId] = $Ring }
        } elseif ($upn) {
            $key = $upn.ToLowerInvariant()
            if ($Exclude) { $script:ringByUser[$key] = "!$Ring" }
            elseif (-not $script:ringByUser.ContainsKey($key)) { $script:ringByUser[$key] = $Ring }
        }
    }
}

if ($needRings) {
    if ($RingGroups) {
        foreach ($name in $RingGroups.Keys) {
            $ringOrder.Add([string] $name)
            Add-RingMembers -Ring $name -GroupId $RingGroups[$name] -Exclude $false
        }
    } else {
        Write-Host 'Detecting Windows Update rings...' -ForegroundColor Cyan
        $configs = Invoke-GraphPaged "https://graph.microsoft.com/v1.0/deviceManagement/deviceConfigurations?`$expand=assignments"
        $rings = $configs |
            Where-Object { (Get-Prop $_ '@odata.type') -eq '#microsoft.graph.windowsUpdateForBusinessConfiguration' } |
            Sort-Object { [int](Get-Prop $_ 'qualityUpdatesDeferralPeriodInDays') }, { [int](Get-Prop $_ 'featureUpdatesDeferralPeriodInDays') }
        foreach ($ring in $rings) {
            $ringOrder.Add($ring.displayName)
            foreach ($a in @(Get-Prop $ring 'assignments')) {
                $target = Get-Prop $a 'target'
                $type = Get-Prop $target '@odata.type'
                $groupId = Get-Prop $target 'groupId'
                if ($groupId -and $type -eq '#microsoft.graph.groupAssignmentTarget') {
                    Add-RingMembers -Ring $ring.displayName -GroupId $groupId -Exclude $false
                } elseif ($groupId -and $type -eq '#microsoft.graph.exclusionGroupAssignmentTarget') {
                    Add-RingMembers -Ring $ring.displayName -GroupId $groupId -Exclude $true
                } elseif ($type -eq '#microsoft.graph.allDevicesAssignmentTarget') {
                    $script:allDevicesRing = $ring.displayName
                }
            }
        }
        Write-Host "  $($ringOrder.Count) rings: $($ringOrder -join ' > ')"
    }
}

function Resolve-Ring($Device) {
    $id = Get-Prop $Device 'azureADDeviceId'
    $upn = Get-Prop $Device 'userPrincipalName'
    $ring = if ($id -and $ringByDevice.ContainsKey($id)) { $ringByDevice[$id] }
            elseif ($upn -and $ringByUser.ContainsKey($upn.ToLowerInvariant())) { $ringByUser[$upn.ToLowerInvariant()] }
            else { $null }
    if ($ring -and $ring.StartsWith('!')) { $ring = $null }
    if (-not $ring -and (Get-Variable allDevicesRing -Scope Script -ErrorAction SilentlyContinue)) { $ring = $script:allDevicesRing }
    if ($ring) { $ring } else { 'Unassigned' }
}

# ---------------------------------------------------------------- compliance reasons

$reasons = @{}
if ($IncludeReasons) {
    $bad = @($devices | Where-Object { $_.complianceState -in 'noncompliant', 'inGracePeriod' })
    Write-Host "Fetching compliance details for $($bad.Count) devices..." -ForegroundColor Cyan
    $n = 0
    foreach ($d in $bad) {
        $n++
        if ($n % 25 -eq 0) { Write-Progress -Activity 'Compliance details' -PercentComplete ($n / $bad.Count * 100) }
        try {
            $states = Invoke-GraphPaged "https://graph.microsoft.com/v1.0/deviceManagement/managedDevices/$($d.id)/deviceCompliancePolicyStates"
            $reasons[$d.id] = @($states | Where-Object { $_.state -in 'nonCompliant', 'error', 'conflict' } | ForEach-Object { $_.displayName })
        } catch {
            Write-Verbose "Couldn't read compliance states for $($d.deviceName): $_"
        }
    }
    Write-Progress -Activity 'Compliance details' -Completed
}

# ---------------------------------------------------------------- shape

$sha = [System.Security.Cryptography.SHA256]::Create()
function Get-Hash([string] $Text, [int] $Length = 8) {
    $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text))
    ([System.BitConverter]::ToString($bytes) -replace '-', '').Substring(0, $Length)
}

$complianceMap = @{ compliant = 'compliant'; noncompliant = 'noncompliant'; inGracePeriod = 'ingrace' }

$out = foreach ($d in $devices) {
    $site = switch ($SiteSource) {
        'Category' { Get-Prop $d 'deviceCategoryDisplayName' }
        'NamePrefix' { if ($d.deviceName -match $SitePattern) { $Matches[1].ToUpperInvariant() } }
        'None' { 'All devices' }
    }
    if (-not $site -or $site -eq 'Unknown') { $site = 'Unassigned' }
    if ($SiteNames.ContainsKey($site)) { $site = $SiteNames[$site] }

    $state = [string](Get-Prop $d 'complianceState')
    $owner = [string](Get-Prop $d 'managedDeviceOwnerType')
    $entry = [ordered]@{
        id           = $d.id
        name         = if ($Anonymize) { "DEV-$(Get-Hash $d.id 6)" } else { $d.deviceName }
        osVersion    = [string](Get-Prop $d 'osVersion')
        manufacturer = [string](Get-Prop $d 'manufacturer')
        model        = [string](Get-Prop $d 'model')
        site         = $site
        ring         = if ($needRings) { Resolve-Ring $d } else { 'Unassigned' }
        ownership    = if ($owner -eq 'company') { 'corporate' } elseif ($owner -eq 'personal') { 'personal' } else { 'unknown' }
        compliance   = if ($complianceMap.ContainsKey($state)) { $complianceMap[$state] } else { 'unknown' }
        lastSync     = ([datetime](Get-Prop $d 'lastSyncDateTime')).ToUniversalTime().ToString('o')
        encrypted    = [bool](Get-Prop $d 'isEncrypted')
    }
    $enrolled = Get-Prop $d 'enrolledDateTime'
    if ($enrolled) { $entry.enrolled = ([datetime]$enrolled).ToUniversalTime().ToString('o') }
    if (-not $Anonymize -and (Get-Prop $d 'userPrincipalName')) { $entry.user = $d.userPrincipalName }
    if ($reasons.ContainsKey($d.id) -and $reasons[$d.id].Count) { $entry.complianceReasons = $reasons[$d.id] }
    if ($Anonymize) { $entry.id = Get-Hash $d.id 16 }
    [pscustomobject]$entry
}

$fleet = [ordered]@{
    version   = 1
    tenant    = if ($Anonymize) { 'Anonymized tenant' } else { $TenantName }
    generated = (Get-Date).ToUniversalTime().ToString('o')
    devices   = @($out)
}
if ($ringOrder.Count) { $fleet.rings = @($ringOrder) + @('Unassigned') }

$fleet | ConvertTo-Json -Depth 5 -Compress | Set-Content -Path $OutFile -Encoding utf8NoBOM
$full = (Resolve-Path $OutFile).Path
Write-Host "`nWrote $($out.Count) devices to $full" -ForegroundColor Green
Write-Host 'Open Fleet Galaxy and drop the file onto the page. It never leaves your browser.'
