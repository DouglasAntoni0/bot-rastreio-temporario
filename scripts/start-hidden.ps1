param([switch]$TaskMode)
. (Join-Path $PSScriptRoot 'common.ps1')
$nodePath = Get-BotNode
if (Get-BotProcess) { Write-Output 'O bot já está em execução.'; exit 0 }
$scriptPath = Join-Path $ProjectRoot 'src\cli.js'
$arguments = '--max-old-space-size=64 "' + $scriptPath + '" run --quiet'
$botProcess = Start-Process -FilePath $nodePath -ArgumentList $arguments -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru
try { $botProcess.PriorityClass = 'BelowNormal' } catch {}
if ($TaskMode) {
    $botProcess.WaitForExit()
    exit $botProcess.ExitCode
}
Start-Sleep -Seconds 2
$botProcess.Refresh()
if ($botProcess.HasExited) { throw 'O bot encerrou ao iniciar. Consulte logs\bot.log e execute iniciar.bat para ver o erro.' }
Write-Output ('Bot iniciado em segundo plano. PID: ' + $botProcess.Id)
