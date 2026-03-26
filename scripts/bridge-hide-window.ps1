param(
  [string]$ProfileMarker = 'bridge-browser-profile',
  [int]$IntervalMs = 900,
  [bool]$HideChatGptTitleWindows = $true
)

$ErrorActionPreference = 'SilentlyContinue'

if ($IntervalMs -lt 300) {
  $IntervalMs = 300
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public static class BridgeWindowHiderNative {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern int GetWindowTextLength(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
  public static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);

  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
  public static extern IntPtr GetWindowLong32(IntPtr hWnd, int nIndex);

  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
  public static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

  [DllImport("user32.dll", EntryPoint = "SetWindowLongW")]
  public static extern IntPtr SetWindowLong32(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool SetWindowPos(
    IntPtr hWnd,
    IntPtr hWndInsertAfter,
    int X,
    int Y,
    int cx,
    int cy,
    uint uFlags
  );

  public static IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex) {
    if (IntPtr.Size == 8) return GetWindowLongPtr64(hWnd, nIndex);
    return GetWindowLong32(hWnd, nIndex);
  }

  public static IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong) {
    if (IntPtr.Size == 8) return SetWindowLongPtr64(hWnd, nIndex, dwNewLong);
    return SetWindowLong32(hWnd, nIndex, dwNewLong);
  }
}
"@

$GWL_EXSTYLE = -20
$WS_EX_TOOLWINDOW = 0x00000080
$WS_EX_APPWINDOW = 0x00040000
$SW_HIDE = 0
$SW_MINIMIZE = 6
$SWP_NOMOVE = 0x0002
$SWP_NOSIZE = 0x0001
$SWP_NOZORDER = 0x0004
$SWP_NOACTIVATE = 0x0010
$SWP_FRAMECHANGED = 0x0020
$SWP_FLAGS = $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOZORDER -bor $SWP_NOACTIVATE -bor $SWP_FRAMECHANGED

function Set-BridgeWindowHiddenStyle {
  param(
    [IntPtr]$Handle
  )

  if ($Handle -eq [IntPtr]::Zero) {
    return
  }

  try {
    $stylePtr = [BridgeWindowHiderNative]::GetWindowLongPtr($Handle, $GWL_EXSTYLE)
    $styleValue = $stylePtr.ToInt64()
    $nextStyle = ($styleValue -bor $WS_EX_TOOLWINDOW) -band (-bnot $WS_EX_APPWINDOW)
    if ($nextStyle -ne $styleValue) {
      [BridgeWindowHiderNative]::SetWindowLongPtr($Handle, $GWL_EXSTYLE, [IntPtr]::new($nextStyle)) | Out-Null
      [BridgeWindowHiderNative]::SetWindowPos($Handle, [IntPtr]::Zero, 0, 0, 0, 0, [uint32]$SWP_FLAGS) | Out-Null
    }
    [BridgeWindowHiderNative]::ShowWindowAsync($Handle, $SW_MINIMIZE) | Out-Null
    [BridgeWindowHiderNative]::ShowWindowAsync($Handle, $SW_HIDE) | Out-Null
  } catch {
    # Ignore style update failures.
  }
}

function Get-BridgeRelatedPids {
  param(
    [string]$Marker
  )

  $browserProcs = @()
  try {
    $browserProcs = Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe' OR Name='brave.exe' OR Name='firefox.exe'"
  } catch {
    return @()
  }

  if (-not $browserProcs) {
    return @()
  }

  $allByPid = @{}
  foreach ($proc in $browserProcs) {
    $allByPid[[int]$proc.ProcessId] = $proc
  }

  $roots = @()
  foreach ($proc in $browserProcs) {
    if ($proc.CommandLine -like "*$Marker*") {
      $roots += [int]$proc.ProcessId
    }
  }

  if ($roots.Count -eq 0) {
    return @()
  }

  $targets = New-Object 'System.Collections.Generic.HashSet[int]'
  $queue = New-Object 'System.Collections.Generic.Queue[int]'

  foreach ($pid in $roots) {
    if ($targets.Add($pid)) {
      $queue.Enqueue($pid)
    }
  }

  while ($queue.Count -gt 0) {
    $current = $queue.Dequeue()
    foreach ($proc in $browserProcs) {
      if ([int]$proc.ParentProcessId -eq $current) {
        $childPid = [int]$proc.ProcessId
        if ($targets.Add($childPid)) {
          $queue.Enqueue($childPid)
        }
      }
    }
  }

  return @($targets)
}

function Get-WindowTitle {
  param(
    [IntPtr]$Handle
  )

  try {
    $length = [BridgeWindowHiderNative]::GetWindowTextLength($Handle)
    if ($length -le 0) {
      return ''
    }
    $sb = New-Object System.Text.StringBuilder ($length + 1)
    [BridgeWindowHiderNative]::GetWindowText($Handle, $sb, $sb.Capacity) | Out-Null
    return $sb.ToString()
  } catch {
    return ''
  }
}

function ShouldHideByTitle {
  param(
    [string]$Title
  )

  if (-not $HideChatGptTitleWindows) {
    return $false
  }

  if (-not $Title) {
    return $false
  }

  return ($Title -match '(?i)chatgpt|doan chat tam thoi|temporary chat')
}

while ($true) {
  try {
    $targetPids = Get-BridgeRelatedPids -Marker $ProfileMarker
    if ($targetPids.Count -gt 0) {
      $pidSet = New-Object 'System.Collections.Generic.HashSet[uint32]'
      foreach ($pid in $targetPids) {
        $pidSet.Add([uint32]$pid) | Out-Null
        try {
          $proc = Get-Process -Id $pid -ErrorAction Stop
          if ($proc.MainWindowHandle -and $proc.MainWindowHandle -ne 0) {
            Set-BridgeWindowHiddenStyle -Handle ([IntPtr]$proc.MainWindowHandle)
          }
        } catch {
          # Ignore per-process lookup failures.
        }
      }

      $handles = New-Object 'System.Collections.Generic.List[IntPtr]'
      $callback = [BridgeWindowHiderNative+EnumWindowsProc]{
        param([IntPtr]$hWnd, [IntPtr]$lParam)
        try {
          [uint32]$pid = 0
          [BridgeWindowHiderNative]::GetWindowThreadProcessId($hWnd, [ref]$pid) | Out-Null
          if ($pid -eq 0) {
            return $true
          }

          $title = Get-WindowTitle -Handle $hWnd
          $matchedByPid = $pidSet.Contains($pid)
          $matchedByTitle = ShouldHideByTitle -Title $title
          if ($matchedByPid -or $matchedByTitle) {
            $handles.Add($hWnd) | Out-Null
          }
        } catch {
          # Ignore enumeration issues.
        }
        return $true
      }
      [BridgeWindowHiderNative]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null

      foreach ($handle in $handles) {
        Set-BridgeWindowHiddenStyle -Handle $handle
      }
    }
  } catch {
    # Ignore scan failures and keep scanning.
  }

  Start-Sleep -Milliseconds $IntervalMs
}
