# Windows lab (0.68.3): can this caller change an installed RustDesk's
# settings live through its own command line?
#
# Run once as SYSTEM (from a scheduled task, as the signed agent runs) and
# once as the runner's elevated administrator, against a RustDesk that
# rustdesk-lab.ps1 installed as a service and pointed at 127.0.0.1. For each
# option the Managed Secure Access design uses, it sets a value with
# `rustdesk.exe --option <key> <value>`, reads it back with
# `rustdesk.exe --option <key>`, and records what came back, what the
# service's RustDesk2.toml now says, whether it still says so a few seconds
# later and after a service restart, and whether a second value replaces the
# first. It sets a permanent password with `--password` and records only the
# exit code, the output with the password removed, and whether the service's
# RustDesk.toml password line changed (compared by hash; never printed).
# Last it toggles `stop-service` Y then N and records what the service and
# its processes did.
#
# A refusal by RustDesk is a result, not an error: this script exits 0 having
# written its JSON whatever RustDesk did. It exits non-zero only when it
# could not run (no RustDesk, no output file), which the workflow treats as a
# broken probe.
#
# Windows PowerShell 5.1: it runs under System32's powershell.exe as SYSTEM.

param(
    [Parameter(Mandatory = $true)][ValidateSet('system', 'admin')][string]$Caller,
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$Exe = (Join-Path $env:ProgramFiles 'RustDesk\rustdesk.exe'),
    # A copy of the whole RustDesk install in another directory: the negative
    # control. RustDesk 1.4.7 restricted its IPC pipe to callers running the
    # same executable (or SYSTEM); a copy elsewhere is not the same path.
    [string]$CopyExe = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$started = Get-Date
$log = New-Object System.Collections.Generic.List[string]
function Note([string]$m) { $log.Add(((Get-Date).ToString('HH:mm:ss.fff') + ' ' + $m)) | Out-Null }

$svcDir = 'C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\RustDesk\config'
$sysDir = 'C:\Windows\System32\config\systemprofile\AppData\Roaming\RustDesk\config'
$ownDir = if ($env:APPDATA) { Join-Path $env:APPDATA 'RustDesk\config' } else { $null }
$configDirs = [ordered]@{ localService = $svcDir; systemProfile = $sysDir }
if ($ownDir -and $ownDir -ne $sysDir) { $configDirs['caller'] = $ownDir }

# Every value written is a value the caller chose, never a secret, except the
# password, which goes only to Invoke-Rd's argument list and is scrubbed from
# what is recorded.
function Clip([string]$s, [int]$n = 300) {
    if ($null -eq $s) { return '' }
    $s = $s.Trim()
    if ($s.Length -gt $n) { return $s.Substring(0, $n) + '...' }
    return $s
}

function Invoke-Rd {
    param([string[]]$ArgList, [int]$TimeoutSec = 30, [string]$Secret = $null, [string]$ExePath = $Exe)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $ExePath
    $psi.Arguments = (($ArgList | ForEach-Object { if ($_ -match '[\s"]' -or $_ -eq '') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' ')
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $shown = @($ArgList | ForEach-Object { if ($Secret -and $_ -eq $Secret) { '[redacted]' } else { $_ } })
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $r = [ordered]@{ args = $shown; exitCode = $null; timedOut = $false; stdout = ''; stderr = ''; ms = 0; error = $null }
    try {
        $p = [Diagnostics.Process]::Start($psi)
        $ot = $p.StandardOutput.ReadToEndAsync()
        $et = $p.StandardError.ReadToEndAsync()
        if (-not $p.WaitForExit($TimeoutSec * 1000)) {
            $r['timedOut'] = $true
            try { $p.Kill() } catch {}
            $p.WaitForExit(5000) | Out-Null
        }
        $o = ''; $e = ''
        if ($ot.Wait(5000)) { $o = $ot.Result }
        if ($et.Wait(5000)) { $e = $et.Result }
        if ($Secret) { $o = $o.Replace($Secret, '[redacted]'); $e = $e.Replace($Secret, '[redacted]') }
        $r['stdout'] = Clip $o
        $r['stderr'] = Clip $e
        if (-not $r.timedOut) { $r['exitCode'] = $p.ExitCode }
    } catch {
        $r['error'] = Clip $_.Exception.Message
    }
    $r['ms'] = $sw.ElapsedMilliseconds
    return $r
}

function Read-Option([string]$key) {
    $c = Invoke-Rd -ArgList @('--option', $key)
    # The value is the first line of stdout; anything else (an error message)
    # is still what came back, and is recorded as such.
    $v = ''
    if ($c.stdout) { $v = ($c.stdout -split "`r?`n")[0].Trim() }
    return [ordered]@{ value = $v; call = $c }
}

function Read-Toml([string]$file, [string]$key) {
    if (-not (Test-Path -LiteralPath $file)) { return $null }
    try { $t = [IO.File]::ReadAllText($file) } catch { return '(unreadable: ' + (Clip $_.Exception.Message 80) + ')' }
    $k = [regex]::Escape($key)
    $m = [regex]::Match($t, "(?m)^\s*['""]?$k['""]?\s*=\s*['""]([^'""]*)['""]")
    if ($m.Success) { return $m.Groups[1].Value }
    return ''
}

function Read-Files([string]$key) {
    $o = [ordered]@{}
    foreach ($n in $configDirs.Keys) { $o[$n] = Read-Toml (Join-Path $configDirs[$n] 'RustDesk2.toml') $key }
    return $o
}

function Line-Hash([string]$file, [string]$pattern) {
    if (-not (Test-Path -LiteralPath $file)) { return 'no-file' }
    try { $t = [IO.File]::ReadAllText($file) } catch { return 'unreadable' }
    $m = [regex]::Match($t, $pattern)
    if (-not $m.Success) { return 'no-line' }
    $sha = [Security.Cryptography.SHA256]::Create()
    return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($m.Value))) -replace '-', '').Substring(0, 16)
}

