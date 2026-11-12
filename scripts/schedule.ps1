param([switch]$Remove)
. (Join-Path $PSScriptRoot 'common.ps1')
$nodePath = Get-BotNode
Push-Location $ProjectRoot
try {
    $protocol = & $nodePath --input-type=module -e "import {loadConfig} from './src/config.js'; console.log(loadConfig({needToken:false,needChat:false,needShipment:false}).shipment.protocol ?? '');"
    if ($LASTEXITCODE -ne 0 -or $protocol -notmatch '^\d{1,20}$') { throw 'Configure RODONAVES_PROTOCOLO no .env.' }
} finally { Pop-Location }
$taskName = 'RastreioRodonaves-' + $protocol
if ($Remove) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output 'Inicialização automática desativada. O processo que já estiver aberto pode ser encerrado com parar.bat.'
    exit 0
}
$userName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$scriptHost = Join-Path $env:SystemRoot 'System32\wscript.exe'
$launchScript = Join-Path $PSScriptRoot 'run-task.js'
$arguments = '//B //NoLogo "' + $launchScript + '" "' + $nodePath + '"'
$action = New-ScheduledTaskAction -Execute $scriptHost -Argument $arguments -WorkingDirectory $ProjectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userName
$principal = New-ScheduledTaskPrincipal -UserId $userName -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$settings.Priority = 7
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Rastreio Rodonaves a cada 5 minutos. Node.js leve, sem navegador.' -Force | Out-Null
Write-Output 'Inicialização automática ativada para o próximo login. Use iniciar-segundo-plano.bat para iniciar agora.'
