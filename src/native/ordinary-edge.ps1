param(
    [switch]$Worker,
    [string]$RequestBase64,
    [string]$FixturePath,
    [ValidateRange(500, 10000)][int]$TimeoutMs = 4000
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$neisTaskModule = Join-Path $PSScriptRoot 'neis-tasks.ps1'
if (-not (Test-Path -LiteralPath $neisTaskModule -PathType Leaf)) { throw 'NEIS task module is unavailable.' }
. $neisTaskModule

function Write-BridgeJson {
    param([object]$Value)
    Write-Output -NoEnumerate ($Value | ConvertTo-Json -Depth 9 -Compress)
}

function New-BridgeResult {
    param([string]$Status, [object[]]$Windows = @(), [Nullable[bool]]$Invoked = $null)
    $result = [ordered]@{ status = $Status; windows = @($Windows) }
    if ($null -ne $Invoked) { $result.invoked = [bool]$Invoked }
    return [pscustomobject]$result
}

if (-not $Worker -and [string]::IsNullOrEmpty($RequestBase64)) {
    # Read stdin as UTF-8 explicitly; [Console]::In would decode with the ambient console code page.
    $requestReader = New-Object IO.StreamReader([Console]::OpenStandardInput(), (New-Object Text.UTF8Encoding($false)))
    $requestText = $requestReader.ReadToEnd()
    $RequestBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($requestText))
}

function CodePoints {
    param([int[]]$Values)
    return -join ($Values | ForEach-Object { [char]$_ })
}

$labels = [ordered]@{
    logout = CodePoints @(0xB85C, 0xADF8, 0xC544, 0xC6C3)
    login = (CodePoints @(0xC778, 0xC99D, 0xC11C)) + ' ' + (CodePoints @(0xB85C, 0xADF8, 0xC778))
    portal = CodePoints @(0xC5C5, 0xBB34, 0xD3EC, 0xD138)
    neis = CodePoints @(0xB098, 0xC774, 0xC2A4)
    edufine = 'K-' + (CodePoints @(0xC5D0, 0xB4C0, 0xD30C, 0xC778))
    hardDisk = CodePoints @(0xD558, 0xB4DC, 0xB514, 0xC2A4, 0xD06C)
    removableDisk = CodePoints @(0xC774, 0xB3D9, 0xC2DD, 0xB514, 0xC2A4, 0xD06C)
    documentManagement = CodePoints @(0xBB38, 0xC11C, 0xAD00, 0xB9AC)
    # Session notices seen live: K-에듀파인 '사용시간이 종료되었습니다.' (Nexacro popup KAA0028,
    # 확인 = btnOk) and the portal's SweetAlert2 '세션이 만료되었습니다.' (OK = swal2-confirm).
    usetimeEnded = (CodePoints @(0xC0AC, 0xC6A9, 0xC2DC, 0xAC04, 0xC774)) + ' ' + (CodePoints @(0xC885, 0xB8CC, 0xB418, 0xC5C8, 0xC2B5, 0xB2C8, 0xB2E4))
    sessionExpired = (CodePoints @(0xC138, 0xC158, 0xC774)) + ' ' + (CodePoints @(0xB9CC, 0xB8CC, 0xB418, 0xC5C8, 0xC2B5, 0xB2C8, 0xB2E4))
}
$actionNames = [ordered]@{
    login = @($labels.login)
    portal = @($labels.portal)
    neis = @($labels.neis, 'NEIS')
    edufine = @($labels.edufine)
    'hard-disk' = @($labels.hardDisk)
    'removable-disk' = @($labels.removableDisk)
}
$actionRoles = @('Button', 'Hyperlink', 'TabItem', 'ListItem', 'MenuItem', 'TreeItem', 'RadioButton')
$interactivePatterns = @('Invoke', 'SelectionItem')

function Get-CertificateState {
    param([object]$Window)
    $region = $Window.certificateRegion
    if ($null -eq $region -or $region.verified -ne $true) {
        return [pscustomobject]@{ verified = $false; ambiguous = $false; drives = @(); driveOptions = @(); token = $null; selectedDriveId = $null; rows = @(); rowCount = $null; selectedRowCount = $null; soleRowSelectable = $false }
    }
    $drives = @($region.drives | Where-Object {
        $_.id -is [string] -and $_.id -cmatch '^[A-Z]:$' -and $_.label -is [string] -and
        $_.visible -eq $true -and $_.enabled -eq $true -and [int]$_.processId -eq [int]$Window.pid -and
        @($_.patterns | Where-Object { $_ -in $interactivePatterns }).Count -gt 0
    })
    $duplicateDrive = @($drives | Group-Object id | Where-Object { $_.Count -ne 1 }).Count -gt 0
    $sortedIds = @($drives.id | Sort-Object -Unique)
    $token = if ($sortedIds.Count -gt 0) { $sortedIds -join '|' } else { $null }
    $selectedDrives = @($drives | Where-Object { $_.selected -eq $true })
    $rows = @($region.rows | Where-Object { $_.header -ne $true -and $_.visible -eq $true })
    $selectedRows = @($rows | Where-Object { $_.selected -eq $true })
    $selectableRows = @($rows | Where-Object { $_.selectionAvailable -eq $true })
    return [pscustomobject]@{
        verified = $true
        ambiguous = ($duplicateDrive -or $selectedDrives.Count -gt 1)
        drives = $drives
        driveOptions = @($drives | ForEach-Object { [pscustomobject][ordered]@{ id = [string]$_.id; label = [string]$_.label; selected = ($_.selected -eq $true) } })
        token = $token
        selectedDriveId = if ($selectedDrives.Count -eq 1) { [string]$selectedDrives[0].id } else { $null }
        rows = $rows
        rowCount = $rows.Count
        selectedRowCount = $selectedRows.Count
        soleRowSelectable = ($rows.Count -eq 1 -and $selectedRows.Count -eq 0 -and $selectableRows.Count -eq 1)
    }
}

# A page deeper inside a business system is still that system. Requiring its front page made
# activation fail once the user had navigated on (for example into 공용서식).
function Test-SystemPresence {
    param([object]$Public, [string]$System)
    if ($System -ceq 'portal') { return ($Public.landing -ceq 'portal' -and $Public.authenticated -eq $true) }
    if ($Public.landing -ceq $System) { return $true }
    $origins = @{ neis = 'https://sen.neis.go.kr'; edufine = 'https://klef.sen.go.kr' }
    return ($Public.origin -ceq $origins[$System])
}

function Get-SystemTabState {
    param([object]$Window)
    $tabs = @($Window.systemTabs | Where-Object {
        $_.system -in @('portal', 'neis', 'edufine') -and $_.role -ceq 'TabItem' -and
        $_.className -ceq 'EdgeTab' -and $_.automationId -ceq 'view_24' -and
        $_.visible -eq $true -and $_.enabled -eq $true -and $_.selectionAvailable -eq $true -and
        [int]$_.processId -eq [int]$Window.pid
    })
    $available = [System.Collections.Generic.List[string]]::new()
    foreach ($system in @('portal', 'neis', 'edufine')) {
        if (@($tabs | Where-Object { $_.system -ceq $system }).Count -gt 0) { $available.Add($system) }
    }
    return [pscustomobject]@{ tabs = $tabs; availableSystems = @($available) }
}

# A session notice blocks the page until its one button is pressed. Only the two notices seen
# on the real systems are recognised, each by its own sentence plus its own button, in the
# window's own process; anything else is left for the user.
function Get-SessionNotice {
    param([object]$Window)
    $controls = @($Window.noticeControls | Where-Object { $null -ne $_ -and [int]$_.processId -eq [int]$Window.pid -and $_.visible -eq $true })
    $texts = @($controls | Where-Object { $_.role -ceq 'Text' -and $_.name -is [string] })
    $buttons = @($controls | Where-Object { $_.role -ceq 'Button' -and $_.enabled -eq $true -and 'Invoke' -in @($_.patterns) })
    $usetime = @($texts | Where-Object { $_.name.Contains($labels.usetimeEnded) })
    $okButtons = @($buttons | Where-Object { [string]$_.automationId -clike '*.KAA0028.form.btnOk' })
    if ($usetime.Count -ge 1 -and $okButtons.Count -eq 1) { return [pscustomobject]@{ kind = 'edufine-usetime'; button = $okButtons[0] } }
    $expired = @($texts | Where-Object { $_.name.Contains($labels.sessionExpired) })
    $swal = @($buttons | Where-Object { [string]$_.className -match '(^|\s)swal2-confirm(\s|$)' })
    if ($expired.Count -ge 1 -and $swal.Count -eq 1) { return [pscustomobject]@{ kind = 'portal-session'; button = $swal[0] } }
    return $null
}

