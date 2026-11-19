# Windows lab (0.68.3): install one official RustDesk release on a disposable
# GitHub runner and run rustdesk-probe.ps1 against it as SYSTEM and as the
# runner's administrator. Writes one JSON part for lab-evidence-windows.
#
#   powershell -File rustdesk-lab.ps1 -Version 1.4.6 -Part <file>
#
# Network: the only hosts contacted are api.github.com (the release's
# published SHA-256) and GitHub's release download. RustDesk is kept off its
# public servers three ways, before it ever runs: its configuration is written
# first (rendezvous, relay and API all 127.0.0.1) for the installing user and
# both service profiles; the rustdesk.com names RustDesk uses resolve to
# 127.0.0.1 through the hosts file; and outbound connections by the
# installed rustdesk.exe and the installer are blocked by Windows Firewall.
# The part records any TCP connection a RustDesk process holds to an address
# that is not loopback.
#
# Exit codes: 0 whenever the probe ran (whatever RustDesk refused) and when
# the download could not be verified (recorded as a failed test, nothing
# installed); non-zero when the lab itself broke: RustDesk did not install,
# or a probe produced no result.

param(
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$Part,
    [string]$Work = 'C:\lab'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

New-Item -ItemType Directory -Force -Path $Work | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Part) | Out-Null
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$probe = Join-Path $Work 'rustdesk-probe.ps1'
Copy-Item -LiteralPath (Join-Path $here 'rustdesk-probe.ps1') -Destination $probe -Force
$ps51 = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$rdExe = Join-Path $env:ProgramFiles 'RustDesk\rustdesk.exe'
$svcDir = 'C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\RustDesk\config'
$sysDir = 'C:\Windows\System32\config\systemprofile\AppData\Roaming\RustDesk\config'

$log = New-Object System.Collections.Generic.List[string]
function Note([string]$m) { $line = ((Get-Date).ToString('HH:mm:ss') + ' ' + $m); $log.Add($line) | Out-Null; Write-Host $line }

$os = Get-CimInstance Win32_OperatingSystem
$cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$ev = [ordered]@{
    schema   = 'rem0te-lab-rustdesk-part/1'
    version  = $Version
    os       = [ordered]@{ caption = $os.Caption; version = $os.Version; build = $os.BuildNumber; ubr = $cv.UBR; displayVersion = $cv.DisplayVersion; productType = $os.ProductType }
    download = [ordered]@{}
    guard    = [ordered]@{}
    install  = [ordered]@{}
    probes   = [ordered]@{}
    network  = [ordered]@{}
    log      = $log
}
$broken = $null

function Save-Part {
    [IO.File]::WriteAllText($Part, ($ev | ConvertTo-Json -Depth 16), (New-Object Text.UTF8Encoding($false)))
}

function Rd-Pids { @(Get-CimInstance Win32_Process -Filter "Name='rustdesk.exe'" -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessId }) }

function Server-Up {
    @(Get-CimInstance Win32_Process -Filter "Name='rustdesk.exe'" -ErrorAction SilentlyContinue | Where-Object { ('' + $_.CommandLine) -match '--server' }).Count -gt 0
}

function Seed-Config([string]$dir) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $toml = "rendezvous_server = '127.0.0.1:21116'`r`nnat_type = 1`r`nserial = 0`r`n`r`n[options]`r`ncustom-rendezvous-server = '127.0.0.1'`r`nrelay-server = '127.0.0.1'`r`napi-server = 'http://127.0.0.1:21114'`r`n"
    [IO.File]::WriteAllText((Join-Path $dir 'RustDesk2.toml'), $toml, (New-Object Text.UTF8Encoding($false)))
}

