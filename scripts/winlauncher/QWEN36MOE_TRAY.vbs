' Silent launcher: no console flash. Double-click this to start QWEN36MOE in tray.
' Auto-closes when all vibe instances exit (only if vibe was seen running at least once).
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\tray_wrapper.ps1"" -Bat QWEN36MOE.bat -WatchVibe", 0, False