function Get-SafeNeisTaskState {
    param([object]$Window, [object]$OriginEvidence, [bool]$LandingVerified)
    if (-not $LandingVerified -or $OriginEvidence.origin -cne 'https://sen.neis.go.kr' -or $OriginEvidence.landingCandidate -cne 'neis') { return $null }
    $root = if ($null -ne $Window.neisTaskRoot) { $Window.neisTaskRoot } else { $Window.uiaRoot }
    if ($null -eq $root) { return $null }
    $target = [pscustomobject]@{ pid = [int]$Window.pid; hwnd = [string]$Window.hwnd; processStartedAt = [string]$Window.processStartedAt; origin = 'https://sen.neis.go.kr' }
    try { $state = Get-NeisTaskState -Root $root -Target $target } catch { return $null }
    [object[]]$visibleTasks = @('attendance', 'trip' | Where-Object { $_ -in @($state.visibleTasks) })
    [object[]]$existingTabs = @('attendance', 'trip' | Where-Object { $_ -in @($state.existingTaskTabs) })
    [object[]]$safeActions = @('select-my-menu','expand-duty','select-attendance-tab','select-trip-tab','open-attendance','open-trip' | Where-Object { $_ -in @($state.actions) })
    return [pscustomobject][ordered]@{
        myMenuSelected = ($state.myMenuSelected -eq $true)
        dutyExpanded = ($state.dutyExpanded -eq $true)
        visibleTasks = $visibleTasks
        existingTaskTabs = $existingTabs
        activeTask = if ($state.activeTask -in @('attendance', 'trip')) { $state.activeTask } else { $null }
        actions = $safeActions
    }
}

# Fixtures state this directly; a real run asks Windows, and only when the interop type has
# actually been loaded, so fixture runs never depend on it.
function Test-ForegroundWindow {
    param([object]$Window)
    if ($null -ne $Window.foreground) { return [bool]$Window.foreground }
    if ($null -eq ('OrdinaryEdgeNativeV1' -as [type])) { return $false }
    try { return ([OrdinaryEdgeNativeV1]::GetForegroundWindow() -eq [IntPtr][int64]$Window.hwnd) } catch { return $false }
}

function Get-OriginEvidence {
    param([object]$Window)
    $rawValues = [System.Collections.Generic.List[string]]::new()
    foreach ($address in @($Window.addressControls)) {
        if ($null -eq $address -or $address.controlType -ne 'Edit' -or $address.isPassword -eq $true -or $address.isOffscreen -eq $true) { continue }
        if ($address.automationId -notin @('view_1021', 'addressEditBox') -and $address.name -notin @(
            (CodePoints @(0xC8FC,0xC18C)) + ' ' + (CodePoints @(0xBC0F)) + ' ' + (CodePoints @(0xAC80,0xC0C9)) + ' ' + (CodePoints @(0xCC3D)),
            (CodePoints @(0xAC80,0xC0C9)) + ' ' + (CodePoints @(0xB610,0xB294)) + ' ' + (CodePoints @(0xC6F9)) + ' ' + (CodePoints @(0xC8FC,0xC18C)) + ' ' + (CodePoints @(0xC785,0xB825)),
            (CodePoints @(0xC8FC,0xC18C)) + ' ' + (CodePoints @(0xD45C,0xC2DC,0xC904)),
            'Address and search bar', 'Search or enter web address', 'Address bar'
        )) { continue }
        if ($address.value -is [string] -and $address.value.Length -gt 0) { $rawValues.Add($address.value) }
        if ($address.legacyValue -is [string] -and $address.legacyValue.Length -gt 0) { $rawValues.Add($address.legacyValue) }
    }
    foreach ($document in @($Window.documents)) {
        if ($null -eq $document -or $document.controlType -ne 'Document' -or $document.isPassword -eq $true -or $document.isOffscreen -eq $true) { continue }
        if ($document.legacyValue -is [string] -and $document.legacyValue.Length -gt 0) { $rawValues.Add($document.legacyValue) }
    }
    $origins = [System.Collections.Generic.List[string]]::new()
    $uris = [System.Collections.Generic.List[Uri]]::new()
    foreach ($raw in $rawValues) {
        $uri = $null
        if ([Uri]::TryCreate($raw, [UriKind]::Absolute, [ref]$uri)) {
            $uris.Add($uri)
            $origin = $uri.GetLeftPart([UriPartial]::Authority).ToLowerInvariant()
            if (-not $origins.Contains($origin)) { $origins.Add($origin) }
        }
    }
    if ($origins.Count -gt 1) { return [pscustomobject]@{ state = 'ambiguous'; origin = $null; landingCandidate = $null } }
    if ($origins.Count -eq 0) { return [pscustomobject]@{ state = 'unavailable'; origin = $null; landingCandidate = $null } }
    $candidate = [Uri]$origins[0]
    if ($candidate.Scheme -ceq 'https' -and $candidate.DnsSafeHost -ceq 'sen.eduptl.kr' -and $candidate.IsDefaultPort) {
        return [pscustomobject]@{ state = 'trusted'; origin = 'https://sen.eduptl.kr'; landingCandidate = 'portal' }
    }
    if ($candidate.Scheme -ceq 'https' -and $candidate.DnsSafeHost -ceq 'sen.neis.go.kr' -and $candidate.IsDefaultPort) {
        $landing = if (@($uris | Where-Object { $_.AbsolutePath -ceq '/jsp/main.jsp' }).Count -gt 0) { 'neis' } else { $null }
        return [pscustomobject]@{ state = 'trusted'; origin = 'https://sen.neis.go.kr'; landingCandidate = $landing }
    }
    if ($candidate.Scheme -ceq 'https' -and $candidate.DnsSafeHost -ceq 'klef.sen.go.kr' -and $candidate.IsDefaultPort) {
        $landing = if (@($uris | Where-Object { $_.AbsolutePath -ceq '/keris_ui/main.do' }).Count -gt 0) { 'edufine' } else { $null }
        return [pscustomobject]@{ state = 'trusted'; origin = 'https://klef.sen.go.kr'; landingCandidate = $landing }
    }
    return [pscustomobject]@{ state = 'unavailable'; origin = $null; landingCandidate = $null }
}

function Test-BusinessLink {
    param([object]$Control, [string]$Action)
    if ($Control.role -cne 'Hyperlink' -or $Control.className -cne 'menuBtn' -or $Control.automationId -isnot [string]) { return $false }
    $uri = $null
    if (-not [Uri]::TryCreate($Control.automationId, [UriKind]::Absolute, [ref]$uri) -or -not $uri.IsDefaultPort) { return $false }
    if ($Action -eq 'neis') {
        return $uri.Scheme -ceq 'https' -and $uri.DnsSafeHost -ceq 'sen.neis.go.kr' -and $uri.AbsolutePath -ceq '/cmc_fcm_lg01_000.do'
    }
    if ($Action -eq 'edufine') {
        return $uri.Scheme -ceq 'http' -and $uri.DnsSafeHost -ceq 'klef.sen.go.kr' -and $uri.AbsolutePath -ceq '/'
    }
    return $false
}

function Get-EligibleControls {
    param([object]$Window, [string]$Action)
    $matches = [System.Collections.Generic.List[object]]::new()
    $names = if ($Action -eq '__logout') { @($labels.logout) } else { @($actionNames[$Action]) }
    foreach ($control in @($Window.controls)) {
        if ($null -eq $control) { continue }
        $selectorMatch = if ($Action -eq 'login') { $control.automationId -ceq 'btnLgn' }
                         elseif ($Action -in @('neis', 'edufine')) { Test-BusinessLink -Control $control -Action $Action }
                         else { $control.name -in $names }
        if (-not $selectorMatch) { continue }
        if ($control.role -notin $actionRoles -or $control.visible -ne $true -or $control.enabled -ne $true) { continue }
        if ([int]$control.processId -ne [int]$Window.pid) { continue }
        if (@($control.patterns | Where-Object { $_ -in $interactivePatterns }).Count -eq 0) { continue }
        $matches.Add($control)
    }
    return @($matches)
}

