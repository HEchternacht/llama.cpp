@echo off
setlocal
rem usage: QWEN36MOECLI.BAT --args "1,Y"  (comma-separated answers fed to the launcher prompts)
rem        QWEN36MOECLI.BAT --args "3"
rem        QWEN36MOECLI.BAT              (interactive, same as QWEN36MOE.bat)

set ANSWERS=
if /i "%~1"=="--args" set ANSWERS=%~2

if "%ANSWERS%"=="" (
    python "%~dp0llama_launcher.py"
) else (
    (for %%a in (%ANSWERS%) do @echo %%a) | python "%~dp0llama_launcher.py"
)
pause
