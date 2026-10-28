' Silent launcher for router mode: hidden tray icon, auto-closes when all pi/vibe instances exit.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\tray_wrapper.ps1"" -Bat start_router.bat -WatchVibe", 0, False
