$ErrorActionPreference = 'Stop'

function New-NeisLabel {
    param([int[]]$CodePoints)
    return -join ($CodePoints | ForEach-Object { [char]$_ })
}

$script:NeisTaskLabels = [ordered]@{
    myMenu = (New-NeisLabel @(0xB098,0xC758)) + ' ' + (New-NeisLabel @(0xBA54,0xB274))
    duty = (New-NeisLabel @(0xBCF5,0xBB34)) + ' 0' + (New-NeisLabel @(0xB2E8,0xACC4)) + ' ' + (New-NeisLabel @(0xBA54,0xB274,0xD56D,0xBAA9))
    attendance = New-NeisLabel @(0xAC1C,0xC778,0xADFC,0xBB34,0xC0C1,0xD669,0xAD00,0xB9AC)
    trip = New-NeisLabel @(0xAC1C,0xC778,0xCD9C,0xC7A5,0xAD00,0xB9AC)
}
$script:NeisSafeActions = @('select-my-menu', 'expand-duty', 'select-attendance-tab', 'select-trip-tab', 'open-attendance', 'open-trip')
$script:NeisSelectedMarker = New-NeisLabel @(0xC120,0xD0DD,0xB428)

function ConvertFrom-NeisTaskFixtureJson {
    param([Parameter(Mandatory, ValueFromPipeline)][string]$Json)
    if ($Json -match '(?i)"(?:password|secret|credential|recordValues|documentText)"\s*:') { throw 'Sensitive-shaped fixture fields are forbidden.' }
    $value = $Json | ConvertFrom-Json -ErrorAction Stop
    if ($null -eq $value -or $null -eq $value.root -or $null -eq $value.target -or $value.operation -isnot [string]) { throw 'Malformed NEIS fixture request.' }
    if ($value.root.controls -isnot [System.Array]) { throw 'NEIS fixture controls must be an array.' }
    return $value
}

function Test-NeisClassTokens {
    param([string]$ClassName, [string[]]$Tokens)
    $actual = @($ClassName -split '\s+' | Where-Object { $_ })
    foreach ($token in $Tokens) { if ($token -cnotin $actual) { return $false } }
    return $true
}

function Test-NeisTargetIdentity {
    param([object]$Root, [object]$Target)
    if ($null -eq $Root -or $null -eq $Target -or $Target.origin -cne 'https://sen.neis.go.kr') { return $false }
    if ($Root.PSObject.Properties.Name -contains 'controls') {
        return [int]$Root.processId -eq [int]$Target.pid -and [string]$Root.hwnd -ceq [string]$Target.hwnd -and
            [string]$Root.processStartedAt -ceq [string]$Target.processStartedAt -and $Root.origin -ceq $Target.origin -and $Root.locked -ne $true
    }
    try {
        $current = $Root.Current
        if ([int]$current.ProcessId -ne [int]$Target.pid) { return $false }
        $process = Get-Process -Id ([int]$Target.pid) -ErrorAction Stop
        if ([Int64]$current.NativeWindowHandle -ne [Int64]$Target.hwnd) { return $false }
        $actualStart = $process.StartTime.ToUniversalTime()
        $expectedStart = [DateTimeOffset]::Parse([string]$Target.processStartedAt).UtcDateTime
        return [Math]::Abs(($actualStart - $expectedStart).TotalMilliseconds) -lt 2
    } catch { return $false }
}

function Get-NeisLivePatterns {
    param([System.Windows.Automation.AutomationElement]$Element)
    $patterns = [System.Collections.Generic.List[string]]::new()
    foreach ($entry in @(
        @{ name = 'Invoke'; pattern = [System.Windows.Automation.InvokePattern]::Pattern },
        @{ name = 'SelectionItem'; pattern = [System.Windows.Automation.SelectionItemPattern]::Pattern },
        @{ name = 'Toggle'; pattern = [System.Windows.Automation.TogglePattern]::Pattern },
        @{ name = 'ExpandCollapse'; pattern = [System.Windows.Automation.ExpandCollapsePattern]::Pattern },
        @{ name = 'ScrollItem'; pattern = [System.Windows.Automation.ScrollItemPattern]::Pattern }
    )) {
        $found = $null
        if ($Element.TryGetCurrentPattern($entry.pattern, [ref]$found)) { $patterns.Add($entry.name) }
    }
    return @($patterns)
}

