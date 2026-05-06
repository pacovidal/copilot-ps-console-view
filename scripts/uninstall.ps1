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

Write-Host "Removing $target ..." -ForegroundColor Cyan
Remove-Item -Recurse -Force $target
Write-Host "✅ Uninstalled." -ForegroundColor Green
Write-Host "Reload Copilot CLI extensions (or restart) for the change to take effect."
