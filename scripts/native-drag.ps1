param([int]$StartX,[int]$StartY,[int]$EndX,[int]$EndY)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class PointerDriver {
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[PointerDriver]::SetProcessDPIAware() | Out-Null
[PointerDriver]::SetCursorPos($StartX,$StartY) | Out-Null
Start-Sleep -Milliseconds 100
[PointerDriver]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
for($i=1;$i -le 12;$i++) {
 [PointerDriver]::SetCursorPos(($StartX+($EndX-$StartX)*$i/12),($StartY+($EndY-$StartY)*$i/12)) | Out-Null
 Start-Sleep -Milliseconds 30
}
[PointerDriver]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
