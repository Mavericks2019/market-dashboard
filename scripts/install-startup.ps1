$ErrorActionPreference = 'Stop'
$dashboardRoot = Split-Path -Parent $PSScriptRoot
$dashboardTaskName = 'Market Dashboard'
$dashboardUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$dashboardPowerShell = Join-Path $PSHOME 'powershell.exe'
$dashboardRunner = Join-Path $PSScriptRoot 'run-supervisor.ps1'
$dashboardArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $dashboardRunner + '"'
$dashboardAction = New-ScheduledTaskAction -Execute $dashboardPowerShell -Argument $dashboardArguments -WorkingDirectory $dashboardRoot
$dashboardLogon = New-ScheduledTaskTrigger -AtLogOn -User $dashboardUser
$dashboardRecovery = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$dashboardSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$dashboardPrincipal = New-ScheduledTaskPrincipal -UserId $dashboardUser -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $dashboardTaskName -Action $dashboardAction -Trigger @($dashboardLogon, $dashboardRecovery) -Settings $dashboardSettings -Principal $dashboardPrincipal -Description 'Keep the local market dashboard running and recover after service or supervisor exits.' -Force | Out-Null

$dashboardShortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'Market Dashboard.lnk'
if (Test-Path -LiteralPath $dashboardShortcutPath) {
    $dashboardShortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($dashboardShortcutPath)
    if ($dashboardShortcut.Arguments.Contains((Join-Path $dashboardRoot 'start-background.mjs'))) {
        $dashboardBackupDirectory = Join-Path $dashboardRoot 'data\startup-backup'
        New-Item -ItemType Directory -Path $dashboardBackupDirectory -Force | Out-Null
        Copy-Item -LiteralPath $dashboardShortcutPath -Destination (Join-Path $dashboardBackupDirectory 'Market Dashboard.lnk') -Force
        Remove-Item -LiteralPath $dashboardShortcutPath
    }
}

Start-ScheduledTask -TaskName $dashboardTaskName
Write-Output 'Market Dashboard startup and recovery task installed. Open http://localhost:4174/.'
