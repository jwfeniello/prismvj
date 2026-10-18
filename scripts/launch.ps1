$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$packagedDirectory = Join-Path $projectDirectory 'release\resolume-transports\PrismLive-win32-x64'
if (-not ((Test-Path -LiteralPath (Join-Path $packagedDirectory 'PrismLive.exe')) -and ((Test-Path -LiteralPath (Join-Path $packagedDirectory 'resources\app.asar')) -or (Test-Path -LiteralPath (Join-Path $packagedDirectory 'resources\app\dist\index.html'))))) {
    $packagedDirectory = Join-Path $projectDirectory 'release\manual-parity\PrismLive-win32-x64'
}
if (-not ((Test-Path -LiteralPath (Join-Path $packagedDirectory 'PrismLive.exe')) -and ((Test-Path -LiteralPath (Join-Path $packagedDirectory 'resources\app.asar')) -or (Test-Path -LiteralPath (Join-Path $packagedDirectory 'resources\app\dist\index.html'))))) {
    $packagedDirectory = Join-Path $projectDirectory 'release\reverse-smooth-dxv\PrismLive-win32-x64'
}
if (-not ((Test-Path -LiteralPath (Join-Path $packagedDirectory 'PrismLive.exe')) -and ((Test-Path -LiteralPath (Join-Path $packagedDirectory 'resources\app.asar')) -or (Test-Path -LiteralPath (Join-Path $packagedDirectory 'resources\app\dist\index.html'))))) {
    $packagedDirectory = Join-Path $projectDirectory 'release\smooth-transport\PrismLive-win32-x64'
}
if (-not ((Test-Path -LiteralPath (Join-Path $packagedDirectory 'PrismLive.exe')) -and ((Test-Path -LiteralPath (Join-Path $packagedDirectory 'resources\app.asar')) -or (Test-Path -LiteralPath (Join-Path $packagedDirectory 'resources\app\dist\index.html'))))) {
    $packagedDirectory = Join-Path $projectDirectory 'release\resizable-panels\PrismLive-win32-x64'
}
if (-not ((Test-Path -LiteralPath (Join-Path $packagedDirectory 'PrismLive.exe')) -and ((Test-Path -LiteralPath (Join-Path $packagedDirectory 'resources\app.asar')) -or (Test-Path -LiteralPath (Join-Path $packagedDirectory 'resources\app\dist\index.html'))))) {
    $packagedDirectory = Join-Path $projectDirectory 'release\snapshots\PrismLive-win32-x64'
}
if (-not ((Test-Path -LiteralPath (Join-Path $packagedDirectory 'PrismLive.exe')) -and ((Test-Path -LiteralPath (Join-Path $packagedDirectory 'resources\app.asar')) -or (Test-Path -LiteralPath (Join-Path $packagedDirectory 'resources\app\dist\index.html'))))) {
    $packagedDirectory = Join-Path $projectDirectory 'release\persistent-clips\PrismLive-win32-x64'
}
if (-not ((Test-Path -LiteralPath (Join-Path $packagedDirectory 'PrismLive.exe')) -and ((Test-Path -LiteralPath (Join-Path $packagedDirectory 'resources\app.asar')) -or (Test-Path -LiteralPath (Join-Path $packagedDirectory 'resources\app\dist\index.html'))))) {
    $packagedDirectory = Join-Path $projectDirectory 'release\new-manual-dashboard\PrismLive-win32-x64'
}
if (-not ((Test-Path -LiteralPath (Join-Path $packagedDirectory 'PrismLive.exe')) -and ((Test-Path -LiteralPath (Join-Path $packagedDirectory 'resources\app.asar')) -or (Test-Path -LiteralPath (Join-Path $packagedDirectory 'resources\app\dist\index.html'))))) {
    $packagedDirectory = Join-Path $projectDirectory 'release\reverse-thumbnails\PrismLive-win32-x64'
}
if (-not ((Test-Path -LiteralPath (Join-Path $packagedDirectory 'PrismLive.exe')) -and ((Test-Path -LiteralPath (Join-Path $packagedDirectory 'resources\app.asar')) -or (Test-Path -LiteralPath (Join-Path $packagedDirectory 'resources\app\dist\index.html'))))) {
    $packagedDirectory = Join-Path $projectDirectory 'release\mov-support\PrismLive-win32-x64'
}
if (-not ((Test-Path -LiteralPath (Join-Path $packagedDirectory 'PrismLive.exe')) -and ((Test-Path -LiteralPath (Join-Path $packagedDirectory 'resources\app.asar')) -or (Test-Path -LiteralPath (Join-Path $packagedDirectory 'resources\app\dist\index.html'))))) {
    $packagedDirectory = Join-Path $projectDirectory 'release\current\PrismLive-win32-x64'
}
if (-not ((Test-Path -LiteralPath (Join-Path $packagedDirectory 'PrismLive.exe')) -and ((Test-Path -LiteralPath (Join-Path $packagedDirectory 'resources\app.asar')) -or (Test-Path -LiteralPath (Join-Path $packagedDirectory 'resources\app\dist\index.html'))))) {
    $packagedDirectory = Join-Path $projectDirectory 'release\PrismLive-win32-x64'
}
$packagedApp = Join-Path $packagedDirectory 'PrismLive.exe'
$electronApp = Join-Path $projectDirectory 'node_modules\electron\dist\electron.exe'
$builtPage = Join-Path $projectDirectory 'dist\index.html'
$packagedArchive = Join-Path $packagedDirectory 'resources\app.asar'
$packagedPage = Join-Path $packagedDirectory 'resources\app\dist\index.html'
try {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    # Keep the test build usable when the Windows drive is full. Data lives
    # beside the project so replacing the packaged release preserves it.
    $dataDirectory = $projectDirectory + '-data'
    $profileDirectory = Join-Path $dataDirectory 'profile'
    if ($env:PRISM_TEST_DATA) {
        if (-not [IO.Path]::IsPathRooted($env:PRISM_TEST_DATA)) { throw 'PRISM_TEST_DATA must be an absolute directory.' }
        $profileDirectory = [IO.Path]::GetFullPath($env:PRISM_TEST_DATA)
    }
    $temporaryDirectory = Join-Path $dataDirectory 'temp'
    $diagnosticDirectory = Join-Path $dataDirectory 'logs'
    New-Item -ItemType Directory -Path $profileDirectory,$temporaryDirectory -Force | Out-Null
    New-Item -ItemType Directory -Path $diagnosticDirectory -Force | Out-Null
    $env:TEMP = $temporaryDirectory
    $env:TMP = $temporaryDirectory
    # SW_HIDE can suppress Electron's first editor.show(). Only automated
    # checks should hide the GUI process; a user launch must open its window.
    $automatedLaunch = $env:PRISM_HEADLESS -eq '1' -or $env:PRISM_TEST_DATA -or $env:NODE_TEST_CONTEXT -or ($env:CI -and $env:CI -notmatch '^(0|false)$')
    $windowStyle = if ($automatedLaunch) { 'Hidden' } else { 'Normal' }
    if (-not $automatedLaunch) {
        # Two packaged versions sharing one Chromium profile can leave the
        # launcher looking successful while the operator sees the old window.
        $releaseRoot = Join-Path $projectDirectory 'release'
        $existing = Get-CimInstance Win32_Process -Filter "Name = 'PrismLive.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $_.ExecutablePath -and $_.CommandLine -and
                $_.ExecutablePath.StartsWith($releaseRoot + '\', [StringComparison]::OrdinalIgnoreCase) -and
                $_.CommandLine.IndexOf($profileDirectory, [StringComparison]::OrdinalIgnoreCase) -ge 0
            } | Select-Object -First 1
        if ($existing) {
            if ($existing.ExecutablePath.StartsWith($packagedDirectory + '\', [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Prism Live is already running. Switch to its window, or close it before starting a fresh session.'
            }
            throw 'An older Prism Live build is still running. Close all Prism Live windows, then launch again to use the update.'
        }
    }
    $profileArgument = '--user-data-dir="' + $profileDirectory + '"'
    $diagnosticFile = Join-Path $diagnosticDirectory ('startup-' + [Guid]::NewGuid().ToString('N') + '.log')
    if ((Test-Path -LiteralPath $packagedApp) -and ((Test-Path -LiteralPath $packagedArchive) -or (Test-Path -LiteralPath $packagedPage))) {
        $launched = Start-Process -FilePath $packagedApp -ArgumentList $profileArgument -WorkingDirectory (Split-Path -Parent $packagedApp) -WindowStyle $windowStyle -RedirectStandardError $diagnosticFile -PassThru
    } elseif ((Test-Path -LiteralPath $electronApp) -and (Test-Path -LiteralPath $builtPage)) {
        $launched = Start-Process -FilePath $electronApp -ArgumentList @(('"' + $projectDirectory + '"'), $profileArgument) -WorkingDirectory $projectDirectory -WindowStyle $windowStyle -RedirectStandardError $diagnosticFile -PassThru
    } else {
        throw 'Prism Live needs a complete build. In the project folder, run npm ci and npm run build.'
    }
    if ($launched.WaitForExit(2500) -and $launched.ExitCode -ne 0) {
        $detail = if (Test-Path -LiteralPath $diagnosticFile) { Get-Content -LiteralPath $diagnosticFile -Raw } else { '' }
        throw "Prism Live could not start. $detail`nStartup details: $diagnosticFile"
    }
    exit 0
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
