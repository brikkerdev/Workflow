# Workflow session orchestrator (Windows / PowerShell 5.1+).
#
# Reads a session manifest passed as the first arg (path to a JSON file),
# arranges virtual desktops, launches windows, and snaps each one into a
# FancyZones zone or an explicit {x,y,w,h} rectangle.
#
# Invoked from bin/session.mjs after `workflow up` brings the kanban server
# online. Designed to be re-runnable: already-open windows are matched by
# title and re-positioned instead of duplicated.

param(
  [Parameter(Mandatory = $true)] [string] $ManifestPath,
  [string] $ProjectRoot = $PWD,
  [int]    $KanbanPort  = 7777
)

$ErrorActionPreference = 'Continue'

function Log([string]$msg) { Write-Host "[session] $msg" }
function Warn([string]$msg) { Write-Host "[session] WARN: $msg" -ForegroundColor Yellow }
function Err([string]$msg)  { Write-Host "[session] ERR: $msg"  -ForegroundColor Red }

# --- pinvoke: Win32 window management -------------------------------------
if (-not ([System.Management.Automation.PSTypeName]'WfWin').Type) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WfWin {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string cls, string name);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint dwFlags);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint dwFlags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; }
  public const int SW_RESTORE = 9;
  public const uint SWP_NOZORDER = 0x0004;
  public const uint SWP_SHOWWINDOW = 0x0040;
  public const uint MONITOR_DEFAULTTONEAREST = 0x00000002;
  public static IntPtr FindByTitleSubstring(string sub) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h); if (len == 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      if (sb.ToString().IndexOf(sub, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static IntPtr FindByPid(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
}

# --- Manifest load ---------------------------------------------------------
if (-not (Test-Path $ManifestPath)) { Err "manifest not found: $ManifestPath"; exit 2 }
$manifest = Get-Content -Raw -Path $ManifestPath | ConvertFrom-Json
$waitSecs = if ($manifest.wait_window_secs) { [int]$manifest.wait_window_secs } else { 15 }

# --- FancyZones layout (optional) -----------------------------------------
function Resolve-ZoneRect {
  param($zone, [int]$monitorIdx)
  if ($null -eq $zone) { return $null }
  if ($zone -is [string] -and $zone -eq 'fullscreen') { return Get-MonitorWorkArea $monitorIdx }
  if ($zone -is [pscustomobject]) {
    # Inline grid: { "grid": "RxC", "cell": N }  -- splits work area uniformly.
    if ($zone.PSObject.Properties.Name -contains 'grid') {
      return Get-GridCellRect -spec $zone.grid -cell ([int]$zone.cell) -monitorIdx $monitorIdx
    }
    # Explicit pixel rect: { "x": 0, "y": 0, "w": 960, "h": 540 }
    if ($zone.PSObject.Properties.Name -contains 'x') {
      $mon = Get-MonitorWorkArea $monitorIdx
      return [pscustomobject]@{
        X = $mon.X + [int]$zone.x; Y = $mon.Y + [int]$zone.y
        W = [int]$zone.w; H = [int]$zone.h
      }
    }
  }
  if ($zone -is [int] -or ($zone -is [string] -and $zone -match '^\d+$')) {
    $idx = [int]$zone
    return Get-FancyZoneRect -LayoutName $manifest.fancyzones_layout -ZoneIndex $idx -MonitorIdx $monitorIdx
  }
  Warn "unrecognized zone spec: $zone"
  return $null
}

# Split monitor work area into a uniform RxC grid and return cell N.
# Cell numbering is row-major from top-left: 0=TL, 1=TR (for 2x2: 2=BL, 3=BR).
function Get-GridCellRect {
  param([string]$spec, [int]$cell, [int]$monitorIdx)
  if ($spec -notmatch '^\s*(\d+)\s*[xX]\s*(\d+)\s*$') {
    Warn "grid spec must look like 'RxC' (e.g. '2x2'), got: $spec"
    return $null
  }
  $rows = [int]$Matches[1]; $cols = [int]$Matches[2]
  $total = $rows * $cols
  if ($cell -lt 0 -or $cell -ge $total) {
    Warn "grid cell $cell out of range for ${rows}x${cols} (have $total)"
    return $null
  }
  $mon = Get-MonitorWorkArea $monitorIdx
  $cellW = [int]($mon.W / $cols)
  $cellH = [int]($mon.H / $rows)
  $row = [int]($cell / $cols)
  $col = $cell % $cols
  return [pscustomobject]@{
    X = $mon.X + ($col * $cellW)
    Y = $mon.Y + ($row * $cellH)
    W = $cellW
    H = $cellH
  }
}

function Get-MonitorWorkArea {
  param([int]$idx)
  $screens = [System.Windows.Forms.Screen]::AllScreens
  if ($idx -ge $screens.Length) { $idx = 0 }
  $wa = $screens[$idx].WorkingArea
  return [pscustomobject]@{ X = $wa.X; Y = $wa.Y; W = $wa.Width; H = $wa.Height }
}

# Read the FancyZones custom-layouts.json + applied-layouts.json to translate
# (layoutName, zoneIndex) into a screen rectangle. PowerToys stores the layout
# as percentage refs; we resolve against the monitor work area.
function Get-FancyZoneRect {
  param([string]$LayoutName, [int]$ZoneIndex, [int]$MonitorIdx)
  if (-not $LayoutName) {
    Warn "zone index used but fancyzones_layout not set in manifest"
    return $null
  }
  $fzDir = Join-Path $env:LOCALAPPDATA 'Microsoft\PowerToys\FancyZones'
  $custom = Join-Path $fzDir 'custom-layouts.json'
  if (-not (Test-Path $custom)) { Warn "FancyZones custom-layouts.json not found"; return $null }
  $cfg = Get-Content -Raw $custom | ConvertFrom-Json
  $layout = $cfg.'custom-layouts' | Where-Object { $_.name -eq $LayoutName } | Select-Object -First 1
  if (-not $layout) { Warn "FancyZones layout '$LayoutName' not found"; return $null }

  $mon = Get-MonitorWorkArea $MonitorIdx
  if ($layout.type -eq 'canvas') {
    $info = $layout.info
    $refW = [double]$info.'ref-width'
    $refH = [double]$info.'ref-height'
    $zones = @($info.zones)
    if ($ZoneIndex -ge $zones.Count) { Warn "zone index $ZoneIndex out of range (have $($zones.Count))"; return $null }
    $z = $zones[$ZoneIndex]
    $sx = $mon.W / $refW; $sy = $mon.H / $refH
    return [pscustomobject]@{
      X = $mon.X + [int]([double]$z.X * $sx)
      Y = $mon.Y + [int]([double]$z.Y * $sy)
      W = [int]([double]$z.width  * $sx)
      H = [int]([double]$z.height * $sy)
    }
  }
  if ($layout.type -eq 'grid') {
    Warn "grid layouts not yet supported - declare zone as explicit {x,y,w,h} or use canvas"
    return $null
  }
  Warn "FancyZones layout type '$($layout.type)' not supported"
  return $null
}

# --- Window placement ------------------------------------------------------
Add-Type -AssemblyName System.Windows.Forms

function Move-WindowToRect {
  param([IntPtr]$hwnd, $rect)
  if ($hwnd -eq [IntPtr]::Zero -or $null -eq $rect) { return $false }
  [void][WfWin]::ShowWindow($hwnd, [WfWin]::SW_RESTORE)
  $flags = [WfWin]::SWP_NOZORDER -bor [WfWin]::SWP_SHOWWINDOW
  return [WfWin]::SetWindowPos($hwnd, [IntPtr]::Zero, $rect.X, $rect.Y, $rect.W, $rect.H, $flags)
}

function Wait-ForWindow {
  param([string]$titleSub, [uint32]$processId, [int]$timeoutSecs)
  $deadline = (Get-Date).AddSeconds($timeoutSecs)
  while ((Get-Date) -lt $deadline) {
    $h = [IntPtr]::Zero
    # PID takes priority: a launched exe has a unique PID, whereas titles are
    # ambiguous (Unity + Rider both contain the project name; multiple agents
    # of the same kind share their prefix until disambiguated by instance_id).
    if ($processId) { $h = [WfWin]::FindByPid($processId) }
    if ($h -eq [IntPtr]::Zero -and $titleSub) { $h = [WfWin]::FindByTitleSubstring($titleSub) }
    if ($h -ne [IntPtr]::Zero) { return $h }
    Start-Sleep -Milliseconds 300
  }
  return [IntPtr]::Zero
}

# --- Virtual desktop switching ---------------------------------------------
# Best-effort. Uses keyboard shortcuts via WScript.Shell - no extra deps.
# Caller is expected to NOT touch the keyboard while this runs. If
# VirtualDesktopAccessor.dll is detected on PATH or alongside the script we
# could bind to it for precise control, but that is deferred.
$wshell = New-Object -ComObject WScript.Shell

function Switch-ToDesktopIndex {
  param([int]$targetIdx, [ref]$currentIdx)
  if ($targetIdx -eq $currentIdx.Value) { return }
  $delta = $targetIdx - $currentIdx.Value
  if ($delta -gt 0) { 1..$delta | ForEach-Object { $wshell.SendKeys('^#{RIGHT}'); Start-Sleep -Milliseconds 250 } }
  elseif ($delta -lt 0) { 1..([Math]::Abs($delta)) | ForEach-Object { $wshell.SendKeys('^#{LEFT}'); Start-Sleep -Milliseconds 250 } }
  $currentIdx.Value = $targetIdx
}

function Ensure-DesktopCount {
  param([int]$count)
  # Win+Ctrl+D creates a new desktop. We only ADD desktops if the user has
  # fewer than they need - never remove existing ones (they may have other
  # work parked there).
  $have = Get-DesktopCount
  while ($have -lt $count) {
    $wshell.SendKeys('^#d'); Start-Sleep -Milliseconds 400
    $have += 1
  }
}

function Get-DesktopCount {
  # Heuristic: read from registry (Windows 11 stores VirtualDesktopIDs).
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\VirtualDesktops'
  try {
    $ids = (Get-ItemProperty -Path $key -Name VirtualDesktopIDs -ErrorAction Stop).VirtualDesktopIDs
    return [int]($ids.Length / 16) # each GUID is 16 bytes
  } catch { return 1 }
}

# --- Unity launcher --------------------------------------------------------
function Start-UnityForProject {
  param([string]$projectPath)
  if (-not (Test-Path $projectPath)) { Warn "unity_project not found: $projectPath"; return $null }
  $verFile = Join-Path $projectPath 'ProjectSettings\ProjectVersion.txt'
  if (-not (Test-Path $verFile)) { Warn "no ProjectVersion.txt in $projectPath"; return $null }
  $ver = (Get-Content $verFile | Where-Object { $_ -match '^m_EditorVersion:' } | Select-Object -First 1) -replace '^m_EditorVersion:\s*', ''
  $ver = $ver.Trim()
  if (-not $ver) { Warn 'could not parse Unity version'; return $null }

  $pf   = $env:ProgramFiles
  $pf86 = (Get-Item 'Env:\ProgramFiles(x86)' -ErrorAction SilentlyContinue).Value
  $candidates = @()
  if ($pf)   { $candidates += "$pf\Unity\Hub\Editor\$ver\Editor\Unity.exe" }
  if ($pf86) { $candidates += "$pf86\Unity\Hub\Editor\$ver\Editor\Unity.exe" }
  $candidates += "C:\Program Files\Unity\Hub\Editor\$ver\Editor\Unity.exe"
  $exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $exe) {
    # Fall back to Unity Hub dispatcher.
    $hub = Join-Path $env:ProgramFiles 'Unity Hub\Unity Hub.exe'
    if (Test-Path $hub) {
      Log "Unity $ver not found locally - asking Unity Hub to install/open"
      $args = @('--', '--headless', 'editors', '-i') # minimal hub call to trigger install handoff
      Start-Process -FilePath $hub -ArgumentList "-projectPath `"$projectPath`""
      return $null
    }
    Warn "Unity $ver not found and Unity Hub not installed"
    return $null
  }

  Log "launching Unity $ver for $projectPath"
  $p = Start-Process -FilePath $exe -ArgumentList "-projectPath `"$projectPath`"" -PassThru
  return $p
}

# --- Generic launcher ------------------------------------------------------
# Returns @{ Process; InstanceId } so spawn_agent calls can match the unique
# per-instance window title (otherwise four spawns of the same agent all
# match the substring "workflow:developer-light" and we'd reposition the
# same window four times).
function Start-Window {
  param($win)
  $out = @{ Process = $null; InstanceId = $null }
  if ($win.spawn_agent) {
    Log "spawning workflow agent: $($win.spawn_agent)"
    $url = "http://127.0.0.1:$KanbanPort/api/instance/spawn"
    try {
      $body = @{ agent = $win.spawn_agent } | ConvertTo-Json -Compress
      $r = Invoke-RestMethod -Method POST -Uri $url -Body $body -ContentType 'application/json' -TimeoutSec 5
      $out.InstanceId = $r.instance_id
      Start-Sleep -Milliseconds 800  # let the cmd window come up before we hunt for it
    } catch { Warn "spawn failed: $_" }
    return $out
  }
  if ($win.url) {
    Log "opening url: $($win.url)"
    Start-Process $win.url
    return $out
  }
  if ($win.open -eq 'unity') {
    if (-not $manifest.unity_project) { Warn 'open=unity but unity_project not set'; return $out }
    $out.Process = Start-UnityForProject -projectPath $manifest.unity_project
    return $out
  }
  if ($win.exe) {
    $argList = @()
    if ($win.args) { $argList = @($win.args) }
    Log "launching $($win.exe) $($argList -join ' ')"
    try {
      $out.Process = Start-Process -FilePath $win.exe -ArgumentList $argList -PassThru -ErrorAction Stop
    } catch { Warn "launch failed for $($win.exe): $_" }
    return $out
  }
  Warn "window has no launcher (need spawn_agent / url / open / exe): $($win | ConvertTo-Json -Compress)"
  return $out
}

function Resolve-MatchTitle {
  param($win, $launch)
  if ($win.match_title) { return [string]$win.match_title }
  if ($win.spawn_agent) {
    # Prefer the unique instance id so multiple spawns of the same agent are
    # disambiguated. Falls back to the agent prefix if the spawn API didn't
    # return an id (kanban offline etc.).
    if ($launch.InstanceId) { return "workflow:$($win.spawn_agent):$($launch.InstanceId)" }
    return "workflow:$($win.spawn_agent)"
  }
  if ($win.url) {
    if ($win.url -match '^https?://[^/]*7777') { return 'Workflow' }
    return $null
  }
  if ($win.open -eq 'unity') {
    $name = if ($manifest.unity_project) { Split-Path -Leaf $manifest.unity_project } else { 'Unity' }
    return $name
  }
  if ($win.exe) { return [string]$win.exe }
  return $null
}

# --- Orchestration ---------------------------------------------------------
$desktops = @($manifest.desktops)
if ($desktops.Count -eq 0) { Log 'no desktops in manifest - nothing to do'; exit 0 }

Ensure-DesktopCount -count $desktops.Count

$currentIdx = [ref] 0
# Force ourselves to desktop 0 by repeatedly pressing left until we can't go further.
1..10 | ForEach-Object { $wshell.SendKeys('^#{LEFT}'); Start-Sleep -Milliseconds 120 }

for ($i = 0; $i -lt $desktops.Count; $i++) {
  $d = $desktops[$i]
  Log "configuring desktop $i ($($d.name))"
  Switch-ToDesktopIndex -targetIdx $i -currentIdx $currentIdx
  Start-Sleep -Milliseconds 400

  foreach ($win in @($d.windows)) {
    $launch = Start-Window -win $win
    $matchTitle = Resolve-MatchTitle -win $win -launch $launch
    $procPid = if ($launch.Process) { [uint32]$launch.Process.Id } else { 0 }
    $hwnd = Wait-ForWindow -titleSub $matchTitle -processId $procPid -timeoutSecs $waitSecs
    if ($hwnd -eq [IntPtr]::Zero) {
      Warn "could not locate window for '$matchTitle' within $waitSecs s"
      continue
    }
    $monIdx = if ($null -ne $d.monitor) { [int]$d.monitor } else { 0 }
    $rect = Resolve-ZoneRect -zone $win.zone -monitorIdx $monIdx
    if ($rect) {
      $ok = Move-WindowToRect -hwnd $hwnd -rect $rect
      if ($ok) { Log ("placed '{0}' at {1},{2} {3}x{4}" -f $matchTitle, $rect.X, $rect.Y, $rect.W, $rect.H) }
      else { Warn "SetWindowPos failed for '$matchTitle'" }
    }
  }
}

Log 'session ready'
