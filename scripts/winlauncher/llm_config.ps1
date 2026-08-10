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

# launcher-only flags (llama_launcher.py strips them before spawning the server):
#   --getcache   also compare/rebuild the prefix, not just restore it
#   --norestore  skip restoring the saved prefix at startup
function Has-Flag($s, $flag) { ([regex]"\s*--$flag\b").IsMatch([string]$s) }
function Set-Flag($s, $flag, $on) {
    $s = ([regex]"\s*--$flag\b").Replace([string]$s, '').Trim()
    if ($on) { $s = ($s + " --$flag").Trim() }
    return $s
}
function Cache-Paths($file, $argsText) {
    $slotDir = 'cache'
    if ([string]$argsText -match '--slot-save-path\s+"?([^\s"]+)') { $slotDir = $Matches[1] }
    $stem = [System.IO.Path]::GetFileNameWithoutExtension($file)
    $base = Join-Path $dir $slotDir
    return @((Join-Path $base "$stem-prefix.bin"), (Join-Path $base "$stem-prefix.meta.json"))
}

# ---- environment (llm_env.cmd) ----------------------------------------
# The launcher chain sources llm_env.cmd for its ggml/CUDA env vars. Only the block
# between the MANAGED markers is rewritten here; the comments around it are kept.
$envFile = Join-Path $dir 'llm_env.cmd'
$envBegin = 'rem === BEGIN MANAGED ==='
$envEnd   = 'rem === END MANAGED ==='

# Name / recommended value / on by default / note. Order is display order.
$envCatalog = @(
    @{N='GGML_SCHED_PREFETCH';   V='1'; Rec=$true;  Note='+25% pp (698->874 t/s). Overlaps expert weight uploads with compute. Needs ~420 MiB VRAM + a 2nd CUDA context: at -ncmoe 38 cuBLAS init aborts, use -ncmoe 44 or lower -ub.'}
    @{N='GGML_CUDA_REGISTER_HOST';V='1'; Rec=$true; Note='Pins mmap-backed CPU weights for faster H2D. Inert under --no-mmap; the 22 GiB range is too big to page-lock here anyway.'}
    @{N='GGML_CUDA_GRAPH_OPT';   V='1'; Rec=$false; Note='Measured, no gain: pp 864->852, tg 31.5->31.2.'}
    @{N='GGML_SCHED_PERF';       V='1'; Rec=$false; Note='DIAGNOSTIC. Synchronizes after every phase, destroying the overlap prefetch provides - its t/s is meaningless. Use bench_prefetch.cmd.'}
    @{N='GGML_MOE_STATS';        V='1'; Rec=$false; Note='DIAGNOSTIC. Expert routing histogram to stderr.'}
    @{N='GGML_SCHED_DEBUG';      V='1'; Rec=$false; Note='DIAGNOSTIC. Per-node backend assignment dump.'}
    @{N='GGML_SCHED_DEBUG_REALLOC';V='1'; Rec=$false; Note='DIAGNOSTIC.'}
    @{N='GGML_CUDA_ENABLE_UNIFIED_MEMORY';V='1'; Rec=$false; Note='Lets allocations spill silently to host RAM instead of failing. That spill is the demand-paging behind the multi-second stalls - a hard OOM is the signal you want.'}
    @{N='GGML_CUDA_NO_PINNED';   V='1'; Rec=$false; Note='Disables pinned staging. Slower.'}
    @{N='GGML_CUDA_DISABLE_FUSION';V='1'; Rec=$false; Note='Disables kernel fusion. Slower.'}
    @{N='GGML_CPU_DISABLE_FUSION';V='1'; Rec=$false; Note='Disables kernel fusion on the CPU backend. Slower.'}
    @{N='GGML_OP_OFFLOAD_MIN_BATCH';V='32'; Rec=$false; Note='Batch threshold for offloading ops to GPU (default 32). Untested here.'}
)

function Read-EnvBlock {
    # returns an ordered dict of NAME -> value for the vars currently set
    $d = New-Object 'System.Collections.Specialized.OrderedDictionary'
    if (-not (Test-Path $envFile)) { return $d }
    $inBlock = $false
    foreach ($line in [System.IO.File]::ReadAllLines($envFile)) {
        $t = $line.Trim()
        if ($t -eq $envBegin) { $inBlock = $true;  continue }
        if ($t -eq $envEnd)   { $inBlock = $false; continue }
        if (-not $inBlock) { continue }
        if ($t -match '^(?:if\s+not\s+defined\s+\S+\s+)?set\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
            $d[$Matches[1]] = $Matches[2].Trim()
        }
    }
    return $d
}