function ConvertTo-NeisControlRecord {
    param([System.Windows.Automation.AutomationElement]$Element)
    $rect = $Element.Current.BoundingRectangle
    $selected = $false; $expanded = $false
    $pattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) { $selected = $pattern.Current.IsSelected }
    $pattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) { $selected = $pattern.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On }
    $pattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) {
        $expanded = $pattern.Current.ExpandCollapseState -in @([System.Windows.Automation.ExpandCollapseState]::Expanded, [System.Windows.Automation.ExpandCollapseState]::LeafNode)
    }
    return [pscustomobject]@{
        name = [string]$Element.Current.Name
        role = ([string]$Element.Current.ControlType.ProgrammaticName).Replace('ControlType.', '')
        className = [string]$Element.Current.ClassName
        processId = [int]$Element.Current.ProcessId
        visible = -not $Element.Current.IsOffscreen
        enabled = [bool]$Element.Current.IsEnabled
        patterns = @(Get-NeisLivePatterns -Element $Element)
        selected = $selected
        expanded = $expanded
        bounds = [pscustomobject]@{ left = $rect.Left; top = $rect.Top; width = $rect.Width; height = $rect.Height }
        element = $Element
    }
}

function Get-NeisControls {
    param([object]$Root)
    if ($Root.PSObject.Properties.Name -contains 'controls') { return @($Root.controls) }
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $button = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    # Work tabs are titled '선택됨, <메뉴>' rather than the bare label, so an exact-name
    # condition never collected them and activeTask could never become true.
    $tab = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
    $names = @($script:NeisTaskLabels.duty, $script:NeisTaskLabels.attendance, $script:NeisTaskLabels.trip) | ForEach-Object {
        [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $_)
    }
    $condition = [System.Windows.Automation.OrCondition]::new(@($button, $tab) + $names)
    $found = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    $records = [System.Collections.Generic.List[object]]::new()
    foreach ($element in $found) { $records.Add((ConvertTo-NeisControlRecord -Element $element)) }
    return @($records)
}

function Find-NeisSemanticControls {
    param([object[]]$Controls, [string]$Kind)
    $label = if ($Kind -like '*attendance*') { $script:NeisTaskLabels.attendance } elseif ($Kind -like '*trip*') { $script:NeisTaskLabels.trip } else { $null }
    $matches = [System.Collections.Generic.List[object]]::new()
    foreach ($control in $Controls) {
        if ($control.enabled -ne $true) { continue }
        $matched = switch -Wildcard ($Kind) {
            'my-menu' { $control.role -ceq 'Button' -and (Test-NeisClassTokens -ClassName $control.className -Tokens @('btn-asd','mymenu')); break }
            'duty' { $control.name -ceq $script:NeisTaskLabels.duty -and $control.role -ceq 'MenuItem' -and (Test-NeisClassTokens -ClassName $control.className -Tokens @('cl-folder','cl-level-1','cl-sidenavigation-item')); break }
            'leaf-*' { $control.name -ceq $label -and $control.role -ceq 'Group' -and (Test-NeisClassTokens -ClassName $control.className -Tokens @('cl-leaf','cl-level-2','cl-sidenavigation-item')); break }
            'tab-*' { $control.name -is [string] -and $control.name.Contains($label) -and $control.role -ceq 'TabItem' -and $control.className -cne 'EdgeTab'; break }
            'heading-*' { $control.name -ceq $label -and $control.role -ceq 'Group' -and (Test-NeisClassTokens -ClassName $control.className -Tokens @('app-tit')); break }
            default { $false }
        }
        if ($matched) { $matches.Add($control) }
    }
    return @($matches)
}

# Arrival still needs the task's own tab, selected, and only that one. The page title was the
# second witness, but it only carries the task name on first open: switching back to a tab that
# is already there leaves the app-tit element unnamed, so the heading vanished while the panel
# was plainly on screen and the walk reported the screen as never reached. The tab's own
# '선택됨, <메뉴>' text is the marker this system is trusted for, so it stands in for the title.
function Test-NeisTaskArrival {
    param([object[]]$Tabs, [object[]]$Headings)
    if ($Tabs.Count -ne 1 -or $Tabs[0].visible -ne $true -or $Tabs[0].selected -ne $true) { return $false }
    if ($Headings.Count -eq 1) { return $true }
    if ($Headings.Count -gt 1) { return $false }
    return ([string]$Tabs[0].name).Contains($script:NeisSelectedMarker)
}

function New-NeisEmptyState {
    return [pscustomobject][ordered]@{ myMenuSelected = $false; dutyExpanded = $false; visibleTasks = @(); existingTaskTabs = @(); activeTask = $null; actions = @() }
}

