param(
    [switch]$IncludeHuggingFaceCache,
    [int]$KeepLingmaVersions = 3
)

$ErrorActionPreference = "SilentlyContinue"

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-DirSizeBytes {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return [int64]0
    }

    $sum = (Get-ChildItem -LiteralPath $Path -File -Recurse -Force -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum).Sum

    if ($null -eq $sum) {
        return [int64]0
    }

    return [int64]$sum
}

function Remove-DirectorySafe {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return [pscustomobject]@{
            Path     = $Path
            BeforeGB = 0
            AfterGB  = 0
            FreedGB  = 0
            Status   = "Missing"
        }
    }

    $before = Get-DirSizeBytes -Path $Path

    try {
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
        $status = "Removed"
    } catch {
        $status = "PartialOrLocked"
    }

    $after = Get-DirSizeBytes -Path $Path

    return [pscustomobject]@{
        Path     = $Path
        BeforeGB = [math]::Round($before / 1GB, 2)
        AfterGB  = [math]::Round($after / 1GB, 2)
        FreedGB  = [math]::Round(($before - $after) / 1GB, 2)
        Status   = $status
    }
}

function Clear-TempFolder {
    param(
        [string]$Path,
        [string[]]$SkipTopNames = @()
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return [pscustomobject]@{
            Path     = $Path
            BeforeGB = 0
            AfterGB  = 0
            FreedGB  = 0
            Status   = "Missing"
        }
    }

    $before = Get-DirSizeBytes -Path $Path

    $topItems = Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notin $SkipTopNames }

    foreach ($item in $topItems) {
        if ($item.PSIsContainer) {
            Get-ChildItem -LiteralPath $item.FullName -File -Recurse -Force -ErrorAction SilentlyContinue |
                ForEach-Object {
                    try {
                        Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop
                    } catch {
                    }
                }
        } else {
            try {
                Remove-Item -LiteralPath $item.FullName -Force -ErrorAction Stop
            } catch {
            }
        }
    }

    Get-ChildItem -LiteralPath $Path -Directory -Recurse -Force -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending |
        ForEach-Object {
            try {
                if (-not (Get-ChildItem -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue | Select-Object -First 1)) {
                    Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop
                }
            } catch {
            }
        }

    Get-ChildItem -LiteralPath $Path -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notin $SkipTopNames } |
        ForEach-Object {
            try {
                if (-not (Get-ChildItem -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue | Select-Object -First 1)) {
                    Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop
                }
            } catch {
            }
        }

    $after = Get-DirSizeBytes -Path $Path

    return [pscustomobject]@{
        Path     = $Path
        BeforeGB = [math]::Round($before / 1GB, 2)
        AfterGB  = [math]::Round($after / 1GB, 2)
        FreedGB  = [math]::Round(($before - $after) / 1GB, 2)
        Status   = "Processed"
    }
}

function Clear-WindowsUpdateDownload {
    $path = "C:\Windows\SoftwareDistribution\Download"

    if (-not (Test-Path -LiteralPath $path)) {
        return [pscustomobject]@{
            Path     = $path
            BeforeGB = 0
            AfterGB  = 0
            FreedGB  = 0
            Status   = "Missing"
        }
    }

    $before = Get-DirSizeBytes -Path $path
    $empty = Join-Path $env:TEMP "empty_sd_cleanup"

    try {
        Stop-Service wuauserv -Force -ErrorAction Stop
        Stop-Service bits -Force -ErrorAction Stop

        New-Item -ItemType Directory -Path $empty -Force | Out-Null
        robocopy $empty $path /MIR | Out-Null
        Remove-Item -LiteralPath $empty -Recurse -Force -ErrorAction SilentlyContinue

        $status = "Removed"
    } catch {
        $status = "PartialOrLocked"
    } finally {
        Start-Service bits -ErrorAction SilentlyContinue
        Start-Service wuauserv -ErrorAction SilentlyContinue
    }

    $after = Get-DirSizeBytes -Path $path

    return [pscustomobject]@{
        Path     = $path
        BeforeGB = [math]::Round($before / 1GB, 2)
        AfterGB  = [math]::Round($after / 1GB, 2)
        FreedGB  = [math]::Round(($before - $after) / 1GB, 2)
        Status   = $status
    }
}

