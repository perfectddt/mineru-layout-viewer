param([switch]$DisableShellIntegration, [switch]$ShellIntegrationOnly)
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcherScript = Join-Path $projectRoot 'start-viewer.ps1'
$icon = Join-Path $projectRoot 'assets\mineru-layout-viewer.ico'
$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
# A packaged host (an MSIX app such as the desktop client) redirects
# LocalApplicationData into its per-package LocalCache. Shell entries written
# with such a path point at a cache folder that Explorer may never see, so the
# file icon and the "open" verb break as soon as that cache is recycled.
if ($localAppData -match '\\Packages\\[^\\]+\\LocalCache\\') {
  $localAppData = Join-Path $env:USERPROFILE 'AppData\Local'
}
$launcherDirectory = Join-Path $localAppData 'MinerU Layout Viewer'
$launcherName = 'mineru-layout-viewer-launcher-v1.exe'
$launcher = Join-Path $launcherDirectory $launcherName
# Explorer needs a real icon: a ProgID without DefaultIcon falls back to the
# generic document icon, which is what "set as default app" would otherwise pick up.
$installedIcon = Join-Path $launcherDirectory 'mineru-layout-viewer.ico'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'MinerU Layout Viewer.lnk'
$progId = 'MinerULayoutViewer.Document'
$appName = 'MinerU Layout Viewer'
$openCommand = ('"{0}" "%1"' -f $launcher)
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$classesRoot = 'HKCU:\Software\Classes'
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $classesRoot = 'HKLM:\Software\Classes'
}
function Update-ViewerAssociations {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ViewerShellRefresh {
    [DllImport("shell32.dll")]
    public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);
}
'@
  [ViewerShellRefresh]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
}

if ($DisableShellIntegration) {
  foreach ($root in @('HKCU:\Software\Classes', $classesRoot) | Select-Object -Unique) {
    foreach ($verb in 'MinerULayoutViewer', 'MinerULayoutViewer.Open') {
      $key = "$root\Directory\shell\$verb"
      if (Test-Path $key) { Set-ItemProperty $key -Name LegacyDisable -Value '' }
    }
    foreach ($app in $launcherName, 'start-viewer.cmd') {
      $key = "$root\Applications\$app"
      if (Test-Path $key) { Set-ItemProperty $key -Name NoOpenWith -Value '' }
    }
    foreach ($extension in '.zip', '.md', '.markdown', '.org') {
      $key = "$root\$extension\OpenWithProgids"
      if (Test-Path $key) { Remove-ItemProperty $key -Name $progId -ErrorAction SilentlyContinue }
    }
  }
  Update-ViewerAssociations
  exit 0
}

if (-not (Test-Path -LiteralPath $launcherScript)) { throw "Launcher script not found: $launcherScript" }
if (-not (Test-Path -LiteralPath $icon)) { throw "Icon not found: $icon" }

New-Item -ItemType Directory -Path $launcherDirectory -Force | Out-Null
$projectRootForCSharp = $projectRoot.Replace('"', '""')
$launcherSourcePath = Join-Path $launcherDirectory 'mineru-layout-viewer-launcher-v1.cs'
$launcherBuild = Join-Path $launcherDirectory 'mineru-layout-viewer-launcher-v1.new.exe'
$launcherSource = @"
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

[assembly: AssemblyTitle("MinerU Layout Viewer")]
[assembly: AssemblyProduct("MinerU Layout Viewer")]
[assembly: AssemblyDescription("Open MinerU files and folders with MinerU Layout Viewer")]

public static class MinerULayoutViewerLauncher {
    private const string ProjectRoot = @"$projectRootForCSharp";

    private static string Quote(string value) {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    public static void Main(string[] args) {
        string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string powerShell = Path.Combine(programFiles, "PowerShell", "7", "pwsh.exe");
        if (!File.Exists(powerShell)) {
            powerShell = Path.Combine(localAppData, "Microsoft", "WindowsApps", "pwsh.exe");
        }
        if (!File.Exists(powerShell)) powerShell = "powershell.exe";

        string script = Path.Combine(ProjectRoot, "start-viewer.ps1");
        string arguments = "-NoProfile -ExecutionPolicy Bypass -File " + Quote(script);
        if (args.Length > 0) arguments += " -Paths";
        foreach (string argument in args) arguments += " " + Quote(argument);

        Process.Start(new ProcessStartInfo {
            FileName = powerShell,
            Arguments = arguments,
            WorkingDirectory = ProjectRoot,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            UseShellExecute = false
        });
    }
}
"@
Set-Content -LiteralPath $launcherSourcePath -Value $launcherSource -Encoding UTF8
$compilerCandidates = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$compiler = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $compiler) { throw 'The built-in .NET C# compiler was not found.' }
$compileArguments = '/nologo /target:winexe /win32icon:"{2}" /reference:System.dll /out:"{0}" "{1}"' -f $launcherBuild, $launcherSourcePath, $icon
$compile = Start-Process -FilePath $compiler -ArgumentList $compileArguments -Wait -PassThru -WindowStyle Hidden
if ($compile.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $launcherBuild)) {
  throw "Failed to build the Viewer launcher (compiler exit code $($compile.ExitCode))."
}
Move-Item -LiteralPath $launcherBuild -Destination $launcher -Force
Copy-Item -LiteralPath $icon -Destination $installedIcon -Force

