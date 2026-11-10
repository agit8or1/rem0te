# rem0te Windows Update bridge (v0.27). Compiled into the signed agent and run
# by it, never fetched: rem0te-agent.exe writes this text to a temporary file
# in its own locked state directory and runs it with powershell.exe.
#
# It decides nothing. It reads the Windows Update Agent, or installs exactly
# the identities it is handed, and writes what Windows reported. Which
# updates may be installed, and what a result means, is decided in Go.
#
#   REM0TE_WUA_MODE    scan | lookup | install
#   REM0TE_WUA_INPUT   lookup/install: JSON array of { updateId, revision }
#   REM0TE_WUA_OUTPUT  where to write the JSON result
#
# It never restarts the computer, never accepts a licence, never shows UI and
# never changes Windows Update settings.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$mode = [string]$env:REM0TE_WUA_MODE
$outPath = [string]$env:REM0TE_WUA_OUTPUT
if ($mode -cnotmatch '^(scan|lookup|install)$') { exit 64 }
if ($outPath -notmatch '^[A-Za-z]:\\[A-Za-z0-9 ._\\()-]{1,240}\.json$') { exit 64 }

function Write-Out($obj) {
    $json = $obj | ConvertTo-Json -Depth 6 -Compress
    [System.IO.File]::WriteAllText($outPath, $json, (New-Object System.Text.UTF8Encoding $false))
}

function Hex($hr) { return ('0x{0:X8}' -f ([int64]$hr -band 0xFFFFFFFF)) }

function Read-Ids {
    $inPath = [string]$env:REM0TE_WUA_INPUT
    if ($inPath -notmatch '^[A-Za-z]:\\[A-Za-z0-9 ._\\()-]{1,240}\.json$') { exit 64 }
    $raw = Get-Content -Raw -LiteralPath $inPath | ConvertFrom-Json
    $ids = New-Object System.Collections.ArrayList
    foreach ($i in @($raw)) {
        $u = [string]$i.updateId
        $r = [int]$i.revision
        # Validated by the agent already; checked again because this is the
        # process that hands them to Windows.
        if ($u -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or $r -lt 1) { exit 64 }
        [void]$ids.Add(@{ updateId = $u; revision = $r })
        if ($ids.Count -gt 20) { exit 64 }
    }
    return ,$ids
}

function Describe($u) {
    $kb = ''
    foreach ($k in @($u.KBArticleIDs)) { if ($k) { $kb = 'KB' + [string]$k; break } }
    $cls = ''
    $clsName = ''
    foreach ($c in @($u.Categories)) {
        if ([string]$c.Type -eq 'UpdateClassification') { $cls = ([string]$c.CategoryID).ToLowerInvariant(); $clsName = [string]$c.Name; break }
    }
    $rb = 1
    try { $rb = [int]$u.InstallationBehavior.RebootBehavior } catch {}
    $ui = $true
    try { $ui = [bool]$u.InstallationBehavior.CanRequestUserInput } catch {}
    return @{
        updateId       = ([string]$u.Identity.UpdateID).ToLowerInvariant()
        revision       = [int]$u.Identity.RevisionNumber
        kb             = $kb
        title          = [string]$u.Title
        classification = $cls
        className      = $clsName
        severity       = [string]$u.MsrcSeverity
        downloaded     = [bool]$u.IsDownloaded
        rebootBehavior = $rb
        userInput      = $ui
        eulaAccepted   = [bool]$u.EulaAccepted
        browseOnly     = [bool]$u.BrowseOnly
        sizeBytes      = [int64]$u.MaxDownloadSize
    }
}

function Find($searcher, [string]$id, [int]$rev, [string]$extra) {
    $res = $searcher.Search("UpdateID='$id' and RevisionNumber=$rev and $extra")
    if ($res.Updates.Count -gt 0) { return $res.Updates.Item(0) }
    return $null
}

$session = New-Object -ComObject Microsoft.Update.Session
$session.ClientApplicationID = 'rem0te-agent'
$searcher = $session.CreateUpdateSearcher()

