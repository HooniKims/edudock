# Shared with the app: only identities measured on the browser chrome belong in this table.
$script:BrowserProfiles = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../browsers.json') -Raw -Encoding UTF8 | ConvertFrom-Json
function Set-BrowserProfile {
    param([string]$Id)
    $script:BrowserProfile = $script:BrowserProfiles | Where-Object { $_.id -ceq $Id } | Select-Object -First 1
    if ($null -eq $script:BrowserProfile) { $script:BrowserProfile = $script:BrowserProfiles | Where-Object { $_.id -ceq 'edge' } }
}
function Test-BrowserProcess {
    param([int]$OwnerPid)
    $owner = Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue
    return ($null -ne $owner -and $owner.ProcessName -ieq $script:BrowserProfile.processName)
}
function Test-BrowserTab {
    param([string]$ClassName, [string]$AutomationId)
    return ($ClassName -ceq $script:BrowserProfile.tabClass -and $AutomationId -ceq $script:BrowserProfile.tabId)
}
Set-BrowserProfile -Id 'edge'
