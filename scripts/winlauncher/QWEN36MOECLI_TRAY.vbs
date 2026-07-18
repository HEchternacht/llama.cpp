' Silent launcher: reads args from QWEN36MOECLI_config.json, tray hidden, auto-closes when all vibe instances exit.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
configPath = dir & "\QWEN36MOECLI_config.json"
batArgs = ReadJsonArg(configPath, "args")
CreateObject("WScript.Shell").Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\tray_wrapper.ps1"" -Bat QWEN36MOECLI.BAT -BatArgs """ & batArgs & """ -WatchVibe", 0, False

Function ReadJsonArg(filePath, key)
    Dim f, text, re, m
    Set f = fso.OpenTextFile(filePath, 1, False)
    text = f.ReadAll
    f.Close
    Set re = New RegExp
    re.Pattern = """" & key & """\s*:\s*""([^""]*)"""
    re.Global = False
    If re.Test(text) Then
        Set m = re.Execute(text)(0)
        ReadJsonArg = m.SubMatches(0)
    Else
        ReadJsonArg = ""
    End If
End Function
