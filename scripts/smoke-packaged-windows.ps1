param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path $PSScriptRoot -Parent
$smokeDirectory = Join-Path $repositoryRoot 'dist\smoke'
$installDirectory = Join-Path $env:RUNNER_TEMP 'wok-release-smoke-install'
$profileDirectory = Join-Path $env:RUNNER_TEMP 'wok-release-smoke-profile'
$reportPath = Join-Path $smokeDirectory 'report.json'

if (Test-Path $installDirectory) { throw "Smoke install directory already exists: $installDirectory" }
New-Item -ItemType Directory -Force $smokeDirectory | Out-Null
New-Item -ItemType Directory -Force (Join-Path $profileDirectory 'config') | Out-Null
@{
    clientSplash = $false
    fullscreen = 'windowed'
    hideAds = 'off'
    immersiveSplash = $false
    introAnimation = $false
    introAudio = $false
    matchmaker = $false
    rawMouseInput = $false
} | ConvertTo-Json | Set-Content (Join-Path $profileDirectory 'config\settings.json') -Encoding utf8NoBOM

$installer = Start-Process -FilePath $InstallerPath -ArgumentList @('/S', '/NODESKTOP', '/NOSTARTMENU', "/D=$installDirectory") -Wait -PassThru
if ($installer.ExitCode -ne 0) { throw "Installer exited with code $($installer.ExitCode)." }

$executable = Join-Path $installDirectory 'wok-client.exe'
if (-not (Test-Path $executable)) { throw "Installed executable is missing: $executable" }

$env:WOK_RELEASE_SMOKE_REPORT = $reportPath
$env:WOK_USER_DATA_DIR = $profileDirectory
try {
    $client = Start-Process -FilePath $executable -PassThru
    if (-not $client.WaitForExit(90000)) {
        & taskkill.exe /PID $client.Id /T /F | Out-Host
        throw 'Packaged WOK did not finish its release smoke test within 90 seconds.'
    }
    $clientExitCode = $client.ExitCode
} finally {
    Remove-Item Env:WOK_RELEASE_SMOKE_REPORT -ErrorAction SilentlyContinue
    Remove-Item Env:WOK_USER_DATA_DIR -ErrorAction SilentlyContinue
}

if (-not (Test-Path $reportPath)) { throw "Release smoke report is missing: $reportPath" }
$reportText = Get-Content $reportPath -Raw
$report = $reportText | ConvertFrom-Json
Write-Host $reportText

if ($clientExitCode -ne 0) { throw "Packaged WOK exited with code $clientExitCode." }
if ($report.outcome -ne 'success') { throw "Release smoke outcome was $($report.outcome)." }
if (-not $report.visible) { throw 'Game window was not visible when usability was reported.' }
if ($report.forceHighPerformanceGpu) { throw 'Release enabled the forbidden forced-GPU switch.' }
if (-not $report.pixels.nonUniform) { throw 'Release screenshot was visually uniform.' }
if (-not $report.url.StartsWith('https://krunker.io')) { throw "Unexpected game URL: $($report.url)" }
if (-not (Test-Path $report.screenshotPath)) { throw "Release screenshot is missing: $($report.screenshotPath)" }