function Get-NeisTaskState {
    param([Parameter(Mandatory)][object]$Root, [Parameter(Mandatory)][object]$Target)
    if (-not (Test-NeisTargetIdentity -Root $Root -Target $Target)) { return New-NeisEmptyState }
    $controls = @(Get-NeisControls -Root $Root | Where-Object { [int]$_.processId -eq [int]$Target.pid })
    $myMenu = @(Find-NeisSemanticControls -Controls $controls -Kind 'my-menu')
    $duty = @(Find-NeisSemanticControls -Controls $controls -Kind 'duty')
    $attendanceLeaves = @(Find-NeisSemanticControls -Controls $controls -Kind 'leaf-attendance')
    $tripLeaves = @(Find-NeisSemanticControls -Controls $controls -Kind 'leaf-trip')
    $attendanceTabs = @(Find-NeisSemanticControls -Controls $controls -Kind 'tab-attendance')
    $tripTabs = @(Find-NeisSemanticControls -Controls $controls -Kind 'tab-trip')
    $attendanceHeadings = @(Find-NeisSemanticControls -Controls $controls -Kind 'heading-attendance' | Where-Object { $_.visible -eq $true })
    $tripHeadings = @(Find-NeisSemanticControls -Controls $controls -Kind 'heading-trip' | Where-Object { $_.visible -eq $true })
    # The side menu button exposes neither SelectionItem nor Toggle; it marks the active
    # entry with a 'selected' class token, so the pattern check alone never became true and
    # the walk stalled on select-my-menu forever.
    $myMenuSelected = $myMenu.Count -eq 1 -and ($myMenu[0].selected -eq $true -or (Test-NeisClassTokens -ClassName $myMenu[0].className -Tokens @('selected')))
    $dutyExpanded = $duty.Count -eq 1 -and ($duty[0].expanded -eq $true -or @($attendanceLeaves + $tripLeaves | Where-Object { $_.visible -eq $true }).Count -gt 0)
    $visibleTasks = [System.Collections.Generic.List[string]]::new()
    if ($attendanceLeaves.Count -eq 1 -and $attendanceLeaves[0].visible -eq $true) { $visibleTasks.Add('attendance') }
    if ($tripLeaves.Count -eq 1 -and $tripLeaves[0].visible -eq $true) { $visibleTasks.Add('trip') }
    $existingTabs = [System.Collections.Generic.List[string]]::new()
    if ($attendanceTabs.Count -eq 1 -and $attendanceTabs[0].visible -eq $true) { $existingTabs.Add('attendance') }
    if ($tripTabs.Count -eq 1 -and $tripTabs[0].visible -eq $true) { $existingTabs.Add('trip') }
    $active = $null
    if (Test-NeisTaskArrival -Tabs $attendanceTabs -Headings $attendanceHeadings) { $active = 'attendance' }
    if (Test-NeisTaskArrival -Tabs $tripTabs -Headings $tripHeadings) { $active = if ($null -eq $active) { 'trip' } else { $null } }
    # Actions stay available even while one task is already open. Suppressing them whenever
    # anything was active made it impossible to move from 개인근무상황 to 출장: the state
    # reported no actions at all and the walk failed as 'task-unavailable'.
    $actions = [System.Collections.Generic.List[string]]::new()
    if ($attendanceTabs.Count -eq 1 -and $attendanceTabs[0].visible -eq $true -and $attendanceTabs[0].selected -ne $true -and 'SelectionItem' -in @($attendanceTabs[0].patterns)) { $actions.Add('select-attendance-tab') }
    if ($tripTabs.Count -eq 1 -and $tripTabs[0].visible -eq $true -and $tripTabs[0].selected -ne $true -and 'SelectionItem' -in @($tripTabs[0].patterns)) { $actions.Add('select-trip-tab') }
    if ($actions.Count -eq 0 -and -not $myMenuSelected -and $myMenu.Count -eq 1 -and @($myMenu[0].patterns | Where-Object { $_ -in @('SelectionItem','Toggle','Invoke') }).Count -gt 0) { $actions.Add('select-my-menu') }
    elseif ($actions.Count -eq 0 -and -not $dutyExpanded -and $duty.Count -eq 1 -and 'ExpandCollapse' -in @($duty[0].patterns)) { $actions.Add('expand-duty') }
    elseif ($actions.Count -eq 0 -and $myMenuSelected -and $dutyExpanded) {
        # Only offer to open a task that is not already the active one.
        if ($active -cne 'attendance' -and $attendanceLeaves.Count -eq 1 -and 'ScrollItem' -in @($attendanceLeaves[0].patterns)) { $actions.Add('open-attendance') }
        if ($active -cne 'trip' -and $tripLeaves.Count -eq 1 -and 'ScrollItem' -in @($tripLeaves[0].patterns)) { $actions.Add('open-trip') }
    }
    return [pscustomobject][ordered]@{ myMenuSelected = $myMenuSelected; dutyExpanded = $dutyExpanded; visibleTasks = @($visibleTasks); existingTaskTabs = @($existingTabs); activeTask = $active; actions = @($actions) }
}


