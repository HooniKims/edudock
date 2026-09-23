param([int]$TargetPid, [string]$TargetHwnd, [string]$ExpectedStartedAt, [switch]$InvokeLogin)

$ErrorActionPreference = 'Stop'
$null = Add-Type -AssemblyName UIAutomationClient
$null = Add-Type -AssemblyName UIAutomationTypes
$null = Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativeSelectorWindow {
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@

function U([int[]]$C) { return -join ($C | ForEach-Object { [char]$_ }) }
$knownNames = @(
    (U @(0xB85C,0xADF8,0xC778))
    (U @(0xC778,0xC99D,0xC11C)) + ' ' + (U @(0xB85C,0xADF8,0xC778)),
    (U @(0xACF5,0xB3D9,0xC778,0xC99D,0xC11C)) + ' ' + (U @(0xB85C,0xADF8,0xC778))
)
$h = [IntPtr]([int64]$TargetHwnd)
$owner = [uint32]0
$null = [NativeSelectorWindow]::GetWindowThreadProcessId($h, [ref]$owner)
$root = if ([NativeSelectorWindow]::IsWindow($h)) { [System.Windows.Automation.AutomationElement]::FromHandle($h) } else { $null }
$process = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
$actualStartedAt = if ($null -ne $process) { $process.StartTime.ToUniversalTime().ToString('o') } else { $null }
$startedAtMatches = -not $ExpectedStartedAt -or $actualStartedAt -ceq $ExpectedStartedAt
$owned = $null -ne $root -and $null -ne $process -and $process.ProcessName -ceq 'msedge' -and $startedAtMatches -and [int]$owner -eq $TargetPid -and $root.Current.ProcessId -eq $TargetPid -and [NativeSelectorWindow]::IsWindowVisible($h)
$origin = $null
if ($owned) {
    $addressCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'view_1021')
    $address = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $addressCondition)
    if ($null -ne $address -and -not $address.Current.IsPassword) {
        $valuePattern = $null
        if ($address.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
            $uri = $null
            if ([Uri]::TryCreate($valuePattern.Current.Value, [UriKind]::Absolute, [ref]$uri) -and $uri.Scheme -ceq 'https' -and $uri.DnsSafeHost -ceq 'sen.eduptl.kr' -and $uri.IsDefaultPort) {
                $origin = 'https://sen.eduptl.kr'
            }
        }
    }
}
$matches = @()
$matchedElements = @()
if ($owned -and $origin -eq 'https://sen.eduptl.kr') {
    $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'btnLgn')
    $matchedElements = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition))
    $matches = @($matchedElements | ForEach-Object {
        $rect = $_.Current.BoundingRectangle
        $patterns = @()
        $unused = $null
        if ($_.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$unused)) { $patterns += 'Invoke' }
        $unused = $null
        if ($_.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$unused)) { $patterns += 'SelectionItem' }
        [pscustomobject]@{
            automationId = 'btnLgn'
            ownerMatches = ($_.Current.ProcessId -eq $TargetPid)
            role = ($_.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '')
            visible = (-not $_.Current.IsOffscreen -and $rect.Width -gt 0 -and $rect.Height -gt 0)
            enabled = $_.Current.IsEnabled
            knownName = if ($_.Current.Name -in $knownNames) { $_.Current.Name } else { $null }
            patterns = @($patterns)
        }
    })
}
$invoked = $false
if ($InvokeLogin -and $matches.Count -eq 1 -and $matches[0].ownerMatches -and $matches[0].visible -and $matches[0].enabled -and 'Invoke' -in $matches[0].patterns) {
    $invokePattern = $null
    if ($matchedElements[0].TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokePattern)) {
        $invokePattern.Invoke()
        $invoked = $true
    }
}
[ordered]@{
    target = [ordered]@{ pid = $TargetPid; hwnd = $TargetHwnd }
    exactOwnership = $owned
    origin = $origin
    selector = 'AutomationId=btnLgn'
    matchCount = $matches.Count
    matches = @($matches)
    processStartedAt = $actualStartedAt
    processStartedAtMatches = $startedAtMatches
    invokePerformed = $invoked
    focusChanged = $false
    passwordValueRead = $false
} | ConvertTo-Json -Depth 6 -Compress