function Test-AuthenticatedWindow {
    param([object]$Window, [bool]$Trusted, [object]$OriginEvidence)
    if (-not $Trusted) { return $false }
    $portalIdentity = {
        param($control)
        $control.name -ceq 'Logout' -and $control.automationId -ceq 'btn-logout' -and $control.role -ceq 'Hyperlink' -and
        $control.parentRole -ceq 'Document' -and $control.parentAutomationId -ceq 'RootWebArea' -and
        $control.enabled -eq $true -and [int]$control.processId -eq [int]$Window.pid -and 'Invoke' -in @($control.patterns)
    }
    $portalMatches = @($Window.controls | Where-Object { (& $portalIdentity $_) -and $_.visible -eq $true })
    if ($OriginEvidence.origin -ceq 'https://sen.eduptl.kr') {
        if ($portalMatches.Count -eq 1) { return $true }
        # The link can be scrolled or clipped out of the rendered area on a short window. That
        # is not a logged-out portal: a logged-out one offers the certificate login button, and
        # requiring its absence keeps a hidden or stale element from passing as a session.
        $offscreenMatches = @($Window.controls | Where-Object { (& $portalIdentity $_) -and $_.visible -ne $true })
        if ($offscreenMatches.Count -eq 1 -and @(Get-EligibleControls -Window $Window -Action 'login').Count -eq 0) { return $true }
        return $false
    }
    if ($OriginEvidence.origin -ceq 'https://sen.neis.go.kr' -and $OriginEvidence.landingCandidate -eq 'neis') {
        $neisMatches = @($Window.controls | Where-Object {
            $_.name -ceq $labels.logout -and $_.role -ceq 'Button' -and $_.visible -eq $true -and $_.enabled -eq $true -and
            [int]$_.processId -eq [int]$Window.pid -and 'Invoke' -in @($_.patterns)
        })
        return $neisMatches.Count -eq 1
    }
    return $false
}

function Test-LandingWindow {
    param([object]$Window, [object]$OriginEvidence, [bool]$Authenticated)
    if ($OriginEvidence.landingCandidate -in @('portal', 'neis')) { return $Authenticated }
    if ($OriginEvidence.landingCandidate -eq 'edufine') {
        $documents = @($Window.landingMarkers | Where-Object {
            $_.kind -ceq 'document' -and $_.name -ceq $labels.edufine -and $_.automationId -ceq 'RootWebArea' -and
            $_.role -ceq 'Document' -and $_.visible -eq $true -and [int]$_.processId -eq [int]$Window.pid
        })
        $management = @($Window.landingMarkers | Where-Object {
            $_.kind -ceq 'text' -and $_.name -ceq $labels.documentManagement -and $_.role -ceq 'Text' -and
            $_.visible -eq $true -and [int]$_.processId -eq [int]$Window.pid
        })
        return $documents.Count -eq 1 -and $management.Count -ge 1
    }
    return $false
}

function ConvertTo-PublicWindow {
    param([object]$Window, [object]$OriginEvidence)
    $trusted = $OriginEvidence.state -eq 'trusted'
    $authenticated = Test-AuthenticatedWindow -Window $Window -Trusted $trusted -OriginEvidence $OriginEvidence
    $landingVerified = Test-LandingWindow -Window $Window -OriginEvidence $OriginEvidence -Authenticated $authenticated
    $neisTaskState = Get-SafeNeisTaskState -Window $Window -OriginEvidence $OriginEvidence -LandingVerified $landingVerified
    $certificateState = Get-CertificateState -Window $Window
    $systemTabState = Get-SystemTabState -Window $Window
    $availableActions = [System.Collections.Generic.List[string]]::new()
    if ($trusted) {
        foreach ($action in @('login', 'hard-disk', 'removable-disk', 'portal', 'neis', 'edufine')) {
            if ($action -eq 'portal') {
                if ($authenticated) { $availableActions.Add($action) }
            } elseif (@(Get-EligibleControls -Window $Window -Action $action).Count -eq 1) { $availableActions.Add($action) }
        }
        if (-not $certificateState.ambiguous -and $certificateState.drives.Count -gt 0) { $availableActions.Add('select-drive') }
        if (-not $certificateState.ambiguous -and $certificateState.soleRowSelectable) { $availableActions.Add('select-certificate-row') }
    }
    $hard = @(if ($trusted) { Get-EligibleControls -Window $Window -Action 'hard-disk' })
    $removable = @(if ($trusted) { Get-EligibleControls -Window $Window -Action 'removable-disk' })
    # The official store buttons expose no SelectionItemPattern; the live dialog marks the
    # chosen one only through its class name (kc-rbg-pressed vs kc-rbg-normal). Without this
    # selectedStore stayed null, so the hard-disk -> removable-disk fallback never ran.
    $selectedStore = $null
    if ($hard.Count -eq 1 -and ($hard[0].selected -eq $true -or $hard[0].className -ceq 'kc-rbg-pressed')) { $selectedStore = 'hard-disk' }
    if ($removable.Count -eq 1 -and ($removable[0].selected -eq $true -or $removable[0].className -ceq 'kc-rbg-pressed')) { $selectedStore = 'removable-disk' }
    $hardDiskEmpty = $null
    if ($trusted -and $selectedStore -eq 'hard-disk' -and $certificateState.verified -and $certificateState.rowCount -eq 0) { $hardDiskEmpty = $true }
    [object[]]$publicDriveOptions = @()
    if ($trusted) {
        foreach ($option in @($certificateState.driveOptions)) {
            if ($null -ne $option) { $publicDriveOptions += $option }
        }
    }
    $publicWindow = [ordered]@{
        pid = [int]$Window.pid
        hwnd = [string]$Window.hwnd
        processStartedAt = [string]$Window.processStartedAt
        origin = if ($trusted) { $OriginEvidence.origin } else { $null }
        landing = if ($trusted -and $landingVerified) { $OriginEvidence.landingCandidate } else { $null }
        availableSystems = @($systemTabState.availableSystems)
        # Which system's tab is the one on screen. The address bar says the host, but a browser
        # error page keeps the host while the tab loses the system's name, so this separates
        # 'a K-에듀파인 screen the user is working on' from 'a failure on klef.sen.go.kr'.
        selectedSystem = $(if ($trusted) { $showing = @($systemTabState.tabs | Where-Object { $_.selected -eq $true }); if ($showing.Count -eq 1) { $showing[0].system } else { $null } } else { $null })
        sessionNotice = $(if ($trusted) { $notice = Get-SessionNotice -Window $Window; if ($null -ne $notice) { $notice.kind } else { $null } } else { $null })
        authenticated = $authenticated
        # Which window the user is actually looking at, used to break ties when the portal
        # opens more than one window.
        foreground = (Test-ForegroundWindow -Window $Window)
        loginAvailable = (@(Get-EligibleControls -Window $Window -Action 'login').Count -eq 1)
        certificate = [pscustomobject][ordered]@{
            visible = (($hard.Count + $removable.Count) -gt 0)
            hardDiskAvailable = ($hard.Count -eq 1)
            removableAvailable = ($removable.Count -eq 1)
            selectedStore = $selectedStore
            hardDiskEmpty = $hardDiskEmpty
            driveOptions = $publicDriveOptions
            driveOptionsToken = if ($trusted) { $certificateState.token } else { $null }
            selectedDriveId = if ($trusted) { $certificateState.selectedDriveId } else { $null }
            certRowCount = if ($trusted -and $certificateState.verified) { [int]$certificateState.rowCount } else { $null }
            selectedCertRowCount = if ($trusted -and $certificateState.verified) { [int]$certificateState.selectedRowCount } else { $null }
            soleCertRowSelectable = ($trusted -and $certificateState.soleRowSelectable)
        }
        actions = @($availableActions)
    }
    if ($null -ne $neisTaskState) { $publicWindow.neisTaskState = $neisTaskState }
    return [pscustomobject]$publicWindow
}

# Logout is observation-only and never appears in the public action list.
$actionNames['__logout'] = @($labels.logout)

function Read-UiaPatternNames {
    param([System.Windows.Automation.AutomationElement]$Element)
    $names = [System.Collections.Generic.List[string]]::new()
    foreach ($entry in @(
        @{ Name = 'Invoke'; Pattern = [System.Windows.Automation.InvokePattern]::Pattern },
        @{ Name = 'SelectionItem'; Pattern = [System.Windows.Automation.SelectionItemPattern]::Pattern }
    )) {
        $patternObject = $null
        if ($Element.TryGetCurrentPattern($entry.Pattern, [ref]$patternObject)) { $names.Add($entry.Name) }
    }
    return @($names)
}

function Read-LegacyValue {
    param([System.Windows.Automation.AutomationElement]$Element)
    # UIA_LegacyIAccessibleValuePropertyId from the installed Windows SDK.
    $property = [System.Windows.Automation.AutomationProperty]::LookupById(30093)
    if ($null -eq $property) { return $null }
    $value = $Element.GetCurrentPropertyValue($property, $true)
    if ($value -is [string]) { return $value }
    return $null
}