function Initialize-NeisAccessibilityApi {
    if ('EduDockNeisAccessibility' -as [type]) { return }
    $null = Add-Type -ReferencedAssemblies 'Accessibility' -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Accessibility;

// Edge answers accHitTest from its own accessibility tree, so the question "which element is
// at this point" is about the page, not about the desktop. A messenger toast or a chat window
// sitting over the pixel changes nothing, which is why this replaces the physical click: the
// old guarded click had to own the pixel on screen and silently refused whenever it did not.
public static class EduDockNeisAccessibility {
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr hwnd, EnumProc callback, IntPtr lParam);
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint objectId, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object acc);

  static IntPtr RenderSurface(IntPtr top, int expectedPid) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(top, (hwnd, lParam) => {
      StringBuilder name = new StringBuilder(256);
      GetClassName(hwnd, name, 256);
      if (!name.ToString().Contains("RenderWidgetHost")) return true;
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if ((int)pid != expectedPid) return true;
      found = hwnd; return false;
    }, IntPtr.Zero);
    return found;
  }

  static string NameOf(IAccessible element, int childId) {
    try { return element.get_accName(childId); } catch { return null; }
  }

  // 'ok' only once the element Edge reports at the point carries the label the caller verified
  // through UIA. Every other answer names why nothing was pressed.
  public static string InvokeDefaultAction(IntPtr top, int expectedPid, int x, int y, string expectedName) {
    IntPtr surface = RenderSurface(top, expectedPid);
    if (surface == IntPtr.Zero) return "no-surface";
    Guid iid = new Guid("618736e0-3c3d-11cf-810c-00aa00389b71");
    object raw;
    if (AccessibleObjectFromWindow(surface, 0xFFFFFFFC, ref iid, out raw) != 0 || raw == null) return "no-surface";
    IAccessible root = raw as IAccessible;
    if (root == null) return "no-surface";
    object hit;
    try { hit = root.accHitTest(x, y); } catch { return "hit-failed"; }
    if (hit == null) return "miss";
    IAccessible element = hit as IAccessible;
    int childId = 0;
    if (element == null) {
      try { childId = Convert.ToInt32(hit); element = root; } catch { return "miss"; }
    }
    // The point often lands on an inner node the page leaves unnamed — its own default action
    // reads '상위 개체 클릭' — while the label sits on an ancestor. Only the entry actually
    // carrying the verified label may be pressed, so the chain is walked to find it.
    IAccessible named = null;
    IAccessible walk = element;
    int walkChildId = childId;
    for (int depth = 0; depth < 4 && walk != null; depth++) {
      if (string.Equals(NameOf(walk, walkChildId), expectedName, StringComparison.Ordinal)) { named = walk; break; }
      if (walkChildId != 0) { walkChildId = 0; continue; }
      try { walk = walk.accParent as IAccessible; } catch { walk = null; }
    }
    if (named == null) return "name-mismatch";
    int targetChildId = ReferenceEquals(named, element) ? childId : 0;
    string action;
    try { action = named.get_accDefaultAction(targetChildId); } catch { return "no-action"; }
    if (string.IsNullOrEmpty(action)) return "no-action";
    try { named.accDoDefaultAction(targetChildId); } catch { return "invoke-failed"; }
    return "ok";
  }
}
'@
}

