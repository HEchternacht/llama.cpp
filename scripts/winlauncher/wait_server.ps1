# Animated wait for llama-server /health = 200 (max 300s). Exit 0 ready, 1 timeout.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$start = Get-Date
$deadline = $start.AddSeconds(300)
$frames = '⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'
$i = 0
Write-Host ""
while ((Get-Date) -lt $deadline) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8080/health -TimeoutSec 1
        if ($r.StatusCode -eq 200) {
            Write-Host ("`r  ✔ llama-server ready in {0}s                    " -f [int]((Get-Date)-$start).TotalSeconds) -ForegroundColor Green
            exit 0
        }
    } catch {}
    foreach ($n in 1..5) {
        Write-Host ("`r  {0} Loading model... {1}s " -f $frames[$i++ % $frames.Count], [int]((Get-Date)-$start).TotalSeconds) -NoNewline -ForegroundColor Cyan
        Start-Sleep -Milliseconds 120
    }
}
Write-Host "`r  ✘ llama-server not healthy within 300s          " -ForegroundColor Red
exit 1
