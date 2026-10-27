param([ValidateSet('aside', 'chrome')][string]$Browser)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
. (Join-Path $PSScriptRoot '../src/native/browser-profile.ps1')
Set-BrowserProfile -Id $Browser
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$tabCount = 0
$addresses = @()
$tabs = @()
$testUrlVisible = $false
foreach ($owner in @(Get-Process -Name $script:BrowserProfile.processName -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0)) {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($owner.MainWindowHandle)
    $condition = [System.Windows.Automation.OrCondition]::new(
        [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty, $script:BrowserProfile.addressClass),
        [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty, $script:BrowserProfile.tabClass))
    foreach ($element in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)) {
        if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit) {
            $value = $null
            if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$value)) {
                # Record only whether our public test URL is present; never dump browsing history.
                $testAddress = 'example.com/?edudock-browser-check=' + $Browser
                if ($value.Current.Value -ceq $testAddress -or $value.Current.Value -ceq ('https://' + $testAddress)) { $testUrlVisible = $true }
            }
            $addresses += [pscustomobject]@{ processName=$owner.ProcessName; name=$element.Current.Name; className=$element.Current.ClassName; automationId=$element.Current.AutomationId }
        } elseif ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem -and (Test-BrowserTab -ClassName $element.Current.ClassName -AutomationId $element.Current.AutomationId)) {
            $selection = $null
            if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) {
                $tabCount += 1
                $tabs += [pscustomobject]@{ className=$element.Current.ClassName; automationId=$element.Current.AutomationId; selectionAvailable=$true }
            }
        }
    }
}
[pscustomobject]@{ testUrlVisible=$testUrlVisible; tabCount=$tabCount; addresses=@($addresses | Sort-Object processName, className, automationId -Unique); tabs=@($tabs | Sort-Object className, automationId -Unique) } | ConvertTo-Json -Depth 4 -Compress
