. (Join-Path $PSScriptRoot 'common.ps1')
$nodePath = Get-BotNode
foreach ($name in @('data', 'logs', 'runtime')) { New-Item -ItemType Directory -Path (Join-Path $ProjectRoot $name) -Force | Out-Null }
[IO.File]::WriteAllText((Join-Path $ProjectRoot 'runtime\node-path.txt'), $nodePath)
if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot '.env'))) { Copy-Item -LiteralPath (Join-Path $ProjectRoot '.env.example') -Destination (Join-Path $ProjectRoot '.env') }
Push-Location $ProjectRoot
try {
    & $nodePath --test 'test/monitor.test.js' 'test/sources.test.js' 'test/cloud.test.js'
    if ($LASTEXITCODE -ne 0) { throw 'Os testes falharam.' }
} finally { Pop-Location }
Write-Output 'Instalação validada. Nenhum pacote extra, navegador ou ambiente Python é necessário.'
Write-Output 'Use iniciar-segundo-plano.bat para iniciar sem janela, status.bat para consultar e parar.bat para encerrar.'
