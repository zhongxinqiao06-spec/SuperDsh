# Run locally in PowerShell. Use -WhatIf to inspect without changing files.
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param()

$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$taskManifest = Get-Content -LiteralPath (Join-Path $taskRoot 'apps\desktop\package.json') -Raw | ConvertFrom-Json
if ($taskManifest.name -ne '@superdsh/desktop') {
  throw 'This script must remain in the SuperDsh scripts directory.'
}

$taskNames = @(
  'dsh-plugin-desktop',
  'dsh-desktop-next',
  'packages\backend',
  'packages\contracts',
  'packages\desktop-ui',
  'plugins\harness',
  'apps\desktop\shared',
  'apps\desktop\src',
  'apps\desktop\tsdown.config.ts',
  'apps\desktop\vite.native-ui.config.ts'
)

# Validate every target before removing any target. Never follow a directory link.
$taskTargets = @(
  foreach ($taskName in $taskNames) {
    $taskCandidate = Join-Path $taskRoot $taskName
    if (-not (Test-Path -LiteralPath $taskCandidate)) { continue }
    $taskPath = (Resolve-Path -LiteralPath $taskCandidate).Path
    if (-not $taskPath.StartsWith($taskRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Target escaped the workspace: $taskName"
    }
    $taskItem = Get-Item -LiteralPath $taskPath -Force
    $taskEntries = @($taskItem)
    if ($taskItem.PSIsContainer) {
      $taskEntries += @(Get-ChildItem -LiteralPath $taskPath -Force -Recurse)
    }
    foreach ($taskEntry in $taskEntries) {
      if ($taskEntry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "Refusing a linked path: $($taskEntry.FullName)"
      }
      if ($taskEntry.Name -in @('.git', '.env', '.desktop-next', '.superdsh', 'home') -or $taskEntry.Name -like '.env.*') {
        throw "Preserve and move potential user data before cleanup: $($taskEntry.FullName)"
      }
    }
    [PSCustomObject]@{ Relative = $taskName; Path = $taskPath }
  }
)

if ($taskTargets.Count -eq 0) {
  Write-Output 'No retired source remains.'
  return
}
$taskTargets | Select-Object -ExpandProperty Relative | Write-Output
if (-not $PSCmdlet.ShouldProcess($taskRoot, 'Back up and permanently remove only the listed retired sources')) {
  return
}

$taskBackupDirectory = Join-Path $taskRoot '.superdsh-work'
if (Test-Path -LiteralPath $taskBackupDirectory) {
  if ((Get-Item -LiteralPath $taskBackupDirectory -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    throw 'Refusing a linked backup directory.'
  }
} else {
  New-Item -Path $taskBackupDirectory -ItemType Directory | Out-Null
}
$taskStamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$taskArchive = Join-Path $taskBackupDirectory "physical-cleanup-$taskStamp.tar.gz"
$taskRelativePaths = @($taskTargets | Select-Object -ExpandProperty Relative)
& tar.exe -czf $taskArchive -C $taskRoot @taskRelativePaths
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $taskArchive -PathType Leaf)) {
  throw 'Backup failed. Nothing was deleted.'
}
& tar.exe -tzf $taskArchive | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Backup validation failed. Nothing was deleted.' }
$taskHash = (Get-FileHash -LiteralPath $taskArchive -Algorithm SHA256).Hash

foreach ($taskTarget in $taskTargets) {
  # Recheck the absolute boundary immediately before recursive deletion.
  $taskResolved = (Resolve-Path -LiteralPath $taskTarget.Path).Path
  if (-not $taskResolved.StartsWith($taskRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Cleanup target escaped the workspace.'
  }
  if ((Get-Item -LiteralPath $taskResolved -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    throw 'Cleanup target became a link.'
  }
  Remove-Item -LiteralPath $taskResolved -Recurse -Force
  if (Test-Path -LiteralPath $taskResolved) { throw "Deletion incomplete: $taskResolved" }
  Write-Output "Deleted: $($taskTarget.Relative)"
}

# Remove only empty parent directories, without recursion.
foreach ($taskName in @('packages', 'plugins')) {
  $taskParent = Join-Path $taskRoot $taskName
  if ((Test-Path -LiteralPath $taskParent -PathType Container) -and @(Get-ChildItem -LiteralPath $taskParent -Force).Count -eq 0) {
    Remove-Item -LiteralPath $taskParent -Force
  }
}
[PSCustomObject]@{
  CompletedAt = (Get-Date).ToString('o')
  Removed = $taskRelativePaths
  Backup = $taskArchive
  BackupSha256 = $taskHash
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskBackupDirectory 'physical-cleanup-result.json') -Encoding utf8
Write-Output "Cleanup complete. Backup: $taskArchive"