if (-not $ShellIntegrationOnly) {
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcher
$shortcut.WorkingDirectory = $projectRoot
$shortcut.IconLocation = "$installedIcon,0"
$shortcut.Description = $appName
$shortcut.Save()
}

$classRoot = "$classesRoot\$progId"
New-Item -Path "$classRoot\shell\open\command" -Force | Out-Null
New-Item -Path "$classRoot\DefaultIcon" -Force | Out-Null
Set-Item -Path $classRoot -Value $appName
Set-ItemProperty -Path $classRoot -Name 'FriendlyTypeName' -Value $appName
Set-Item -Path "$classRoot\DefaultIcon" -Value "$installedIcon,0"
Set-Item -Path "$classRoot\shell\open\command" -Value $openCommand

$applicationRoot = "$classesRoot\Applications\$launcherName"
New-Item -Path "$applicationRoot\shell\open\command" -Force | Out-Null
New-Item -Path "$applicationRoot\SupportedTypes" -Force | Out-Null
New-Item -Path "$applicationRoot\DefaultIcon" -Force | Out-Null
Set-ItemProperty -Path $applicationRoot -Name 'FriendlyAppName' -Value $appName
Remove-ItemProperty -Path $applicationRoot -Name 'NoOpenWith' -ErrorAction SilentlyContinue
Remove-ItemProperty -Path "HKCU:\Software\Classes\Applications\$launcherName" -Name 'NoOpenWith' -ErrorAction SilentlyContinue
Set-Item -Path "$applicationRoot\DefaultIcon" -Value "$installedIcon,0"
Set-Item -Path "$applicationRoot\shell\open\command" -Value $openCommand

foreach ($extension in '.zip', '.md', '.markdown', '.org') {
  $extensionRoot = "$classesRoot\$extension"
  New-Item -Path "$extensionRoot\OpenWithProgids" -Force | Out-Null
  New-ItemProperty -Path "$extensionRoot\OpenWithProgids" -Name $progId -PropertyType None -Value ([byte[]]@()) -Force | Out-Null
  New-ItemProperty -Path "$applicationRoot\SupportedTypes" -Name $extension -PropertyType String -Value '' -Force | Out-Null
}

# Hide the previous batch launcher so Explorer does not show two identical apps.
$legacyApplicationRoot = 'HKCU:\Software\Classes\Applications\start-viewer.cmd'
if (Test-Path -LiteralPath $legacyApplicationRoot) {
  Set-ItemProperty -Path $legacyApplicationRoot -Name 'NoOpenWith' -Value ''
  $legacyShellRoot = "$classesRoot\Applications\start-viewer.cmd"
  New-Item -Path $legacyShellRoot -Force | Out-Null
  Set-ItemProperty -Path $legacyShellRoot -Name 'NoOpenWith' -Value ''
}

$directoryVerbRoot = "$classesRoot\Directory\shell\MinerULayoutViewer.Open"
New-Item -Path "$directoryVerbRoot\command" -Force | Out-Null
$directoryVerbLabel = "用 $appName 打开"
Set-Item -Path $directoryVerbRoot -Value $directoryVerbLabel
Set-ItemProperty -Path $directoryVerbRoot -Name 'MUIVerb' -Value $directoryVerbLabel
Set-ItemProperty -Path $directoryVerbRoot -Name 'Icon' -Value "$installedIcon,0"
Remove-ItemProperty -Path $directoryVerbRoot -Name 'LegacyDisable' -ErrorAction SilentlyContinue
Remove-ItemProperty -Path $directoryVerbRoot -Name 'Position' -ErrorAction SilentlyContinue
$directoryCommand = '"{0}" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{1}" -Paths "%V"' -f (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'), $launcherScript
Set-Item -Path "$directoryVerbRoot\command" -Value $directoryCommand
foreach ($oldClassesRoot in 'HKCU:\Software\Classes', $classesRoot) {
  $oldVerb = "$oldClassesRoot\Directory\shell\MinerULayoutViewer"
  if (Test-Path -LiteralPath $oldVerb) {
    Set-ItemProperty -Path $oldVerb -Name 'LegacyDisable' -Value ''
  }
}

Update-ViewerAssociations

Write-Output "Desktop shortcut created: $shortcutPath"
Write-Output 'Open With registration added for .zip, .md, .markdown, and .org.'
Write-Output 'Directory context-menu entry added.'
