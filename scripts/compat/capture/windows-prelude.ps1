# Wire-fixture capture (0.73.1): a stand-in Windows for the standard agent's
# real heartbeat.ps1, run under PowerShell 7 on Linux by capture-wire.mjs.
#
# Every function here shadows a cmdlet the agent calls (functions win over
# cmdlets in PowerShell's command lookup), so the agent's own code builds every
# request body exactly as it would on Windows, from these synthetic values.
# Nothing here is from a real computer: names are fixtures, addresses are
# RFC 5737 (192.0.2.0/24), the domain is wire.example.
#
# Invoke-RestMethod is the capture point: it appends what the agent sent (the
# path and the body text, byte for byte) to $env:WIRE_CAPTURE and answers with
# the canned response for that path from $env:WIRE_RESPONSES. Nothing leaves
# this machine.

$env:COMPUTERNAME = 'WIRE-FIXTURE-PC'
$env:SystemDrive = 'C:'

function Invoke-RestMethod {
    [CmdletBinding()]
    param([string]$Uri, [string]$Method, $Body, [string]$ContentType, [switch]$UseBasicParsing, [int]$TimeoutSec)
    $p = ([uri]$Uri).AbsolutePath -replace '^/api/v1', ''
    $rec = [ordered]@{ path = $p; method = $Method; body = [string]$Body }
    Add-Content -LiteralPath $env:WIRE_CAPTURE -Value ($rec | ConvertTo-Json -Compress -Depth 3)
    $map = Get-Content -Raw -LiteralPath $env:WIRE_RESPONSES | ConvertFrom-Json
    $hit = $map.PSObject.Properties[$p]
    if ($hit) { return $hit.Value }
    return $map.PSObject.Properties['default'].Value
}

function icacls { }
function schtasks { }

$script:WireNow = Get-Date
function New-WireObj([hashtable]$h) { return [pscustomobject]$h }

function Get-CimInstance {
    [CmdletBinding()]
    param([Parameter(Position = 0)][string]$ClassName, [string]$Filter, [string]$Namespace, [string]$Query)
    switch ($ClassName) {
        'Win32_ComputerSystem' { return New-WireObj @{ UserName = 'WIREFIX\tech'; Manufacturer = 'Contoso Hardware'; Model = 'Fixture 9000'; Domain = 'wire.example'; TotalPhysicalMemory = [uint64]17179869184; Name = 'WIRE-FIXTURE-PC'; PartOfDomain = $true } }
        'Win32_OperatingSystem' { return New-WireObj @{ Caption = 'Microsoft Windows 11 Pro'; Version = '10.0.22631'; BuildNumber = '22631'; OSArchitecture = '64-bit'; InstallDate = $script:WireNow.AddDays(-400); LastBootUpTime = $script:WireNow.AddDays(-3); TotalVisibleMemorySize = [uint64]16777216; FreePhysicalMemory = [uint64]8388608 } }
        'Win32_BIOS' { return New-WireObj @{ SerialNumber = 'WIRE-SERIAL-0001'; SMBIOSBIOSVersion = '1.2.3'; ReleaseDate = $script:WireNow.AddDays(-700); Manufacturer = 'Contoso Hardware' } }
        'Win32_Processor' { return New-WireObj @{ Name = 'Fixture CPU 8-Core'; NumberOfCores = 8; NumberOfLogicalProcessors = 16; MaxClockSpeed = 3000; LoadPercentage = 12 } }
        'Win32_SystemEnclosure' { return New-WireObj @{ ChassisTypes = @(3) } }
        'Win32_LogicalDisk' { return New-WireObj @{ DeviceID = 'C:'; VolumeName = 'OS'; FileSystem = 'NTFS'; Size = [uint64]512110190592; FreeSpace = [uint64]214748364800; DriveType = 3 } }
        'Win32_VideoController' { return New-WireObj @{ Name = 'Fixture GPU'; DriverVersion = '31.0.101.1'; CurrentHorizontalResolution = 1920; CurrentVerticalResolution = 1080 } }
        'Win32_NetworkAdapterConfiguration' { return New-WireObj @{ Description = 'Fixture Ethernet'; MACAddress = '02:00:5E:00:00:01'; IPAddress = @('192.0.2.10', 'fe80::1'); IPSubnet = @('255.255.255.0', '64'); DefaultIPGateway = @('192.0.2.1'); DHCPEnabled = $true; DHCPServer = '192.0.2.1'; DHCPLeaseObtained = $script:WireNow.AddHours(-5); DHCPLeaseExpires = $script:WireNow.AddHours(19); DNSServerSearchOrder = @('192.0.2.53'); DNSDomain = 'wire.example'; Index = 1; InterfaceIndex = 7; IPEnabled = $true } }
        'Win32_NetworkAdapter' { return New-WireObj @{ Name = 'Fixture Ethernet'; NetConnectionID = 'Ethernet'; NetConnectionStatus = 2; Speed = [uint64]1000000000; MACAddress = '02:00:5E:00:00:01'; Index = 1; InterfaceIndex = 7; DeviceID = '1'; PhysicalAdapter = $true; NetEnabled = $true; AdapterType = 'Ethernet 802.3' } }
        'Win32_Process' {
            return @(
                (New-WireObj @{ Name = 'rustdesk.exe'; ProcessId = 4120; ParentProcessId = 700; CommandLine = '"rustdesk.exe" --service'; CreationDate = $script:WireNow.AddDays(-3); WorkingSetSize = [uint64]52428800; ThreadCount = 20; HandleCount = 300; SessionId = 0; KernelModeTime = [uint64]1000000; UserModeTime = [uint64]2000000 }),
                (New-WireObj @{ Name = 'explorer.exe'; ProcessId = 5200; ParentProcessId = 5100; CommandLine = 'explorer.exe'; CreationDate = $script:WireNow.AddHours(-2); WorkingSetSize = [uint64]104857600; ThreadCount = 60; HandleCount = 2000; SessionId = 1; KernelModeTime = [uint64]3000000; UserModeTime = [uint64]9000000 })
            )
        }
        'Win32_Service' {
            return @(
                (New-WireObj @{ Name = 'Spooler'; DisplayName = 'Print Spooler'; State = 'Running'; StartMode = 'Auto'; Status = 'OK'; ProcessId = 2400; DelayedAutoStart = $false; ServiceType = 'Own Process'; Started = $true; AcceptStop = $true; ExitCode = 0 }),
                (New-WireObj @{ Name = 'wuauserv'; DisplayName = 'Windows Update'; State = 'Stopped'; StartMode = 'Manual'; Status = 'OK'; ProcessId = 0; DelayedAutoStart = $false; ServiceType = 'Share Process'; Started = $false; AcceptStop = $false; ExitCode = 0 })
            )
        }
        default { return $null }
    }
}