function Write-EnvBlock($dict) {
    $body = New-Object System.Collections.ArrayList
    [void]$body.Add($envBegin)
    foreach ($k in $dict.Keys) {
        [void]$body.Add("if not defined $k set $k=$($dict[$k])")
    }
    if ($dict.Count -eq 0) { [void]$body.Add('rem (no variables set)') }
    [void]$body.Add($envEnd)

    $out = New-Object System.Collections.ArrayList
    $inBlock = $false; $wrote = $false
    foreach ($line in [System.IO.File]::ReadAllLines($envFile)) {
        $t = $line.Trim()
        if ($t -eq $envBegin) { $inBlock = $true; foreach ($b in $body) { [void]$out.Add($b) }; $wrote = $true; continue }
        if ($t -eq $envEnd)   { $inBlock = $false; continue }
        if (-not $inBlock) { [void]$out.Add($line) }
    }
    if (-not $wrote) { throw "markers not found in $envFile" }
    [System.IO.File]::WriteAllText($envFile, (($out -join "`r`n") + "`r`n"), $utf8NoBom)
}

$cfg = Load-Args
$script:startupIdx = Get-StartupIndex
$script:dirty = $false
$script:current = $null
$script:loading = $false

# ---- ui ---------------------------------------------------------------
$form = New-Object System.Windows.Forms.Form
$form.Text = 'LLM Config'
$form.Size = New-Object System.Drawing.Size(1000, 620)
$form.MinimumSize = New-Object System.Drawing.Size(760, 460)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9.75)
$icoPath = Join-Path $dir 'llmconfig.ico'
if (Test-Path $icoPath) { $form.Icon = New-Object System.Drawing.Icon($icoPath) }

$tabs = New-Object System.Windows.Forms.TabControl
$tabs.Dock = 'Fill'
$tabCfg  = New-Object System.Windows.Forms.TabPage; $tabCfg.Text  = 'Config'
$tabEnv  = New-Object System.Windows.Forms.TabPage; $tabEnv.Text  = 'Environment'
$tabLogs = New-Object System.Windows.Forms.TabPage; $tabLogs.Text = 'Logs'
[void]$tabs.TabPages.Add($tabCfg); [void]$tabs.TabPages.Add($tabEnv); [void]$tabs.TabPages.Add($tabLogs)
$form.Controls.Add($tabs)

$split = New-Object System.Windows.Forms.SplitContainer
$split.Dock = 'Fill'; $split.SplitterDistance = 380; $split.FixedPanel = 'Panel1'
$tabCfg.Controls.Add($split)

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
function New-FlagBox($text) {
    $c = New-Object System.Windows.Forms.CheckBox
    $c.Text = $text; $c.Dock = 'Bottom'; $c.Height = 28; $c.Padding = '8,3,0,0'
    return $c
}
$chkGetCache  = New-FlagBox 'getcache  -  build / refresh the prompt-prefix cache (off = restore only, no slots-debug)'
$chkNoRestore = New-FlagBox 'disable restore  -  do not load the saved prefix at startup'
$split.Panel2.Controls.Add($box); $split.Panel2.Controls.Add($lblArgs)
$split.Panel2.Controls.Add($chkGetCache); $split.Panel2.Controls.Add($chkNoRestore)

# bottom bar
$bar = New-Object System.Windows.Forms.FlowLayoutPanel
$bar.Dock = 'Bottom'; $bar.Height = 46; $bar.Padding = '6,6,6,6'
$tabCfg.Controls.Add($bar)

function New-Btn($text, $w) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text; $b.Width = $w; $b.Height = 32
    [void]$bar.Controls.Add($b); return $b
}
$btnSave    = New-Btn 'Save args' 110
$btnDefault = New-Btn 'Set as startup default' 180
$btnRestart = New-Btn 'Restart server with this model' 230
$btnDelCache = New-Btn 'Delete cache' 120
$status = New-Object System.Windows.Forms.Label
$status.AutoSize = $true; $status.Padding = '12,8,0,0'
[void]$bar.Controls.Add($status)