switch ($mode) {
    'scan' {
        $updates = New-Object System.Collections.ArrayList
        $found = $searcher.Search('IsInstalled=0 and IsHidden=0')
        foreach ($u in $found.Updates) {
            if ($updates.Count -ge 100) { break }
            [void]$updates.Add((Describe $u))
        }
        $history = New-Object System.Collections.ArrayList
        $total = $searcher.GetTotalHistoryCount()
        if ($total -gt 0) {
            $names = @{ 0 = 'unknown'; 1 = 'in_progress'; 2 = 'succeeded'; 3 = 'succeeded_with_errors'; 4 = 'failed'; 5 = 'aborted' }
            foreach ($h in $searcher.QueryHistory(0, [Math]::Min($total, 50))) {
                $kb = ''
                if ([string]$h.Title -match '\b(KB[0-9]{4,10})\b') { $kb = $Matches[1] }
                $op = 'other'
                if ([int]$h.Operation -eq 1) { $op = 'install' } elseif ([int]$h.Operation -eq 2) { $op = 'uninstall' }
                $rc = [int]$h.ResultCode
                $rn = 'unknown'
                if ($names.ContainsKey($rc)) { $rn = $names[$rc] }
                [void]$history.Add(@{
                    updateId  = ([string]$h.UpdateIdentity.UpdateID).ToLowerInvariant()
                    revision  = [int]$h.UpdateIdentity.RevisionNumber
                    kb        = $kb
                    title     = [string]$h.Title
                    result    = $rn
                    hresult   = (Hex $h.HResult)
                    operation = $op
                    date      = ([DateTime]$h.Date).ToUniversalTime().ToString('o')
                })
            }
        }
        $reboot = $false
        try { $reboot = [bool](New-Object -ComObject Microsoft.Update.SystemInfo).RebootRequired } catch {}
        Write-Out @{ updates = $updates; history = $history; rebootRequired = $reboot }
    }
    'lookup' {
        $ids = Read-Ids
        $results = New-Object System.Collections.ArrayList
        foreach ($i in $ids) {
            $state = 'not_found'
            $desc = $null
            $u = Find $searcher $i.updateId $i.revision 'IsInstalled=0 and IsHidden=0'
            if ($u) { $state = 'offered'; $desc = Describe $u }
            elseif (Find $searcher $i.updateId $i.revision 'IsInstalled=1') { $state = 'installed' }
            else {
                # Superseded updates are hidden from an ordinary search; asking
                # again with them included is how Windows tells the two apart.
                $searcher.IncludePotentiallySupersededUpdates = $true
                if (Find $searcher $i.updateId $i.revision 'IsInstalled=0') { $state = 'superseded' }
                $searcher.IncludePotentiallySupersededUpdates = $false
            }
            $row = @{ updateId = $i.updateId; revision = $i.revision; state = $state }
            if ($desc) { $row['update'] = $desc }
            [void]$results.Add($row)
        }
        Write-Out @{ results = $results }
    }
    'install' {
        $ids = Read-Ids
        $coll = New-Object -ComObject Microsoft.Update.UpdateColl
        $order = New-Object System.Collections.ArrayList
        $results = @{}
        foreach ($i in $ids) {
            $key = $i.updateId + '@' + $i.revision
            $results[$key] = @{ updateId = $i.updateId; revision = $i.revision; downloaded = $false; resultCode = 0; hresult = ''; rebootRequired = $false; found = $false }
            $u = Find $searcher $i.updateId $i.revision 'IsInstalled=0 and IsHidden=0'
            # A licence is never accepted here: the agent refuses those first.
            if ($u -and [bool]$u.EulaAccepted) {
                [void]$coll.Add($u)
                [void]$order.Add($key)
                $results[$key].found = $true
            }
        }
        $err = ''
        $rebootAll = $false
        if ($coll.Count -gt 0) {
            try {
                $dl = $session.CreateUpdateDownloader()
                $dl.Updates = $coll
                [void]$dl.Download()
                for ($n = 0; $n -lt $coll.Count; $n++) { $results[$order[$n]].downloaded = [bool]$coll.Item($n).IsDownloaded }
                $inst = $session.CreateUpdateInstaller()
                $inst.Updates = $coll
                try { $inst.ForceQuiet = $true } catch {}
                $inst.AllowSourcePrompts = $false
                $r = $inst.Install()
                $rebootAll = [bool]$r.RebootRequired
                for ($n = 0; $n -lt $coll.Count; $n++) {
                    $ur = $r.GetUpdateResult($n)
                    $results[$order[$n]].resultCode = [int]$ur.ResultCode
                    $results[$order[$n]].hresult = (Hex $ur.HResult)
                    $results[$order[$n]].rebootRequired = [bool]$ur.RebootRequired
                }
            } catch {
                $err = [string]$_.Exception.Message
                if ($err.Length -gt 200) { $err = $err.Substring(0, 200) }
            }
        }
        $list = New-Object System.Collections.ArrayList
        foreach ($i in $ids) { [void]$list.Add($results[$i.updateId + '@' + $i.revision]) }
        Write-Out @{ results = $list; rebootRequired = $rebootAll; error = $err }
    }
}
exit 0
