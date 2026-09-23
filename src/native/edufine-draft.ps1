param(
    [string]$FixturePath,
    [switch]$Worker,
    [string]$RequestBase64,
    [ValidateRange(500, 30000)][int]$TimeoutMs = 8000
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Text-FromCodePoints {
    param([int[]]$Values)
    return -join ($Values | ForEach-Object { [char]$_ })
}

$expectedCaption = (Text-FromCodePoints @(0xC77C,0xBC18,0xAE30,0xC548,0xBB38)) + ' ' +
    (Text-FromCodePoints @(0xC11C,0xC2DD)) + '(' +
    (Text-FromCodePoints @(0xACB0,0xC7AC)) + '4' + (Text-FromCodePoints @(0xC778)) + ',' +
    (Text-FromCodePoints @(0xD611,0xC870)) + '4' + (Text-FromCodePoints @(0xC778)) + ')'
$generalDraftTitle = Text-FromCodePoints @(0xC77C,0xBC18,0xAE30,0xC548,0xBB38)
$draftLabel = Text-FromCodePoints @(0xAE30,0xC548)
$publicFormLabel = Text-FromCodePoints @(0xACF5,0xC6A9,0xC11C,0xC2DD)
$requiredMarkers = @('Shell Embedding', 'Shell DocObject View', 'Internet Explorer_Server', 'AfxOleControl120u', 'HwpMainEditWnd')
$expectedProcessPath = 'C:\Program Files (x86)\kedu\WXSClient.exe'

function Write-Result {
    param([object]$Value)
    Write-Output -NoEnumerate ($Value | ConvertTo-Json -Depth 8 -Compress)
}

function New-Result {
    param([string]$Status = 'ok', [object[]]$Editors = @())
    return [ordered]@{ status = $Status; editors = @($Editors) }
}

function Public-Editor {
    param([object]$Value)
    return [pscustomobject][ordered]@{
        pid = [int]$Value.pid
        hwnd = [string]$Value.hwnd
        processStartedAt = [string]$Value.processStartedAt
        processPath = [string]$Value.processPath
        title = [string]$Value.title
        markers = @($Value.markers | ForEach-Object { [string]$_ })
        documentState = if ([string]$Value.documentState -in @('blank','nonblank','unknown','closed')) { [string]$Value.documentState } else { 'unknown' }
        dialogOpen = ($Value.dialogOpen -eq $true)
        dialogKind = if ([string]$Value.dialogKind -in @('autosave', 'close-other')) { [string]$Value.dialogKind } else { $null }
        identityReused = ($Value.identityReused -eq $true)
    }
}

function Read-Fixture {
    if ([string]::IsNullOrWhiteSpace($FixturePath)) { return $null }
    $resolved = (Resolve-Path -LiteralPath $FixturePath).Path
    return [IO.File]::ReadAllText($resolved, [Text.Encoding]::UTF8) | ConvertFrom-Json
}

function Load-Uia {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
}

function Load-ChildWindowApi {
    if (-not ('EduDockDraftChildWindows' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class EduDockDraftChildWindows {
    private delegate bool EnumProc(IntPtr handle, IntPtr param);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr param);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr handle, StringBuilder text, int max);
    public static string[] ClassNames(IntPtr parent) {
        List<string> names = new List<string>();
        EnumChildWindows(parent, delegate(IntPtr handle, IntPtr param) {
            StringBuilder builder = new StringBuilder(256);
            if (GetClassName(handle, builder, builder.Capacity) > 0) names.Add(builder.ToString());
            return true;
        }, IntPtr.Zero);
        return names.ToArray();
    }
}
'@
    }
}

function Get-DescendantByAutomationId {
    param([System.Windows.Automation.AutomationElement]$Root, [string]$AutomationId)
    $condition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $AutomationId)
    return @($Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition))
}

# The autosave prompt is a real Win32 dialog (#32770 '웹 페이지 메시지') owned by the editor.
# Walking the editor's UI Automation tree to find it cost 26 seconds and the click that
# followed timed out at 60, because the editor bridges a 1,000-element IE document into that
# tree. Plain window enumeration answers the same question in about 30 milliseconds.
#
# A second prompt appears when a form is opened while another editor is already running:
# '열려있는 기안/결재기를 닫습니다.' [확인][취소]. 확인 would close the user's own editor, so it is
# never pressed; 취소 keeps that editor and still lets the new one open (observed live).
function Find-AutosaveDialog {
    param([int]$ProcessId, [object[]]$TopLevel)
    Load-ProcessWindowApi
    # Enumerating every top-level window costs a full desktop walk, so an inspect that looks at
    # several editors does it once and hands the result in.
    if ($null -eq $TopLevel) { $TopLevel = @([EduDockProcessWindows]::TopLevel($ProcessId)) }
    $autosaveSentence = Text-FromCodePoints @(0xC790,0xB3D9,0xC800,0xC7A5,0xBB38,0xC11C)   # 자동저장문서
    $closeSentence = (Text-FromCodePoints @(0xC5F4,0xB824,0xC788,0xB294)) + ' ' + (Text-FromCodePoints @(0xAE30,0xC548)) + '/' + (Text-FromCodePoints @(0xACB0,0xC7AC,0xAE30,0xB97C)) + ' ' + (Text-FromCodePoints @(0xB2EB,0xC2B5,0xB2C8,0xB2E4))   # 열려있는 기안/결재기를 닫습니다
    $cancelLabel = Text-FromCodePoints @(0xCDE8,0xC18C)                             # 취소
    $confirmLabel = Text-FromCodePoints @(0xD655,0xC778)                            # 확인
    foreach ($window in $TopLevel) {
        if ([EduDockProcessWindows]::ClassOf($window) -cne '#32770') { continue }
        $kind = $null
        $cancelButton = [IntPtr]::Zero
        $confirmButton = [IntPtr]::Zero
        foreach ($child in [EduDockProcessWindows]::Children($window)) {
            $class = [EduDockProcessWindows]::ClassOf($child)
            $text = [EduDockProcessWindows]::Title($child)
            if ($class -ceq 'Static' -and $text -is [string]) {
                if ($text.Contains($autosaveSentence)) { $kind = 'autosave' }
                elseif ($text.Contains($closeSentence)) { $kind = 'close-other' }
            }
            if ($class -ceq 'Button' -and $text.Trim() -ceq $cancelLabel) { $cancelButton = $child }
            if ($class -ceq 'Button' -and $text.Trim() -ceq $confirmLabel) { $confirmButton = $child }
        }
        # Both buttons and one of the two known sentences must be present; never a generic box.
        if ($null -ne $kind -and $cancelButton -ne [IntPtr]::Zero -and $confirmButton -ne [IntPtr]::Zero) {
            return [pscustomobject]@{ window = $window; cancel = $cancelButton; kind = $kind }
        }
    }
    return $null
}