function Get-RealCertificateRegion {
    param([System.Windows.Automation.AutomationElement]$Root, [int]$OwnerPid)
    $groupCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'kc-cert-redisk')
    $groups = @($Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $groupCondition) | Where-Object {
        $_.Current.ProcessId -eq $OwnerPid -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Group -and -not $_.Current.IsOffscreen
    })
    if ($groups.Count -ne 1) { return $null }
    $group = $groups[0]
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $certificateWindow = $group
    while ($null -ne $certificateWindow -and $certificateWindow.Current.ControlType -ne [System.Windows.Automation.ControlType]::Window) {
        $certificateWindow = $walker.GetParent($certificateWindow)
    }
    if ($null -eq $certificateWindow -or $certificateWindow.Current.ProcessId -ne $OwnerPid -or $certificateWindow.Current.ClassName -cne 'kc-dialog kc-widget kc-widget-content kc-corner-all kc-front ui-draggable') { return $null }

    $driveCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)
    $drives = @(
        foreach ($element in $group.FindAll([System.Windows.Automation.TreeScope]::Descendants, $driveCondition)) {
            $rectangle = $element.Current.BoundingRectangle
            if ($element.Current.ProcessId -ne $OwnerPid -or $element.Current.IsOffscreen -or -not $element.Current.IsEnabled -or $rectangle.Width -le 0 -or $rectangle.Height -le 0) { continue }
            $match = [regex]::Match($element.Current.Name, '^(.+?)\s*\(([A-Z]):\)$')
            if (-not $match.Success) { continue }
            $patterns = @(Read-UiaPatternNames -Element $element)
            if (@($patterns | Where-Object { $_ -in $interactivePatterns }).Count -eq 0) { continue }
            $selected = $false
            $selection = $null
            if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) { $selected = $selection.Current.IsSelected }
            [pscustomobject]@{ element = $element; id = ($match.Groups[2].Value + ':'); label = $element.Current.Name; selected = $selected; visible = $true; enabled = $true; patterns = $patterns; processId = $element.Current.ProcessId }
        }
    )

    $gridCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::DataGrid)
    $grids = @($certificateWindow.FindAll([System.Windows.Automation.TreeScope]::Descendants, $gridCondition) | Where-Object { $_.Current.ProcessId -eq $OwnerPid -and -not $_.Current.IsOffscreen })
    if ($grids.Count -ne 1) { return $null }
    $rowCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::DataItem)
    $rows = @(
        foreach ($rowElement in $grids[0].FindAll([System.Windows.Automation.TreeScope]::Children, $rowCondition)) {
            $rectangle = $rowElement.Current.BoundingRectangle
            if ($rowElement.Current.ProcessId -ne $OwnerPid -or $rowElement.Current.IsOffscreen -or $rectangle.Width -le 0 -or $rectangle.Height -le 0) { continue }
            $selectableCells = [System.Collections.Generic.List[object]]::new()
            foreach ($cell in $rowElement.FindAll([System.Windows.Automation.TreeScope]::Children, $rowCondition)) {
                $selection = $null
                if ($cell.Current.ProcessId -eq $OwnerPid -and -not $cell.Current.IsOffscreen -and $cell.Current.IsEnabled -and $cell.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) {
                    $selectableCells.Add([pscustomobject]@{ element = $cell; pattern = $selection; selected = $selection.Current.IsSelected })
                }
            }
            $isHeader = $selectableCells.Count -eq 0
            # The official list marks its chosen row only with this class; SelectionItemPattern
            # reports false on every cell, exactly like the storage buttons do.
            $rowSelected = (@($selectableCells | Where-Object { $_.selected }).Count -gt 0) -or ([string]$rowElement.Current.ClassName -ceq 'kc-tableview-selected-row')
            [pscustomobject]@{
                header = $isHeader; visible = $true; childCellCount = $rowElement.FindAll([System.Windows.Automation.TreeScope]::Children, $rowCondition).Count
                selectableCellCount = $selectableCells.Count; selected = $rowSelected
                selectionAvailable = (-not $isHeader); actionElement = if ($selectableCells.Count -gt 0) { $selectableCells[0].element } else { $null }
            }
        }
    )
    return [pscustomobject]@{ verified = $true; drives = $drives; rows = $rows }
}

function Initialize-EdgeNativeApi {
    $null = Add-Type -AssemblyName UIAutomationClient
    $null = Add-Type -AssemblyName UIAutomationTypes
    if ($null -eq ('OrdinaryEdgeNativeV1' -as [type])) {
        $null = Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OrdinaryEdgeNativeV1 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Explicit, Size = 40)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }
    [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);

    // A background helper is not the foreground process, so Windows ignores a bare
    // SetForegroundWindow; attaching to the current foreground thread lifts that lock.
    public static bool Activate(IntPtr hWnd) {
        if (IsIconic(hWnd)) ShowWindowAsync(hWnd, 9);
        if (GetForegroundWindow() == hWnd) return true;
        uint self = GetCurrentThreadId();
        uint ignored = 0;
        uint owner = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
        bool attached = owner != 0 && owner != self && AttachThreadInput(owner, self, true);
        try { SetForegroundWindow(hWnd); } finally { if (attached) AttachThreadInput(owner, self, false); }
        return GetForegroundWindow() == hWnd;
    }

    // Unicode scan codes, so every character of the password arrives regardless of layout.
    // Keyboard only: the helper never moves or presses the real mouse.
    public static void TypeText(string text) {
        foreach (char c in text) {
            INPUT[] pair = new INPUT[2];
            pair[0].type = 1; pair[0].ki.scan = c; pair[0].ki.flags = 0x0004;
            pair[1].type = 1; pair[1].ki.scan = c; pair[1].ki.flags = 0x0006;
            SendInput(2, pair, Marshal.SizeOf(typeof(INPUT)));
            System.Threading.Thread.Sleep(25);
        }
    }
}
'@
    }
}

# A minimised window renders nothing, so Chromium builds no accessibility tree for it and the
# page simply is not there to read: the NEIS menu walk stalled with '화면이 더 진행되지
# 않았습니다' whenever the teacher had put Edge away. SW_SHOWNOACTIVATE puts the window back on
# screen at its old size WITHOUT giving it the foreground, so the work can proceed while the
# teacher keeps typing wherever they are. Only ever done for the window an operation is already
# bound to; plain discovery stays passive.
function Restore-TargetWindow {
    param([IntPtr]$Handle)
    Initialize-EdgeNativeApi
    if (-not [OrdinaryEdgeNativeV1]::IsWindow($Handle) -or -not [OrdinaryEdgeNativeV1]::IsIconic($Handle)) { return $false }
    $null = [OrdinaryEdgeNativeV1]::ShowWindowAsync($Handle, 4)
    Start-Sleep -Milliseconds 400
    return $true
}

# UI Automation reports a minimised window as offscreen and exposes no page for it, so a
# discovery pass simply did not see the browser: the product then opened the portal again and
# added a tab on every press while the teacher had Edge put away. Restoring without activating
# lets the existing window be found. Only done when a press is actually starting some work.
function Restore-MinimisedEdgeWindows {
    Initialize-EdgeNativeApi
    $restored = 0
    $callback = [OrdinaryEdgeNativeV1+EnumWindowsProc]{
        param([IntPtr]$Handle, [IntPtr]$Unused)
        if (-not [OrdinaryEdgeNativeV1]::IsIconic($Handle)) { return $true }
        $owner = [uint32]0
        $null = [OrdinaryEdgeNativeV1]::GetWindowThreadProcessId($Handle, [ref]$owner)
        $process = Get-Process -Id $owner -ErrorAction SilentlyContinue
        if ($null -ne $process -and $process.ProcessName -ceq 'msedge') {
            $null = [OrdinaryEdgeNativeV1]::ShowWindowAsync($Handle, 4)
            $script:restoredEdgeWindows += 1
        }
        return $true
    }
    $script:restoredEdgeWindows = 0
    $null = [OrdinaryEdgeNativeV1]::EnumWindows($callback, [IntPtr]::Zero)
    $restored = $script:restoredEdgeWindows
    if ($restored -gt 0) { Start-Sleep -Milliseconds 500 }
    return $restored
}