function Reset-Service([string]$why) {
    # Puts the service back to a known state between callers: running, its
    # stop-service flag cleared in the files, and its server process up.
    Note "reset ($why)"
    try { Stop-Service -Name RustDesk -Force -ErrorAction Stop } catch { Note "stop: $($_.Exception.Message)" }
    Start-Sleep -Seconds 2
    foreach ($d in @($svcDir, $sysDir)) {
        $f = Join-Path $d 'RustDesk2.toml'
        if (Test-Path -LiteralPath $f) {
            $t = [IO.File]::ReadAllText($f)
            $t2 = [regex]::Replace($t, "(?m)^\s*(stop-service|direct-server)\s*=.*\r?\n?", '')
            if ($t2 -ne $t) { [IO.File]::WriteAllText($f, $t2, (New-Object Text.UTF8Encoding($false))); Note "cleared stop-service / direct-server in $f" }
        }
    }
    try { Start-Service -Name RustDesk -ErrorAction Stop } catch { Note "start: $($_.Exception.Message)" }
    $deadline = (Get-Date).AddSeconds(60)
    while (-not (Server-Up) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
    Note "server process up: $(Server-Up)"
    Start-Sleep -Seconds 5
}

try {
    # ── Keep RustDesk off its public servers ────────────────────────────────
    $names = @('rustdesk.com', 'www.rustdesk.com', 'rs-ny.rustdesk.com', 'rs-sg.rustdesk.com', 'rs-cn.rustdesk.com', 'admin.rustdesk.com', 'api.rustdesk.com')
    $hosts = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
    Add-Content -LiteralPath $hosts -Value ("`r`n# rem0te lab`r`n" + (($names | ForEach-Object { "127.0.0.1 $_" }) -join "`r`n") + "`r`n") -Encoding ASCII
    $ev.guard['hostsFile'] = $names
    $ev.guard['firewallBefore'] = @(Get-NetFirewallProfile | ForEach-Object { [ordered]@{ name = $_.Name; enabled = [string]$_.Enabled; outbound = [string]$_.DefaultOutboundAction } })
    Set-NetFirewallProfile -All -Enabled True
    $ev.guard['firewallAfter'] = @(Get-NetFirewallProfile | ForEach-Object { [ordered]@{ name = $_.Name; enabled = [string]$_.Enabled; outbound = [string]$_.DefaultOutboundAction } })
    New-NetFirewallRule -DisplayName 'lab: block installed rustdesk.exe outbound' -Direction Outbound -Action Block -Program $rdExe | Out-Null
    foreach ($d in @($svcDir, $sysDir, (Join-Path $env:APPDATA 'RustDesk\config'))) { Seed-Config $d }
    $ev.guard['seededConfig'] = @($svcDir, $sysDir, '%APPDATA% of the installing user')
    Note 'guard: hosts, firewall rule, seeded configuration'

    # ── The release, and the digest GitHub publishes for it ────────────────
    $headers = @{ 'Accept' = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
    if ($env:GH_TOKEN) { $headers['Authorization'] = 'Bearer ' + $env:GH_TOKEN }
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/rustdesk/rustdesk/releases/tags/$Version" -Headers $headers
    $assetName = "rustdesk-$Version-x86_64.exe"
    $asset = @($rel.assets | Where-Object { $_.name -eq $assetName })[0]
    if (-not $asset) { throw "release $Version has no $assetName" }
    $ev.download['asset'] = $assetName
    $ev.download['url'] = $asset.browser_download_url
    $ev.download['published'] = $rel.published_at
    $digest = $null
    if ($asset.PSObject.Properties.Name -contains 'digest' -and $asset.digest) { $digest = [string]$asset.digest }
    $ev.download['publishedDigest'] = $digest
    if (-not $digest -or $digest -notmatch '^sha256:[0-9a-f]{64}$') {
        $ev.download['verified'] = $false
        $ev.download['reason'] = 'unverified download: GitHub publishes no SHA-256 digest for this asset (assets uploaded before GitHub began recording digests have none), so it was not downloaded or installed'
        Note $ev.download.reason
        Save-Part
        exit 0
    }
    $installer = Join-Path $Work $assetName
    New-NetFirewallRule -DisplayName 'lab: block installer outbound' -Direction Outbound -Action Block -Program $installer | Out-Null
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installer -UseBasicParsing
    $sha = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLower()
    $ev.download['sha256'] = $sha
    $ev.download['verified'] = ('sha256:' + $sha) -eq $digest
    if (-not $ev.download.verified) {
        $ev.download['reason'] = 'the download does not match the digest GitHub publishes; not installed'
        Remove-Item -LiteralPath $installer -Force
        Note $ev.download.reason
        Save-Part
        exit 0
    }
    $sig = Get-AuthenticodeSignature -LiteralPath $installer
    $ev.download['authenticode'] = [ordered]@{ status = [string]$sig.Status; subject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { $null } }
    Note "downloaded $assetName, sha256 verified, signature $($sig.Status)"

    # ── Install as a service ─────────────────────────────────────────────────
    $t0 = Get-Date
    $p = Start-Process -FilePath $installer -ArgumentList '--silent-install' -PassThru -WindowStyle Hidden
    $p.WaitForExit(240000) | Out-Null
    $sp = $null
    while (((Get-Date) - $t0).TotalSeconds -lt 240) {
        $sp = (Get-CimInstance Win32_Service -Filter "Name='RustDesk'" -ErrorAction SilentlyContinue).PathName
        if ((Test-Path -LiteralPath $rdExe) -and $sp -match '--service') { break }
        Start-Sleep -Seconds 3
    }
    $ev.install['seconds'] = [int]((Get-Date) - $t0).TotalSeconds
    $ev.install['servicePath'] = $sp
    $ev.install['exe'] = (Test-Path -LiteralPath $rdExe)
    if (-not $ev.install.exe -or $sp -notmatch '--service') { throw "RustDesk $Version did not install as a service within 240 s (service command line: $sp)" }
    $ev.install['fileVersion'] = (Get-Item -LiteralPath $rdExe).VersionInfo.ProductVersion
    # Whatever the installer imported, the service runs with the lab's
    # loopback-only configuration.
    try { Stop-Service -Name RustDesk -Force -ErrorAction Stop } catch {}
    Get-CimInstance Win32_Process -Filter "Name='rustdesk.exe'" -ErrorAction SilentlyContinue | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
    Seed-Config $svcDir; Seed-Config $sysDir
    Reset-Service 'after install'
    # The negative control: the whole install copied to another directory.
    # Same files, different executable path.
    $copyDir = Join-Path $Work 'rdcopy'
    Copy-Item -Path (Join-Path $env:ProgramFiles 'RustDesk') -Destination $copyDir -Recurse -Force
    $copyExe = Join-Path $copyDir 'rustdesk.exe'
    New-NetFirewallRule -DisplayName 'lab: block copied rustdesk.exe outbound' -Direction Outbound -Action Block -Program $copyExe | Out-Null
    $ev.install['copyExe'] = (Test-Path -LiteralPath $copyExe)
    $ev.install['serverUp'] = (Server-Up)
    $ev.install['service'] = [string](Get-Service RustDesk).Status
    Note "installed $($ev.install.fileVersion) in $($ev.install.seconds) s; service $($ev.install.service); server process $($ev.install.serverUp)"

    # ── The probe as SYSTEM, from a scheduled task ──────────────────────────
    $sysOut = Join-Path $Work "probe-system-$Version.json"
    Remove-Item -LiteralPath $sysOut -ErrorAction SilentlyContinue
    $arg = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$probe`" -Caller system -Out `"$sysOut`" -CopyExe `"$copyExe`""
    $task = 'LabRustDeskProbe'
    Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $task -Action (New-ScheduledTaskAction -Execute $ps51 -Argument $arg) `
        -Principal (New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest) `
        -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 25) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries) | Out-Null
    Start-ScheduledTask -TaskName $task
    Note 'SYSTEM probe started'
    $deadline = (Get-Date).AddMinutes(25)
    Start-Sleep -Seconds 5
    while ((Get-Date) -lt $deadline -and (Get-ScheduledTask -TaskName $task).State -eq 'Running') { Start-Sleep -Seconds 5 }
    $info = Get-ScheduledTaskInfo -TaskName $task
    $ev.probes['systemTask'] = [ordered]@{ lastResult = $info.LastTaskResult; state = [string](Get-ScheduledTask -TaskName $task).State }
    Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $sysOut) {
        $ev.probes['system'] = Get-Content -Raw -LiteralPath $sysOut | ConvertFrom-Json
    } else {
        $broken = 'the SYSTEM probe wrote no result (task result ' + $info.LastTaskResult + ')'
    }
    Note "SYSTEM probe done: task result $($info.LastTaskResult)"

    # ── The probe as the runner's administrator ─────────────────────────────
    Reset-Service 'between callers'
    $admOut = Join-Path $Work "probe-admin-$Version.json"
    & $ps51 -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $probe -Caller admin -Out $admOut -CopyExe $copyExe
    $ev.probes['adminExit'] = $LASTEXITCODE
    if (Test-Path -LiteralPath $admOut) {
        $ev.probes['admin'] = Get-Content -Raw -LiteralPath $admOut | ConvertFrom-Json
    } elseif (-not $broken) {
        $broken = 'the administrator probe wrote no result'
    }
    Note "admin probe done: exit $($ev.probes.adminExit)"

    # ── Did RustDesk hold any connection off this computer? ─────────────────
    $pids = Rd-Pids
    $conns = @(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $pids -contains $_.OwningProcess } | ForEach-Object {
            [ordered]@{ local = "$($_.LocalAddress):$($_.LocalPort)"; remote = "$($_.RemoteAddress):$($_.RemotePort)"; state = [string]$_.State }
        })
    $public = @($conns | Where-Object { $_.state -ne 'Listen' -and $_.remote -notmatch '^(127\.|::1|0\.0\.0\.0|:::|\[::\])' -and $_.remote -notmatch '^:+0?:0$' })
    $ev.network['rustdeskConnections'] = $conns
    $ev.network['offHost'] = $public
    $ev.network['firewallBlocks'] = @(Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 5157 } -MaxEvents 50 -ErrorAction SilentlyContinue | Where-Object { $_.Message -match 'rustdesk' }).Count
    Reset-Service 'end'
} catch {
    $broken = $_.Exception.Message
    Note "error: $broken"
}
if ($broken) { $ev['broken'] = $broken }
Save-Part
if ($broken) { exit 2 }
exit 0