function Load-ProcessWindowApi {
    if ('EduDockProcessWindows' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class EduDockProcessWindows {
    private delegate bool EnumProc(IntPtr handle, IntPtr param);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr param);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLength(IntPtr handle);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr handle, StringBuilder text, int max);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr param);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(IntPtr handle, uint message, IntPtr w, StringBuilder l, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")] private static extern IntPtr SendMessageTimeout(IntPtr handle, uint message, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
    // GetWindowText reads a top-level caption without waiting, but on a CHILD control of
    // another process it sends WM_GETTEXT and blocks until that process pumps messages. The
    // editor stops pumping while it loads the HWP document, so reading its dialog's labels
    // wedged the whole inspect until the caller's timeout. SMTO_ABORTIFHUNG returns instead.
    public static string Title(IntPtr handle) {
        StringBuilder builder = new StringBuilder(2048);
        IntPtr ignored;
        // 0x000D = WM_GETTEXT, flags 0x0002 = SMTO_ABORTIFHUNG.
        if (SendMessageTimeout(handle, 0x000D, new IntPtr(builder.Capacity), builder, 0x0002, 400, out ignored) == IntPtr.Zero) {
            GetWindowText(handle, builder, builder.Capacity);
        }
        return builder.ToString();
    }
    public static string ClassOf(IntPtr handle) {
        StringBuilder builder = new StringBuilder(256);
        GetClassName(handle, builder, builder.Capacity);
        return builder.ToString();
    }
    public static IntPtr[] TopLevel(int processId) {
        List<IntPtr> found = new List<IntPtr>();
        EnumWindows(delegate(IntPtr handle, IntPtr param) {
            uint owner;
            GetWindowThreadProcessId(handle, out owner);
            if ((int)owner == processId && IsWindowVisible(handle)) found.Add(handle);
            return true;
        }, IntPtr.Zero);
        return found.ToArray();
    }
    // One desktop walk for every process at once: "<pid>|<hwnd>" per visible top-level window.
    // Inspecting five editors used to mean five full enumerations.
    public static string[] AllTopLevel() {
        List<string> found = new List<string>();
        EnumWindows(delegate(IntPtr handle, IntPtr param) {
            uint owner;
            GetWindowThreadProcessId(handle, out owner);
            if (IsWindowVisible(handle)) found.Add(((int)owner).ToString() + "|" + handle.ToInt64().ToString());
            return true;
        }, IntPtr.Zero);
        return found.ToArray();
    }
    public static IntPtr[] Children(IntPtr parent) {
        List<IntPtr> found = new List<IntPtr>();
        EnumChildWindows(parent, delegate(IntPtr handle, IntPtr param) { found.Add(handle); return true; }, IntPtr.Zero);
        return found.ToArray();
    }
    // BM_CLICK reaches the button directly: no cursor movement, no foreground requirement.
    // Sent with a timeout so a busy editor cannot wedge the helper; the caller re-checks the
    // dialog afterwards, so a click that did not land is caught there.
    public static void ClickButton(IntPtr button) {
        IntPtr ignored;
        SendMessageTimeout(button, 0x00F5, IntPtr.Zero, IntPtr.Zero, 0x0002, 3000, out ignored);
    }
    // While the editor shows a modal, Process.MainWindowHandle reports 0, which hid the whole
    // editor from the product. Its top-level windows are still there, so ask Windows directly.
    public static IntPtr MainWindow(int processId) {
        IntPtr best = IntPtr.Zero;
        int bestLength = -1;
        EnumWindows(delegate(IntPtr handle, IntPtr param) {
            uint owner;
            GetWindowThreadProcessId(handle, out owner);
            if ((int)owner != processId || !IsWindowVisible(handle)) return true;
            int length = GetWindowTextLength(handle);
            if (length > bestLength) { bestLength = length; best = handle; }
            return true;
        }, IntPtr.Zero);
        return best;
    }
}
'@
}

function Get-WindowTitleText {
    param([IntPtr]$Handle)
    Load-ProcessWindowApi
    return [EduDockProcessWindows]::Title($Handle)
}

function Get-RealEditors {
    # No UI Automation here on purpose. The editor bridges a 1,000-element IE document into the
    # accessibility tree, so touching it is slow and can block; every fact below comes from
    # plain window calls. An unused FromHandle here cost about 0.4s per editor.
    Load-ProcessWindowApi
    Load-ChildWindowApi
    $byProcess = @{}
    foreach ($entry in [EduDockProcessWindows]::AllTopLevel()) {
        $parts = $entry -split '\|'
        $owner = [int]$parts[0]
        if (-not $byProcess.ContainsKey($owner)) { $byProcess[$owner] = [System.Collections.Generic.List[IntPtr]]::new() }
        $byProcess[$owner].Add([IntPtr][int64]$parts[1])
    }
    $editors = [System.Collections.Generic.List[object]]::new()
    foreach ($process in @(Get-Process -Name 'WXSClient' -ErrorAction SilentlyContinue)) {
        try { $path = $process.Path } catch { $path = $null }
        if ($path -cne $expectedProcessPath) { continue }
        $owned = @(if ($byProcess.ContainsKey([int]$process.Id)) { $byProcess[[int]$process.Id] })
        $handle = $process.MainWindowHandle
        if ($handle -eq 0) { $handle = [EduDockProcessWindows]::MainWindow([int]$process.Id) }
        if ($handle -eq 0) { continue }
        $childClasses = @([EduDockDraftChildWindows]::ClassNames($handle))
        $markers = [System.Collections.Generic.List[string]]::new()
        foreach ($marker in $requiredMarkers) {
            if ($childClasses -ccontains $marker) { $markers.Add($marker) }
        }
        # The body lives in an embedded HWP control that exposes no text to UI Automation, so
        # this probe always came back 'unknown' anyway — while costing 20+ seconds per call,
        # because searching the editor's tree crosses a bridged 1,000-element IE document.
        # Whether the form may be written into is decided by provenance instead (canFillBody).
        $state = 'unknown'
        # The editor shows its own modal (autosave recovery). While one is up the window cannot
        # be driven, so report it instead of looking stuck.
        $prompt = Find-AutosaveDialog -ProcessId $process.Id -TopLevel $owned
        $editors.Add([pscustomobject][ordered]@{
            dialogOpen = ($null -ne $prompt)
            dialogKind = if ($null -ne $prompt) { $prompt.kind } else { $null }
            pid = $process.Id
            hwnd = ([int64]$handle).ToString()
            processStartedAt = $process.StartTime.ToUniversalTime().ToString('o')
            processPath = $path
            title = (Get-WindowTitleText -Handle $handle)
            markers = @($markers)
            documentState = $state
        })
    }
    return @($editors)
}

function Get-Editors {
    param([object]$Fixture)
    if ($null -ne $Fixture) { return @($Fixture.editors | ForEach-Object { Public-Editor $_ }) }
    return @(Get-RealEditors)
}

