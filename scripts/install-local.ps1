param([string]$Destination = '')
$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
$packagePath = Join-Path $projectPath "release\Mindmap-win32-x64"
$expectedExecutable = Join-Path $packagePath "Mindmap.exe"
if (-not (Test-Path -LiteralPath $expectedExecutable)) { throw 'Build the package first.' }

function Test-SameOrChildPath([string]$Candidate, [string]$Parent) {
  $candidatePath = [System.IO.Path]::GetFullPath($Candidate).TrimEnd('\', '/')
  $parentPath = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
  return $candidatePath.Equals($parentPath, [StringComparison]::OrdinalIgnoreCase) -or $candidatePath.StartsWith($parentPath + '\', [StringComparison]::OrdinalIgnoreCase)
}

if ([string]::IsNullOrWhiteSpace($Destination)) {
  $Destination = if (Test-Path -LiteralPath 'D:\apps' -PathType Container) { 'D:\apps\Mindmap' }
    else { Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\Mindmap' }
}
$destinationPath = [System.IO.Path]::GetFullPath($Destination)
$protectedRoots = @(
  [System.IO.Path]::GetPathRoot($destinationPath),
  [Environment]::GetFolderPath('UserProfile'),
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('MyDocuments'),
  [Environment]::GetFolderPath('LocalApplicationData'),
  [Environment]::GetFolderPath('ApplicationData'),
  [Environment]::GetFolderPath('CommonApplicationData'),
  [Environment]::GetFolderPath('ProgramFiles'),
  [Environment]::GetFolderPath('ProgramFilesX86'),
  (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs')
)
foreach ($protectedPath in $protectedRoots) {
  if ($protectedPath -and (Test-SameOrChildPath $destinationPath $protectedPath) -and (Test-SameOrChildPath $protectedPath $destinationPath)) {
    throw 'Choose a dedicated application folder, not a drive, user, or system root.'
  }
}
if (Test-SameOrChildPath $destinationPath ([Environment]::GetFolderPath('Windows'))) { throw 'Cannot install inside the Windows system directory.' }
if ((Test-SameOrChildPath $destinationPath $projectPath) -or (Test-SameOrChildPath $projectPath $destinationPath)) {
  throw 'Choose an application folder outside the source and package directories.'
}
# Reject junctions before copying so an apparently safe path cannot redirect into another folder.
$ancestor = $destinationPath
while ($ancestor) {
  if (Test-Path -LiteralPath $ancestor) {
    $item = Get-Item -LiteralPath $ancestor -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
      throw 'The installation path must contain only regular folders, without links or junctions.'
    }
  }
  $ancestor = Split-Path -Parent $ancestor
}
if (Test-Path -LiteralPath $destinationPath) {
  $foldersToCheck = [System.Collections.Generic.Queue[string]]::new()
  $foldersToCheck.Enqueue($destinationPath)
  while ($foldersToCheck.Count) {
    $folderToCheck = $foldersToCheck.Dequeue()
    foreach ($item in (Get-ChildItem -LiteralPath $folderToCheck -Force)) {
      if ($folderToCheck -eq $destinationPath -and $item.Name -in @('导图', '.mindmap')) { continue }
      if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Application files cannot be installed through a link or junction.' }
      if ($item.PSIsContainer) { $foldersToCheck.Enqueue($item.FullName) }
    }
  }
}
if (-not (Test-Path -LiteralPath $destinationPath)) { New-Item -ItemType Directory -Path $destinationPath | Out-Null }
Get-ChildItem -LiteralPath $packagePath -Force | Where-Object { $_.Name -notin @('导图', '.mindmap') } | ForEach-Object {
  for ($copyAttempt = 0; ; $copyAttempt++) {
    try {
      Copy-Item -LiteralPath $_.FullName -Destination $destinationPath -Recurse -Force
      break
    } catch [System.IO.IOException] {
      if ($copyAttempt -ge 19) { throw }
      Start-Sleep -Milliseconds 250
    }
  }
}
Copy-Item -LiteralPath (Join-Path $projectPath 'assets\icon.ico') -Destination (Join-Path $destinationPath 'icon.ico') -Force
Copy-Item -LiteralPath (Join-Path $projectPath 'assets\icon.png') -Destination (Join-Path $destinationPath 'icon.png') -Force
Copy-Item -LiteralPath (Join-Path $projectPath 'assets\icon-prompt.txt') -Destination (Join-Path $destinationPath 'icon-prompt.txt') -Force
Copy-Item -LiteralPath (Join-Path $projectPath 'README.md') -Destination (Join-Path $destinationPath '使用说明.md') -Force
if (-not (Test-Path -LiteralPath (Join-Path $destinationPath '导图'))) { New-Item -ItemType Directory -Path (Join-Path $destinationPath '导图') | Out-Null }
$desktopPath = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopPath "Mindmap.lnk"
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $destinationPath "Mindmap.exe"
$shortcut.WorkingDirectory = $destinationPath
$shortcut.IconLocation = "${destinationPath}\icon.ico,0"
$shortcut.Description = "Mindmap - 本地思维导图"
$shortcut.Save()
[PSCustomObject]@{ Application = $shortcut.TargetPath; Shortcut = $shortcutPath; Maps = Join-Path $destinationPath '导图'; Icon = $shortcut.IconLocation } | ConvertTo-Json
