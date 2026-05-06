<#
.SYNOPSIS
    Install the copilot-ps-console-view Copilot CLI extension.

.DESCRIPTION
    Copies the extension into the appropriate Copilot CLI extension discovery
    directory and runs `npm install` so it is ready to load on the next
    Copilot CLI session start.

    By default the script installs from the local working tree it lives in
    (whatever you currently have checked out, modified or not). Pass
    -FromGitHub to instead clone or download a fresh copy from GitHub.

.PARAMETER Scope
    Project  -> install into <ProjectPath>\.github\extensions\copilot-ps-console-view\
               (the project must be a git repository for Copilot to discover it)
    Global   -> install into $env:USERPROFILE\.copilot\extensions\copilot-ps-console-view\
               (available in every Copilot CLI session for the current user)

.PARAMETER ProjectPath
    Used only when -Scope is Project. Defaults to the current directory.

.PARAMETER FromGitHub
    Install from GitHub instead of the local working tree. Implied when
    -Ref or -RepoUrl is specified.

.PARAMETER Ref
    Branch or tag to install. Only used with -FromGitHub. Defaults to "main".
    (Arbitrary commit SHAs are not reliably supported by `git clone --branch`
    or the codeload tarball URL.)

.PARAMETER RepoUrl
    Override the source repository URL. Only used with -FromGitHub.
    Defaults to the public GitHub URL.

.PARAMETER Force
    Overwrite an existing install at the target path.

.EXAMPLE
    # Install for the current project, from the local working tree
    .\install.ps1

.EXAMPLE
    # Install globally, from the local working tree
    .\install.ps1 -Scope Global

.EXAMPLE
    # Install from GitHub (e.g. when running the script via irm | iex)
    .\install.ps1 -FromGitHub

.EXAMPLE
    # Install a specific branch from GitHub
    .\install.ps1 -FromGitHub -Ref my-feature-branch
