Option Explicit

Dim shell, files, home, node, envFile, line, cmd, stopped, collector
Dim started, result, delay, shortRuns, epochFile, epoch
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
home = files.GetParentFolderName(files.GetParentFolderName(WScript.ScriptFullName))
stopped = home & "\luna-run\collector\stopped"
epochFile = home & "\luna-run\collector\supervisor-epoch"
If files.FileExists(stopped) Then WScript.Quit 0
epoch = ReadEpoch()
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

collector = home & "\scripts\luna-collector.mjs"
cmd = """" & node & """ """ & collector & """ run """ & epoch & """"
delay = 10000
shortRuns = 0
Do
    If files.FileExists(stopped) Or ReadEpoch() <> epoch Then Exit Do
    If Not files.FileExists(collector) Or Not files.FileExists(node) Then WScript.Quit 1
    started = Now
    result = shell.Run(cmd, 0, True)
    If result = 3 Or files.FileExists(stopped) Or ReadEpoch() <> epoch Then Exit Do
    If DateDiff("s", started, Now) < 60 Then
        shortRuns = shortRuns + 1
        If shortRuns >= 5 Then WScript.Quit 1
    Else
        shortRuns = 0
        delay = 10000
    End If
    WScript.Sleep delay
    If shortRuns > 0 Then
        delay = delay * 2
        If delay > 300000 Then delay = 300000
    End If
Loop

Function ReadEpoch()
    Dim stream
    ReadEpoch = "-"
    If Not files.FileExists(epochFile) Then Exit Function
    Set stream = files.OpenTextFile(epochFile, 1)
    ReadEpoch = stream.ReadAll
    stream.Close
End Function
