# LLM Config GUI: pick startup model (QWEN36MOECLI_config.json) and edit per-model args (model_args.json).
# Model list replicates llama_launcher.py numbering exactly (ordinal sort + extra +MMPROJ entry for "ornith" models).
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$dir        = $PSScriptRoot
$modelDir   = 'C:\cmodels'
$argsFile   = Join-Path $dir 'model_args.json'
$startFile  = Join-Path $dir 'QWEN36MOECLI_config.json'
$utf8NoBom  = New-Object System.Text.UTF8Encoding($false)

# ---- data -------------------------------------------------------------
$files = @([System.IO.Directory]::GetFiles($modelDir) | ForEach-Object { [System.IO.Path]::GetFileName($_) } | Where-Object { $_.ToLower().EndsWith('.gguf') })
[Array]::Sort($files, [System.StringComparer]::Ordinal)   # match python sorted()

$entries = New-Object System.Collections.ArrayList        # items: @{File=..; Mmproj=$bool; Index=N}
$n = 1
foreach ($f in $files) {
    [void]$entries.Add(@{File=$f; Mmproj=$false; Index=$n}); $n++
    if ($f.ToLower().Contains('ornith')) { [void]$entries.Add(@{File=$f; Mmproj=$true; Index=$n}); $n++ }
}

# case-sensitive JSON (file has keys differing only by case; ConvertFrom-Json chokes on those)
Add-Type -AssemblyName System.Web.Extensions
$jsSer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$jsSer.MaxJsonLength = 67108864

function Load-Args {
    if (Test-Path $argsFile) { $jsSer.DeserializeObject([System.IO.File]::ReadAllText($argsFile)) }
    else { New-Object 'System.Collections.Generic.Dictionary[string,object]' }
}
function Save-ArgsJson($dict) {
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine('{')
    $keys = @($dict.Keys)
    for ($k = 0; $k -lt $keys.Count; $k++) {
        $line = '  ' + $jsSer.Serialize($keys[$k]) + ': ' + $jsSer.Serialize([string]$dict[$keys[$k]])
        if ($k -lt $keys.Count - 1) { $line += ',' }
        [void]$sb.AppendLine($line)
    }
    [void]$sb.Append('}')
    [System.IO.File]::WriteAllText($argsFile, $sb.ToString(), $utf8NoBom)
}
function Get-StartupIndex {
    if (Test-Path $startFile) {
        try {
            $a = (Get-Content $startFile -Raw | ConvertFrom-Json).args
            if ($a -match '--args\s+(\d+)') { return [int]$Matches[1] }
        } catch {}
    }
    return 0
}
function Set-StartupIndex($i) {
    [System.IO.File]::WriteAllText($startFile, "{`r`n    `"args`": `"--args $i`"`r`n}`r`n", $utf8NoBom)
}
function Server-Up {
    try {
        $t = (New-Object Net.Sockets.TcpClient).ConnectAsync('127.0.0.1', 8080)
        return ($t.Wait(300) -and $t.Status -eq 'RanToCompletion')
    } catch { return $false }
}

$cfg = Load-Args
$script:startupIdx = Get-StartupIndex
$script:dirty = $false
$script:current = $null

# ---- ui ---------------------------------------------------------------
$form = New-Object System.Windows.Forms.Form
$form.Text = 'LLM Config'
$form.Size = New-Object System.Drawing.Size(1000, 620)
$form.MinimumSize = New-Object System.Drawing.Size(760, 460)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9.75)
$icoPath = Join-Path $dir 'llmconfig.ico'
if (Test-Path $icoPath) { $form.Icon = New-Object System.Drawing.Icon($icoPath) }

$split = New-Object System.Windows.Forms.SplitContainer
$split.Dock = 'Fill'; $split.SplitterDistance = 380; $split.FixedPanel = 'Panel1'
$form.Controls.Add($split)

# left: model list
$lblModels = New-Object System.Windows.Forms.Label
$lblModels.Text = "Models  (C:\cmodels)      *  = startup default"
$lblModels.Dock = 'Top'; $lblModels.Height = 28; $lblModels.TextAlign = 'MiddleLeft'; $lblModels.Padding = '8,0,0,0'
$list = New-Object System.Windows.Forms.ListBox
$list.Dock = 'Fill'; $list.IntegralHeight = $false; $list.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$split.Panel1.Controls.Add($list); $split.Panel1.Controls.Add($lblModels)

