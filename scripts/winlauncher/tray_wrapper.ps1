# Tray wrapper: runs a .bat hidden with tray icon.
# Usage: powershell -File tray_wrapper.ps1 -Bat QWEN36MOECLI.BAT -BatArgs "--args 3" [-WatchVibe]
param(
    [string]$Bat = "QWEN36MOE.bat",
    [string]$BatArgs = "",
    [switch]$WatchVibe
)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Name Win32 -Namespace Native -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
"@

$batPath = Join-Path $PSScriptRoot $Bat
$proc = Start-Process cmd.exe -ArgumentList "/c `"`"$batPath`" $BatArgs`"" -WorkingDirectory $PSScriptRoot -WindowStyle Minimized -PassThru

# wait for console window handle
$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 100 -and $hwnd -eq [IntPtr]::Zero; $i++) {
    Start-Sleep -Milliseconds 100
    $proc.Refresh()
    $hwnd = $proc.MainWindowHandle
}
[Native.Win32]::ShowWindow($hwnd, 0) | Out-Null   # SW_HIDE — start in tray

$script:hidden = $true
$script:vibeSeen = $false

function Stop-ServerTree {
    if (-not $proc.HasExited) { taskkill /PID $proc.Id /T /F 2>$null | Out-Null }
}

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Application
$icon.Text = [System.IO.Path]::GetFileNameWithoutExtension($Bat)
$icon.Visible = $true
$icon.ShowBalloonTip(3000, "llama.cpp", "$Bat started (double-click tray icon to show)", 'Info')

$show = {
    [Native.Win32]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE
    [Native.Win32]::SetForegroundWindow($hwnd) | Out-Null
    $script:hidden = $false
}
$icon.add_MouseDoubleClick($show)

$menu = New-Object System.Windows.Forms.ContextMenuStrip
[void]$menu.Items.Add("Show", $null, $show)
[void]$menu.Items.Add("Exit", $null, {
    Stop-ServerTree
    [System.Windows.Forms.Application]::Exit()
})
$icon.ContextMenuStrip = $menu

# poll: hide to tray when minimized; exit when bat exits; auto-exit when all vibe instances closed
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.add_Tick({
    if ($proc.HasExited) { [System.Windows.Forms.Application]::Exit(); return }
    if (-not $script:hidden -and [Native.Win32]::IsIconic($hwnd)) {
        [Native.Win32]::ShowWindow($hwnd, 0) | Out-Null
        $script:hidden = $true
    }
    if ($WatchVibe) {
        # agents: vibe (vibe.exe) and pi (node.exe running pi-coding-agent cli)
        $agents = @(Get-Process vibe -ErrorAction SilentlyContinue).Count
        if ($agents -eq 0 -and @(Get-Process node -ErrorAction SilentlyContinue).Count -gt 0) {
            $agents = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'pi-coding-agent' }).Count
        }
        if ($agents -gt 0) {
            $script:vibeSeen = $true
        } elseif ($script:vibeSeen) {
            $icon.ShowBalloonTip(2000, "llama.cpp", "All vibe/pi instances closed - shutting down server", 'Info')
            Stop-ServerTree
            [System.Windows.Forms.Application]::Exit()
        }
    }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
$icon.Visible = $false
$icon.Dispose()
