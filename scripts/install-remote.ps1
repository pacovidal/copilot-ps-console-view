# Thin remote bootstrap: downloads install.ps1 and runs it with -FromGitHub
# and any args you pass through. Lets users do the simple form:
#
#   irm https://raw.githubusercontent.com/pacovidal/copilot-ps-console-view/main/scripts/install-remote.ps1 | iex
#
# or, with arguments, the (slightly less simple but still one-liner) form:
#
#   $bootstrap = "$env:TEMP\cpcv-install-remote.ps1"
#   irm https://raw.githubusercontent.com/pacovidal/copilot-ps-console-view/main/scripts/install-remote.ps1 -OutFile $bootstrap
#   & $bootstrap -Scope Global

$installerUrl = 'https://raw.githubusercontent.com/pacovidal/copilot-ps-console-view/main/scripts/install.ps1'

# When invoked with no args (typical `irm | iex` case), prompt for scope and
# offer to overwrite an existing install. If args were passed the user knows
# what they want — just forward them through.
$extraArgs = @{}
if ($args.Count -eq 0) {
    Write-Host ''
    Write-Host 'Install scope:' -ForegroundColor Cyan
    Write-Host '  [P] Per-project  (current folder, must be a git repo)'
    Write-Host '  [G] Global       (available in every Copilot CLI session)'
    while ($true) {
        $choice = (Read-Host 'Choose [P/G]').Trim().ToUpperInvariant()
        if ($choice -eq 'P' -or $choice -eq '') { break }
        if ($choice -eq 'G') { $extraArgs['Scope'] = 'Global'; break }
        Write-Host "  Please answer P or G." -ForegroundColor Yellow
    }

    # Compute the eventual install target so we can offer to overwrite it.
    $existingTarget = if ($extraArgs['Scope'] -eq 'Global') {
        Join-Path $env:USERPROFILE '.copilot\extensions\copilot-ps-console-view'
    } else {
        Join-Path (Get-Location).Path '.github\extensions\copilot-ps-console-view'
    }
    if (Test-Path $existingTarget) {
        Write-Host ''
        Write-Host "An existing install was found at:" -ForegroundColor Yellow
        Write-Host "  $existingTarget"
        while ($true) {
            $ow = (Read-Host 'Overwrite? [y/N]').Trim().ToUpperInvariant()
            if ($ow -eq 'Y') { $extraArgs['Force'] = $true; break }
            if ($ow -eq 'N' -or $ow -eq '') {
                Write-Host 'Aborted.' -ForegroundColor Yellow
                return
            }
            Write-Host "  Please answer y or n." -ForegroundColor Yellow
        }
    }
}

& ([scriptblock]::Create((Invoke-RestMethod $installerUrl))) -FromGitHub @extraArgs @args
