param(
  [Parameter(Mandatory = $true)][string]$OutputDir,
  [Parameter(Mandatory = $true)][int]$ExpectedPid,
  [long]$ExpectedHwnd = 0
)

$ErrorActionPreference = 'Stop'
$OutputDir = [System.IO.Path]::GetFullPath($OutputDir)
[System.IO.Directory]::CreateDirectory($OutputDir) | Out-Null

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class QaNativeWin32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; public POINT(int x, int y) { X = x; Y = y; } }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr hWnd, IntPtr region);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
  [DllImport("gdi32.dll")] public static extern bool PtInRegion(IntPtr region, int x, int y);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr handle);
}
'@

function New-Point([int]$x, [int]$y) { return [QaNativeWin32+POINT]::new($x, $y) }

function Get-Rect([IntPtr]$Handle) {
  $rect = New-Object QaNativeWin32+RECT
  if (-not [QaNativeWin32]::GetWindowRect($Handle, [ref]$rect)) { throw "GetWindowRect failed for $Handle" }
  return [ordered]@{ x = $rect.Left; y = $rect.Top; width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top; right = $rect.Right; bottom = $rect.Bottom }
}

function Get-Title([IntPtr]$Handle) {
  $text = New-Object Text.StringBuilder 512
  [QaNativeWin32]::GetWindowText($Handle, $text, $text.Capacity) | Out-Null
  return $text.ToString()
}

function Get-Class([IntPtr]$Handle) {
  $text = New-Object Text.StringBuilder 256
  [QaNativeWin32]::GetClassName($Handle, $text, $text.Capacity) | Out-Null
  return $text.ToString()
}

function Get-WindowInfo([IntPtr]$Handle) {
  if ($Handle -eq [IntPtr]::Zero) { return $null }
  [uint32]$windowProcessId = 0
  [QaNativeWin32]::GetWindowThreadProcessId($Handle, [ref]$windowProcessId) | Out-Null
  try { $rect = Get-Rect $Handle } catch { return $null }
  return [ordered]@{ hwnd = $Handle.ToInt64(); pid = [int]$windowProcessId; visible = [QaNativeWin32]::IsWindowVisible($Handle); title = Get-Title $Handle; class = Get-Class $Handle; rect = $rect }
}

function Get-TopLevelWindows([int]$ProcessId) {
  $items = [System.Collections.Generic.List[object]]::new()
  $callback = [QaNativeWin32+EnumWindowsProc] {
    param([IntPtr]$Handle, [IntPtr]$Unused)
    [uint32]$windowPid = 0
    [QaNativeWin32]::GetWindowThreadProcessId($Handle, [ref]$windowPid) | Out-Null
    if ([int]$windowPid -eq $ProcessId -and [QaNativeWin32]::IsWindowVisible($Handle)) {
      $items.Add((Get-WindowInfo $Handle))
    }
    return $true
  }
  [QaNativeWin32]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
  return @($items)
}