function Get-Fingerprint {
    param([object]$Editor)
    return ([string]$Editor.pid + '|' + [string]$Editor.processStartedAt + '|' + [string]$Editor.hwnd)
}

function Find-ExactNamedElement {
    param([System.Windows.Automation.AutomationElement]$Root, [string]$Name)
    $condition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::NameProperty, $Name)
    return @($Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition) | Where-Object {
        -not $_.Current.IsOffscreen -and $_.Current.IsEnabled -and $_.Current.BoundingRectangle.Width -gt 0 -and $_.Current.BoundingRectangle.Height -gt 0
    })
}

# K-에듀파인 runs in Edge, whose page cannot be scripted without a debugging port. What Edge
# does offer is its accessibility tree (the same one UI Automation reads) and its render
# surface window. Both take a press for the page without the real cursor being moved:
#  - accDoDefaultAction on the element Edge reports at a point presses it inside the page;
#  - failing that, a mouse press delivered as window messages to Chrome_RenderWidgetHostHWND
#    lands on the page at that point exactly as if clicked, but the desktop cursor stays put.
# The previous version moved the cursor and clicked the pixel, which Windows only allows when
# nothing covers it, so any overlapping window turned the whole walk into 'not-actionable'.
function Load-DraftPageInputApi {
    if ('EduDockDraftPageInput' -as [type]) { return }
    Add-Type -ReferencedAssemblies 'Accessibility' -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Accessibility;
public static class EduDockDraftPageInput {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr hwnd, EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr hwnd, ref POINT point);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr w, IntPtr l);
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint objectId, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object acc);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

  public static IntPtr RenderSurface(IntPtr top, int expectedPid) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(top, delegate(IntPtr hwnd, IntPtr lParam) {
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
    try { string value = element.get_accName(childId); return value == null ? null : value.Trim(); } catch { return null; }
  }

  // 'ok' only once the element Edge reports at the point carries the label the caller verified
  // through UI Automation (compared without surrounding spaces: the grid labels end in one).
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
    string wanted = expectedName == null ? "" : expectedName.Trim();
    IAccessible named = null;
    IAccessible walk = element;
    int walkChildId = childId;
    for (int depth = 0; depth < 4 && walk != null; depth++) {
      if (string.Equals(NameOf(walk, walkChildId), wanted, StringComparison.Ordinal)) { named = walk; break; }
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

  // A left click delivered to Edge's render surface as window messages, in that window's own
  // client coordinates. The page sees an ordinary press at the point; the cursor never moves.
  public static string ClickPoint(IntPtr top, int expectedPid, int x, int y) {
    IntPtr surface = RenderSurface(top, expectedPid);
    if (surface == IntPtr.Zero) return "no-surface";
    POINT point = new POINT(); point.X = x; point.Y = y;
    if (!ScreenToClient(surface, ref point)) return "no-surface";
    if (point.X < 0 || point.Y < 0) return "outside-surface";
    IntPtr where = new IntPtr((point.Y << 16) | (point.X & 0xFFFF));
    SendMessage(surface, 0x0200, IntPtr.Zero, where);
    PostMessage(surface, 0x0201, new IntPtr(1), where);
    PostMessage(surface, 0x0202, IntPtr.Zero, where);
    return "ok";
  }
}
'@
}

function Get-TopWindowHandle {
    param([System.Windows.Automation.AutomationElement]$Element)
    $owner = Get-OwnerWindowElement -Element $Element
    if ($null -eq $owner) { return [IntPtr]::Zero }
    return [IntPtr][int64]$owner.Current.NativeWindowHandle
}

$script:lastPressMethod = $null
# Every press of the walk, in order, with how it was delivered — reported back so a live run
# shows which path K-에듀파인 actually accepted.
$script:pressTrace = [System.Collections.Generic.List[string]]::new()

function Note-Press {
    param([string]$Label, [string]$Method)
    $script:lastPressMethod = $Method
    $script:pressTrace.Add("${Label}:${Method}")
}

function Invoke-GuardedElement {
    param([System.Windows.Automation.AutomationElement]$Element, [int]$OwnerPid, [string]$Label = 'element')
    if ($Element.Current.ProcessId -ne $OwnerPid -or $Element.Current.IsOffscreen -or -not $Element.Current.IsEnabled) { return $false }
    $invoke = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
        $invoke.Invoke()
        Note-Press -Label $Label -Method 'invoke'
        return $true
    }
    $rectangle = $Element.Current.BoundingRectangle
    if ($rectangle.Width -le 0 -or $rectangle.Height -le 0) { return $false }
    $top = Get-TopWindowHandle -Element $Element
    if ($top -eq [IntPtr]::Zero) { return $false }
    Load-DraftPageInputApi
    $x = [int]($rectangle.Left + ($rectangle.Width / 2))
    $y = [int]($rectangle.Top + ($rectangle.Height / 2))
    $outcome = [EduDockDraftPageInput]::InvokeDefaultAction($top, $OwnerPid, $x, $y, [string]$Element.Current.Name)
    if ($outcome -ceq 'ok') { Note-Press -Label $Label -Method 'default-action'; return $true }
    $first = $outcome
    $outcome = [EduDockDraftPageInput]::ClickPoint($top, $OwnerPid, $x, $y)
    if ($outcome -ceq 'ok') { Note-Press -Label $Label -Method "surface-message(after:$first)"; return $true }
    Note-Press -Label $Label -Method "failed($first,$outcome)"
    return $false
}

function Wait-WinRt {
    param([object]$Operation, [Type]$ResultType)
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
    } | Select-Object -First 1
    if ($null -eq $method) { throw 'WinRT AsTask bridge unavailable' }
    $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $task.Wait()
    return $task.Result
}

function ConvertTo-CanonicalOcrCaption {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    $value = ($Text.Normalize([Text.NormalizationForm]::FormKC) -replace '\s+', '')
    $corrections = 0
    if ($value.Contains((Text-FromCodePoints @(0xAE30,0xB9CC,0xBB38)))) {
        $value = $value.Replace((Text-FromCodePoints @(0xAE30,0xB9CC,0xBB38)), (Text-FromCodePoints @(0xAE30,0xC548,0xBB38)))
        $corrections++
    }
    foreach ($wrong in @(
        (Text-FromCodePoints @(0xACE8,0xC7AC)),
        (Text-FromCodePoints @(0xCE28,0xC7AC)),
        (Text-FromCodePoints @(0xC990,0xC7AC))
    )) {
        if ($value.Contains($wrong)) {
            $value = $value.Replace($wrong, (Text-FromCodePoints @(0xACB0,0xC7AC)))
            $corrections++
        }
    }
    $target = $expectedCaption -replace '\s+', ''
    if ($value -cne $target) { return $null }
    $confidence = 1.0 - ([double]$corrections / [Math]::Max(1, $target.Length * 2))
    return [pscustomobject]@{ caption = $expectedCaption; confidence = $confidence }
}

