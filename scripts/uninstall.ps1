<#
.SYNOPSIS
    Uninstall the copilot-ps-console-view Copilot CLI extension.

.PARAMETER Scope
    Project or Global. Must match the scope used at install time.

.PARAMETER ProjectPath
    Used only when -Scope is Project. Defaults to the current directory.

.EXAMPLE
    .\uninstall.ps1
    .\uninstall.ps1 -Scope Global
#>
[CmdletBinding()]
param(
    [ValidateSet('Project', 'Global')]
    [string]$Scope = 'Project',
    [string]$ProjectPath = (Get-Location).Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ExtensionDirName = 'copilot-ps-console-view'

if ($Scope -eq 'Global') {
    $target = Join-Path $env:USERPROFILE ".copilot\extensions\$ExtensionDirName"
} else {
    $resolved = (Resolve-Path -LiteralPath $ProjectPath).Path
    $target = Join-Path $resolved ".github\extensions\$ExtensionDirName"
}

if (-not (Test-Path $target)) {
    Write-Host "Nothing to uninstall: $target does not exist." -ForegroundColor Yellow
    exit 0
}

# User themes live in <target>\themes\ (built-in themes live under content\themes\).
# Warn before they go — uninstall is destructive on purpose, but the user may
# want to copy them out first.
$userThemes = Join-Path $target 'themes'
if (Test-Path $userThemes) {
    $count = @(Get-ChildItem -LiteralPath $userThemes -File -Filter '*.css' -ErrorAction SilentlyContinue).Count
    if ($count -gt 0) {
        Write-Host "Note: $count user theme file(s) in $userThemes will also be removed." -ForegroundColor Yellow
        Write-Host "      Copy them out now if you want to keep them." -ForegroundColor Yellow
    }
}

Write-Host "Removing $target ..." -ForegroundColor Cyan
Remove-Item -Recurse -Force $target
Write-Host "✅ Uninstalled." -ForegroundColor Green
Write-Host "Reload Copilot CLI extensions (or restart) for the change to take effect."
