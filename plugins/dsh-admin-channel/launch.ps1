#requires -Version 5.1
<#
  dsh-admin-channel UAC launcher (NOT elevated).

  Spawned by the DSH host plugin. Reads the same spec file as the broker and
  asks Windows to start broker.ps1 elevated with ShellExecute "runas" -- this
  is the single UAC prompt the user sees per channel start.

  The result of the UAC decision is written to launch.json next to the spec:
    {"ok":true,"pid":...}                 the elevated process was created
    {"ok":false,"code":"uac-cancelled"}   the user clicked No / closed the prompt

  ASCII-only on purpose (Windows PowerShell 5.1 reads BOM-less files as ANSI).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Spec
)

$ErrorActionPreference = 'Stop'
$specPath = [System.IO.Path]::GetFullPath($Spec)
$specDir = [System.IO.Path]::GetDirectoryName($specPath)
$resultPath = [System.IO.Path]::Combine($specDir, 'launch.json')

function Write-LaunchResult {
  param([hashtable]$Payload)
  try {
    $json = $Payload | ConvertTo-Json -Compress -Depth 4
    [System.IO.File]::WriteAllText($resultPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}

try {
  $cfg = Get-Content -LiteralPath $specPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $broker = [string]$cfg.brokerPath
  if (-not [System.IO.File]::Exists($broker)) {
    throw ('broker script missing: ' + $broker)
  }

  $escapedBroker = $broker.Replace("'", "''")
  $escapedSpec = $specPath.Replace("'", "''")
  $inner = "& '" + $escapedBroker + "' -Spec '" + $escapedSpec + "'"
  $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($inner))
  $arguments = @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded)

  # Absolute path only: ShellExecute must not resolve a planted powershell.exe
  # from the launcher's inherited cwd/PATH.
  $powershellExe = [System.IO.Path]::Combine($env:SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (-not [System.IO.File]::Exists($powershellExe)) {
    throw ('powershell.exe not found: ' + $powershellExe)
  }
  $process = Start-Process -FilePath $powershellExe -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -PassThru
  Write-LaunchResult @{ ok = $true; pid = $process.Id; at = (Get-Date).ToString('o') }
} catch {
  $message = $_.Exception.Message
  $code = 'uac-failed'
  if ($message -match 'cancel|0x800704C7|1223') { $code = 'uac-cancelled' }
  Write-LaunchResult @{ ok = $false; code = $code; error = $message; at = (Get-Date).ToString('o') }
  exit 1
}