function Get-RealWindows {
    Initialize-EdgeNativeApi
    $handles = [System.Collections.Generic.List[object]]::new()
    $callback = [OrdinaryEdgeNativeV1+EnumWindowsProc]{
        param([IntPtr]$Handle, [IntPtr]$Unused)
        if (-not [OrdinaryEdgeNativeV1]::IsWindowVisible($Handle)) { return $true }
        $owner = [uint32]0
        $null = [OrdinaryEdgeNativeV1]::GetWindowThreadProcessId($Handle, [ref]$owner)
        $process = Get-Process -Id $owner -ErrorAction SilentlyContinue
        if ($null -ne $process -and $process.ProcessName -ceq 'msedge') {
            $handles.Add([pscustomobject]@{ pid = [int]$owner; hwnd = $Handle.ToInt64() })
        }
        return $true
    }
    $null = [OrdinaryEdgeNativeV1]::EnumWindows($callback, [IntPtr]::Zero)

    $windows = [System.Collections.Generic.List[object]]::new()
    foreach ($handle in $handles) {
        $process = Get-Process -Id $handle.pid -ErrorAction SilentlyContinue
        if ($null -eq $process -or $process.ProcessName -cne 'msedge') { continue }
        $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$handle.hwnd)
        if ($null -eq $root -or $root.Current.ProcessId -ne $handle.pid -or $root.Current.IsOffscreen) { continue }

        $addressConditions = [System.Collections.Generic.List[System.Windows.Automation.Condition]]::new()
        foreach ($automationId in @('view_1021', 'addressEditBox')) {
            $idCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $automationId)
            $typeCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
            $addressConditions.Add([System.Windows.Automation.AndCondition]::new($typeCondition, $idCondition))
        }
        foreach ($name in @(
            (CodePoints @(0xC8FC,0xC18C)) + ' ' + (CodePoints @(0xBC0F)) + ' ' + (CodePoints @(0xAC80,0xC0C9)) + ' ' + (CodePoints @(0xCC3D)),
            (CodePoints @(0xAC80,0xC0C9)) + ' ' + (CodePoints @(0xB610,0xB294)) + ' ' + (CodePoints @(0xC6F9)) + ' ' + (CodePoints @(0xC8FC,0xC18C)) + ' ' + (CodePoints @(0xC785,0xB825)),
            (CodePoints @(0xC8FC,0xC18C)) + ' ' + (CodePoints @(0xD45C,0xC2DC,0xC904)),
            'Address and search bar', 'Search or enter web address', 'Address bar'
        )) {
            $nameCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $name)
            $typeCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
            $addressConditions.Add([System.Windows.Automation.AndCondition]::new($typeCondition, $nameCondition))
        }
        $addresses = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.OrCondition]::new($addressConditions.ToArray()))
        $normalizedAddresses = @(
            foreach ($element in $addresses) {
                if ($element.Current.IsPassword -or $element.Current.IsOffscreen) { continue }
                $value = $null
                $valuePattern = $null
                if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) { $value = [string]$valuePattern.Current.Value }
                [pscustomobject]@{
                    automationId = $element.Current.AutomationId; name = $element.Current.Name; controlType = 'Edit'
                    isPassword = $false; isOffscreen = $false; value = $value; legacyValue = (Read-LegacyValue -Element $element)
                }
            }
        )
        $documentCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
        $documents = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $documentCondition)
        $normalizedDocuments = @(
            foreach ($element in $documents) {
                if ($element.Current.IsPassword -or $element.Current.IsOffscreen) { continue }
                [pscustomobject]@{ controlType = 'Document'; isPassword = $false; isOffscreen = $false; legacyValue = (Read-LegacyValue -Element $element) }
            }
        )

        $allNames = @($labels.Values | Select-Object -Unique)
        $allNames += 'Logout'
        $nameConditions = @($allNames | ForEach-Object { [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $_) })
        $nameConditions += [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'btnLgn')
        $nameConditions += [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'btn-logout')
        $nameConditions += [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'menuBtn')
        $controls = @()
        if ($nameConditions.Count -gt 0) {
            $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.OrCondition]::new([System.Windows.Automation.Condition[]]$nameConditions))
            $controls = @(
                foreach ($element in $found) {
                    $rectangle = $element.Current.BoundingRectangle
                    $role = $element.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
                    if ($element.Current.IsPassword -or -not $element.Current.IsEnabled) { continue }
                    # Offscreen elements are kept, marked as such. Chromium reports a control as
                    # offscreen when it is merely scrolled or clipped out of the rendered area,
                    # and the portal's logout link is exactly that on a short window. Dropping it
                    # here made a logged-in portal report 'not authenticated', so the widget sat
                    # at '인증서 창에서 암호를 입력해 주세요' while the teacher was already in.
                    # Everything that acts on a control still demands visible (Get-EligibleControls).
                    $onScreen = (-not $element.Current.IsOffscreen) -and $rectangle.Width -gt 0 -and $rectangle.Height -gt 0
                    $patterns = @(Read-UiaPatternNames -Element $element)
                    if ($patterns.Count -eq 0) { continue }
                    $selected = $false
                    $selection = $null
                    if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) { $selected = $selection.Current.IsSelected }
                    $parent = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($element)
                    [pscustomobject]@{
                        element = $element; automationId = $element.Current.AutomationId; name = $element.Current.Name; className = $element.Current.ClassName; role = $role
                        visible = $onScreen; enabled = $true; patterns = $patterns; processId = $element.Current.ProcessId; selected = $selected
                        parentRole = if ($null -ne $parent) { $parent.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '' } else { $null }
                        parentAutomationId = if ($null -ne $parent) { $parent.Current.AutomationId } else { $null }
                    }
                }
            )
        }
        $landingMarkers = @()
        $documentNameCondition = [System.Windows.Automation.AndCondition]::new(
            [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document),
            [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $labels.edufine)
        )
        foreach ($element in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $documentNameCondition)) {
            if ($element.Current.ProcessId -eq $handle.pid -and -not $element.Current.IsOffscreen) {
                $landingMarkers += [pscustomobject]@{ kind = 'document'; name = $labels.edufine; automationId = $element.Current.AutomationId; role = 'Document'; visible = $true; processId = $element.Current.ProcessId }
            }
        }
        $managementCondition = [System.Windows.Automation.AndCondition]::new(
            [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text),
            [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $labels.documentManagement)
        )
        foreach ($element in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $managementCondition)) {
            $rectangle = $element.Current.BoundingRectangle
            if ($element.Current.ProcessId -eq $handle.pid -and -not $element.Current.IsOffscreen -and $rectangle.Width -gt 0 -and $rectangle.Height -gt 0) {
                $landingMarkers += [pscustomobject]@{ kind = 'text'; name = $labels.documentManagement; automationId = $element.Current.AutomationId; role = 'Text'; visible = $true; processId = $element.Current.ProcessId }
            }
        }
        # Session notices: the sentence (a Text) and its single button, recorded raw here and
        # judged in Get-SessionNotice so fixtures can state the same shape.
        $noticeControls = @()
        $noticeTextCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
        foreach ($element in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $noticeTextCondition)) {
            $text = [string]$element.Current.Name
            if ($element.Current.ProcessId -ne $handle.pid -or -not ($text.Contains($labels.usetimeEnded) -or $text.Contains($labels.sessionExpired))) { continue }
            $noticeControls += [pscustomobject]@{ role = 'Text'; name = $text; className = [string]$element.Current.ClassName; automationId = [string]$element.Current.AutomationId; visible = (-not $element.Current.IsOffscreen); enabled = $true; patterns = @(); processId = $element.Current.ProcessId; element = $null }
        }
        $noticeButtonCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
        foreach ($element in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $noticeButtonCondition)) {
            $automationId = [string]$element.Current.AutomationId
            $className = [string]$element.Current.ClassName
            if ($element.Current.ProcessId -ne $handle.pid -or -not ($automationId -clike '*.KAA0028.form.btnOk' -or $className -match '(^|\s)swal2-confirm(\s|$)')) { continue }
            $noticeControls += [pscustomobject]@{ role = 'Button'; name = [string]$element.Current.Name; className = $className; automationId = $automationId; visible = (-not $element.Current.IsOffscreen); enabled = [bool]$element.Current.IsEnabled; patterns = @(Read-UiaPatternNames -Element $element); processId = $element.Current.ProcessId; element = $element }
        }
        $systemTabs = @()
        $originalSelectedTab = $null
        $tabCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
        $systemTokens = [ordered]@{ portal = $labels.portal; neis = $labels.neis; edufine = $labels.edufine }
        foreach ($element in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCondition)) {
            if ($element.Current.ProcessId -ne $handle.pid -or $element.Current.ClassName -cne 'EdgeTab' -or $element.Current.AutomationId -cne 'view_24') { continue }
            $selection = $null
            if (-not $element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) { continue }
            if ($selection.Current.IsSelected) { $originalSelectedTab = $element }
            $matchedSystems = @($systemTokens.Keys | Where-Object { $element.Current.Name.IndexOf($systemTokens[$_], [StringComparison]::OrdinalIgnoreCase) -ge 0 })
            if ($matchedSystems.Count -ne 1) { continue }
            $rectangle = $element.Current.BoundingRectangle
            $systemTabs += [pscustomobject]@{
                element = $element; system = $matchedSystems[0]; role = 'TabItem'; className = 'EdgeTab'; automationId = 'view_24'
                visible = (-not $element.Current.IsOffscreen -and $rectangle.Width -gt 0 -and $rectangle.Height -gt 0)
                enabled = $element.Current.IsEnabled; selectionAvailable = $true; selected = $selection.Current.IsSelected; processId = $element.Current.ProcessId
            }
        }
        $windows.Add([pscustomobject]@{
            pid = $handle.pid; hwnd = [string]$handle.hwnd; processName = 'msedge'
            processStartedAt = $process.StartTime.ToUniversalTime().ToString('o')
            visible = $true; rootAvailable = $true; rootProcessId = $root.Current.ProcessId
            addressControls = $normalizedAddresses; documents = $normalizedDocuments; controls = $controls
            certificateRegion = (Get-RealCertificateRegion -Root $root -OwnerPid $handle.pid); landingMarkers = $landingMarkers
            systemTabs = $systemTabs; originalSelectedTab = $originalSelectedTab; noticeControls = $noticeControls
            uiaRoot = $root; neisTaskRoot = $null
        })
    }
    return @($windows)
}