function Refresh-List {
    $sel = $list.SelectedIndex
    $list.BeginUpdate(); $list.Items.Clear()
    foreach ($e in $entries) {
        $mark = if ($e.Index -eq $script:startupIdx) { '* ' } else { '   ' }
        $name = [System.IO.Path]::GetFileNameWithoutExtension($e.File) + $(if ($e.Mmproj) { '  +MMPROJ' } else { '' })
        $tag  = if (-not $e.Mmproj -and -not $cfg.ContainsKey($e.File)) { '   [no args]' } else { '' }
        [void]$list.Items.Add(("{0}{1,2}  {2}{3}" -f $mark, $e.Index, $name, $tag))
    }
    if ($sel -ge 0 -and $sel -lt $list.Items.Count) { $list.SelectedIndex = $sel }
    $list.EndUpdate()
}

# right: args editor
$lblArgs = New-Object System.Windows.Forms.Label
$lblArgs.Text = 'Select a model'; $lblArgs.Dock = 'Top'; $lblArgs.Height = 28; $lblArgs.TextAlign = 'MiddleLeft'; $lblArgs.Padding = '8,0,0,0'
$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true; $box.ScrollBars = 'Vertical'; $box.WordWrap = $true; $box.Dock = 'Fill'
$box.Font = New-Object System.Drawing.Font('Consolas', 10)
$split.Panel2.Controls.Add($box); $split.Panel2.Controls.Add($lblArgs)

# bottom bar
$bar = New-Object System.Windows.Forms.FlowLayoutPanel
$bar.Dock = 'Bottom'; $bar.Height = 46; $bar.Padding = '6,6,6,6'
$form.Controls.Add($bar)

function New-Btn($text, $w) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text; $b.Width = $w; $b.Height = 32
    [void]$bar.Controls.Add($b); return $b
}
$btnSave    = New-Btn 'Save args' 110
$btnDefault = New-Btn 'Set as startup default' 180
$btnRestart = New-Btn 'Restart server with this model' 230
$status = New-Object System.Windows.Forms.Label
$status.AutoSize = $true; $status.Padding = '12,8,0,0'
[void]$bar.Controls.Add($status)

function Set-Status($msg, $color) { $status.Text = $msg; $status.ForeColor = $color }

function Current-Entry { if ($list.SelectedIndex -ge 0) { $entries[$list.SelectedIndex] } }

function Load-Selection {
    $e = Current-Entry
    if (-not $e) { return }
    $script:current = $e
    if ($e.Mmproj) {
        $lblArgs.Text = "$($e.File)  (+MMPROJ variant - args come from base model, launcher adds --mmproj)"
        $box.Text = ''; $box.Enabled = $false; $btnSave.Enabled = $false
    } else {
        $lblArgs.Text = "Args for  $($e.File)"
        $box.Enabled = $true; $btnSave.Enabled = $true
        $v = ''
        if ($cfg.ContainsKey($e.File)) { $v = [string]$cfg[$e.File] }
        $box.Text = $v
    }
    $script:dirty = $false
}

$list.add_SelectedIndexChanged({
    if ($script:dirty -and $script:current -and -not $script:current.Mmproj) {
        $r = [System.Windows.Forms.MessageBox]::Show("Save changes to $($script:current.File)?", 'Unsaved args', 'YesNo', 'Question')
        if ($r -eq 'Yes') {
            $cfg[$script:current.File] = $box.Text
            Save-ArgsJson $cfg
        }
    }
    Load-Selection
})
$box.add_TextChanged({ $script:dirty = $true })

$btnSave.add_Click({
    $e = Current-Entry
    if (-not $e -or $e.Mmproj) { return }
    $cfg[$e.File] = $box.Text
    Save-ArgsJson $cfg
    $script:dirty = $false
    Refresh-List
    Set-Status "Saved args for $($e.File)" ([System.Drawing.Color]::Green)
})

$btnDefault.add_Click({
    $e = Current-Entry
    if (-not $e) { return }
    Set-StartupIndex $e.Index
    $script:startupIdx = $e.Index
    Refresh-List
    Set-Status "Startup default -> #$($e.Index)" ([System.Drawing.Color]::Green)
})

$btnRestart.add_Click({
    $e = Current-Entry
    if (-not $e) { return }
    if ($script:dirty) { $btnSave.PerformClick() }
    Set-StartupIndex $e.Index
    $script:startupIdx = $e.Index
    Refresh-List
    Set-Status 'Restarting server...' ([System.Drawing.Color]::DarkOrange)
    $form.Refresh()
    Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 800
    Start-Process wscript.exe -ArgumentList "`"$dir\QWEN36MOECLI_TRAY.vbs`""
    Set-Status "Server starting with #$($e.Index) (tray icon, watch notification)" ([System.Drawing.Color]::Green)
})

Refresh-List
if ($script:startupIdx -ge 1 -and $script:startupIdx -le $entries.Count) { $list.SelectedIndex = $script:startupIdx - 1 }
elseif ($entries.Count -gt 0) { $list.SelectedIndex = 0 }
Set-Status $(if (Server-Up) { 'Server: running on :8080' } else { 'Server: stopped' }) ([System.Drawing.Color]::Gray)

[void]$form.ShowDialog()
