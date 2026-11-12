$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot

function Get-BotNode {
    $savedPath = Join-Path $ProjectRoot 'runtime\node-path.txt'
    $candidate = if (Test-Path -LiteralPath $savedPath) { (Get-Content -LiteralPath $savedPath -Raw).Trim() } else { (Get-Command node.exe -ErrorAction Stop).Source }
    if (-not (Test-Path -LiteralPath $candidate)) { throw 'Node.js não encontrado. Execute instalar.bat.' }
    & $candidate -e "if(Number(process.versions.node.split('.')[0])<24)process.exit(1);require('node:sqlite');"
    if ($LASTEXITCODE -ne 0) { throw 'É necessário Node.js 24 ou mais recente, com SQLite integrado.' }
    return $candidate
}

function Get-BotProcess {
    $processPath = Join-Path $ProjectRoot 'data\process.json'
    if (-not (Test-Path -LiteralPath $processPath)) { return $null }
    try {
        $info = Get-Content -LiteralPath $processPath -Raw | ConvertFrom-Json
        $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$info.pid)"
        $expectedScript = Join-Path $ProjectRoot 'src\cli.js'
        if ($candidate -and $candidate.Name -eq 'node.exe' -and $candidate.CommandLine -and $candidate.CommandLine.IndexOf($expectedScript, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $candidate.ExecutablePath -eq $info.executable) { return $candidate }
    } catch { return $null }
    return $null
}