function Test-ValidRequest {
    param([object]$Request)
    if ($null -eq $Request -or $Request.command -notin @('inspect', 'invoke')) { return $false }
    $validActions = @($actionNames.Keys | Where-Object { $_ -ne '__logout' }) + @(
        'select-drive', 'select-certificate-row', 'submit-certificate-password', 'activate-system-tab', 'dismiss-session-notice',
        'select-my-menu', 'expand-duty', 'select-attendance-tab', 'select-trip-tab', 'open-attendance', 'open-trip'
    )
    if ($Request.command -eq 'invoke' -and ($Request.action -notin $validActions -or $null -eq $Request.target)) { return $false }
    if ($Request.command -eq 'invoke' -and $null -ne $Request.requireLanding -and $Request.requireLanding -isnot [bool]) { return $false }
    if ($null -ne $Request.restoreMinimised -and $Request.restoreMinimised -isnot [bool]) { return $false }
    if ($Request.command -eq 'invoke' -and $Request.action -eq 'select-drive') {
        if ($Request.driveId -isnot [string] -or $Request.driveId -cnotmatch '^[A-Z]:$' -or $Request.driveOptionsToken -isnot [string] -or $Request.driveOptionsToken.Length -eq 0) { return $false }
    }
    if ($Request.command -eq 'invoke' -and $Request.action -eq 'activate-system-tab' -and $Request.system -notin @('portal', 'neis', 'edufine')) { return $false }
    if ($Request.command -eq 'invoke' -and $Request.action -eq 'submit-certificate-password') {
        if ($Request.password -isnot [string] -or $Request.password.Length -eq 0 -or $Request.password.Length -gt 256) { return $false }
    }
    if ($null -ne $Request.target) {
        if ($Request.target.pid -isnot [int] -and $Request.target.pid -isnot [long]) { return $false }
        if ([int64]$Request.target.pid -le 0 -or $Request.target.hwnd -isnot [string] -or $Request.target.hwnd -notmatch '^\d+$' -or $Request.target.processStartedAt -isnot [string]) { return $false }
    }
    return $true
}