function Set-Status($msg, $color) { $status.Text = $msg; $status.ForeColor = $color }

function Current-Entry { if ($list.SelectedIndex -ge 0) { $entries[$list.SelectedIndex] } }

function Load-Selection {
    $e = Current-Entry
    if (-not $e) { return }
    $script:current = $e
    $script:loading = $true
    if ($e.Mmproj) {
        $lblArgs.Text = "$($e.File)  (+MMPROJ variant - args come from base model, launcher adds --mmproj)"
        $box.Text = ''; $box.Enabled = $false; $btnSave.Enabled = $false
        $chkGetCache.Checked  = $false; $chkGetCache.Enabled  = $false
        $chkNoRestore.Checked = $false; $chkNoRestore.Enabled = $false
    } else {
        $lblArgs.Text = "Args for  $($e.File)"
        $box.Enabled = $true; $btnSave.Enabled = $true
        $v = ''
        if ($cfg.ContainsKey($e.File)) { $v = [string]$cfg[$e.File] }
        $box.Text = $v
        $chkGetCache.Enabled  = $true; $chkGetCache.Checked  = (Has-Flag $v 'getcache')
        $chkNoRestore.Enabled = $true; $chkNoRestore.Checked = (Has-Flag $v 'norestore')
    }
    $script:loading = $false
    Refresh-CacheBtn
    $script:dirty = $false
}

