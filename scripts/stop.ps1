. (Join-Path $PSScriptRoot 'common.ps1')
$botProcess = Get-BotProcess
if (-not $botProcess) { Write-Output 'O bot não está em execução nesta pasta.'; exit 0 }
$stopPath = Join-Path $ProjectRoot 'data\stop.request'
[IO.File]::WriteAllText($stopPath, 'stop')
$deadline = [DateTime]::UtcNow.AddSeconds(25)
do {
    Start-Sleep -Milliseconds 300
    if (-not (Get-BotProcess)) { Write-Output 'Bot encerrado com segurança. Os dados foram preservados.'; exit 0 }
} while ([DateTime]::UtcNow -lt $deadline)
throw 'O bot não confirmou o encerramento. Use Ctrl+C na janela de iniciar.bat ou confira o PID em status.bat.'