function Rd-State {
    $s = Get-CimInstance Win32_Service -Filter "Name='RustDesk'" -ErrorAction SilentlyContinue
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='rustdesk.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
            $cl = '' + $_.CommandLine
            $mode = 'other'
            if ($cl -match '--service') { $mode = 'service' } elseif ($cl -match '--server') { $mode = 'server' } elseif ($cl -match '--tray') { $mode = 'tray' } elseif ($cl -match '--cm') { $mode = 'cm' } elseif ($cl -match '--option|--password|--get-id') { $mode = 'cli' }
            [ordered]@{ pid = $_.ProcessId; session = $_.SessionId; mode = $mode }
        } | Where-Object { $_.mode -ne 'cli' })
    return [ordered]@{
        service   = if ($s) { $s.State } else { 'absent' }
        startMode = if ($s) { $s.StartMode } else { '' }
        processes = $procs
    }
}

function Listening {
    $pids = @(Get-CimInstance Win32_Process -Filter "Name='rustdesk.exe'" -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.ProcessId })
    return @(Get-NetTCPConnection -State Listen -LocalPort 21118 -ErrorAction SilentlyContinue | Where-Object { $pids -contains [int]$_.OwningProcess }).Count -gt 0
}

# Wait-Listener: milliseconds until the 21118 listener is (or is not) there,
# or -1 if it never got that way within $seconds.
function Wait-Listener([bool]$want, [int]$seconds) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $seconds) {
        if ((Listening) -eq $want) { return [int]$sw.ElapsedMilliseconds }
        Start-Sleep -Milliseconds 500
    }
    return -1
}

