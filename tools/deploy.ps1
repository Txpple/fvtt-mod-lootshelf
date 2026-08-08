# Deploy Loot Shelf to the local Foundry install (copy, not symlink).
# Usage: .\tools\deploy.ps1
$repo = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $env:LOCALAPPDATA "FoundryVTT\Data\modules\fvtt-mod-lootshelf"

robocopy $repo $dest module.json /NJH /NJS | Out-Null
foreach ($dir in "scripts", "styles", "templates") {
    robocopy (Join-Path $repo $dir) (Join-Path $dest $dir) /MIR /NJH /NJS | Out-Null
}
Write-Host "Deployed to $dest"
Write-Host "Reload the world (F5 in Foundry) for script changes; restart Foundry only if module.json changed."
