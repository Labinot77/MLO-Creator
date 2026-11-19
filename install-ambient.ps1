# Adds baked interior lighting to MLO Creator and rebuilds MloCreator.exe.
# Put this folder (install-ambient.ps1 + patch\) in your MLO Creator folder (the one with MloCreator.exe and source\), then:
#   powershell -ExecutionPolicy Bypass -File install-ambient.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = if (Test-Path "$here\source\build.ps1") { $here } elseif (Test-Path "$here\..\source\build.ps1") { (Resolve-Path "$here\..").Path } else { throw "Put this folder inside your MLO Creator folder (next to MloCreator.exe and source\)." }
$src = "$root\source\src"

# 1. Ambient.cs (the bake)
Copy-Item "$here\patch\Ambient.cs" "$src\Ambient.cs" -Force

# 2. three small edits in Exporter.cs (skipped when already done)
$file = "$src\Exporter.cs"
$code = [IO.File]::ReadAllText($file)
$edits = @(
    @('public float[] Pos, Nrm, Uv; public int[] Idx; }', 'public float[] Pos, Nrm, Uv; public int[] Idx; public byte[] Col; }'),
    @('"   255 255 255 255   " + F(m.Uv[i * 2])', '"   " + (m.Col == null ? "255 255 255 255" : m.Col[i * 4] + " " + m.Col[i * 4 + 1] + " " + m.Col[i * 4 + 2] + " " + m.Col[i * 4 + 3]) + "   " + F(m.Uv[i * 2])'),
    @('                // ---- write game files ----', "                // ---- baked ambient light (Ambient.cs) ----`n                List<GroupData> doorGroups = new List<GroupData>();`n                foreach (FitDoor fd in fit.Doors) doorGroups.Add(fd.G);`n                BakeAmbient(groups, doorGroups, log);`n`n                // ---- write game files ----")
)
if ($code.Contains('BakeAmbient(')) { Write-Host 'Exporter.cs already patched.' }
else {
    foreach ($e in $edits) {
        if (-not $code.Contains($e[0])) { throw "Exporter.cs is a different version than expected (missing: $($e[0])). Nothing was changed in it." }
    }
    Copy-Item $file "$file.bak" -Force
    foreach ($e in $edits) { $code = $code.Replace($e[0], $e[1]) }
    [IO.File]::WriteAllText($file, $code)
    Write-Host 'Exporter.cs patched (backup: Exporter.cs.bak).'
}

# 3. build (the libraries of the release are copied next to the source the first time)
New-Item -ItemType Directory -Force "$root\source\lib" | Out-Null
if (-not (Test-Path "$root\source\lib\CodeWalker.Core.dll")) { Copy-Item "$root\lib\*.dll" "$root\source\lib\" -Force }
& "$root\source\build.ps1"

# 4. replace the program you run
Get-Process MloCreator -ErrorAction SilentlyContinue | Stop-Process -Force
if (Test-Path "$root\MloCreator.exe") { Copy-Item "$root\MloCreator.exe" "$root\MloCreator.exe.bak" -Force }
Copy-Item "$root\source\MloCreator.exe" "$root\MloCreator.exe" -Force
Copy-Item "$root\source\MloCreator.exe.config" "$root\MloCreator.exe.config" -Force -ErrorAction SilentlyContinue
Write-Host 'Done: MloCreator.exe rebuilt with baked interior lighting. Export your house again.'
