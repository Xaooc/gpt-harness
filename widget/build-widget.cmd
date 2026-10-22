@echo off
rem Builds LunaWidget.exe with the C# compiler that ships with .NET Framework 4.x (no SDK needed).
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
set OUT=%~1
if "%OUT%"=="" set OUT=%USERPROFILE%\.claude\bin\luna-widget\LunaWidget.exe
for %%I in ("%OUT%") do if not exist "%%~dpI" mkdir "%%~dpI"
"%CSC%" /nologo /optimize+ /target:winexe /out:"%OUT%" /r:System.Web.Extensions.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll "%~dp0LunaWidget.cs"