function Invoke-NeisTaskAction {
    param([Parameter(Mandatory)][object]$Root, [Parameter(Mandatory)][object]$Target, [Parameter(Mandatory)][string]$Action)
    if ($Action -cnotin $script:NeisSafeActions) { return [pscustomobject][ordered]@{ status = 'unsafe-action'; action = $Action } }
    if ($Root.PSObject.Properties.Name -contains 'cancelled' -and $Root.cancelled -eq $true) { return [pscustomobject][ordered]@{ status = 'cancelled'; action = $Action } }
    if (-not (Test-NeisTargetIdentity -Root $Root -Target $Target)) { return [pscustomobject][ordered]@{ status = 'unavailable'; action = $Action } }
    $state = Get-NeisTaskState -Root $Root -Target $Target
    if ($Action -cnotin @($state.actions)) { return [pscustomobject][ordered]@{ status = 'unavailable'; action = $Action } }
    $kind = switch ($Action) {
        'select-my-menu' { 'my-menu' }; 'expand-duty' { 'duty' }
        'select-attendance-tab' { 'tab-attendance' }; 'select-trip-tab' { 'tab-trip' }
        'open-attendance' { 'leaf-attendance' }; 'open-trip' { 'leaf-trip' }
    }
    $freshControls = @(Get-NeisControls -Root $Root | Where-Object { [int]$_.processId -eq [int]$Target.pid })
    $fresh = @(Find-NeisSemanticControls -Controls $freshControls -Kind $kind)
    if ($fresh.Count -ne 1 -or -not (Test-NeisTargetIdentity -Root $Root -Target $Target)) { return [pscustomobject][ordered]@{ status = 'unavailable'; action = $Action } }
    $control = $fresh[0]
    if ($Action -like 'select-*-tab' -or $Action -eq 'select-my-menu') {
        $method = if ('SelectionItem' -in @($control.patterns)) { 'SelectionItem' } elseif ('Toggle' -in @($control.patterns)) { 'Toggle' } elseif ('Invoke' -in @($control.patterns)) { 'Invoke' } else { $null }
        if ($null -eq $method) { return [pscustomobject][ordered]@{ status = 'unavailable'; action = $Action } }
        if ($null -ne $control.element) {
            $pattern = $null
            $patternId = if ($method -eq 'SelectionItem') { [System.Windows.Automation.SelectionItemPattern]::Pattern } elseif ($method -eq 'Toggle') { [System.Windows.Automation.TogglePattern]::Pattern } else { [System.Windows.Automation.InvokePattern]::Pattern }
            if (-not $control.element.TryGetCurrentPattern($patternId, [ref]$pattern)) { return [pscustomobject][ordered]@{ status = 'unavailable'; action = $Action } }
            if ($method -eq 'SelectionItem') { $pattern.Select() } elseif ($method -eq 'Toggle') { $pattern.Toggle() } else { $pattern.Invoke() }
        }
        return [pscustomobject][ordered]@{ status = 'invoked'; action = $Action; method = $method }
    }
    if ($Action -eq 'expand-duty') {
        if ('ExpandCollapse' -notin @($control.patterns)) { return [pscustomobject][ordered]@{ status = 'unavailable'; action = $Action } }
        if ($null -ne $control.element) { $pattern = $null; if (-not $control.element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) { return [pscustomobject][ordered]@{ status = 'unavailable'; action = $Action } }; $pattern.Expand() }
        return [pscustomobject][ordered]@{ status = 'invoked'; action = $Action; method = 'ExpandCollapse' }
    }
    if ('ScrollItem' -notin @($control.patterns)) { return [pscustomobject][ordered]@{ status = 'unavailable'; action = $Action } }
    if ($null -ne $control.element -and $control.visible -ne $true) { $scroll = $null; if (-not $control.element.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$scroll)) { return [pscustomobject][ordered]@{ status = 'unavailable'; action = $Action } }; $scroll.ScrollIntoView(); $control = ConvertTo-NeisControlRecord -Element $control.element }
    $bounds = $control.bounds
    if ($null -eq $bounds -or [double]$bounds.width -le 0 -or [double]$bounds.height -le 0) { return [pscustomobject][ordered]@{ status = 'unavailable'; action = $Action } }
    if (-not (Test-NeisTargetIdentity -Root $Root -Target $Target)) { return [pscustomobject][ordered]@{ status = 'unavailable'; action = $Action } }
    if ($Root.PSObject.Properties.Name -contains 'controls') {
        if ([string]$control.pointOwnerHwnd -cne [string]$Target.hwnd) { return [pscustomobject][ordered]@{ status = 'unavailable'; action = $Action } }
    } else {
        # The leaf exposes no Invoke, so opening it used to mean moving the real cursor and
        # clicking the pixel, which Windows only allows when our window owns that pixel. Any
        # overlapping window turned every attempt into 'unavailable' and the walk gave up with
        # 'task-stalled' while the menu sat there, correct and reachable, behind the cover.
        # Edge's own accessibility tree answers for the page rather than the desktop, so the
        # element is pressed where it lives and nothing has to be raised or uncovered.
        Initialize-NeisAccessibilityApi
        $x = [int]([double]$bounds.left + [double]$bounds.width / 2); $y = [int]([double]$bounds.top + [double]$bounds.height / 2)
        $outcome = [EduDockNeisAccessibility]::InvokeDefaultAction([IntPtr]([Int64]$Target.hwnd), [int]$Target.pid, $x, $y, [string]$control.name)
        if ($outcome -cne 'ok') { return [pscustomobject][ordered]@{ status = 'unavailable'; action = $Action; reason = $outcome } }
    }
    return [pscustomobject][ordered]@{ status = 'invoked'; action = $Action; method = 'default-action' }
}
