# Lower a process's memory priority so Windows can trim its pages before foreground apps.
# Usage: .\luna-mempri.ps1 -ProcessId <pid> [-Level VeryLow|Low|Medium] [-Tree]

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId,
    [ValidateSet('VeryLow', 'Low', 'Medium')]
    [string]$Level = 'Low',
    [switch]$Tree
)

$levelValues = @{
    VeryLow = 1
    Low = 2
    Medium = 3
}

if (-not ('LunaMemPri.NativeMethods' -as [type])) {
    $source = @'
using System;
using System.Runtime.InteropServices;

namespace LunaMemPri
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MemoryPriorityInformation
    {
        public UInt32 MemoryPriority;
    }

    public static class NativeMethods
    {
        public const UInt32 PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        public const UInt32 PROCESS_SET_INFORMATION = 0x0200;
        public const int ProcessMemoryPriority = 0;

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(UInt32 access, bool inheritHandle, int processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetProcessInformation(
            IntPtr process, int informationClass, ref MemoryPriorityInformation information,
            UInt32 informationSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetProcessInformation(
            IntPtr process, int informationClass, out MemoryPriorityInformation information,
            UInt32 informationSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);
    }
}
'@
    Add-Type -TypeDefinition $source -Language CSharp
}

function Get-ProcessName {
    param([int]$Id)
    try {
        return (Get-Process -Id $Id -ErrorAction Stop).ProcessName
    }
    catch {
        return 'unknown'
    }
}

function Write-MemoryPriority {
    param([int]$Id, [int]$Priority)

    $name = Get-ProcessName -Id $Id
    $access = [LunaMemPri.NativeMethods]::PROCESS_SET_INFORMATION -bor
        [LunaMemPri.NativeMethods]::PROCESS_QUERY_LIMITED_INFORMATION
    $handle = [LunaMemPri.NativeMethods]::OpenProcess($access, $false, $Id)
    if ($handle -eq [IntPtr]::Zero) {
        $message = (New-Object ComponentModel.Win32Exception(
            [Runtime.InteropServices.Marshal]::GetLastWin32Error())).Message
        [Console]::WriteLine("mempri pid=$Id name=$name level=$Priority error=$message")
        return $false
    }

    try {
        $information = New-Object LunaMemPri.MemoryPriorityInformation
        $information.MemoryPriority = [uint32]$Priority
        $size = [uint32][Runtime.InteropServices.Marshal]::SizeOf($information)
        if (-not [LunaMemPri.NativeMethods]::SetProcessInformation(
                $handle, [LunaMemPri.NativeMethods]::ProcessMemoryPriority,
                [ref]$information, $size)) {
            $message = (New-Object ComponentModel.Win32Exception(
                [Runtime.InteropServices.Marshal]::GetLastWin32Error())).Message
            [Console]::WriteLine("mempri pid=$Id name=$name level=$Priority error=$message")
            return $false
        }

        $readBack = New-Object LunaMemPri.MemoryPriorityInformation
        if (-not [LunaMemPri.NativeMethods]::GetProcessInformation(
                $handle, [LunaMemPri.NativeMethods]::ProcessMemoryPriority,
                [ref]$readBack, $size)) {
            $message = (New-Object ComponentModel.Win32Exception(
                [Runtime.InteropServices.Marshal]::GetLastWin32Error())).Message
            [Console]::WriteLine("mempri pid=$Id name=$name level=$Priority error=$message")
            return $false
        }

        [Console]::WriteLine("mempri pid=$Id name=$name level=$($readBack.MemoryPriority) ok")
        return $true
    }
    finally {
        [void][LunaMemPri.NativeMethods]::CloseHandle($handle)
    }
}

$target = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
if (-not $target) {
    [Console]::WriteLine(
        "mempri pid=$ProcessId name=unknown level=$($levelValues[$Level]) error=process does not exist")
    exit 1
}

$processIds = New-Object 'System.Collections.Generic.List[int]'
$processIds.Add($ProcessId)
if ($Tree) {
    try {
        $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    }
    catch {
        $name = Get-ProcessName -Id $ProcessId
        $message = $_.Exception.Message -replace '[\r\n]+', ' '
        [Console]::WriteLine(
            "mempri pid=$ProcessId name=$name level=$($levelValues[$Level]) error=$message")
        exit 2
    }

    $parentIds = New-Object 'System.Collections.Generic.HashSet[int]'
    [void]$parentIds.Add($ProcessId)
    do {
        $foundChild = $false
        foreach ($process in $processes) {
            $childId = [int]$process.ProcessId
            if ($parentIds.Contains([int]$process.ParentProcessId) -and
                -not $parentIds.Contains($childId)) {
                [void]$parentIds.Add($childId)
                $processIds.Add($childId)
                $foundChild = $true
            }
        }
    } while ($foundChild)
}

$failed = $false
foreach ($id in $processIds) {
    if (-not (Write-MemoryPriority -Id $id -Priority $levelValues[$Level])) {
        $failed = $true
    }
}

if ($failed) {
    exit 2
}
exit 0