function Get-LingmaOldVersionPaths {
    param([int]$KeepCount)

    $root = "C:\Users\59110\.lingma\bin"
    if (-not (Test-Path -LiteralPath $root)) {
        return @()
    }

    $versions = Get-ChildItem -LiteralPath $root -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^\d+(\.\d+){1,3}$' } |
        Sort-Object @{ Expression = { [version]$_.Name }; Descending = $true }

    if (-not $versions) {
        return @()
    }

    return $versions | Select-Object -Skip $KeepCount | ForEach-Object { $_.FullName }
}

$isAdmin = Test-Admin
$results = @()

Write-Host ""
Write-Host "Cleanup started..." -ForegroundColor Cyan
Write-Host ("Admin mode: {0}" -f $isAdmin) -ForegroundColor Cyan

$results += Clear-TempFolder -Path "C:\Users\59110\AppData\Local\Temp" -SkipTopNames @("claude-agent-tmp", "node-compile-cache")
$results += Clear-TempFolder -Path "C:\Windows\Temp"

if ($isAdmin) {
    $results += Clear-WindowsUpdateDownload
} else {
    $results += [pscustomobject]@{
        Path     = "C:\Windows\SoftwareDistribution\Download"
        BeforeGB = [math]::Round((Get-DirSizeBytes -Path "C:\Windows\SoftwareDistribution\Download") / 1GB, 2)
        AfterGB  = [math]::Round((Get-DirSizeBytes -Path "C:\Windows\SoftwareDistribution\Download") / 1GB, 2)
        FreedGB  = 0
        Status   = "SkippedNeedAdmin"
    }
}

$claudeTargets = @(
    "C:\Users\59110\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\vm_bundles",
    "C:\Users\59110\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude-code",
    "C:\Users\59110\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude-code-vm",
    "C:\Users\59110\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\Cache",
    "C:\Users\59110\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\Code Cache",
    "C:\Users\59110\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\GPUCache",
    "C:\Users\59110\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\DawnWebGPUCache",
    "C:\Users\59110\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\DawnGraphiteCache",
    "C:\Users\59110\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\Crashpad"
)

$lingmaTargets = @(
    "C:\Users\59110\.lingma\cache",
    "C:\Users\59110\.lingma\tmp",
    "C:\Users\59110\AppData\Roaming\lingma\SharedClientCache",
    "C:\Users\59110\AppData\Roaming\lingma\CachedExtensionVSIXs",
    "C:\Users\59110\AppData\Roaming\lingma\GPUCache",
    "C:\Users\59110\AppData\Roaming\lingma\CachedData",
    "C:\Users\59110\AppData\Roaming\lingma\Cache",
    "C:\Users\59110\AppData\Roaming\lingma\Code Cache",
    "C:\Users\59110\AppData\Roaming\lingma\Crashpad"
)

foreach ($path in $claudeTargets + $lingmaTargets) {
    $results += Remove-DirectorySafe -Path $path
}

$oldLingmaVersions = Get-LingmaOldVersionPaths -KeepCount $KeepLingmaVersions
foreach ($path in $oldLingmaVersions) {
    $results += Remove-DirectorySafe -Path $path
}

if ($IncludeHuggingFaceCache) {
    $results += Remove-DirectorySafe -Path "C:\Users\59110\.cache\huggingface"
}

$totalFreed = [math]::Round((($results | Measure-Object -Property FreedGB -Sum).Sum), 2)
$freeGB = [math]::Round(((Get-PSDrive -Name C).Free / 1GB), 2)

Write-Host ""
$results |
    Where-Object { $_.Status -ne "Missing" -or $_.FreedGB -gt 0 } |
    Sort-Object FreedGB -Descending |
    Format-Table -AutoSize

Write-Host ""
Write-Host ("Total freed: {0} GB" -f $totalFreed) -ForegroundColor Green
Write-Host ("C: free space: {0} GB" -f $freeGB) -ForegroundColor Green

if (-not $isAdmin) {
    Write-Host ""
    Write-Host "Tip: Run as Administrator next time to clear Windows Update cache too." -ForegroundColor Yellow
}