function Test-Live([string]$path, [string]$label) {
    $l = [ordered]@{ exe = $label; before = (Listening) }
    if ($l.before) {
        $l['note'] = 'a 21118 listener was already open; turning direct-server off first'
        Invoke-Rd -ArgList @('--option', 'direct-server', 'N') | Out-Null
        $l['closedFirst'] = ((Wait-Listener $false 30) -ge 0)
    }
    $l['setOn'] = Invoke-Rd -ArgList @('--option', 'direct-server', 'Y') -ExePath $path
    $l['filesOn'] = (Read-Files 'direct-server')
    $ms = Wait-Listener $true 30
    $l['listenerAppeared'] = ($ms -ge 0)
    $l['appearMs'] = $ms
    if (-not $l.listenerAppeared) { return $l }
    if ($label -ne 'installed') { return $l }
    $l['stopY'] = Invoke-Rd -ArgList @('--option', 'stop-service', 'Y') -ExePath $path
    $ms = Wait-Listener $false 30
    $l['stopServiceClosed'] = ($ms -ge 0)
    $l['stopServiceCloseMs'] = $ms
    $l['stateAfterStop'] = (Rd-State)
    $l['stopN'] = Invoke-Rd -ArgList @('--option', 'stop-service', 'N') -ExePath $path
    $ms = Wait-Listener $true 45
    $l['stopServiceNReopened'] = ($ms -ge 0)
    $l['stopServiceReopenMs'] = $ms
    $l['setOff'] = Invoke-Rd -ArgList @('--option', 'direct-server', 'N') -ExePath $path
    $ms = Wait-Listener $false 30
    $l['offClosed'] = ($ms -ge 0)
    $l['offCloseMs'] = $ms
    return $l
}

function Wait-Ipc([int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        $r = Read-Option 'custom-rendezvous-server'
        if ($r.value -eq '127.0.0.1') { return $true }
        Start-Sleep -Seconds 2
    }
    return $false
}

# Which values each step sets. The second value restores something closer to
# the default, and an empty readback is what RustDesk stores for a default
# (it removes the key), so for those an empty readback counts as a match.
$keys = [ordered]@{
    'access-mode'             = @('view', 'full')
    'enable-keyboard'         = @('N', 'Y')
    'enable-clipboard'        = @('N', 'Y')
    'enable-file-transfer'    = @('N', 'Y')
    'enable-audio'            = @('N', 'Y')
    'enable-tunnel'           = @('N', 'Y')
    'enable-remote-restart'   = @('N', 'Y')
    'approve-mode'            = @('password', 'click')
    'verification-method'     = @('use-permanent-password', 'use-both-passwords')
    'allow-auto-disconnect'   = @('Y', 'N')
    'auto-disconnect-timeout' = @('17', '23')
}
$emptyMeans = @{
    'enable-keyboard' = 'Y'; 'enable-clipboard' = 'Y'; 'enable-file-transfer' = 'Y'; 'enable-audio' = 'Y'; 'enable-tunnel' = 'Y'; 'enable-remote-restart' = 'Y'
    'allow-auto-disconnect' = 'N'; 'verification-method' = 'use-both-passwords'; 'stop-service' = 'N'
}
function Test-Value([string]$key, [string]$got, [string]$want) {
    if ($got -eq $want) { return $true }
    if ($got -eq '' -and $emptyMeans.ContainsKey($key) -and $emptyMeans[$key] -eq $want) { return $true }
    return $false
}

$result = [ordered]@{
    schema   = 'rem0te-lab-rustdesk-probe/1'
    caller   = $Caller
    complete = $false
    identity = $null
    elevated = $null
    session  = $null
    rustdesk = $null
    options  = [ordered]@{}
    password = $null
    stopService = $null
    restart  = $null
    log      = $log
}

function Save {
    $result['durationSec'] = [int]((Get-Date) - $started).TotalSeconds
    $json = $result | ConvertTo-Json -Depth 12
    [IO.File]::WriteAllText($Out, $json, (New-Object Text.UTF8Encoding($false)))
}

