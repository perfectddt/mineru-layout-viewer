$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $projectRoot 'start-viewer.cmd'
$icon = Join-Path $projectRoot 'assets\mineru-layout-viewer.ico'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'start-viewer.cmd.lnk'
$progId = 'MinerULayoutViewer.Document'
$appName = 'MinerU Layout Viewer'
$openCommand = ('"{0}" /d /c ""{1}" "%1""' -f $env:ComSpec, $launcher)

if (-not (Test-Path -LiteralPath $launcher)) { throw "Launcher not found: $launcher" }
if (-not (Test-Path -LiteralPath $icon)) { throw "Icon not found: $icon" }

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcher
$shortcut.WorkingDirectory = $projectRoot
$shortcut.IconLocation = "$icon,0"
$shortcut.Description = $appName
$shortcut.Save()

$classRoot = "HKCU:\Software\Classes\$progId"
New-Item -Path "$classRoot\shell\open\command" -Force | Out-Null
New-Item -Path "$classRoot\DefaultIcon" -Force | Out-Null
Set-Item -Path $classRoot -Value $appName
Set-ItemProperty -Path $classRoot -Name 'FriendlyTypeName' -Value $appName
Set-Item -Path "$classRoot\DefaultIcon" -Value "$icon,0"
Set-Item -Path "$classRoot\shell\open\command" -Value $openCommand

$applicationRoot = 'HKCU:\Software\Classes\Applications\start-viewer.cmd'
New-Item -Path "$applicationRoot\shell\open\command" -Force | Out-Null
New-Item -Path "$applicationRoot\SupportedTypes" -Force | Out-Null
New-Item -Path "$applicationRoot\DefaultIcon" -Force | Out-Null
Set-ItemProperty -Path $applicationRoot -Name 'FriendlyAppName' -Value $appName
Set-Item -Path "$applicationRoot\DefaultIcon" -Value "$icon,0"
Set-Item -Path "$applicationRoot\shell\open\command" -Value $openCommand

foreach ($extension in '.zip', '.md', '.markdown', '.org') {
  $extensionRoot = "HKCU:\Software\Classes\$extension"
  New-Item -Path "$extensionRoot\OpenWithProgids" -Force | Out-Null
  New-ItemProperty -Path "$extensionRoot\OpenWithProgids" -Name $progId -PropertyType None -Value ([byte[]]@()) -Force | Out-Null
  New-ItemProperty -Path "$applicationRoot\SupportedTypes" -Name $extension -PropertyType String -Value '' -Force | Out-Null
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ViewerShellRefresh {
    [DllImport("shell32.dll")]
    public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);
}
'@
[ViewerShellRefresh]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)

Write-Output "Desktop shortcut created: $shortcutPath"
Write-Output 'Open With registration added for .zip, .md, .markdown, and .org.'
