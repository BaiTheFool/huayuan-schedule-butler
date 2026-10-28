# 华园日程管家 · 版本递增脚本
# 单一事实源：VERSION.md 首行 VERSION=x.y.z
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\bump-version.ps1                # patch+1
#   powershell -ExecutionPolicy Bypass -File scripts\bump-version.ps1 -Part minor     # minor+1（patch 归零）
#   powershell -ExecutionPolicy Bypass -File scripts\bump-version.ps1 -Message "..."  # 递增并追加变更日志
# 规则：版本号默认自动递增，不要手动改 VERSION.md / plugin.json 的版本号。
param(
  [ValidateSet("major", "minor", "patch")]
  [string]$Part = "patch",
  [string]$Message = ""
)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$versionFile = Join-Path $root "VERSION.md"
$pluginFile = Join-Path $root ".codebuddy-plugin\plugin.json"

$line0 = Get-Content -LiteralPath $versionFile -TotalCount 1
if ($line0 -notmatch '^VERSION=(\d+)\.(\d+)\.(\d+)$') {
  throw "VERSION.md 首行格式错误（应为 VERSION=x.y.z）：$line0"
}
[int]$major = [int]$Matches[1]
[int]$minor = [int]$Matches[2]
[int]$patch = [int]$Matches[3]

switch ($Part) {
  "major" { $major++; $minor = 0; $patch = 0 }
  "minor" { $minor++; $patch = 0 }
  default { $patch++ }
}
$new = "$major.$minor.$patch"

# 1) 更新 VERSION.md 首行
$content = Get-Content -LiteralPath $versionFile -Raw
$content = $content -replace '^VERSION=\d+\.\d+\.\d+', "VERSION=$new"
if ($Message -ne "") {
  $date = Get-Date -Format "yyyy-MM-dd"
  $entry = "`n### $new · $date · $Message`n"
  $content = $content -replace "(?m)^(VERSION=.*\n)", "`$1$entry"
}
[IO.File]::WriteAllText($versionFile, $content, (New-Object Text.UTF8Encoding($false)))

# 2) 同步 plugin.json 的 version 字段
$plugin = Get-Content -LiteralPath $pluginFile -Raw | ConvertFrom-Json
$plugin.version = $new
$json = $plugin | ConvertTo-Json -Depth 10
[IO.File]::WriteAllText($pluginFile, $json, (New-Object Text.UTF8Encoding($false)))

Write-Host "BUMPED: $new (part=$Part)"
