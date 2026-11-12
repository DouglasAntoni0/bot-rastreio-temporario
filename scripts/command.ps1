param([ValidateSet('run', 'once', 'status', 'discover-chat', 'test-telegram', 'verify-source')][string]$Command = 'run')
. (Join-Path $PSScriptRoot 'common.ps1')
$nodePath = Get-BotNode
& $nodePath --max-old-space-size=64 (Join-Path $ProjectRoot 'src\cli.js') $Command
exit $LASTEXITCODE