try {
    $requestText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RequestBase64))
    $request = $requestText | ConvertFrom-Json -ErrorAction Stop
    if (-not (Test-ValidRequest -Request $request)) {
        Write-BridgeJson (New-BridgeResult -Status 'error' -Invoked $(if ($request.command -eq 'invoke') { $false } else { $null }))
        exit 0
    }
    if ($FixturePath) {
        $fixture = Get-Content -LiteralPath $FixturePath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
        if ([int]$fixture.delayMs -gt $TimeoutMs) {
            Write-BridgeJson (New-BridgeResult -Status 'cancelled')
            exit 0
        }
        if ([int]$fixture.delayMs -gt 0) { Start-Sleep -Milliseconds ([int]$fixture.delayMs) }
        $windows = @($fixture.windows)
    } else {
        # Once an operation is bound to a window, put it back on screen if the teacher had
        # minimised it — without activating it, so their own window keeps the focus.
        if ($null -ne $request.target) { $null = Restore-TargetWindow -Handle ([IntPtr][int64]$request.target.hwnd) }
        elseif ($request.restoreMinimised -eq $true) { $null = Restore-MinimisedEdgeWindows }
        $windows = @(Get-RealWindows)
    }
    $eligibleWindows = @($windows | Where-Object {
        $_.processName -ceq 'msedge' -and $_.visible -eq $true -and $_.rootAvailable -eq $true -and [int]$_.rootProcessId -eq [int]$_.pid
    })
    if ($null -ne $request.target) {
        $eligibleWindows = @($eligibleWindows | Where-Object {
            [int64]$_.pid -eq [int64]$request.target.pid -and [string]$_.hwnd -ceq [string]$request.target.hwnd -and [string]$_.processStartedAt -ceq [string]$request.target.processStartedAt
        })
        if ($eligibleWindows.Count -ne 1) {
            Write-BridgeJson (New-BridgeResult -Status 'stale' -Invoked $(if ($request.command -eq 'invoke') { $false } else { $null }))
            exit 0
        }
    }
    if ($eligibleWindows.Count -eq 0) {
        Write-BridgeJson (New-BridgeResult -Status 'unavailable' -Invoked $(if ($request.command -eq 'invoke') { $false } else { $null }))
        exit 0
    }
    $evaluated = @(
        foreach ($window in $eligibleWindows) {
            $originEvidence = Get-OriginEvidence -Window $window
            [pscustomobject]@{ raw = $window; origin = $originEvidence; public = (ConvertTo-PublicWindow -Window $window -OriginEvidence $originEvidence) }
        }
    )
    if ($request.command -eq 'inspect') {
        $status = if (@($evaluated | Where-Object { $_.origin.state -eq 'ambiguous' }).Count -gt 0) { 'ambiguous' }
                  elseif (@($evaluated | Where-Object { $_.origin.state -eq 'trusted' }).Count -gt 0) { 'ok' }
                  else { 'unavailable' }
        Write-BridgeJson (New-BridgeResult -Status $status -Windows @($evaluated.public))
        exit 0
    }
    $evaluation = $evaluated[0]
    if ($request.action -eq 'activate-system-tab') {
        $tabState = Get-SystemTabState -Window $evaluation.raw
        $tabMatches = @($tabState.tabs | Where-Object { $_.system -ceq $request.system })
        if ($evaluation.raw.cancelledBeforeActivation -eq $true) {
            Write-BridgeJson (New-BridgeResult -Status 'cancelled' -Windows @($evaluation.public) -Invoked $false)
            exit 0
        }
        if ($tabMatches.Count -eq 0) {
            Write-BridgeJson (New-BridgeResult -Status 'unavailable' -Windows @($evaluation.public) -Invoked $false)
            exit 0
        }
        # The portal opens itself in extra tabs over time (every launch used to add one), so
        # several tabs of the same system are normal, not ambiguous: the one already showing
        # wins, otherwise the leftmost.
        $selectedTab = @($tabMatches | Where-Object { $_.selected -eq $true }) | Select-Object -First 1
        if ($null -eq $selectedTab) { $selectedTab = $tabMatches[0] }
        # requireLanding=false only switches to the tab: used to get back to a portal tab that
        # may be logged out or showing a session notice, where landing cannot be verified yet.
        $requireLanding = ($request.requireLanding -ne $false)
        # Bringing the window forward is best effort only. The user may be typing somewhere
        # else while the task runs, and Windows then keeps the foreground where it is; the tab
        # is still selected and the landing still verified, so the task must not fail on that.
        if ($FixturePath) {
            $postRaw = $evaluation.raw
            if ($selectedTab.selected -ne $true) {
                $resultProperty = $evaluation.raw.activationResults.PSObject.Properties[$request.system]
                if ($null -eq $resultProperty) {
                    Write-BridgeJson (New-BridgeResult -Status 'unavailable' -Windows @($evaluation.public) -Invoked $false)
                    exit 0
                }
                $postRaw = $resultProperty.Value
            }
            if ([int]$postRaw.pid -ne [int]$request.target.pid -or [string]$postRaw.hwnd -cne [string]$request.target.hwnd -or [string]$postRaw.processStartedAt -cne [string]$request.target.processStartedAt) {
                Write-BridgeJson (New-BridgeResult -Status 'stale' -Windows @() -Invoked $false)
                exit 0
            }
            $postOrigin = Get-OriginEvidence -Window $postRaw
            $postPublic = ConvertTo-PublicWindow -Window $postRaw -OriginEvidence $postOrigin
            if ($requireLanding -and -not (Test-SystemPresence -Public $postPublic -System $request.system)) {
                Write-BridgeJson (New-BridgeResult -Status 'unavailable' -Windows @($postPublic) -Invoked $false)
                exit 0
            }
            Write-BridgeJson (New-BridgeResult -Status 'ok' -Windows @($postPublic) -Invoked $true)
            exit 0
        }
        $restoreElement = $evaluation.raw.originalSelectedTab
        $selectionChanged = $false
        if ($selectedTab.selected -ne $true) {
            $selectionPattern = $null
            if ($null -eq $selectedTab.element -or -not $selectedTab.element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selectionPattern)) {
                Write-BridgeJson (New-BridgeResult -Status 'unavailable' -Windows @($evaluation.public) -Invoked $false)
                exit 0
            }
            $selectionPattern.Select()
            $selectionChanged = $true
            Start-Sleep -Milliseconds 150
        }
        $targetHandle = [IntPtr]([int64]$request.target.hwnd)
        if (-not [OrdinaryEdgeNativeV1]::IsWindow($targetHandle)) {
            Write-BridgeJson (New-BridgeResult -Status 'stale' -Windows @() -Invoked $false)
            exit 0
        }
        # A background helper cannot raise a window with a bare SetForegroundWindow; Activate
        # attaches to the foreground thread first. Its outcome is reported (window.foreground),
        # never required: the user working in another window must not break the task.
        $null = [OrdinaryEdgeNativeV1]::Activate($targetHandle)
        # Switching an Edge tab is asynchronous: the address bar still reported the previous
        # tab's page when it was read once, 150 ms after the click, and a perfectly good switch
        # came back 'unavailable'. Give the browser a moment, re-reading until it agrees.
        $postWindows = @()
        $postPublic = $null
        $landingOk = $false
        $presenceDeadline = [DateTime]::UtcNow.AddSeconds(4)
        while ($true) {
            $postWindows = @(Get-RealWindows | Where-Object {
                [int64]$_.pid -eq [int64]$request.target.pid -and [string]$_.hwnd -ceq [string]$request.target.hwnd -and [string]$_.processStartedAt -ceq [string]$request.target.processStartedAt
            })
            if ($postWindows.Count -eq 1) {
                $postOrigin = Get-OriginEvidence -Window $postWindows[0]
                $postPublic = ConvertTo-PublicWindow -Window $postWindows[0] -OriginEvidence $postOrigin
                $landingOk = (-not $requireLanding) -or (Test-SystemPresence -Public $postPublic -System $request.system)
            }
            if ($landingOk -or [DateTime]::UtcNow -ge $presenceDeadline) { break }
            Start-Sleep -Milliseconds 300
        }
        if (-not $landingOk) {
            if ($selectionChanged -and $null -ne $restoreElement) {
                $restorePattern = $null
                if ($restoreElement.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$restorePattern)) { $restorePattern.Select() }
            }
            $failureStatus = if ($postWindows.Count -eq 0) { 'stale' } else { 'unavailable' }
            Write-BridgeJson (New-BridgeResult -Status $failureStatus -Windows $(if ($null -ne $postPublic) { @($postPublic) } else { @() }) -Invoked $false)
            exit 0
        }
        Write-BridgeJson (New-BridgeResult -Status 'ok' -Windows @($postPublic) -Invoked $true)
        exit 0
    }
    if ($evaluation.origin.state -eq 'ambiguous') {
        Write-BridgeJson (New-BridgeResult -Status 'ambiguous' -Windows @($evaluation.public) -Invoked $false)
        exit 0
    }
    if ($evaluation.origin.state -ne 'trusted') {
        Write-BridgeJson (New-BridgeResult -Status 'unavailable' -Windows @($evaluation.public) -Invoked $false)
        exit 0
    }
    if ($request.action -eq 'dismiss-session-notice') {
        $notice = Get-SessionNotice -Window $evaluation.raw
        if ($null -eq $notice) {
            Write-BridgeJson (New-BridgeResult -Status 'unavailable' -Windows @($evaluation.public) -Invoked $false)
            exit 0
        }
        if (-not $FixturePath) {
            # The button is pressed through its own Invoke pattern: no cursor, no foreground.
            $noticePattern = $null
            if ($null -eq $notice.button.element -or -not $notice.button.element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$noticePattern)) {
                Write-BridgeJson (New-BridgeResult -Status 'unavailable' -Windows @($evaluation.public) -Invoked $false)
                exit 0
            }
            $noticePattern.Invoke()
        }
        $dismissed = New-BridgeResult -Status 'ok' -Windows @($evaluation.public) -Invoked $true
        $dismissed | Add-Member -NotePropertyName 'notice' -NotePropertyValue $notice.kind
        Write-BridgeJson $dismissed
        exit 0
    }
    $neisActions = @('select-my-menu','expand-duty','select-attendance-tab','select-trip-tab','open-attendance','open-trip')
    if ($request.action -in $neisActions) {
        $freshRaw = $evaluation.raw
        $freshPublic = $evaluation.public
        if (-not $FixturePath) {
            $freshWindows = @(Get-RealWindows | Where-Object {
                [int64]$_.pid -eq [int64]$request.target.pid -and [string]$_.hwnd -ceq [string]$request.target.hwnd -and [string]$_.processStartedAt -ceq [string]$request.target.processStartedAt
            })
            if ($freshWindows.Count -ne 1) {
                Write-BridgeJson (New-BridgeResult -Status 'stale' -Windows @() -Invoked $false)
                exit 0
            }
            $freshRaw = $freshWindows[0]
            $freshOrigin = Get-OriginEvidence -Window $freshRaw
            $freshPublic = ConvertTo-PublicWindow -Window $freshRaw -OriginEvidence $freshOrigin
        }
        if ($freshPublic.origin -cne 'https://sen.neis.go.kr' -or $freshPublic.landing -cne 'neis' -or $null -eq $freshPublic.neisTaskState) {
            Write-BridgeJson (New-BridgeResult -Status 'unavailable' -Windows @($freshPublic) -Invoked $false)
            exit 0
        }
        $taskRoot = if ($null -ne $freshRaw.neisTaskRoot) { $freshRaw.neisTaskRoot } else { $freshRaw.uiaRoot }
        $taskTarget = [pscustomobject]@{ pid = [int]$freshRaw.pid; hwnd = [string]$freshRaw.hwnd; processStartedAt = [string]$freshRaw.processStartedAt; origin = 'https://sen.neis.go.kr' }
        $taskResult = Invoke-NeisTaskAction -Root $taskRoot -Target $taskTarget -Action $request.action
        $mappedStatus = switch ($taskResult.status) { 'invoked' { 'ok' }; 'cancelled' { 'cancelled' }; default { 'unavailable' } }
        Write-BridgeJson (New-BridgeResult -Status $mappedStatus -Windows @($freshPublic) -Invoked ($taskResult.status -eq 'invoked'))
        exit 0
    }
    if ($request.action -eq 'portal') {
        if (-not $evaluation.public.authenticated) {
            Write-BridgeJson (New-BridgeResult -Status 'unavailable' -Windows @($evaluation.public) -Invoked $false)
            exit 0
        }
        if ($evaluation.raw.cancelledBeforeActivation -eq $true) {
            Write-BridgeJson (New-BridgeResult -Status 'cancelled' -Windows @($evaluation.public) -Invoked $false)
            exit 0
        }
        if ($FixturePath) {
            if ($evaluation.raw.foregroundActivationResult -eq $true -and $evaluation.raw.foregroundAfter -eq $true) {
                Write-BridgeJson (New-BridgeResult -Status 'ok' -Windows @($evaluation.public) -Invoked $true)
            } else {
                Write-BridgeJson (New-BridgeResult -Status 'unavailable' -Windows @($evaluation.public) -Invoked $false)
            }
            exit 0
        }
        $targetHandle = [IntPtr]([int64]$request.target.hwnd)
        if (-not [OrdinaryEdgeNativeV1]::IsWindow($targetHandle)) {
            Write-BridgeJson (New-BridgeResult -Status 'stale' -Windows @() -Invoked $false)
            exit 0
        }
        if (-not [OrdinaryEdgeNativeV1]::Activate($targetHandle)) {
            Write-BridgeJson (New-BridgeResult -Status 'unavailable' -Windows @($evaluation.public) -Invoked $false)
            exit 0
        }
        $postWindows = @(Get-RealWindows | Where-Object {
            [int64]$_.pid -eq [int64]$request.target.pid -and [string]$_.hwnd -ceq [string]$request.target.hwnd -and [string]$_.processStartedAt -ceq [string]$request.target.processStartedAt
        })
        if ($postWindows.Count -ne 1) {
            Write-BridgeJson (New-BridgeResult -Status 'stale' -Windows @() -Invoked $false)
            exit 0
        }
        $postOrigin = Get-OriginEvidence -Window $postWindows[0]
        $postPublic = ConvertTo-PublicWindow -Window $postWindows[0] -OriginEvidence $postOrigin
        if ($postOrigin.state -ne 'trusted' -or -not $postPublic.authenticated -or [OrdinaryEdgeNativeV1]::GetForegroundWindow() -ne $targetHandle) {
            Write-BridgeJson (New-BridgeResult -Status 'unavailable' -Windows @($postPublic) -Invoked $false)
            exit 0
        }
        Write-BridgeJson (New-BridgeResult -Status 'ok' -Windows @($postPublic) -Invoked $true)
        exit 0
    }
    if ($request.action -eq 'submit-certificate-password') {
        $certificateState = Get-CertificateState -Window $evaluation.raw
        if (-not $certificateState.verified -or $certificateState.ambiguous) {
            Write-BridgeJson (New-BridgeResult -Status 'unavailable' -Windows @($evaluation.public) -Invoked $false)
            exit 0
        }
        # Only type into a dialog that already has exactly one certificate chosen.
        if ([int]$certificateState.selectedRowCount -ne 1) {
            Write-BridgeJson (New-BridgeResult -Status 'unavailable' -Windows @($evaluation.public) -Invoked $false)
            exit 0
        }
        $secret = [string]$request.password
        if ([string]::IsNullOrEmpty($secret) -or $secret.Length -gt 256) {
            Write-BridgeJson (New-BridgeResult -Status 'error' -Invoked $false)
            exit 0
        }
        $root = $evaluation.raw.uiaRoot
        $field = $null
        $confirm = $null
        if ($null -ne $root) {
            foreach ($element in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'kc-pw-box'))) {
                if ($element.Current.ProcessId -eq [int]$evaluation.raw.pid -and $element.Current.IsPassword -and -not $element.Current.IsOffscreen -and $element.Current.IsEnabled) { $field = $element }
            }
            foreach ($element in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'kc-btn-blue'))) {
                if ($element.Current.ProcessId -eq [int]$evaluation.raw.pid -and -not $element.Current.IsOffscreen -and $element.Current.IsEnabled) { $confirm = $element }
            }
        }
        if ($null -eq $field -or $null -eq $confirm) {
            Write-BridgeJson (New-BridgeResult -Status 'unavailable' -Windows @($evaluation.public) -Invoked $false)
            exit 0
        }
        $targetHandle = [IntPtr]([int64]$request.target.hwnd)
        $box = $field.Current.BoundingRectangle
        if ($box.Width -le 0 -or $box.Height -le 0) {
            Write-BridgeJson (New-BridgeResult -Status 'unavailable' -Windows @($evaluation.public) -Invoked $false)
            exit 0
        }
        $valuePattern = $null
        if (-not $field.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
            Write-BridgeJson (New-BridgeResult -Status 'unavailable' -Windows @($evaluation.public) -Invoked $false)
            exit 0
        }
        # The secret goes in through the page's accessibility bridge: the field is focused and
        # given its value without the real cursor moving or a pixel of the dialog having to be
        # uncovered. The old click-and-type refused whenever anything overlapped the box.
        $method = 'value-pattern'
        $typed = -1
        try {
            $field.SetFocus()
            Start-Sleep -Milliseconds 80
            $valuePattern.SetValue($secret)
            Start-Sleep -Milliseconds 150
            $typed = [int]$valuePattern.Current.Value.Length
        } catch { $typed = -1 }
        if ($typed -ne $secret.Length) {
            # Some password boxes only accept real key events. The field already holds keyboard
            # focus, so the characters are typed into it; still no mouse involved.
            $method = 'keyboard'
            if (-not [OrdinaryEdgeNativeV1]::Activate($targetHandle)) {
                Write-BridgeJson (New-BridgeResult -Status 'unavailable' -Windows @($evaluation.public) -Invoked $false)
                exit 0
            }
            try { $field.SetFocus() } catch {}
            Start-Sleep -Milliseconds 80
            try { if ([int]$valuePattern.Current.Value.Length -gt 0) { $valuePattern.SetValue('') } } catch {}
            [OrdinaryEdgeNativeV1]::TypeText($secret)
            Start-Sleep -Milliseconds 150
            try { $typed = [int]$valuePattern.Current.Value.Length } catch { $typed = -1 }
        }
        # Verify the field really took the whole secret before committing; never echo it.
        if ($typed -ne $secret.Length) {
            Write-BridgeJson (New-BridgeResult -Status 'unavailable' -Windows @($evaluation.public) -Invoked $false)
            exit 0
        }
        $confirmPattern = $null
        if (-not $confirm.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$confirmPattern)) {
            Write-BridgeJson (New-BridgeResult -Status 'unavailable' -Windows @($evaluation.public) -Invoked $false)
            exit 0
        }
        $confirmPattern.Invoke()
        $submitted = New-BridgeResult -Status 'ok' -Windows @($evaluation.public) -Invoked $true
        $submitted | Add-Member -NotePropertyName 'method' -NotePropertyValue $method
        Write-BridgeJson $submitted
        exit 0
    }
    if ($request.action -in @('select-drive', 'select-certificate-row')) {
        $certificateState = Get-CertificateState -Window $evaluation.raw
        if (-not $certificateState.verified) {
            Write-BridgeJson (New-BridgeResult -Status 'unavailable' -Windows @($evaluation.public) -Invoked $false)
            exit 0
        }
        if ($certificateState.ambiguous) {
            Write-BridgeJson (New-BridgeResult -Status 'ambiguous' -Windows @($evaluation.public) -Invoked $false)
            exit 0
        }
        if ($request.action -eq 'select-drive') {
            if ($request.driveOptionsToken -cne $certificateState.token) {
                Write-BridgeJson (New-BridgeResult -Status 'stale' -Windows @($evaluation.public) -Invoked $false)
                exit 0
            }
            $driveMatches = @($certificateState.drives | Where-Object { $_.id -ceq $request.driveId })
            if ($driveMatches.Count -eq 0) {
                Write-BridgeJson (New-BridgeResult -Status 'stale' -Windows @($evaluation.public) -Invoked $false)
                exit 0
            }
            if ($driveMatches.Count -ne 1) {
                Write-BridgeJson (New-BridgeResult -Status 'ambiguous' -Windows @($evaluation.public) -Invoked $false)
                exit 0
            }
            if (-not $FixturePath) {
                $drive = $driveMatches[0]
                $drivePattern = $null
                if ('Invoke' -in @($drive.patterns) -and $drive.element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$drivePattern)) { $drivePattern.Invoke() }
                elseif ('SelectionItem' -in @($drive.patterns) -and $drive.element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$drivePattern)) { $drivePattern.Select() }
                else {
                    Write-BridgeJson (New-BridgeResult -Status 'unavailable' -Windows @($evaluation.public) -Invoked $false)
                    exit 0
                }
            }
            Write-BridgeJson (New-BridgeResult -Status 'ok' -Windows @($evaluation.public) -Invoked $true)
            exit 0
        }
        if (-not $certificateState.soleRowSelectable) {
            Write-BridgeJson (New-BridgeResult -Status 'unavailable' -Windows @($evaluation.public) -Invoked $false)
            exit 0
        }
        $row = $certificateState.rows[0]
        if (-not $FixturePath) {
            $rowPattern = $null
            if ($null -eq $row.actionElement -or -not $row.actionElement.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$rowPattern)) {
                Write-BridgeJson (New-BridgeResult -Status 'unavailable' -Windows @($evaluation.public) -Invoked $false)
                exit 0
            }
            $rowPattern.Select()
        }
        Write-BridgeJson (New-BridgeResult -Status 'ok' -Windows @($evaluation.public) -Invoked $true)
        exit 0
    }
    $matches = @(Get-EligibleControls -Window $evaluation.raw -Action $request.action)
    if ($matches.Count -gt 1) {
        Write-BridgeJson (New-BridgeResult -Status 'ambiguous' -Windows @($evaluation.public) -Invoked $false)
        exit 0
    }
    if ($matches.Count -eq 0) {
        Write-BridgeJson (New-BridgeResult -Status 'unavailable' -Windows @($evaluation.public) -Invoked $false)
        exit 0
    }
    if (-not $FixturePath) {
        $match = $matches[0]
        $pattern = $null
        if ('Invoke' -in @($match.patterns) -and $match.element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
            $pattern.Invoke()
        } elseif ('SelectionItem' -in @($match.patterns) -and $match.element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
            $pattern.Select()
        } else {
            Write-BridgeJson (New-BridgeResult -Status 'unavailable' -Windows @($evaluation.public) -Invoked $false)
            exit 0
        }
    }
    Write-BridgeJson (New-BridgeResult -Status 'ok' -Windows @($evaluation.public) -Invoked $true)
} catch {
    Write-BridgeJson (New-BridgeResult -Status 'error')
}
