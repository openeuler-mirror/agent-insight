param(
    [string]$IdeHome = $env:JETBRAINS_HOME
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($IdeHome)) {
    throw "Set JETBRAINS_HOME or pass -IdeHome with the path to an installed JetBrains IDE."
}

$IdeHome = [IO.Path]::GetFullPath($IdeHome)
$JavaCompiler = Join-Path $IdeHome "jbr\bin\javac.exe"
if (-not (Test-Path -LiteralPath $JavaCompiler)) {
    throw "The selected IDE does not contain jbr\bin\javac.exe: $IdeHome"
}

$BuildRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "build"))
$PluginVersionLine = Get-Content -LiteralPath (Join-Path $PSScriptRoot "gradle.properties") | Where-Object { $_ -match '^pluginVersion=' } | Select-Object -First 1
$PluginVersion = ($PluginVersionLine -split '=', 2)[1].Trim()
if ([string]::IsNullOrWhiteSpace($PluginVersion)) {
    throw "pluginVersion is missing from gradle.properties."
}
$Classes = Join-Path $BuildRoot "manual-classes"
$JarRoot = Join-Path $BuildRoot "manual-jar-root"
$PluginRoot = Join-Path $BuildRoot "manual-package\agent-insight-qoder-jetbrains"
$Distribution = Join-Path $BuildRoot "distributions\agent-insight-qoder-jetbrains-$PluginVersion.zip"

foreach ($Target in @($Classes, $JarRoot, $PluginRoot)) {
    $ResolvedTarget = [IO.Path]::GetFullPath($Target)
    if (-not $ResolvedTarget.StartsWith($BuildRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean a path outside the plugin build directory: $ResolvedTarget"
    }
    if (Test-Path -LiteralPath $ResolvedTarget) {
        Remove-Item -LiteralPath $ResolvedTarget -Recurse -Force
    }
}

New-Item -ItemType Directory -Force -Path $Classes, $JarRoot, (Join-Path $JarRoot "collector"), (Join-Path $PluginRoot "lib"), (Split-Path $Distribution) | Out-Null
$Sources = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot "src\main\java") -Recurse -Filter "*.java" | Select-Object -ExpandProperty FullName
& $JavaCompiler --release 17 -encoding UTF-8 -cp (Join-Path $IdeHome "lib\*") -d $Classes $Sources
if ($LASTEXITCODE -ne 0) { throw "JetBrains plugin compilation failed." }

Copy-Item -Path (Join-Path $Classes "*") -Destination $JarRoot -Recurse -Force
Copy-Item -Path (Join-Path $PSScriptRoot "src\main\resources\*") -Destination $JarRoot -Recurse -Force
$Scripts = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\scripts"))
Copy-Item -LiteralPath (Join-Path $Scripts "qoder_trace_collector.mjs"), (Join-Path $Scripts "qoder_uploader_client.mjs"), (Join-Path $Scripts "qoder_setup.mjs"), (Join-Path $Scripts "qoder_token_usage_env.mjs") -Destination (Join-Path $JarRoot "collector") -Force

$Jar = Join-Path $PluginRoot "lib\agent-insight-qoder-jetbrains-$PluginVersion.jar"
$JarArchive = "$Jar.zip"
& tar.exe -a -c -f $JarArchive -C $JarRoot META-INF collector org
if ($LASTEXITCODE -ne 0) { throw "JetBrains plugin JAR packaging failed." }
Move-Item -LiteralPath $JarArchive -Destination $Jar -Force
if (Test-Path -LiteralPath $Distribution) { Remove-Item -LiteralPath $Distribution -Force }
& tar.exe -a -c -f $Distribution -C (Split-Path $PluginRoot) (Split-Path $PluginRoot -Leaf)
if ($LASTEXITCODE -ne 0) { throw "JetBrains plugin ZIP packaging failed." }
Write-Output $Distribution