function Get-OcrCandidatesFromBitmap {
    param(
        [System.Drawing.Bitmap]$Bitmap,
        [string]$CaptureToken,
        [string]$RootFingerprint
    )
    Add-Type -AssemblyName System.Drawing
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
    $null = [Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
    $language = [Windows.Globalization.Language]::new('ko')
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
    if ($null -eq $engine) { return [pscustomobject]@{ available = $false; candidates = @() } }

    $scale = [Math]::Min(1.65, 10000.0 / [Math]::Max(1, $Bitmap.Width))
    if ($scale -lt 1.0) { $scale = 1.0 }
    $width = [int][Math]::Round($Bitmap.Width * $scale)
    $height = [int][Math]::Round($Bitmap.Height * $scale)
    $processed = [Drawing.Bitmap]::new($width, $height, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [Drawing.Graphics]::FromImage($processed)
    $attributes = [Drawing.Imaging.ImageAttributes]::new()
    $memory = $null
    $stream = $null
    $softwareBitmap = $null
    try {
        $graphics.Clear([Drawing.Color]::White)
        $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $attributes.SetThreshold(0.78)
        $graphics.DrawImage($Bitmap, [Drawing.Rectangle]::new(0, 0, $width, $height), 0, 0, $Bitmap.Width, $Bitmap.Height, [Drawing.GraphicsUnit]::Pixel, $attributes)
        $graphics.Dispose()
        $attributes.Dispose()
        $memory = [IO.MemoryStream]::new()
        $processed.Save($memory, [Drawing.Imaging.ImageFormat]::Png)
        $memory.Position = 0
        $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($memory)
        $decoder = Wait-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $softwareBitmap = Wait-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $recognized = Wait-WinRt ($engine.RecognizeAsync($softwareBitmap)) ([Windows.Media.Ocr.OcrResult])
        $candidates = [System.Collections.Generic.List[object]]::new()
        foreach ($line in @($recognized.Lines)) {
            $canonical = ConvertTo-CanonicalOcrCaption -Text $line.Text
            if ($null -eq $canonical -or $canonical.confidence -lt 0.9) { continue }
            $words = @($line.Words)
            if ($words.Count -eq 0) { continue }
            $left = ($words | ForEach-Object { $_.BoundingRect.X } | Measure-Object -Minimum).Minimum
            $top = ($words | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum
            $right = ($words | ForEach-Object { $_.BoundingRect.X + $_.BoundingRect.Width } | Measure-Object -Maximum).Maximum
            $bottom = ($words | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height } | Measure-Object -Maximum).Maximum
            $candidates.Add([pscustomobject][ordered]@{
                caption = $expectedCaption
                source = 'ocr'
                confidence = [Math]::Round([double]$canonical.confidence, 4)
                captureToken = $CaptureToken
                rootFingerprint = $RootFingerprint
                bounds = [pscustomobject]@{ x = [double]$left / $scale; y = [double]$top / $scale; width = ([double]$right - $left) / $scale; height = ([double]$bottom - $top) / $scale }
            })
        }
        return [pscustomobject]@{ available = $true; candidates = @($candidates) }
    } finally {
        if ($null -ne $softwareBitmap) { $softwareBitmap.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $memory) { $memory.Dispose() }
        if ($null -ne $graphics) { $graphics.Dispose() }
        if ($null -ne $attributes) { $attributes.Dispose() }
        $processed.Dispose()
    }
}

function Get-OcrCandidatesFromImage {
    param([string]$ImagePath, [string]$CaptureToken, [string]$RootFingerprint)
    Add-Type -AssemblyName System.Drawing
    $resolved = (Resolve-Path -LiteralPath $ImagePath).Path
    $bitmap = [Drawing.Bitmap]::FromFile($resolved)
    try { return Get-OcrCandidatesFromBitmap -Bitmap $bitmap -CaptureToken $CaptureToken -RootFingerprint $RootFingerprint }
    finally { $bitmap.Dispose() }
}

function Initialize-DraftWindowCapture {
    Add-Type -AssemblyName System.Drawing
    if ('DraftWindowCapture' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DraftWindowCapture {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
}
'@
}

function Get-OwnerWindowElement {
    param([System.Windows.Automation.AutomationElement]$Element)
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $current = $Element
    while ($null -ne $current -and $current.Current.ControlType -ne [System.Windows.Automation.ControlType]::Window) {
        $current = $walker.GetParent($current)
    }
    return $current
}

function Get-VerifiedWindowCapture {
    param([System.Windows.Automation.AutomationElement]$Anchor, [int]$OwnerPid)
    Initialize-DraftWindowCapture
    $root = Get-OwnerWindowElement -Element $Anchor
    if ($null -eq $root -or $root.Current.ProcessId -ne $OwnerPid -or [string]::IsNullOrWhiteSpace($root.Current.Name)) { return $null }
    $hwnd = [IntPtr][int64]$root.Current.NativeWindowHandle
    if ($hwnd -eq [IntPtr]::Zero -or -not [DraftWindowCapture]::IsWindowVisible($hwnd)) { return $null }
    $process = Get-Process -Id $OwnerPid -ErrorAction Stop
    try { $processPath = $process.Path } catch { return $null }
    if ([IO.Path]::GetFileName($processPath) -cne 'msedge.exe') { return $null }
    $rectangle = New-Object DraftWindowCapture+RECT
    if (-not [DraftWindowCapture]::GetWindowRect($hwnd, [ref]$rectangle)) { return $null }
    $width = $rectangle.Right - $rectangle.Left
    $height = $rectangle.Bottom - $rectangle.Top
    if ($width -le 0 -or $height -le 0) { return $null }
    $bitmap = [Drawing.Bitmap]::new($width, $height, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $hdc = $graphics.GetHdc()
    try {
        if (-not [DraftWindowCapture]::PrintWindow($hwnd, $hdc, 2)) { $bitmap.Dispose(); return $null }
    } finally {
        $graphics.ReleaseHdc($hdc)
        $graphics.Dispose()
    }
    $started = $process.StartTime.ToUniversalTime().ToString('o')
    return [pscustomobject]@{
        bitmap = $bitmap
        pid = $OwnerPid
        hwnd = $hwnd
        processStartedAt = $started
        processPath = $processPath
        rootName = $root.Current.Name
        bounds = [pscustomobject]@{ left=$rectangle.Left; top=$rectangle.Top; width=$width; height=$height }
        fingerprint = ([string]$OwnerPid + '|' + $started + '|' + ([int64]$hwnd).ToString() + '|' + $rectangle.Left + ',' + $rectangle.Top + ',' + $width + ',' + $height)
        captureToken = [guid]::NewGuid().ToString('N')
        capturedAt = [DateTime]::UtcNow
    }
}

function Test-FreshOcrPoint {
    param([object]$Capture, [object]$Candidate, [string]$TopId, [string]$LeftId)
    if (([DateTime]::UtcNow - $Capture.capturedAt).TotalSeconds -gt 3) { return $false }
    $process = Get-Process -Id $Capture.pid -ErrorAction SilentlyContinue
    if ($null -eq $process) { return $false }
    try { $path = $process.Path } catch { return $false }
    if ($path -cne $Capture.processPath -or $process.StartTime.ToUniversalTime().ToString('o') -cne $Capture.processStartedAt) { return $false }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($Capture.hwnd)
    if ($null -eq $root -or $root.Current.ProcessId -ne $Capture.pid -or $root.Current.Name -cne $Capture.rootName) { return $false }
    if (@(Get-DescendantByAutomationId -Root $root -AutomationId $TopId).Count -ne 1 -or @(Get-DescendantByAutomationId -Root $root -AutomationId $LeftId).Count -ne 1) { return $false }
    $rectangle = New-Object DraftWindowCapture+RECT
    if (-not [DraftWindowCapture]::GetWindowRect($Capture.hwnd, [ref]$rectangle)) { return $false }
    if ($rectangle.Left -ne $Capture.bounds.left -or $rectangle.Top -ne $Capture.bounds.top -or ($rectangle.Right-$rectangle.Left) -ne $Capture.bounds.width -or ($rectangle.Bottom-$rectangle.Top) -ne $Capture.bounds.height) { return $false }
    $x = [int][Math]::Round($Capture.bounds.left + $Candidate.bounds.x + ($Candidate.bounds.width / 2))
    $y = [int][Math]::Round($Capture.bounds.top + $Candidate.bounds.y + ($Candidate.bounds.height / 2))
    # The point used to be refused unless our window owned that pixel on the desktop
    # (WindowFromPoint), which is exactly what fails while the user works in another window.
    # The press now goes to Edge's render surface, so the window may be covered; what still
    # matters is that the capture is fresh and the window has not moved since (checked above).
    return [pscustomobject]@{ x=$x; y=$y }
}

# The OCR fallback knows only a screen point, so it is pressed through Edge's render surface
# (see Load-DraftPageInputApi); the point was already proven to belong to the captured window.
function Invoke-GuardedPoint {
    param([int]$X, [int]$Y, [IntPtr]$TopWindow, [int]$OwnerPid)
    if ($TopWindow -eq [IntPtr]::Zero) { return $false }
    Load-DraftPageInputApi
    $outcome = [EduDockDraftPageInput]::ClickPoint($TopWindow, $OwnerPid, $X, $Y)
    Note-Press -Label 'ocr-point' -Method $(if ($outcome -ceq 'ok') { 'surface-message' } else { "failed($outcome)" })
    return ($outcome -ceq 'ok')
}
function Find-LeftMenuItem {
    param([System.Windows.Automation.AutomationElement]$Root, [string]$Name, [int]$OwnerPid)
    # The left menu labels carry a trailing space ("기안 "), and the grid renders each row as a
    # cell plus a nested celltreeitem with the same label. An exact-name, exactly-one lookup
    # therefore never matched and the walk always reported menu-path-ambiguous.
    $matches = @($Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | Where-Object {
        $_.Current.ProcessId -eq $OwnerPid -and -not $_.Current.IsOffscreen -and $_.Current.IsEnabled -and
        $_.Current.Name -is [string] -and $_.Current.Name.Trim() -ceq $Name -and
        $_.Current.BoundingRectangle.Width -gt 0 -and $_.Current.BoundingRectangle.Height -gt 0
    })
    if ($matches.Count -eq 0) { return $null }
    $leaves = @($matches | Where-Object { [string]$_.Current.AutomationId -clike '*.celltreeitem' })
    if ($leaves.Count -eq 1) { return $leaves[0] }
    if ($matches.Count -eq 1) { return $matches[0] }
    return $null
}

# Selects the K-에듀파인 tab of whichever Edge window has one (the one in front first); a tab
# selection through UI Automation, no cursor and no foreground change.
function Select-EdufineTab {
    Load-Uia
    $label = 'K-' + (Text-FromCodePoints @(0xC5D0,0xB4C0,0xD30C,0xC778))
    $tabCondition = [System.Windows.Automation.AndCondition]::new(
        [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem),
        [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'EdgeTab'))
    $candidates = @([System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCondition) | Where-Object {
        $_.Current.Name -is [string] -and $_.Current.Name.IndexOf($label, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.Current.IsEnabled
    })
    if ($candidates.Count -eq 0) { return $false }
    $selection = $null
    if (-not $candidates[0].TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) { return $false }
    if ($selection.Current.IsSelected) { return $false }
    $selection.Select()
    $script:pressTrace.Add('edufine-tab:selected')
    return $true
}

function Open-RealPublicForm {
    Load-Uia
    $desktop = [System.Windows.Automation.AutomationElement]::RootElement
    $topId = 'mainframe.MainVFrameSet.TopFrame.form.divTopMenu.form.btnMenu_A00AAB01'
    $leftId = 'mainframe.MainVFrameSet.SubHFrameSet.LeftFrame.form.divLnb'
    # The page may still be loading (K-에듀파인 opened a moment ago): the menu button appears
    # late and is not pressable at once, so both finding and pressing it are retried briefly.
    $top = @()
    $ownerPid = 0
    $pressed = $false
    $tabSelected = $false
    $menuDeadline = [DateTime]::UtcNow.AddSeconds(8)
    while (-not $pressed) {
        $top = @(Get-DescendantByAutomationId -Root $desktop -AutomationId $topId | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.IsEnabled })
        if ($top.Count -gt 1) { return [pscustomobject]@{ status='needs-user'; reason='browser-or-menu-unavailable' } }
        # Edge renders only the tab in front. If the user switched away since the product
        # activated K-에듀파인, its page is invisible to automation; bring the tab back once.
        if ($top.Count -eq 0 -and -not $tabSelected) {
            $tabSelected = $true
            if (Select-EdufineTab) { Start-Sleep -Milliseconds 700; continue }
        }
        if ($top.Count -eq 1) {
            # $PID is a read-only automatic variable in PowerShell, so this must not be called $pid.
            $ownerPid = $top[0].Current.ProcessId
            $pressed = Invoke-GuardedElement -Element $top[0] -OwnerPid $ownerPid -Label 'top-menu'
        }
        if ($pressed) { break }
        if ([DateTime]::UtcNow -ge $menuDeadline) {
            return [pscustomobject]@{ status='needs-user'; reason=$(if ($top.Count -eq 1) { 'menu-not-actionable' } else { 'browser-or-menu-unavailable' }) }
        }
        Start-Sleep -Milliseconds 500
    }
    Start-Sleep -Milliseconds 200
    $left = @(Get-DescendantByAutomationId -Root $desktop -AutomationId $leftId | Where-Object { $_.Current.ProcessId -eq $ownerPid -and -not $_.Current.IsOffscreen })
    if ($left.Count -ne 1) { return [pscustomobject]@{ status='needs-user'; reason='left-tree-unavailable' } }
    # Clicking 기안 toggles its branch, so blindly clicking it collapsed an already open tree
    # and 공용서식 disappeared. Reach for the target first and only expand when it is hidden.
    $item = Find-LeftMenuItem -Root $left[0] -Name $publicFormLabel -OwnerPid $ownerPid
    if ($null -eq $item) {
        $branch = Find-LeftMenuItem -Root $left[0] -Name $draftLabel -OwnerPid $ownerPid
        if ($null -eq $branch -or -not (Invoke-GuardedElement -Element $branch -OwnerPid $ownerPid -Label 'branch')) {
            return [pscustomobject]@{ status='needs-user'; reason='menu-path-ambiguous' }
        }
        for ($attempt = 0; $attempt -lt 6; $attempt++) {
            Start-Sleep -Milliseconds 400
            $left = @(Get-DescendantByAutomationId -Root $desktop -AutomationId $leftId | Where-Object { $_.Current.ProcessId -eq $ownerPid -and -not $_.Current.IsOffscreen })
            if ($left.Count -ne 1) { return [pscustomobject]@{ status='needs-user'; reason='left-tree-changed' } }
            $item = Find-LeftMenuItem -Root $left[0] -Name $publicFormLabel -OwnerPid $ownerPid
            if ($null -ne $item) { break }
        }
    }
    if ($null -eq $item -or -not (Invoke-GuardedElement -Element $item -OwnerPid $ownerPid -Label 'public-form-menu')) {
        return [pscustomobject]@{ status='needs-user'; reason='menu-path-ambiguous' }
    }
    Start-Sleep -Milliseconds 700
    $forms = @(Find-ExactNamedElement -Root $desktop -Name $expectedCaption | Where-Object { $_.Current.ProcessId -eq $ownerPid })
    if ($forms.Count -gt 1) { return [pscustomobject]@{ status='needs-user'; reason='exact-form-selector-ambiguous' } }
    if ($forms.Count -eq 1) {
        if (-not (Invoke-GuardedElement -Element $forms[0] -OwnerPid $ownerPid -Label 'form')) { return [pscustomobject]@{ status='needs-user'; reason='exact-form-not-actionable' } }
        return [pscustomobject]@{ status='ok'; selector='uia'; method=$script:lastPressMethod }
    }
    # The freshness check compares the window's rectangle against the one in the screenshot, so
    # a window that moved or was restored between the capture and the click is refused — right,
    # but a one-shot refusal turned a benign nudge of the browser into a failed 기안. The whole
    # capture is simply taken again; the guard itself stays exactly as strict.
    $reason = 'verified-window-capture-unavailable'
    for ($attempt = 0; $attempt -lt 2; $attempt += 1) {
        if ($attempt -gt 0) { Start-Sleep -Milliseconds 600 }
        $capture = Get-VerifiedWindowCapture -Anchor $top[0] -OwnerPid $ownerPid
        if ($null -eq $capture) { $reason = 'verified-window-capture-unavailable'; continue }
        try { $ocr = Get-OcrCandidatesFromBitmap -Bitmap $capture.bitmap -CaptureToken $capture.captureToken -RootFingerprint $capture.fingerprint }
        finally { $capture.bitmap.Dispose() }
        if (-not $ocr.available) { return [pscustomobject]@{ status='needs-user'; reason='korean-ocr-unavailable' } }
        $ocrMatches = @($ocr.candidates)
        if ($ocrMatches.Count -ne 1) { $reason = if ($ocrMatches.Count -gt 1) { 'ocr-selector-ambiguous' } else { 'ocr-selector-unavailable' }; continue }
        $freshPoint = Test-FreshOcrPoint -Capture $capture -Candidate $ocrMatches[0] -TopId $topId -LeftId $leftId
        if ($false -eq $freshPoint) { $reason = 'ocr-root-or-overlay-changed'; continue }
        if (-not (Invoke-GuardedPoint -X $freshPoint.x -Y $freshPoint.y -TopWindow $capture.hwnd -OwnerPid $ownerPid)) { $reason = 'ocr-point-not-actionable'; continue }
        return [pscustomobject]@{ status='ok'; selector='ocr'; method=$script:lastPressMethod }
    }
    return [pscustomobject]@{ status='needs-user'; reason=$reason }
}

# The draft body is not reachable through UI Automation, but the editor page is hosted in a
# real Internet Explorer control, and WM_HTML_GETOBJECT hands back its document object. From
# there the page's own editor API (IMPL_*) reads and writes the HWP form directly. One COM
# round trip costs about 0.4s; walking the same document element by element took 16s.
function Load-DraftDomApi {
    if ('EduDockDraftDom' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class EduDockDraftDom {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern uint RegisterWindowMessage(string name);
    [DllImport("user32.dll")] private static extern IntPtr SendMessageTimeout(IntPtr handle, uint message, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
    [DllImport("oleacc.dll", PreserveSig = false)] [return: MarshalAs(UnmanagedType.Interface)]
    private static extern object ObjectFromLresult(IntPtr lResult, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, IntPtr wParam);
    public static object Document(IntPtr htmlWindow) {
        uint message = RegisterWindowMessage("WM_HTML_GETOBJECT");
        IntPtr answer;
        // SMTO_ABORTIFHUNG: a wedged editor must not block the helper.
        SendMessageTimeout(htmlWindow, message, IntPtr.Zero, IntPtr.Zero, 2, 5000, out answer);
        if (answer == IntPtr.Zero) return null;
        return ObjectFromLresult(answer, new Guid("626FC520-A41E-11CF-A731-00A0C9082637"), IntPtr.Zero);
    }
}
'@
}

function Get-DraftDocumentObject {
    param([IntPtr]$WindowHandle)
    Load-ProcessWindowApi
    Load-DraftDomApi
    foreach ($child in [EduDockProcessWindows]::Children($WindowHandle)) {
        if ([EduDockProcessWindows]::ClassOf($child) -cne 'Internet Explorer_Server') { continue }
        $document = [EduDockDraftDom]::Document($child)
        if ($null -ne $document) { return $document }
    }
    return $null
}

# Everything outside plain printable ASCII is escaped, so the Korean the user typed survives
# no matter what code page the helper happens to be launched with. The angle brackets and
# ampersand go too: the literal is embedded in script source, not parsed as JSON.
function ConvertTo-JsStringLiteral {
    param([string]$Value)
    $builder = New-Object Text.StringBuilder
    [void]$builder.Append('"')
    foreach ($character in $Value.ToCharArray()) {
        $code = [int]$character
        if ($code -lt 0x20 -or $code -gt 0x7E -or '"\<>&'.IndexOf($character) -ge 0) {
            [void]$builder.AppendFormat('\u{0:x4}', $code)
        } else {
            [void]$builder.Append($character)
        }
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Invoke-DraftScript {
    param([object]$Document, [string]$Script)
    # execScript returns a value, and an unassigned return joins the function's output, which
    # made $answer an array whose first element was null instead of the reply string.
    $null = $Document.parentWindow.execScript($Script, 'JavaScript')
    $answer = [string]$Document.title
    if (-not $answer.StartsWith('EDFILL::')) { return $null }
    return $answer.Substring(8)
}

# The blank check asks the document itself rather than inferring from how it was opened: an
# untouched template reports not-modified, an empty 결재제목, an empty 본문 and an empty web
# title box. Anything else is the user's own work and is left untouched.
function Build-DraftFillScript {
    param([string]$Title, [string]$Body, [switch]$ProbeOnly)
    $titleLiteral = ConvertTo-JsStringLiteral -Value $Title
    $bodyLiteral = ConvertTo-JsStringLiteral -Value $Body
    $writeStep = if ($ProbeOnly) {
        "document.title = 'EDFILL::blank';"
    } else {
@"
    try { if (sj) { sj.value = TITLE_TEXT; if (sj.fireEvent) { sj.fireEvent('onchange'); } } } catch (e) {}
    window.IMPL_PutFieldText(W, TITLE_FIELD, TITLE_TEXT);
    // PutFieldText drops line breaks, which would run a whole 기안문 body into one paragraph.
    // Selecting the body field and inserting instead keeps every paragraph — as long as the
    // breaks are CRLF: InsertText turns "\r\n" into a paragraph and silently drops a bare "\n".
    // The move uses the page's own idiom (document start, then the two-argument MoveToField);
    // the five-argument string form never moved and only worked while the caret already sat
    // in the body of a fresh form.
    window.IMPL_MovePos(W, 2, 0, 0);
    if (window.IMPL_MoveToField(W, BODY_FIELD) !== true) {
      document.title = 'EDFILL::body-field-unreachable';
      return;
    }
    window.IMPL_InsertText(W, BODY_TEXT.replace(/\r\n|\r|\n/g, '\r\n'));
    var flat = function (v) { return String(v == null ? '' : v).replace(/\s+/g, ''); };
    var titleOk = flat(read(TITLE_FIELD)) === flat(TITLE_TEXT);
    // Read the document back as text and require each written paragraph to be its own line,
    // so a body that silently collapsed is reported as a failure rather than announced.
    var doc = String(window.editor(W).GetControl().GetTextFile('TEXT', '') || '');
    var placed = {};
    var lines = doc.split(/\r\n|\r|\n/);
    for (var i = 0; i < lines.length; i++) { placed[flat(lines[i])] = true; }
    var wanted = BODY_TEXT.split(/\r\n|\r|\n/);
    var bodyOk = true;
    for (var j = 0; j < wanted.length; j++) {
      var key = flat(wanted[j]);
      if (key.length > 0 && placed[key] !== true) { bodyOk = false; break; }
    }
    document.title = 'EDFILL::written|' + (titleOk ? '1' : '0') + '|' + (bodyOk ? '1' : '0');
"@
    }
    return @"
(function () {
  try {
    var W = 'editor1';
    var TITLE_FIELD = "\uACB0\uC7AC\uC81C\uBAA9";
    var BODY_FIELD = "\uBCF8\uBB38";
    var TITLE_TEXT = $titleLiteral;
    var BODY_TEXT = $bodyLiteral;
    if (typeof window.IMPL_GetFieldText !== 'function' ||
        typeof window.IMPL_PutFieldText !== 'function' ||
        typeof window.IMPL_IsDocumentUpdated !== 'function') {
      document.title = 'EDFILL::editor-api-missing';
      return;
    }
    function read(name) {
      var v = window.IMPL_GetFieldText(W, name);
      return v == null ? '' : String(v);
    }
    if (window.IMPL_IsFieldExist(W, TITLE_FIELD) !== true || window.IMPL_IsFieldExist(W, BODY_FIELD) !== true) {
      document.title = 'EDFILL::unexpected-form';
      return;
    }
    var sj = document.getElementById('Sj');
    var sjText = sj ? String(sj.value) : '';
    if (window.IMPL_IsDocumentUpdated(W) === true || read(TITLE_FIELD).length > 0 ||
        read(BODY_FIELD).length > 0 || sjText.length > 0) {
      document.title = 'EDFILL::not-blank';
      return;
    }
$writeStep
  } catch (err) {
    document.title = 'EDFILL::script-error';
  }
})();
"@
}

# Read stdin as UTF-8 explicitly. [Console]::In decodes with the ambient console code page,
# which mangles the Korean form caption whenever the helper is spawned with a piped stdin.
if ([string]::IsNullOrEmpty($RequestBase64)) {
    $requestReader = New-Object IO.StreamReader([Console]::OpenStandardInput(), (New-Object Text.UTF8Encoding($false)))
    $requestText = $requestReader.ReadToEnd()
} else {
    $requestText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RequestBase64))
}
$request = $requestText | ConvertFrom-Json
$fixture = Read-Fixture

switch ([string]$request.command) {
    'inspect-editors' {
        Write-Result (New-Result -Editors @(Get-Editors -Fixture $fixture))
    }
    'decline-editor-dialog' {
        $editors = @(Get-Editors -Fixture $fixture)
        $matches = @($editors | Where-Object { (Get-Fingerprint $_) -ceq [string]$request.target })
        $result = New-Result -Editors $editors
        $declined = $false
        if ($matches.Count -eq 1 -and $null -eq $fixture) {
            $ownerPid = [int]$matches[0].pid
            # One prompt per call: the caller decides about the next one from its own kind.
            $kind = $null
            for ($try = 0; $try -lt 3 -and -not $declined; $try += 1) {
                $dialog = Find-AutosaveDialog -ProcessId $ownerPid
                if ($null -eq $dialog -or ($null -ne $kind -and $dialog.kind -cne $kind)) { $declined = $true; break }
                $kind = $dialog.kind
                [EduDockProcessWindows]::ClickButton($dialog.cancel)
                Start-Sleep -Milliseconds 500
                $after = Find-AutosaveDialog -ProcessId $ownerPid
                $declined = ($null -eq $after -or $after.kind -cne $kind)
            }
        }
        if ($matches.Count -eq 1 -and $null -ne $fixture) { $declined = ($fixture.declineResult -eq $true) }
        $result.invoked = $declined
        Write-Result $result
    }
    'focus-editor' {
        $editors = @(Get-Editors -Fixture $fixture)
        $matches = @($editors | Where-Object { (Get-Fingerprint $_) -ceq [string]$request.target })
        $result = New-Result -Editors $editors
        $focused = ($matches.Count -eq 1)
        if ($focused -and $null -eq $fixture) {
            if (-not ('DraftWindowActivation' -as [type])) {
                Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DraftWindowActivation {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  // A helper spawned in the background is not the foreground process, so Windows ignores a bare
  // SetForegroundWindow. Attaching to the current foreground thread's input queue lifts that lock.
  public static bool Activate(IntPtr hwnd) {
    if (IsIconic(hwnd)) ShowWindowAsync(hwnd, 9);
    if (GetForegroundWindow() == hwnd) return true;
    uint self = GetCurrentThreadId();
    uint owner = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    bool attached = owner != 0 && owner != self && AttachThreadInput(owner, self, true);
    try {
      SetForegroundWindow(hwnd);
      BringWindowToTop(hwnd);
    } finally {
      if (attached) AttachThreadInput(owner, self, false);
    }
    return GetForegroundWindow() == hwnd;
  }
}
'@
            }
            $focused = [DraftWindowActivation]::Activate([IntPtr][int64]$matches[0].hwnd)
        }
        $result.focused = $focused
        Write-Result $result
    }
    'open-public-form' {
        if ([string]$request.caption -cne $expectedCaption) { throw 'Unexpected public form caption' }
        $editors = @(Get-Editors -Fixture $fixture)
        if ($null -ne $fixture) {
            $matches = @($fixture.publicForms | Where-Object {
                $_.caption -ceq $expectedCaption -and $_.source -in @('uia','ocr') -and $_.visible -eq $true -and $_.enabled -eq $true
            })
            if ($matches.Count -eq 0 -and $fixture.ocrImagePath -is [string]) {
                if ([string]$fixture.rootFingerprint -cne [string]$fixture.currentRootFingerprint -or $fixture.overlayClear -ne $true) {
                    $result = New-Result -Status 'needs-user' -Editors $editors
                    $result.reason = if ($fixture.overlayClear -ne $true) { 'ocr-target-covered' } else { 'ocr-root-changed' }
                    Write-Result $result
                    break
                }
                if ($fixture.ocrUnavailable -eq $true) {
                    $result = New-Result -Status 'needs-user' -Editors $editors
                    $result.reason = 'korean-ocr-unavailable'
                    Write-Result $result
                    break
                }
                $ocr = Get-OcrCandidatesFromImage -ImagePath ([string]$fixture.ocrImagePath) -CaptureToken ([string]$fixture.captureToken) -RootFingerprint ([string]$fixture.rootFingerprint)
                if (-not $ocr.available) {
                    $result = New-Result -Status 'needs-user' -Editors $editors
                    $result.reason = 'korean-ocr-unavailable'
                    Write-Result $result
                    break
                }
                $matches = @($ocr.candidates)
            }
            if ($matches.Count -ne 1) {
                $result = New-Result -Status 'needs-user' -Editors $editors
                $result.reason = if ($matches.Count -gt 1) { 'exact-form-selector-ambiguous' } else { 'exact-form-selector-unavailable' }
                Write-Result $result
                break
            }
            $result = New-Result -Editors $editors
            $result.invoked = $true
            $result.entry = [ordered]@{ selector = [string]$matches[0].source; caption = $expectedCaption }
            Write-Result $result
            break
        }
        $opened = Open-RealPublicForm
        $result = New-Result -Status $opened.status -Editors $editors
        $result.presses = @($script:pressTrace)
        if ($opened.status -eq 'ok') {
            $result.invoked = $true
            # `method` says how the last element was pressed (invoke / default-action /
            # surface-message); the adapter ignores it, the field notes keep it.
            $result.entry = [ordered]@{ selector = $opened.selector; caption = $expectedCaption; method = [string]$opened.method }
        } else { $result.reason = $opened.reason }
        Write-Result $result
    }
    'probe-draft' {
        $editors = @(Get-Editors -Fixture $fixture)
        $matches = @($editors | Where-Object { (Get-Fingerprint $_) -ceq [string]$request.target })
        $result = New-Result -Editors $editors
        if ($matches.Count -ne 1) {
            $result.status = 'needs-user'
            $result.reason = 'editor-not-found'
            Write-Result $result
            break
        }
        if ($null -ne $fixture) {
            $result.blank = ($fixture.probeResult -ceq 'blank')
            if (-not $result.blank) { $result.status = 'needs-user'; $result.reason = [string]$fixture.probeResult }
            Write-Result $result
            break
        }
        $document = Get-DraftDocumentObject -WindowHandle ([IntPtr][int64]$matches[0].hwnd)
        if ($null -eq $document) {
            $result.status = 'needs-user'
            $result.reason = 'editor-document-unavailable'
            Write-Result $result
            break
        }
        $answer = Invoke-DraftScript -Document $document -Script (Build-DraftFillScript -Title '' -Body '' -ProbeOnly)
        if ($answer -ceq 'blank') {
            $result.blank = $true
        } else {
            $result.blank = $false
            $result.status = 'needs-user'
            $result.reason = if ([string]::IsNullOrEmpty($answer)) { 'editor-script-unavailable' } else { $answer }
        }
        Write-Result $result
    }
    'fill-draft' {
        $editors = @(Get-Editors -Fixture $fixture)
        $matches = @($editors | Where-Object { (Get-Fingerprint $_) -ceq [string]$request.target })
        $result = New-Result -Editors $editors
        $result.filled = $false
        if ($matches.Count -ne 1) {
            $result.status = 'needs-user'
            $result.reason = 'editor-not-found'
            Write-Result $result
            break
        }
        $title = [string]$request.title
        $body = [string]$request.body
        if ([string]::IsNullOrWhiteSpace($title) -or [string]::IsNullOrWhiteSpace($body)) {
            $result.status = 'needs-user'
            $result.reason = 'draft-content-empty'
            Write-Result $result
            break
        }
        if ($null -ne $fixture) {
            $result.filled = ($fixture.fillResult -ceq 'written|1|1')
            if (-not $result.filled) { $result.status = 'needs-user'; $result.reason = [string]$fixture.fillResult }
            Write-Result $result
            break
        }
        $document = Get-DraftDocumentObject -WindowHandle ([IntPtr][int64]$matches[0].hwnd)
        if ($null -eq $document) {
            $result.status = 'needs-user'
            $result.reason = 'editor-document-unavailable'
            Write-Result $result
            break
        }
        $answer = Invoke-DraftScript -Document $document -Script (Build-DraftFillScript -Title $title -Body $body)
        # 'written|1|1' means both fields read back exactly what was written. A partial write is
        # reported as a failure so the product never claims a draft it did not actually place.
        if ($answer -ceq 'written|1|1') {
            $result.filled = $true
        } else {
            $result.status = 'needs-user'
            $result.reason = if ([string]::IsNullOrEmpty($answer)) { 'editor-script-unavailable' }
                elseif ($answer.StartsWith('written|')) { 'draft-write-incomplete:' + $answer.Substring(8) }
                else { $answer }
        }
        Write-Result $result
    }
    default { throw 'Unsupported draft handoff command' }
}
