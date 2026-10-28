# Tray wrapper for freectl: runs start-freectl.bat hidden with a tray icon.
# Adapted from scripts/llamactl/scripts/tray_wrapper.ps1.
param(
    [string]$Bat = "start-freectl.bat",
    [string]$UiUrl = "http://127.0.0.1:8090/ui/"
)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Name Win32 -Namespace Native -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
"@

$batPath = Join-Path $PSScriptRoot $Bat
$proc = Start-Process cmd.exe -ArgumentList "/c `"`"$batPath`"`"" -WorkingDirectory $PSScriptRoot -WindowStyle Minimized -PassThru

$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 100 -and $hwnd -eq [IntPtr]::Zero; $i++) {
    Start-Sleep -Milliseconds 100
    $proc.Refresh()
    $hwnd = $proc.MainWindowHandle
}
[Native.Win32]::ShowWindow($hwnd, 0) | Out-Null   # SW_HIDE - start in tray

$script:hidden = $true

function Stop-ServerTree {
    if (-not $proc.HasExited) { taskkill /PID $proc.Id /T /F 2>$null | Out-Null }
}

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Information
$icon.Text = "freectl (:8090)"
$icon.Visible = $true
$icon.ShowBalloonTip(3000, "freectl", "freectl started - double-click the tray icon to open the UI", 'Info')

$show = { Start-Process $UiUrl }
$icon.add_MouseDoubleClick($show)

$menu = New-Object System.Windows.Forms.ContextMenuStrip
[void]$menu.Items.Add("Open UI", $null, $show)
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
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
$icon.Visible = $false
$icon.Dispose()