function Get-Service {
    [CmdletBinding()]
    param([Parameter(Position = 0)][string[]]$Name)
    $all = @(
        (New-WireObj @{ Name = 'Spooler'; DisplayName = 'Print Spooler'; Status = 'Running'; StartType = 'Automatic'; ServiceType = 'Win32OwnProcess' }),
        (New-WireObj @{ Name = 'wuauserv'; DisplayName = 'Windows Update'; Status = 'Stopped'; StartType = 'Manual'; ServiceType = 'Win32ShareProcess' }),
        (New-WireObj @{ Name = 'RustDesk'; DisplayName = 'RustDesk Service'; Status = 'Running'; StartType = 'Automatic'; ServiceType = 'Win32OwnProcess' })
    )
    if (-not $Name) { return $all }
    $hit = @($all | Where-Object { $Name -contains $_.Name })
    if ($hit.Count -eq 0) {
        if ($ErrorActionPreference -eq 'Stop' -or $PSBoundParameters['ErrorAction'] -eq 'Stop') { throw "Cannot find any service with service name '$Name'." }
        return $null
    }
    return $hit
}

function Get-Process {
    [CmdletBinding()]
    param([Parameter(Position = 0)][string[]]$Name, [int[]]$Id)
    return @(
        (New-WireObj @{ Name = 'rustdesk'; ProcessName = 'rustdesk'; Id = 4120; CPU = 12.5; WorkingSet64 = [int64]52428800; StartTime = $script:WireNow.AddDays(-3); HandleCount = 300; Handles = 300; SessionId = 0 }),
        (New-WireObj @{ Name = 'explorer'; ProcessName = 'explorer'; Id = 5200; CPU = 90.25; WorkingSet64 = [int64]104857600; StartTime = $script:WireNow.AddHours(-2); HandleCount = 2000; Handles = 2000; SessionId = 1 })
    )
}

function Get-WinEvent {
    [CmdletBinding()]
    param([hashtable]$FilterHashtable, [int]$MaxEvents)
    return @(
        (New-WireObj @{ Id = 7; Level = 2; ProviderName = 'disk'; LogName = 'System'; Message = 'The device, \Device\Harddisk1\DR1, has a bad block.'; TimeCreated = $script:WireNow.AddMinutes(-5); RecordId = 1001 }),
        (New-WireObj @{ Id = 7; Level = 2; ProviderName = 'disk'; LogName = 'System'; Message = 'The device, \Device\Harddisk1\DR1, has a bad block.'; TimeCreated = $script:WireNow.AddMinutes(-9); RecordId = 1000 })
    )
}