#>
[CmdletBinding()]
param(
    [ValidateSet('Project', 'Global')]
    [string]$Scope = 'Project',
    [string]$ProjectPath = (Get-Location).Path,
    [switch]$FromGitHub,
    [string]$Ref,
    [string]$RepoUrl,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ExtensionDirName = 'copilot-ps-console-view'
$DefaultRef = 'main'
$DefaultRepoUrl = 'https://github.com/pacovidal/copilot-ps-console-view.git'

# Treat any explicit Ref/RepoUrl as opting into the GitHub flow. If the user
# *explicitly* passed -FromGitHub:$false alongside -Ref/-RepoUrl, that's a
# conflict — bail rather than silently overriding their intent.
$refOrUrlGiven = $PSBoundParameters.ContainsKey('Ref') -or $PSBoundParameters.ContainsKey('RepoUrl')
if ($refOrUrlGiven -and $PSBoundParameters.ContainsKey('FromGitHub') -and -not $FromGitHub) {
    throw "-Ref / -RepoUrl require -FromGitHub. Remove -FromGitHub:`$false, or omit -Ref / -RepoUrl."
}
if ($refOrUrlGiven) { $FromGitHub = $true }
if (-not $Ref)     { $Ref     = $DefaultRef }
if (-not $RepoUrl) { $RepoUrl = $DefaultRepoUrl }

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn2($m)  { Write-Host "    $m"   -ForegroundColor Yellow }

function Resolve-TargetDir {
    param([string]$Scope, [string]$ProjectPath)
    if ($Scope -eq 'Global') {
        $base = Join-Path $env:USERPROFILE '.copilot\extensions'
    } else {
        $resolved = (Resolve-Path -LiteralPath $ProjectPath).Path
        # Refuse to install Project-scoped into the cpcv source repo itself —
        # the install would create .github/extensions/copilot-ps-console-view
        # inside its own working tree, polluting it.
        $pkgPath = Join-Path $resolved 'package.json'
        if (Test-Path $pkgPath) {
            try {
                $pkg = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json
                if ($pkg.name -eq $ExtensionDirName) {
                    throw "ProjectPath '$resolved' is the $ExtensionDirName source repo itself. Pass -Scope Global, or pass -ProjectPath pointing at the project where you want to install."
                }
            } catch [System.Management.Automation.RuntimeException] {
                throw  # rethrow our own validation error
            } catch {
                # Malformed package.json — fall through; not our problem.
            }
        }
        # Sanity check: warn if not inside a git repo (Copilot only scans .github/extensions
        # relative to the git root).
        Push-Location $resolved
        try {
            $null = git rev-parse --is-inside-work-tree 2>$null
            if ($LASTEXITCODE -ne 0) {
                Write-Warn2 "WARNING: '$resolved' is not inside a git repository."
                Write-Warn2 "         Copilot CLI only discovers project extensions under the git root's .github\extensions\."
            }
        } finally { Pop-Location }
        $base = Join-Path $resolved '.github\extensions'
    }
    return Join-Path $base $ExtensionDirName
}

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Save-UserThemes {
    # Move <Target>\themes\ to a temp path before the existing tree is wiped,
    # so user-authored theme files survive an upgrade. Returns the backup path
    # (or $null if nothing was backed up). Pair with Restore-UserThemes.
    param([string]$Target)
    $themes = Join-Path $Target 'themes'
    if (-not (Test-Path $themes)) { return $null }
    $backup = Join-Path $env:TEMP "$ExtensionDirName-themes-$([guid]::NewGuid())"
    Write-Step "Preserving user themes from $themes"
    Move-Item -LiteralPath $themes -Destination $backup
    Write-Ok "Backed up to $backup"
    return $backup
}

function Restore-UserThemes {
    # Move themes back into <Target>\themes\ after the new tree is in place.
    # If the new tree shipped its own themes\ folder, *user* themes win on
    # name collisions (so a user override of a built-in stays in effect).
    # No-op if $Backup is $null.
    param([string]$Target, [string]$Backup)
    if (-not $Backup) { return }
    if (-not (Test-Path $Backup)) { return }
    $themes = Join-Path $Target 'themes'
    if (-not (Test-Path $themes)) {
        Move-Item -LiteralPath $Backup -Destination $themes
    } else {
        Write-Step "Restoring user themes into $themes"
        # Recursive copy preserves any subdirectories the user might have
        # created under themes/ (e.g. for organizing personal palettes).
        Copy-Item -LiteralPath (Join-Path $Backup '*') -Destination $themes -Recurse -Force
        Remove-Item -Recurse -Force $Backup -ErrorAction SilentlyContinue
    }
    Write-Ok "User themes restored."
}

function Resolve-LocalCheckout {
    # The script lives in <repoRoot>\scripts\install.ps1 — repoRoot is its parent.
    $candidate = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $pkgPath = Join-Path $candidate 'package.json'
    if (-not (Test-Path $pkgPath)) { return $null }
    try {
        $pkg = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json
    } catch { return $null }
    if ($pkg.name -ne $ExtensionDirName) { return $null }
    return $candidate
}

function Install-FromLocal {
    param([string]$Source, [string]$Target)
    # Guard: refuse to copy when target is inside the source tree (robocopy
    # would recurse into the destination it's just creating). This happens
    # if the user runs `.\install.ps1` from the extension repo with default
    # -ProjectPath, which resolves the target to <repo>\.github\extensions\... .
    $sourceFull = [IO.Path]::GetFullPath($Source).TrimEnd('\')
    $targetFull = [IO.Path]::GetFullPath($Target).TrimEnd('\')
    if ($targetFull.StartsWith($sourceFull + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $targetFull.Equals($sourceFull, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Local install target ($targetFull) is inside the source checkout ($sourceFull). Pass -ProjectPath pointing at a different repo, use -Scope Global, or pass -FromGitHub."
    }
    Write-Step "Copying local working tree from $Source"
    New-Item -ItemType Directory -Path $Target -Force | Out-Null
    # Robocopy ships with Windows. /E = subdirs incl. empty. Exclusions match
    # .gitignore + transient build artefacts. Exit codes 0..7 indicate success.
    $excludeDirs = @('node_modules', '.git', '.vs', '.vscode', '.idea')
    $excludeFiles = @('package-lock.json', '*.log')
    $args = @($Source, $Target, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/NS', '/NC',
              '/XD') + $excludeDirs + @('/XF') + $excludeFiles
    & robocopy @args | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit $LASTEXITCODE)" }
    # Robocopy uses 0..7 as success codes; clear so the next `if ($LASTEXITCODE)`
    # consumer doesn't misread the value. Script-scope only — don't pollute global.
    $script:LASTEXITCODE = 0
    Write-Ok "Copied."
}

function Install-FromGit {
    param([string]$Url, [string]$Ref, [string]$Target)
    # Clone into a temp folder first so a mid-clone failure doesn't leave a
    # half-installed target. Move into place atomically once the clone succeeds.
    $tmp = Join-Path $env:TEMP "$ExtensionDirName-clone-$([guid]::NewGuid())"
    Write-Step "Cloning $Url (ref: $Ref) into $tmp"
    try {
        git clone --depth 1 --branch $Ref $Url $tmp
        if ($LASTEXITCODE -ne 0) { throw "git clone failed (exit $LASTEXITCODE)" }
        # Drop the .git folder so the install isn't a nested repo inside a host project.
        Remove-Item -Recurse -Force (Join-Path $tmp '.git') -ErrorAction SilentlyContinue
        Write-Step "Moving into $Target"
        # If target already exists empty/partial, clear it first so Move-Item
        # doesn't refuse. Caller already handled the -Force prompt.
        if (Test-Path $Target) { Remove-Item -Recurse -Force $Target }
        Move-Item -LiteralPath $tmp -Destination $Target
    } finally {
        if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
    }
}

function Install-FromTarball {
    param([string]$Url, [string]$Ref, [string]$Target)
    # Convert a .git URL into the GitHub codeload zip URL.
    if ($Url -notmatch '^https://github.com/([^/]+)/([^/]+?)(?:\.git)?/?$') {
        throw "Cannot derive a tarball URL from RepoUrl '$Url'. Provide a GitHub URL or install git."
    }
    $owner = $Matches[1]; $repo = $Matches[2]
    $zipUrl = "https://github.com/$owner/$repo/archive/refs/heads/$Ref.zip"
    Write-Step "Downloading $zipUrl"
    $tmpZip = Join-Path $env:TEMP "$ExtensionDirName-$([guid]::NewGuid()).zip"
    $tmpExpand = Join-Path $env:TEMP "$ExtensionDirName-$([guid]::NewGuid())"
    try {
        # If `gh` is available and authenticated, use it (works for private repos).
        # `--output` keeps the binary stream intact; PowerShell's `>` redirection
        # mangles bytes in 5.1.
        if (Test-Command gh) {
            gh api "repos/$owner/$repo/zipball/$Ref" --output $tmpZip
            if ($LASTEXITCODE -ne 0) { throw "gh api download failed (exit $LASTEXITCODE)" }
        } else {
            try {
                Invoke-WebRequest -Uri $zipUrl -OutFile $tmpZip -UseBasicParsing
            } catch {
                throw "Failed to download $zipUrl. For a private repo, install GitHub CLI and run 'gh auth login'."
            }
        }
        Write-Step "Expanding archive"
        Expand-Archive -LiteralPath $tmpZip -DestinationPath $tmpExpand -Force
        $inner = Get-ChildItem -Directory $tmpExpand | Select-Object -First 1
        if (-not $inner) { throw "Unexpected archive layout (no top-level folder)." }
        Write-Step "Moving into $Target"
        # If target already exists empty/partial, clear it first so Move-Item
        # doesn't refuse. Caller already handled the -Force prompt.
        if (Test-Path $Target) { Remove-Item -Recurse -Force $Target }
        Move-Item -LiteralPath $inner.FullName -Destination $Target
    } finally {
        Remove-Item -Recurse -Force $tmpZip, $tmpExpand -ErrorAction SilentlyContinue
    }
}

# ---- Main ------------------------------------------------------------------

$target = Resolve-TargetDir -Scope $Scope -ProjectPath $ProjectPath
Write-Step "Scope: $Scope"
Write-Step "Target: $target"

# Decide source.
$localCheckout = $null
if (-not $FromGitHub) {
    $localCheckout = Resolve-LocalCheckout
    if (-not $localCheckout) {
        Write-Warn2 "Local working tree not detected next to install.ps1; falling back to GitHub."
        $FromGitHub = $true
    }
}

if ($FromGitHub) {
    Write-Step "Source: GitHub ($RepoUrl, ref $Ref)"
} else {
    Write-Step "Source: local working tree ($localCheckout)"
}

# Back up user themes BEFORE the destructive section so they can be rescued
# even if the install path itself fails partway through.
$themesBackup = $null
if (Test-Path $target) {
    if (-not $Force) {
        throw "Target already exists: $target. Pass -Force to overwrite, or run uninstall.ps1 first."
    }
    Write-Warn2 "Removing existing install (-Force)."
    $themesBackup = Save-UserThemes -Target $target
}

try {
    if (Test-Path $target) {
        Remove-Item -Recurse -Force $target
    }

    New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null

    if ($FromGitHub) {
        if (Test-Command git) {
            Install-FromGit  -Url $RepoUrl -Ref $Ref -Target $target
        } else {
            Write-Warn2 "git not found on PATH; falling back to tarball download."
            Install-FromTarball -Url $RepoUrl -Ref $Ref -Target $target
        }
    } else {
        Install-FromLocal -Source $localCheckout -Target $target
    }

    Restore-UserThemes -Target $target -Backup $themesBackup
    # Restored successfully; cancel the finally-block recovery hint.
    $themesBackup = $null
} finally {
    if ($themesBackup -and (Test-Path $themesBackup)) {
        Write-Warn2 ""
        Write-Warn2 "Install did not complete. Your user themes are preserved at:"
        Write-Warn2 "  $themesBackup"
        Write-Warn2 "Move them back into '$target\themes\' once you've recovered the install."
    }
}

Write-Step "Installing Node dependencies (npm install)"
if (-not (Test-Command npm)) {
    throw "npm is not on PATH. Install Node.js 20+ from https://nodejs.org and re-run."
}
Push-Location $target
try {
    npm install --no-audit --no-fund --silent
    if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }
} finally { Pop-Location }
Write-Ok "Dependencies installed."

Write-Host ""
Write-Host "✅ copilot-ps-console-view installed at:" -ForegroundColor Green
Write-Host "   $target"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Open Copilot CLI in $(if ($Scope -eq 'Project') { "the project '$ProjectPath'" } else { 'any git repo' })."
Write-Host "  2. Run /reload-extensions  (or restart Copilot CLI)."
Write-Host "  3. Run /ps-console-view to open the PowerShell console window."
Write-Host ""