function Save-ScreenRegion([string]$Path, [int]$X, [int]$Y, [int]$Width, [int]$Height) {
  $bitmap = New-Object Drawing.Bitmap $Width, $Height, ([Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($X, $Y, 0, 0, (New-Object Drawing.Size $Width, $Height), [Drawing.CopyPixelOperation]::SourceCopy)
    $bitmap.Save($Path, [Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Invoke-NativeClick([int]$X, [int]$Y, [int]$DwellMs = 0) {
  [QaNativeWin32]::SetCursorPos($X, $Y) | Out-Null
  if ($DwellMs -gt 0) { Start-Sleep -Milliseconds $DwellMs }
  [QaNativeWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [QaNativeWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

function Get-PointOwner([int]$X, [int]$Y) {
  return Get-WindowInfo ([QaNativeWin32]::WindowFromPoint((New-Point $X $Y)))
}

function Get-RegionProbe([IntPtr]$Handle, [int]$LocalX, [int]$LocalY) {
  $region = [QaNativeWin32]::CreateRectRgn(0, 0, 0, 0)
  try {
    $kind = [QaNativeWin32]::GetWindowRgn($Handle, $region)
    $inside = [QaNativeWin32]::PtInRegion($region, $LocalX, $LocalY)
    return [ordered]@{ getWindowRgn = $kind; localPoint = [ordered]@{ x = $LocalX; y = $LocalY }; ptInRegion = $inside }
  } finally {
    [QaNativeWin32]::DeleteObject($region) | Out-Null
  }
}

function Wait-VisibleAux([int]$ProcessId, [Int64]$PreviewHwnd, [int]$TimeoutMs = 2500) {
  $elapsed = 0
  while ($elapsed -lt $TimeoutMs) {
    [System.Windows.Forms.Application]::DoEvents()
    $windows = @(Get-TopLevelWindows $ProcessId | Where-Object {
      $_.hwnd -ne $PreviewHwnd -and
      $_.rect.width -gt 300 -and $_.rect.height -gt 300 -and
      -not [string]::IsNullOrWhiteSpace($_.title) -and
      $_.title -match '내 업무 환경|초안 만들기'
    })
    if ($windows.Count -gt 0) { return $windows[0] }
    Start-Sleep -Milliseconds 100
    $elapsed += 100
  }
  return $null
}

$startedAt = [DateTime]::UtcNow.ToString("o")
$sourceFile = Join-Path (Split-Path $PSScriptRoot -Parent) 'src\notch-window.cjs'
$sourceHashStart = (Get-FileHash $sourceFile -Algorithm SHA256).Hash
$process = Get-Process -Id $ExpectedPid -ErrorAction Stop
if ($process.ProcessName -ne 'electron') { throw "Expected Electron main PID $ExpectedPid" }
$previewCandidates = @(Get-TopLevelWindows $ExpectedPid | Where-Object {
  $_.visible -and $_.title -ceq '업무 도우미' -and
  $_.rect.width -ge 52 -and $_.rect.width -le 72 -and
  $_.rect.height -ge 380 -and $_.rect.height -le 408 -and
  (Get-RegionProbe ([IntPtr]$_.hwnd) 1 1).getWindowRgn -eq 3
})
if ($ExpectedHwnd -ne 0) { $previewCandidates = @($previewCandidates | Where-Object { $_.hwnd -eq $ExpectedHwnd }) }
if ($previewCandidates.Count -ne 1) { throw "Expected exactly one visible titled portrait complex-region preview; candidates=$($previewCandidates | ConvertTo-Json -Compress -Depth 5)" }
$previewHandle = [IntPtr]$previewCandidates[0].hwnd
$previewBefore = Get-WindowInfo $previewHandle
$previewRect = $previewBefore.rect
if ($previewRect.x -lt 1700 -or $previewRect.right -gt 2200) { throw "Selected preview is not the expected right-edge window: $($previewRect | ConvertTo-Json -Compress)" }
$screenBounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$cornerLocal = [ordered]@{ x = 1; y = 1 }
$cornerPoint = [ordered]@{ x = $previewRect.x + $cornerLocal.x; y = $previewRect.y + $cornerLocal.y }
$settingsPoint = [ordered]@{ x = $previewRect.x + 28; y = $previewRect.y + 329 }
$outsidePoint = [ordered]@{ x = [Math]::Max($screenBounds.Left, $previewRect.x - 110); y = $previewRect.y + 197 }
$previewCropX = [Math]::Max($screenBounds.Left, $previewRect.x - 144)
$previewCropY = [Math]::Max($screenBounds.Top, $previewRect.y - 80)
$previewCropW = [Math]::Min(300, $screenBounds.Right - $previewCropX)
$previewCropH = [Math]::Min(560, $screenBounds.Bottom - $previewCropY)

$actions = [System.Collections.Generic.List[object]]::new()
function Record-Action([string]$Name, [hashtable]$Data) {
  $entry = [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); action = $Name }
  foreach ($key in $Data.Keys) { $entry[$key] = $Data[$key] }
  $actions.Add($entry)
}

Save-ScreenRegion (Join-Path $OutputDir 'preview-before.png') $previewCropX $previewCropY $previewCropW $previewCropH
Record-Action 'capture-preview-before' @{ path = 'preview-before.png'; rect = $previewBefore.rect; foreground = (Get-WindowInfo ([QaNativeWin32]::GetForegroundWindow())) }

$preWindows = @(Get-TopLevelWindows $ExpectedPid)
$preOwnerCorner = Get-PointOwner $cornerPoint.x $cornerPoint.y
$preOwnerSettings = Get-PointOwner $settingsPoint.x $settingsPoint.y
$regionProbe = Get-RegionProbe $previewHandle $cornerLocal.x $cornerLocal.y
Record-Action 'precondition-native-ownership' @{ cornerPoint = $cornerPoint; cornerOwner = $preOwnerCorner; settingsPoint = $settingsPoint; settingsOwner = $preOwnerSettings; region = $regionProbe; windows = $preWindows }

$counter = @{ clicks = 0 }
$targetWidth = 148
$targetX = [Math]::Max($screenBounds.Left, $previewRect.x - 84)
$targetY = $previewRect.y
$target = New-Object Windows.Forms.Form
$target.FormBorderStyle = [Windows.Forms.FormBorderStyle]::None
$target.StartPosition = [Windows.Forms.FormStartPosition]::Manual
$target.ShowInTaskbar = $false
$target.TopMost = $false
$target.BackColor = [Drawing.Color]::FromArgb(220, 240, 255)
$target.ClientSize = New-Object Drawing.Size $targetWidth, $previewRect.height
$target.Location = New-Object Drawing.Point $targetX, $targetY
$target.Text = 'QA underlying native target'
$button = New-Object Windows.Forms.Button
$button.Dock = [Windows.Forms.DockStyle]::Fill
$button.FlatStyle = [Windows.Forms.FlatStyle]::Flat
$button.BackColor = [Drawing.Color]::FromArgb(220, 240, 255)
$button.Font = New-Object Drawing.Font('Segoe UI', 10, [Drawing.FontStyle]::Bold)
$button.Text = "UNDERLYING TARGET`r`nNative clicks: 0"
$button.Add_Click({ $counter.clicks = [int]$counter.clicks + 1; $button.Text = "UNDERLYING TARGET`r`nNative clicks: $($counter.clicks)" })
$target.Controls.Add($button)
$target.Show()
[System.Windows.Forms.Application]::DoEvents()
[QaNativeWin32]::SetWindowPos($target.Handle, $previewHandle, $targetX, $targetY, $targetWidth, $previewRect.height, 0x0010 -bor 0x0040) | Out-Null
[QaNativeWin32]::SetForegroundWindow($previewHandle) | Out-Null
[System.Windows.Forms.Application]::DoEvents()
Start-Sleep -Milliseconds 120
$targetHandle = [IntPtr]$target.Handle
$targetInfo = Get-WindowInfo $targetHandle
Save-ScreenRegion (Join-Path $OutputDir 'preview-with-underlying-target.png') $previewCropX $previewCropY $previewCropW $previewCropH
Record-Action 'create-underlying-target' @{ target = $targetInfo; preview = (Get-WindowInfo $previewHandle); targetVisible = $target.Visible; targetText = $button.Text }

# Control: move the disposable target away from the product and prove its click counter independently.
$controlX = [Math]::Max($screenBounds.Left, $previewRect.x - 330)
[QaNativeWin32]::SetWindowPos($targetHandle, [IntPtr]::Zero, $controlX, $targetY, $targetWidth, $previewRect.height, 0x0010 -bor 0x0040 -bor 0x0004) | Out-Null
[System.Windows.Forms.Application]::DoEvents()
$controlPoint = [ordered]@{ x = $controlX + [Math]::Floor($targetWidth / 2); y = $targetY + [Math]::Floor($previewRect.height / 2) }
$controlOwner = Get-PointOwner $controlPoint.x $controlPoint.y
$counter.clicks = 0
Invoke-NativeClick $controlPoint.x $controlPoint.y 0
Start-Sleep -Milliseconds 180
[System.Windows.Forms.Application]::DoEvents()
$controlClicks = [int]$counter.clicks
Record-Action 'control-click-target-uncovered' @{ controlPoint = $controlPoint; owner = $controlOwner; clicks = $controlClicks; targetForeground = (Get-WindowInfo ([QaNativeWin32]::GetForegroundWindow())) }

# Put the target under the real preview and reset the counter for the actual corner test.
$counter.clicks = 0
$button.Text = "UNDERLYING TARGET`r`nNative clicks: 0"
[QaNativeWin32]::SetWindowPos($targetHandle, $previewHandle, $targetX, $targetY, $targetWidth, $previewRect.height, 0x0010 -bor 0x0040) | Out-Null
[QaNativeWin32]::SetForegroundWindow($previewHandle) | Out-Null
[System.Windows.Forms.Application]::DoEvents()
Start-Sleep -Milliseconds 120
$cornerOwnerBefore = Get-PointOwner $cornerPoint.x $cornerPoint.y
$cornerCountBefore = [int]$counter.clicks
Invoke-NativeClick $cornerPoint.x $cornerPoint.y 0
Start-Sleep -Milliseconds 220
[System.Windows.Forms.Application]::DoEvents()
$cornerCountAfter = [int]$counter.clicks
$cornerOwnerAfter = Get-PointOwner $cornerPoint.x $cornerPoint.y
$cornerOwnerRoot = [QaNativeWin32]::GetAncestor(([IntPtr]$cornerOwnerBefore.hwnd), 2)
$cornerForeground = Get-WindowInfo ([QaNativeWin32]::GetForegroundWindow())
Save-ScreenRegion (Join-Path $OutputDir 'transparent-corner-after-click.png') $previewCropX $previewCropY $previewCropW $previewCropH
$cornerResult = [ordered]@{
  invocation = 'powershell.exe -NoProfile -STA -File scripts/qa-native-input-independent.ps1'
  previewPid = $ExpectedPid
  previewHwnd = $previewHandle.ToInt64()
  previewRect = $previewRect
  targetHwnd = $targetHandle.ToInt64()
  targetRect = (Get-Rect $targetHandle)
  localPoint = $cornerLocal
  screenPoint = $cornerPoint
  ownerBefore = $cornerOwnerBefore
  ownerAfter = $cornerOwnerAfter
  ownerBeforeRootHwnd = $cornerOwnerRoot.ToInt64()
  foregroundAfter = $cornerForeground
  regionProbe = $regionProbe
  controlClicks = $controlClicks
  cornerClicksBefore = $cornerCountBefore
  cornerClicksAfter = $cornerCountAfter
  clickDelta = $cornerCountAfter - $cornerCountBefore
  pass = ($controlClicks -eq 1 -and $cornerCountAfter -eq 1 -and $cornerOwnerRoot.ToInt64() -eq $targetHandle.ToInt64() -and $regionProbe.ptInRegion -eq $false -and $regionProbe.getWindowRgn -eq 3)
}
$cornerResult | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 (Join-Path $OutputDir 'transparent-corner-result.json')
Record-Action 'transparent-corner-click' @{ result = $cornerResult }

# Settings: real product button, native move from outside and immediate mouse down/up. Close only the aux window opened by this loop.
$target.Close()
$target.Dispose()
[System.Windows.Forms.Application]::DoEvents()
Start-Sleep -Milliseconds 120
$settingsUnderlayReleased = [ordered]@{
  targetDisposed = $target.IsDisposed
  targetHandleStillWindow = ((Get-WindowInfo $targetHandle) -ne $null)
  settingsOwnerAfterDispose = (Get-PointOwner $settingsPoint.x $settingsPoint.y)
}
Record-Action 'dispose-underlying-target-before-settings' @{ release = $settingsUnderlayReleased }
[QaNativeWin32]::SetForegroundWindow($previewHandle) | Out-Null
$settingsTrials = [System.Collections.Generic.List[object]]::new()
$auxHandle = [IntPtr]::Zero
foreach ($dwell in @(0, 20, 40)) {
  [System.Windows.Forms.Application]::DoEvents()
  $beforeVisible = @(Get-TopLevelWindows $ExpectedPid | Where-Object { $_.hwnd -ne $previewHandle.ToInt64() })
  [QaNativeWin32]::SetCursorPos($outsidePoint.x, $outsidePoint.y) | Out-Null
  [QaNativeWin32]::SetCursorPos($settingsPoint.x, $settingsPoint.y) | Out-Null
  $ownerAtSettings = Get-PointOwner $settingsPoint.x $settingsPoint.y
  $regionAtSettings = Get-RegionProbe $previewHandle ($settingsPoint.x - $previewRect.x) ($settingsPoint.y - $previewRect.y)
  Invoke-NativeClick $settingsPoint.x $settingsPoint.y $dwell
  $aux = Wait-VisibleAux $ExpectedPid ($previewHandle.ToInt64()) 2800
  $foreground = Get-WindowInfo ([QaNativeWin32]::GetForegroundWindow())
  $auxVisible = $null -ne $aux
  $screenshotName = "settings-dwell-$dwell.png"
  Save-ScreenRegion (Join-Path $OutputDir $screenshotName) $previewCropX $previewCropY $previewCropW $previewCropH
  if ($auxVisible) {
    $auxHandle = [IntPtr]$aux.hwnd
    if ($auxHandle -eq $previewHandle -or $aux.pid -ne $ExpectedPid) { throw "Refusing to close non-auxiliary window: $($aux | ConvertTo-Json -Compress -Depth 5)" }
    [QaNativeWin32]::PostMessage($auxHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    Start-Sleep -Milliseconds 180
    [System.Windows.Forms.Application]::DoEvents()
  }
  $afterCloseVisible = @(Get-TopLevelWindows $ExpectedPid | Where-Object { $_.hwnd -ne $previewHandle.ToInt64() })
  $trial = [ordered]@{
    dwellMs = $dwell
    outsidePoint = $outsidePoint
    settingsPoint = $settingsPoint
    ownerAtSettings = $ownerAtSettings
    regionAtSettings = $regionAtSettings
    foregroundAfterClick = $foreground
    auxOpened = $auxVisible
    auxWindow = $aux
    auxClosedByPostMessage = $auxVisible
    visibleAuxAfterClose = $afterCloseVisible
    screenshot = $screenshotName
    pass = ($auxVisible -and $ownerAtSettings.hwnd -eq $previewHandle.ToInt64() -and $foreground.pid -eq $ExpectedPid -and $foreground.hwnd -eq $aux.hwnd -and $afterCloseVisible.Count -eq 0)
  }
  $settingsTrials.Add($trial)
  Record-Action "settings-native-click-dwell-$dwell" @{ trial = $trial }
  [QaNativeWin32]::SetForegroundWindow($previewHandle) | Out-Null
  Start-Sleep -Milliseconds 120
}
$settingsResult = [ordered]@{
  previewPid = $ExpectedPid
  previewHwnd = $previewHandle.ToInt64()
  previewRect = $previewRect
  settingsPoint = $settingsPoint
  settingsTrials = @($settingsTrials)
  pass = (@($settingsTrials).Count -eq 3 -and (@($settingsTrials | Where-Object { -not $_.pass })).Count -eq 0)
}
$settingsResult | ConvertTo-Json -Depth 16 | Set-Content -Encoding UTF8 (Join-Path $OutputDir 'settings-native-result.json')

if (-not $target.IsDisposed) {
  $target.Close()
  $target.Dispose()
}
[System.Windows.Forms.Application]::DoEvents()
Start-Sleep -Milliseconds 160
$sourceHashEnd = (Get-FileHash $sourceFile -Algorithm SHA256).Hash
$processAfter = Get-Process -Id $ExpectedPid -ErrorAction Stop
$previewAfter = Get-WindowInfo ([IntPtr]$processAfter.MainWindowHandle)
Save-ScreenRegion (Join-Path $OutputDir 'preview-after-cleanup.png') $previewCropX $previewCropY $previewCropW $previewCropH
$cleanup = [ordered]@{
  targetDisposed = $target.IsDisposed
  targetHandleStillWindow = ((Get-WindowInfo $targetHandle) -ne $null)
  previewPidStillAlive = (-not $processAfter.HasExited)
  previewHwndUnchanged = ($previewAfter.hwnd -eq $previewHandle.ToInt64())
  previewVisible = $previewAfter.visible
  previewRectAfter = $previewAfter.rect
  sourceHashStart = $sourceHashStart
  sourceHashEnd = $sourceHashEnd
  sourceHashUnchanged = ($sourceHashStart -eq $sourceHashEnd)
}
$cleanup | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 (Join-Path $OutputDir 'cleanup-and-source-check.json')

$final = [ordered]@{
  startedAt = $startedAt
  finishedAt = [DateTime]::UtcNow.ToString('o')
  expectedPid = $ExpectedPid
  sourceHashStart = $sourceHashStart
  sourceHashEnd = $sourceHashEnd
  sourceHashUnchanged = ($sourceHashStart -eq $sourceHashEnd)
  previewBefore = $previewBefore
  previewAfter = $previewAfter
  controlClick = [ordered]@{ clicks = $controlClicks; pass = ($controlClicks -eq 1) }
  transparentCorner = $cornerResult
  settings = $settingsResult
  cleanup = $cleanup
  pass = ($cornerResult.pass -and $settingsResult.pass -and $cleanup.sourceHashUnchanged -and $cleanup.previewPidStillAlive -and $cleanup.previewHwndUnchanged -and $cleanup.previewVisible)
}
$final | ConvertTo-Json -Depth 20 | Set-Content -Encoding UTF8 (Join-Path $OutputDir 'independent-native-result.json')
$actions | ConvertTo-Json -Depth 20 | Set-Content -Encoding UTF8 (Join-Path $OutputDir 'native-action-log.json')
if (-not $final.pass) { throw "Independent native QA failed; see $OutputDir\independent-native-result.json" }