function Get-TimeZone { return New-WireObj @{ Id = 'UTC'; DisplayName = '(UTC) Coordinated Universal Time' } }

function Get-ItemProperty {
    [CmdletBinding()]
    param([Parameter(Position = 0)][string[]]$Path, [string[]]$LiteralPath, [Parameter(Position = 1)][string[]]$Name)
    $p = [string](@($Path) + @($LiteralPath) | Where-Object { $_ } | Select-Object -First 1)
    if ($p -like 'HKLM:*WOW6432Node*Uninstall*') {
        return @(New-WireObj @{ DisplayName = 'Fixture Archiver'; DisplayVersion = '23.01'; Publisher = 'Fixture Software'; InstallDate = '20240102'; PSChildName = 'FixtureArchiver'; UninstallString = '"C:\Program Files (x86)\Fixture Archiver\Uninstall.exe"'; WindowsInstaller = 0 })
    }
    if ($p -like 'HKLM:*Uninstall*') {
        return @(
            (New-WireObj @{ DisplayName = 'Fixture Runtime'; DisplayVersion = '8.0.1'; Publisher = 'Fixture Software'; InstallDate = '20240310'; PSChildName = '{11111111-2222-3333-4444-555555555555}'; UninstallString = 'MsiExec.exe /X{11111111-2222-3333-4444-555555555555}'; WindowsInstaller = 1 }),
            (New-WireObj @{ DisplayName = 'Fixture Editor'; DisplayVersion = '4.2'; Publisher = 'Fixture Software'; InstallDate = '20240401'; PSChildName = 'Fixture Editor_is1'; UninstallString = '"C:\Program Files\Fixture Editor\unins000.exe"'; QuietUninstallString = '"C:\Program Files\Fixture Editor\unins000.exe" /SILENT'; WindowsInstaller = 0 })
        )
    }
    return $null
}

function Get-Item {
    [CmdletBinding()]
    param([Parameter(Position = 0)][string[]]$Path, [string[]]$LiteralPath, [switch]$Force)
    $p = [string](@($Path) + @($LiteralPath) | Where-Object { $_ } | Select-Object -First 1)
    if ($p -eq $env:WIRE_RDEXE) { return New-WireObj @{ FullName = $p; VersionInfo = (New-WireObj @{ FileVersion = '1.4.1.0'; ProductVersion = '1.4.1' }) } }
    if ($Path) { return Microsoft.PowerShell.Management\Get-Item -Path $Path -Force:$Force -ErrorAction Stop }
    return Microsoft.PowerShell.Management\Get-Item -LiteralPath $LiteralPath -Force:$Force -ErrorAction Stop
}

function New-Object {
    [CmdletBinding()]
    param([Parameter(Position = 0)][string]$TypeName, [Parameter(Position = 1)][object[]]$ArgumentList, [string]$ComObject, [hashtable]$Property)
    if ($ComObject -eq 'Microsoft.Update.Session') {
        $s = New-WireObj @{}
        $s | Add-Member -MemberType ScriptMethod -Name CreateUpdateSearcher -Value {
            $q = New-WireObj @{}
            $q | Add-Member -MemberType ScriptMethod -Name Search -Value {
                param($criteria)
                return New-WireObj @{ Updates = @(
                    (New-WireObj @{ Title = '2026-11 Cumulative Update for Windows 11 Version 23H2 for x64-based Systems (KB5099999)'; KBArticleIDs = @('5099999'); MsrcSeverity = 'Critical'; MaxDownloadSize = [decimal]734003200; Categories = @(); IsDownloaded = $false; RebootRequired = $true }),
                    (New-WireObj @{ Title = 'Security Intelligence Update for Microsoft Defender Antivirus - KB2267602 (Version 1.421.0.0)'; KBArticleIDs = @('2267602'); MsrcSeverity = ''; MaxDownloadSize = [decimal]10485760; Categories = @(); IsDownloaded = $false; RebootRequired = $false })
                ) }
            }
            return $q
        }
        return $s
    }
    if ($ComObject -eq 'Microsoft.Update.SystemInfo') { return New-WireObj @{ RebootRequired = $false } }
    if ($ComObject) { throw "No COM object '$ComObject' in the capture stand-in." }
    if ($null -ne $ArgumentList) { return Microsoft.PowerShell.Utility\New-Object -TypeName $TypeName -ArgumentList $ArgumentList }
    return Microsoft.PowerShell.Utility\New-Object -TypeName $TypeName
}
