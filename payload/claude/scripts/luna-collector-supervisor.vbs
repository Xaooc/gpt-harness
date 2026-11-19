Option Explicit

Dim shell, files, home, node, envFile, line, cmd, stopped
Dim started, result, delay, shortRun
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
home = files.GetParentFolderName(files.GetParentFolderName(WScript.ScriptFullName))
stopped = home & "\luna-run\collector\stopped"
node = ""
If files.FileExists(home & "\luna-harness.env") Then
    Set envFile = CreateObject("ADODB.Stream")
    envFile.Type = 2
    envFile.Charset = "utf-8"
    envFile.Open
    envFile.LoadFromFile home & "\luna-harness.env"
    For Each line In Split(envFile.ReadText, vbLf)
        If Left(line, 10) = "LUNA_NODE=" Then
            node = Replace(Mid(line, 11), vbCr, "")
            Exit For
        End If
    Next
    envFile.Close
End If
If node = "" Then WScript.Quit 1
If Not files.FileExists(node) Then WScript.Quit 1

cmd = """" & node & """ """ & home & "\scripts\luna-collector.mjs"" run"
delay = 10000
Do
    started = Now
    result = shell.Run(cmd, 0, True)
    If result = 3 Or files.FileExists(stopped) Then Exit Do
    shortRun = DateDiff("s", started, Now) < 60
    If Not shortRun Then delay = 10000
    WScript.Sleep delay
    If files.FileExists(stopped) Then Exit Do
    If shortRun Then
        delay = delay * 2
        If delay > 300000 Then delay = 300000
    End If
Loop
