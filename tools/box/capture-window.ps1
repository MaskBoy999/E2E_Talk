# Capture the Website-in-a-Box window to a PNG.
#
# The box is a native window, so "did the app actually render?" cannot be
# answered from the server's logs alone, and Playwright cannot attach to it
# (use -DebugPort below for a real screenshot of the WebView itself).
# This grabs the real composited pixels of the app window, which is what the
# plan's proof harness asks for and what makes a blank WebView (the Android
# failure mode, and WebView2's untrusted-certificate page) impossible to miss.
#
# Usage (from the repository root):
#   powershell -ExecutionPolicy Bypass -File tools/box/capture-window.ps1 `
#       -Out visual-evidence/box/main-app.png
#
# Options:
#   -ProcessName  exe name without .exe (default: e2e-chat-app)
#   -DelaySeconds wait before capturing (default: 2)
param(
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$ProcessName = 'e2e-chat-app',
    [int]$DelaySeconds = 2
)

Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BoxWin32 {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) {
    Write-Error "No '$ProcessName' process with a main window is running. Start the box first."
    exit 1
}

$hwnd = $proc.MainWindowHandle
[void][BoxWin32]::ShowWindow($hwnd, 9)          # SW_RESTORE
[void][BoxWin32]::SetForegroundWindow($hwnd)
[void][BoxWin32]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, 0, 0, 0x0001 -bor 0x0040)  # NOSIZE | SHOWWINDOW
Start-Sleep -Seconds $DelaySeconds

$rect = New-Object BoxWin32+RECT
if (-not [BoxWin32]::GetWindowRect($hwnd, [ref]$rect)) {
    Write-Error "GetWindowRect failed for window handle $hwnd."
    exit 1
}
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) {
    Write-Error "Window has no size ($w x $h)."
    exit 1
}

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

$bmp = New-Object System.Drawing.Bitmap $w, $h
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
try {
    $gfx.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size $w, $h))
} finally {
    $gfx.Dispose()
}
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Host "Captured $w x $h from '$($proc.ProcessName)' (hwnd $hwnd) -> $Out"

# A cheap "is this a black screen?" signal. A blank WebView is the exact failure
# this script exists to catch, so say so rather than leaving it to the eye.
$sample = New-Object System.Drawing.Bitmap $Out
$dark = 0; $total = 0
for ($x = 0; $x -lt $sample.Width; $x += 16) {
    for ($y = 0; $y -lt $sample.Height; $y += 16) {
        $c = $sample.GetPixel($x, $y)
        $total++
        if ($c.R -lt 25 -and $c.G -lt 25 -and $c.B -lt 25) { $dark++ }
    }
}
$sample.Dispose()
$pct = if ($total -gt 0) { [math]::Round(100 * $dark / $total) } else { 0 }
Write-Host "Sampled $total pixels: $pct% near-black."
if ($pct -gt 90) {
    Write-Warning "This looks like a blank window - check the WebView certificate handling."
}