try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $result['identity'] = $id.Name
    $result['isSystem'] = $id.IsSystem
    $result['elevated'] = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $result['session'] = (Get-Process -Id $PID).SessionId
    if (-not (Test-Path -LiteralPath $Exe)) { throw "no RustDesk at $Exe" }
    $result['rustdesk'] = [ordered]@{ path = $Exe; fileVersion = (Get-Item -LiteralPath $Exe).VersionInfo.ProductVersion; stateBefore = (Rd-State) }
    Note "caller $($id.Name) system=$($id.IsSystem) session=$($result.session)"

    # Can this caller read at all? The rendezvous server is the one value the
    # lab set (in the file, before install), so it is known.
    $first = Read-Option 'custom-rendezvous-server'
    $result['readRendezvous'] = [ordered]@{ value = $first.value; call = $first.call; matches = ($first.value -eq '127.0.0.1') }
    Note "first read: '$($first.value)' exit $($first.call.exitCode)"

    # Step 1: every key to its first value, read back at once.
    foreach ($k in $keys.Keys) {
        $v1 = $keys[$k][0]
        $before = Read-Option $k
        $set = Invoke-Rd -ArgList @('--option', $k, $v1)
        $after = Read-Option $k
        $result.options[$k] = [ordered]@{
            want        = $v1
            before      = $before.value
            set         = $set
            readback    = $after.value
            readbackCall = $after.call
            matches     = (Test-Value $k $after.value $v1)
            files       = (Read-Files $k)
        }
        Note "$k -> $v1 : set exit $($set.exitCode), read '$($after.value)'"
    }
    # Step 2: a few seconds later, still there?
    Start-Sleep -Seconds 5
    foreach ($k in $keys.Keys) {
        $r = Read-Option $k
        $result.options[$k]['after5s'] = $r.value
        $result.options[$k]['after5sMatches'] = (Test-Value $k $r.value $keys[$k][0])
    }
    # Step 3: after the service restarts.
    $rs = [ordered]@{ before = (Rd-State) }
    try {
        Restart-Service -Name RustDesk -Force -ErrorAction Stop
        $rs['restarted'] = $true
    } catch {
        $rs['restarted'] = $false
        $rs['error'] = Clip $_.Exception.Message
    }
    $rs['ipcBackWithin60s'] = (Wait-Ipc 60)
    Start-Sleep -Seconds 3
    $rs['after'] = (Rd-State)
    $result['restart'] = $rs
    foreach ($k in $keys.Keys) {
        $r = Read-Option $k
        $result.options[$k]['afterRestart'] = $r.value
        $result.options[$k]['afterRestartMatches'] = (Test-Value $k $r.value $keys[$k][0])
        $result.options[$k]['filesAfterRestart'] = (Read-Files $k)
    }
    Note "restart: $($rs.restarted), ipc back: $($rs.ipcBackWithin60s)"
    # Step 4: the second value replaces the first.
    foreach ($k in $keys.Keys) {
        $v2 = $keys[$k][1]
        $set = Invoke-Rd -ArgList @('--option', $k, $v2)
        $r = Read-Option $k
        $result.options[$k]['second'] = [ordered]@{ want = $v2; set = $set; readback = $r.value; matches = (Test-Value $k $r.value $v2); files = (Read-Files $k) }
    }

    # The permanent password. Random, never written anywhere but RustDesk's
    # argument list; only whether the stored line changed is recorded.
    $bytes = New-Object byte[] 18
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $pw = 'Lab' + ([Convert]::ToBase64String($bytes) -replace '[+/=]', 'x')
    $pwPattern = '(?m)^\s*password\s*=.*$'
    $hb = [ordered]@{}; foreach ($n in $configDirs.Keys) { $hb[$n] = Line-Hash (Join-Path $configDirs[$n] 'RustDesk.toml') $pwPattern }
    $pwCall = Invoke-Rd -ArgList @('--password', $pw) -Secret $pw
    Start-Sleep -Seconds 2
    $ha = [ordered]@{}; foreach ($n in $configDirs.Keys) { $ha[$n] = Line-Hash (Join-Path $configDirs[$n] 'RustDesk.toml') $pwPattern }
    $changed = [ordered]@{}; foreach ($n in $configDirs.Keys) { $changed[$n] = ($hb[$n] -ne $ha[$n]) }
    $result['password'] = [ordered]@{
        call         = $pwCall
        saidDone     = ($pwCall.stdout -match 'Done')
        storedLineChanged = $changed
        # The hashes are of the stored, encrypted line, truncated; they say
        # only whether it changed.
        lineHashBefore = $hb
        lineHashAfter  = $ha
    }
    Remove-Variable pw
    Note "password: exit $($pwCall.exitCode), done $($result.password.saidDone), changed $(($changed.Values | Where-Object { $_ }).Count)"

    # stop-service: Y, observe, N, observe. Last, because Y may take the
    # service's IPC away and leave nothing to answer the rest.
    $ss = [ordered]@{ before = (Read-Option 'stop-service').value; stateBefore = (Rd-State) }
    $ss['setY'] = Invoke-Rd -ArgList @('--option', 'stop-service', 'Y')
    $r = Read-Option 'stop-service'
    $ss['readY'] = $r.value
    $ss['readYCall'] = $r.call
    $ss['yMatches'] = (Test-Value 'stop-service' $r.value 'Y')
    $ss['filesY'] = (Read-Files 'stop-service')
    Start-Sleep -Seconds 8
    $ss['stateAfterY'] = (Rd-State)
    $r = Read-Option 'stop-service'
    $ss['readY8s'] = $r.value
    $ss['setN'] = Invoke-Rd -ArgList @('--option', 'stop-service', 'N')
    $r = Read-Option 'stop-service'
    $ss['readN'] = $r.value
    $ss['readNCall'] = $r.call
    $ss['nMatches'] = (Test-Value 'stop-service' $r.value 'N')
    $ss['filesN'] = (Read-Files 'stop-service')
    $deadline = (Get-Date).AddSeconds(45)
    do {
        Start-Sleep -Seconds 3
        $st = Rd-State
        $serverBack = @($st.processes | Where-Object { $_.mode -eq 'server' }).Count -gt 0
    } while (-not $serverBack -and (Get-Date) -lt $deadline)
    $ss['stateAfterN'] = $st
    $ss['serverBackAfterN'] = $serverBack
    $result['stopService'] = $ss
    Note "stop-service: Y read '$($ss.readY)', N read '$($ss.readN)', server back $serverBack"

    # Live effect. A readback and a file can agree while the running server
    # never heard of the change: when the IPC pipe refuses the caller,
    # RustDesk's command line falls back to its own process's configuration,
    # and for SYSTEM that is the same LocalService file the service reads at
    # start. So the question "did the running server take it?" is answered by
    # something only the running server does: with direct-server Y it opens a
    # TCP listener on 21118 (direct IP access), and with stop-service Y it
    # stops serving and closes it. Nothing connects to the listener; the
    # firewall keeps inbound closed.
    $result['live'] = Test-Live $Exe 'installed'
    Note "live (installed exe): listener $($result.live.listenerAppeared) in $($result.live.appearMs) ms; stop-service closed it $($result.live.stopServiceClosed); N reopened $($result.live.stopServiceNReopened); off closed $($result.live.offClosed)"
    if ($CopyExe -and (Test-Path -LiteralPath $CopyExe)) {
        $result['control'] = Test-Live $CopyExe 'copy'
        Note "control (copied exe): listener $($result.control.listenerAppeared)"
        # Whatever the copy did, leave direct-server off through the real exe.
        $result.control['cleanup'] = Invoke-Rd -ArgList @('--option', 'direct-server', 'N')
        $result.control['cleanupClosed'] = ((Wait-Listener $false 30) -ge 0)
    }

    $result['complete'] = $true
} catch {
    $result['fatal'] = Clip $_.Exception.Message 500
    Note ('fatal: ' + $result.fatal)
}
Save
if (-not $result.complete) { exit 3 }
exit 0
