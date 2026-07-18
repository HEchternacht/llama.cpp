@echo off
rem Open in Vibe: ensure llama-server is up (start QWEN36MOECLI tray with --args 3 if not), then run vibe.
if not "%~1"=="" cd /d "%~1"

powershell -NoProfile -Command "try{$t=(New-Object Net.Sockets.TcpClient).ConnectAsync('127.0.0.1',8080);if($t.Wait(300) -and $t.Status -eq 'RanToCompletion'){exit 0}}catch{};exit 1"
if not errorlevel 1 goto run

wscript "%~dp0QWEN36MOECLI_TRAY.vbs"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0wait_server.ps1"
if errorlevel 1 (
    pause
    exit /b 1
)

:run
"C:\Program Files\Git\bin\bash.exe" -c vibe