function Refresh-CacheBtn {
    $e = Current-Entry
    if (-not $e) { $btnDelCache.Enabled = $false; $btnDelCache.Text = 'Delete cache'; return }
    $argsText = if ($cfg.ContainsKey($e.File)) { [string]$cfg[$e.File] } else { '' }
    $bytes = 0
    foreach ($p in (Cache-Paths $e.File $argsText)) {
        if (Test-Path $p) { $bytes += (Get-Item $p).Length }
    }
    $btnDelCache.Enabled = ($bytes -gt 0)
    $btnDelCache.Text = if ($bytes -gt 0) { 'Delete cache ({0:N0} MB)' -f ($bytes / 1MB) } else { 'No cache' }
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
$box.add_TextChanged({
    $script:dirty = $true
    if (-not $script:loading) {
        $script:loading = $true
        $chkGetCache.Checked  = (Has-Flag $box.Text 'getcache')
        $chkNoRestore.Checked = (Has-Flag $box.Text 'norestore')
        $script:loading = $false
    }
})
$chkGetCache.add_CheckedChanged({
    if ($script:loading) { return }
    $box.Text = Set-Flag $box.Text 'getcache' $chkGetCache.Checked
})
$chkNoRestore.add_CheckedChanged({
    if ($script:loading) { return }
    $box.Text = Set-Flag $box.Text 'norestore' $chkNoRestore.Checked
})

$btnSave.add_Click({
    $e = Current-Entry
    if (-not $e -or $e.Mmproj) { return }
    $cfg[$e.File] = $box.Text
    Save-ArgsJson $cfg
    $script:dirty = $false
    Refresh-List
    Refresh-CacheBtn
    Set-Status "Saved args for $($e.File)" ([System.Drawing.Color]::Green)
})

$btnDelCache.add_Click({
    $e = Current-Entry
    if (-not $e) { return }
    $argsText = if ($cfg.ContainsKey($e.File)) { [string]$cfg[$e.File] } else { '' }
    $paths = @(Cache-Paths $e.File $argsText | Where-Object { Test-Path $_ })
    if (-not $paths) { Refresh-CacheBtn; return }
    $msg = "Delete the prompt-prefix cache for $($e.File)?`r`n`r`n" + (($paths | ForEach-Object { [System.IO.Path]::GetFileName($_) }) -join "`r`n") +
           "`r`n`r`nIt will be rebuilt on the next run only if getcache is enabled."
    if ([System.Windows.Forms.MessageBox]::Show($msg, 'Delete cache', 'YesNo', 'Warning') -ne 'Yes') { return }
    try {
        foreach ($p in $paths) { Remove-Item -LiteralPath $p -Force -ErrorAction Stop }
        Set-Status "Deleted cache for $($e.File)" ([System.Drawing.Color]::Green)
    } catch {
        Set-Status "Delete failed: $($_.Exception.Message)" ([System.Drawing.Color]::Red)
    }
    Refresh-CacheBtn
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

# ---- environment tab --------------------------------------------------
$envGrid = New-Object System.Windows.Forms.DataGridView
$envGrid.Dock = 'Fill'
$envGrid.AllowUserToAddRows = $false; $envGrid.AllowUserToDeleteRows = $false
$envGrid.AllowUserToResizeRows = $false; $envGrid.RowHeadersVisible = $false
$envGrid.SelectionMode = 'FullRowSelect'; $envGrid.MultiSelect = $false
$envGrid.BackgroundColor = [System.Drawing.Color]::White
$envGrid.AutoSizeColumnsMode = 'Fill'

$colOn = New-Object System.Windows.Forms.DataGridViewCheckBoxColumn
$colOn.HeaderText = 'On'; $colOn.Name = 'On'; $colOn.FillWeight = 8
$colVar = New-Object System.Windows.Forms.DataGridViewTextBoxColumn
$colVar.HeaderText = 'Variable'; $colVar.Name = 'Var'; $colVar.ReadOnly = $true; $colVar.FillWeight = 42
$colVal = New-Object System.Windows.Forms.DataGridViewTextBoxColumn
$colVal.HeaderText = 'Value'; $colVal.Name = 'Val'; $colVal.FillWeight = 14
$colRec = New-Object System.Windows.Forms.DataGridViewTextBoxColumn
$colRec.HeaderText = 'Recommended'; $colRec.Name = 'Rec'; $colRec.ReadOnly = $true; $colRec.FillWeight = 20
foreach ($c in @($colOn, $colVar, $colVal, $colRec)) { [void]$envGrid.Columns.Add($c) }

$envNote = New-Object System.Windows.Forms.TextBox
$envNote.Multiline = $true; $envNote.ReadOnly = $true; $envNote.ScrollBars = 'Vertical'
$envNote.Dock = 'Bottom'; $envNote.Height = 84; $envNote.BackColor = [System.Drawing.Color]::White
$envNote.Font = New-Object System.Drawing.Font('Segoe UI', 9)

$envBar = New-Object System.Windows.Forms.FlowLayoutPanel
$envBar.Dock = 'Top'; $envBar.Height = 46; $envBar.Padding = '6,6,6,6'
$tabEnv.Controls.Add($envGrid); $tabEnv.Controls.Add($envNote); $tabEnv.Controls.Add($envBar)

function New-EnvBtn($text, $w) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text; $b.Width = $w; $b.Height = 32
    [void]$envBar.Controls.Add($b); return $b
}
$btnEnvSave = New-EnvBtn 'Save' 90
$btnEnvRec  = New-EnvBtn 'Restore recommended' 175
$btnEnvOpen = New-EnvBtn 'Open llm_env.cmd' 150
$envStatus = New-Object System.Windows.Forms.Label
$envStatus.AutoSize = $true; $envStatus.Padding = '12,8,0,0'
[void]$envBar.Controls.Add($envStatus)

function Load-EnvGrid {
    $set = Read-EnvBlock
    $envGrid.Rows.Clear()
    foreach ($v in $envCatalog) {
        $on  = $set.Contains($v.N)
        $val = if ($on) { [string]$set[$v.N] } else { $v.V }
        $rec = if ($v.Rec) { "on ($($v.V))" } else { 'off' }
        [void]$envGrid.Rows.Add($on, $v.N, $val, $rec)
    }
    # anything set in the file but not in the catalog - keep it, do not silently drop
    foreach ($k in $set.Keys) {
        if (-not ($envCatalog | Where-Object { $_.N -eq $k })) {
            [void]$envGrid.Rows.Add($true, $k, [string]$set[$k], 'not in catalog')
        }
    }
    foreach ($row in $envGrid.Rows) {
        $c = $envCatalog | Where-Object { $_.N -eq $row.Cells['Var'].Value } | Select-Object -First 1
        if ($c -and -not $c.Rec) { $row.Cells['Rec'].Style.ForeColor = [System.Drawing.Color]::Gray }
    }
    $envStatus.Text = ''
}

function Show-EnvNote {
    if ($envGrid.CurrentRow -eq $null) { return }
    $name = [string]$envGrid.CurrentRow.Cells['Var'].Value
    $c = $envCatalog | Where-Object { $_.N -eq $name } | Select-Object -First 1
    $envNote.Text = if ($c) { "$name`r`n$($c.Note)" } else { "$name`r`nSet in llm_env.cmd but not in the catalog - left as is." }
}

# checkbox edits only commit on focus change otherwise
$envGrid.add_CurrentCellDirtyStateChanged({
    if ($envGrid.IsCurrentCellDirty) { $envGrid.CommitEdit([System.Windows.Forms.DataGridViewDataErrorContexts]::Commit) }
})
$envGrid.add_SelectionChanged({ Show-EnvNote })

$btnEnvSave.add_Click({
    $d = New-Object 'System.Collections.Specialized.OrderedDictionary'
    foreach ($row in $envGrid.Rows) {
        if ($row.Cells['On'].Value -ne $true) { continue }
        $name = [string]$row.Cells['Var'].Value
        $val  = ([string]$row.Cells['Val'].Value).Trim()
        if ($val -eq '') { $val = '1' }
        $d[$name] = $val
    }
    try {
        Write-EnvBlock $d
        $envStatus.Text = "Saved $($d.Count) variable(s) - takes effect on next server start"
        $envStatus.ForeColor = [System.Drawing.Color]::Green
    } catch {
        $envStatus.Text = "Save failed: $($_.Exception.Message)"
        $envStatus.ForeColor = [System.Drawing.Color]::Red
    }
})

$btnEnvRec.add_Click({
    foreach ($row in $envGrid.Rows) {
        $c = $envCatalog | Where-Object { $_.N -eq $row.Cells['Var'].Value } | Select-Object -First 1
        if (-not $c) { continue }
        $row.Cells['On'].Value  = $c.Rec
        $row.Cells['Val'].Value = $c.V
    }
    $envStatus.Text = 'Recommended values loaded - press Save to write them'
    $envStatus.ForeColor = [System.Drawing.Color]::DarkOrange
})

$btnEnvOpen.add_Click({ if (Test-Path $envFile) { Start-Process notepad.exe "`"$envFile`"" } })

# ---- logs tab ---------------------------------------------------------
$logDir  = Join-Path $dir 'logs'
$logFile = Join-Path $logDir 'launcher.log'

$logBar = New-Object System.Windows.Forms.FlowLayoutPanel
$logBar.Dock = 'Top'; $logBar.Height = 46; $logBar.Padding = '6,6,6,6'
$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Multiline = $true; $logBox.ReadOnly = $true; $logBox.ScrollBars = 'Both'; $logBox.WordWrap = $false
$logBox.Dock = 'Fill'; $logBox.Font = New-Object System.Drawing.Font('Consolas', 9.5)
$logBox.BackColor = [System.Drawing.Color]::White
$tabLogs.Controls.Add($logBox); $tabLogs.Controls.Add($logBar)

function New-LogBtn($text, $w) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text; $b.Width = $w; $b.Height = 32
    [void]$logBar.Controls.Add($b); return $b
}
$btnLogRefresh = New-LogBtn 'Refresh' 90
$btnLogFolder  = New-LogBtn 'Open log folder' 140
$btnLogFull    = New-LogBtn 'Open full log' 130

function Refresh-Log {
    if (Test-Path $logFile) {
        $lines = Get-Content $logFile -Tail 500
        $logBox.Text = ($lines -join "`r`n")
        $logBox.SelectionStart = $logBox.Text.Length
        $logBox.ScrollToCaret()
    } else {
        $logBox.Text = "No events logged yet ($logFile)"
    }
}
$btnLogRefresh.add_Click({ Refresh-Log })
$btnLogFolder.add_Click({
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force $logDir | Out-Null }
    Start-Process explorer.exe $logDir
})
$btnLogFull.add_Click({ if (Test-Path $logFile) { Start-Process notepad.exe "`"$logFile`"" } })
$tabs.add_SelectedIndexChanged({
    if ($tabs.SelectedTab -eq $tabLogs) { Refresh-Log }
    if ($tabs.SelectedTab -eq $tabEnv)  { Load-EnvGrid; Show-EnvNote }
})

Refresh-List
if ($script:startupIdx -ge 1 -and $script:startupIdx -le $entries.Count) { $list.SelectedIndex = $script:startupIdx - 1 }
elseif ($entries.Count -gt 0) { $list.SelectedIndex = 0 }
Set-Status $(if (Server-Up) { 'Server: running on :8080' } else { 'Server: stopped' }) ([System.Drawing.Color]::Gray)

[void]$form.ShowDialog()
