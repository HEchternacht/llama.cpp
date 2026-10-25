# Tray wrapper for llamactl: runs start-llamactl.bat hidden with a tray icon.
# Copied/adapted from scripts/winlauncher/tray_wrapper.ps1 so this folder stays
# self-contained and movable. Adds an "Open dashboard" menu item.
param(
    [string]$Bat = "start-llamactl.bat",
    [string]$BatArgs = "",
    [switch]$WatchVibe,
    [string]$DashboardUrl = "http://127.0.0.1:8080/ui/"
)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Name Win32 -Namespace Native -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
"@

$batPath = Join-Path $PSScriptRoot $Bat
$proc = Start-Process cmd.exe -ArgumentList "/c `"`"$batPath`" $BatArgs`"" -WorkingDirectory $PSScriptRoot -WindowStyle Minimized -PassThru

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
$icon.Text = "llamactl"
$icon.Visible = $true
$icon.ShowBalloonTip(3000, "llamactl", "llamactl started - double-click tray icon to open the dashboard", 'Info')

$show = {
    Start-Process $DashboardUrl
}
$icon.add_MouseDoubleClick($show)

$menu = New-Object System.Windows.Forms.ContextMenuStrip
[void]$menu.Items.Add("Open dashboard", $null, $show)
[void]$menu.Items.Add("Show console", $null, {
    [Native.Win32]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE
    [Native.Win32]::SetForegroundWindow($hwnd) | Out-Null
    $script:hidden = $false
})
[void]$menu.Items.Add("Exit", $null, {
    Stop-ServerTree
    [System.Windows.Forms.Application]::Exit()
})
$icon.ContextMenuStrip = $menu

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.add_Tick({
    if ($proc.HasExited) { [System.Windows.Forms.Application]::Exit(); return }
    if (-not $script:hidden -and [Native.Win32]::IsIconic($hwnd)) {
        [Native.Win32]::ShowWindow($hwnd, 0) | Out-Null
        $script:hidden = $true
    }
    if ($WatchVibe) {
        $agents = @(Get-Process vibe, hermes -ErrorAction SilentlyContinue).Count
        if ($agents -eq 0 -and @(Get-Process node -ErrorAction SilentlyContinue).Count -gt 0) {
            $agents = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'pi-coding-agent' }).Count
        }
        if ($agents -gt 0) {
            $script:vibeSeen = $true
        } elseif ($script:vibeSeen) {
            $icon.ShowBalloonTip(2000, "llamactl", "All vibe/pi/hermes instances closed - shutting down", 'Info')
            Stop-ServerTree
            [System.Windows.Forms.Application]::Exit()
        }
    }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
$icon.Visible = $false
$icon.Dispose()
