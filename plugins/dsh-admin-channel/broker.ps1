#requires -Version 5.1
<#
  dsh-admin-channel broker (elevated helper).

  Started once by launch.ps1 through UAC. Serves exactly one client over a
  named pipe: the DSH host process named in the spec file. Every request must
  carry the per-start random token, and the server verifies the client process
  id with GetNamedPipeClientProcessId before reading anything.

  Protocol: one JSON object per line, UTF-8.
    client -> server: {"type":"auth","token":"..."}
    server -> client: {"type":"ready","elevated":true,"pid":..., ...}
    client -> server: {"type":"exec","id":"...","command":"...","cwd":"...","timeoutMs":120000}
    server -> client: {"type":"result","id":"...","ok":true,"exitCode":0,"stdout":"...","stderr":"..."}
    client -> server: {"type":"ping"}  -> {"type":"pong"}
    client -> server: {"type":"stop"}  -> {"type":"stopped"} then exit

  This file is intentionally ASCII-only: Windows PowerShell 5.1 reads a
  BOM-less script as ANSI, and non-ASCII source would garble.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Spec
)

$ErrorActionPreference = 'Stop'
$script:Version = 1
$script:SpecPath = [System.IO.Path]::GetFullPath($Spec)
$script:SpecDir = [System.IO.Path]::GetDirectoryName($script:SpecPath)
$script:LogPath = [System.IO.Path]::Combine($script:SpecDir, 'broker.log')
$script:TaskKill = [System.IO.Path]::Combine($env:SystemRoot, 'System32', 'taskkill.exe')
$script:CancelPath = [System.IO.Path]::Combine($script:SpecDir, 'cancel')
# Absolute paths only: the elevated broker must never resolve an executable through
# the inherited cwd/PATH (a planted powershell.exe/cmd.exe must not be elevated).
$script:PowerShellExe = [System.IO.Path]::Combine($env:SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
$script:CmdExe = [System.IO.Path]::Combine($env:SystemRoot, 'System32', 'cmd.exe')

function Write-BrokerLog {
  param([string]$Text)
  try {
    $line = '[' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '] ' + $Text + "`r`n"
    [System.IO.File]::AppendAllText($script:LogPath, $line, ([System.Text.UTF8Encoding]::new($false)))
  } catch { }
}

function Send-BrokerJson {
  param($Writer, $Payload)
  $json = $Payload | ConvertTo-Json -Compress -Depth 8
  $Writer.WriteLine($json)
  $Writer.Flush()
}

function Read-LimitedText {
  param([string]$Path, [int]$MaxBytes)
  $result = @{ text = ''; truncated = $false; bytes = [long]0 }
  try {
    if (-not [System.IO.File]::Exists($Path)) { return $result }
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      $length = [long]$stream.Length
      $take = [int][Math]::Min($length, [long]$MaxBytes)
      $buffer = New-Object byte[] ([Math]::Max($take, 1))
      $read = 0
      if ($take -gt 0) { $read = $stream.Read($buffer, 0, $take) }
      $result.text = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
      $result.truncated = ($length -gt [long]$take)
      $result.bytes = $length
    } finally {
      $stream.Dispose()
    }
  } catch { }
  return $result
}

<#
  Runs one command inside a fresh Windows PowerShell process, with stdout and
  stderr redirected to files (no pipe-buffer deadlock), a hard timeout and a
  bounded output read. Returns a hashtable.
#>
function Invoke-BrokerCommand {
  param(
    [string]$Command,
    [string]$Cwd,
    [int]$TimeoutMs,
    [int]$MaxBytes
  )

  if ([string]::IsNullOrWhiteSpace($Command)) { throw 'empty command' }

  $workDir = $Cwd
  if ([string]::IsNullOrWhiteSpace($workDir)) {
    $workDir = [Environment]::GetFolderPath('UserProfile')
  }
  if (-not [System.IO.Directory]::Exists($workDir)) {
    throw ('working directory does not exist: ' + $workDir)
  }

  $runDir = [System.IO.Path]::Combine($script:SpecDir, ('run-' + [guid]::NewGuid().ToString('n')))
  [System.IO.Directory]::CreateDirectory($runDir) | Out-Null
  $scriptFile = [System.IO.Path]::Combine($runDir, 'command.ps1')
  $outFile = [System.IO.Path]::Combine($runDir, 'stdout.txt')
  $errFile = [System.IO.Path]::Combine($runDir, 'stderr.txt')

  $prelude = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`r`n" +
             "`$OutputEncoding = [System.Text.Encoding]::UTF8`r`n" +
             "`$ErrorActionPreference = 'Continue'`r`n"
  [System.IO.File]::WriteAllText($scriptFile, ($prelude + $Command), ([System.Text.UTF8Encoding]::new($true)))

  $startedAt = Get-Date
  $process = $null
  $timedOut = $false
  $cancelled = $false
  $exitCode = $null
  $durationMs = 0
  $stdout = @{ text = ''; truncated = $false; bytes = [long]0 }
  $stderr = @{ text = ''; truncated = $false; bytes = [long]0 }

  try {
    # cmd.exe performs the file redirection (bounded memory, no pipe-buffer
    # deadlock) and its exit code is the inner PowerShell's exit code. Both
    # executables are absolute so a planted binary in cwd/PATH cannot win.
    $arguments = '/d /s /c ""' + $script:PowerShellExe + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
                 $scriptFile + '" > "' + $outFile + '" 2> "' + $errFile + '""'
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $script:CmdExe
    $startInfo.Arguments = $arguments
    $startInfo.WorkingDirectory = $workDir
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $process = [System.Diagnostics.Process]::Start($startInfo)
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    $finished = $false
    while ($true) {
      if ($process.WaitForExit(200)) { $finished = $true; break }
      if ([System.IO.File]::Exists($script:CancelPath)) { $cancelled = $true; break }
      if ((Get-Date) -gt $deadline) { $timedOut = $true; break }
      if (-not (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)) { $cancelled = $true; break }
    }
    if (-not $finished) {
      try { & $script:TaskKill /PID $process.Id /T /F 2>&1 | Out-Null } catch { }
      try { $process.WaitForExit(5000) | Out-Null } catch { }
    }
    try { $exitCode = [int]$process.ExitCode } catch { $exitCode = $null }
  } finally {
    $durationMs = [int]((Get-Date) - $startedAt).TotalMilliseconds
    $stdout = Read-LimitedText -Path $outFile -MaxBytes $MaxBytes
    $stderr = Read-LimitedText -Path $errFile -MaxBytes $MaxBytes
    try { [System.IO.Directory]::Delete($runDir, $true) } catch { }
  }

  return @{
    exitCode         = $exitCode
    timedOut         = $timedOut
    cancelled        = $cancelled
    durationMs       = $durationMs
    stdout           = $stdout.text
    stderr           = $stderr.text
    stdoutTruncated  = $stdout.truncated
    stderrTruncated  = $stderr.truncated
    stdoutBytes      = $stdout.bytes
    stderrBytes      = $stderr.bytes
  }
}

# ------------ spec ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
if (-not [System.IO.File]::Exists($script:SpecPath)) {
  Write-BrokerLog 'spec file missing'
  exit 10
}

try {
  $cfg = Get-Content -LiteralPath $script:SpecPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  Write-BrokerLog ('spec parse failed: ' + $_.Exception.Message)
  exit 10
}

$pipeName = [string]$cfg.pipeName
$token = [string]$cfg.token
$ownerPid = [int]$cfg.ownerPid
$maxBytes = 262144
if ($cfg.maxOutputBytes -ne $null) { $maxBytes = [int]$cfg.maxOutputBytes }
$connectTimeoutMs = 120000
if ($cfg.connectTimeoutMs -ne $null) { $connectTimeoutMs = [int]$cfg.connectTimeoutMs }

if ($pipeName -notmatch '^[A-Za-z0-9._-]{1,100}$') { Write-BrokerLog 'invalid pipe name'; exit 11 }
if ($token.Length -lt 32) { Write-BrokerLog 'invalid token'; exit 11 }
if ($ownerPid -le 0) { Write-BrokerLog 'invalid owner pid'; exit 11 }

$owner = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
if ($null -eq $owner) { Write-BrokerLog 'owner process is not running'; exit 12 }

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
$elevated = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)

Write-BrokerLog ('start pid=' + $PID + ' ownerPid=' + $ownerPid + ' elevated=' + $elevated + ' pipe=' + $pipeName)

# Build the pipe DACL BEFORE creation: a NamedPipeServerStream created with its
# default security descriptor was not accessible from the non-elevated host
# (connect -> EPERM), and SetAccessControl after creation is denied because the
# handle lacks WRITE_DAC. The constructor overload takes the security object.
$pipeSecurity = $null
try {
  $pipeSecurity = New-Object System.IO.Pipes.PipeSecurity
  $rights = [System.IO.Pipes.PipeAccessRights]::FullControl
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $pipeSecurity.AddAccessRule(([System.IO.Pipes.PipeAccessRule]::new($identity.User, $rights, $allow)))
  $ownerSidValue = ''
  if ($cfg.ownerUserSid -ne $null) {
    $ownerSidValue = [string]$cfg.ownerUserSid
  } elseif ($cfg.ownerUser -ne $null) {
    try {
      $account = [System.Security.Principal.NTAccount]::new([string]$cfg.ownerUser)
      $ownerSidValue = $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
      Write-BrokerLog ('could not translate owner user: ' + $_.Exception.Message)
      $ownerSidValue = ''
    }
  }
  if ($ownerSidValue -ne '') {
    $ownerSid = [System.Security.Principal.SecurityIdentifier]::new($ownerSidValue)
    if ($ownerSid.Value -ne $identity.User.Value) {
      $pipeSecurity.AddAccessRule(([System.IO.Pipes.PipeAccessRule]::new($ownerSid, $rights, $allow)))
    }
  }
  $systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $pipeSecurity.AddAccessRule(([System.IO.Pipes.PipeAccessRule]::new($systemSid, $rights, $allow)))
} catch {
  Write-BrokerLog ('build pipe acl failed: ' + $_.Exception.Message)
  # Never fall back to the default security descriptor: it was observed to deny
  # the non-elevated host (EPERM), so the channel would be useless and the pipe
  # would be open with a security descriptor nobody designed.
  exit 13
}

try {
  if ($pipeSecurity -ne $null) {
    $pipe = [System.IO.Pipes.NamedPipeServerStream]::new(
      $pipeName,
      [System.IO.Pipes.PipeDirection]::InOut,
      1,
      [System.IO.Pipes.PipeTransmissionMode]::Byte,
      [System.IO.Pipes.PipeOptions]::Asynchronous,
      0,
      0,
      $pipeSecurity
    )
  } else {
    $pipe = [System.IO.Pipes.NamedPipeServerStream]::new(
      $pipeName,
      [System.IO.Pipes.PipeDirection]::InOut,
      1,
      [System.IO.Pipes.PipeTransmissionMode]::Byte,
      [System.IO.Pipes.PipeOptions]::Asynchronous
    )
  }
} catch {
  Write-BrokerLog ('create pipe failed: ' + $_.Exception.Message)
  exit 13
}

$deadline = (Get-Date).AddMilliseconds($connectTimeoutMs)
$waitTask = $pipe.WaitForConnectionAsync()
while (-not $waitTask.Wait(200)) {
  if ([System.IO.File]::Exists($script:CancelPath) -or -not [System.IO.File]::Exists($script:SpecPath)) {
    Write-BrokerLog 'start was cancelled by the host; exiting'
    try { $pipe.Dispose() } catch { }
    exit 17
  }
  if ((Get-Date) -gt $deadline) {
    Write-BrokerLog 'connect timeout; exiting'
    try { $pipe.Dispose() } catch { }
    exit 14
  }
  if (-not (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)) {
    Write-BrokerLog 'owner gone while waiting; exiting'
    try { $pipe.Dispose() } catch { }
    exit 15
  }
}
try { $waitTask.GetAwaiter().GetResult() } catch { Write-BrokerLog ('connect failed: ' + $_.Exception.Message); exit 14 }

# The client must be the exact host process that asked for this channel.
try {
  Add-Type -Namespace DshAdminChannel -Name NativeMethods -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool GetNamedPipeClientProcessId(System.IntPtr Pipe, out uint ClientProcessId);
'@
  $clientPid = [uint32]0
  $okPid = [DshAdminChannel.NativeMethods]::GetNamedPipeClientProcessId($pipe.SafePipeHandle.DangerousGetHandle(), [ref]$clientPid)
} catch {
  Write-BrokerLog ('client pid probe failed: ' + $_.Exception.Message)
  $okPid = $false
  $clientPid = [uint32]0
}
if (-not $okPid) {
  Write-BrokerLog ('GetNamedPipeClientProcessId failed: ' + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
  try { $pipe.Dispose() } catch { }
  exit 16
}
if ([int]$clientPid -ne $ownerPid) {
  Write-BrokerLog ('client pid mismatch: ' + [int]$clientPid + ' != ' + $ownerPid + '; exiting')
  try { $pipe.Dispose() } catch { }
  exit 16
}

$utf8 = [System.Text.UTF8Encoding]::new($false)
$reader = New-Object System.IO.StreamReader($pipe, $utf8, $false, 8192, $true)
$writer = New-Object System.IO.StreamWriter($pipe, $utf8, 8192, $true)
$writer.AutoFlush = $true

# ------------ auth ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
$line = $reader.ReadLine()
if ([string]::IsNullOrEmpty($line)) { Write-BrokerLog 'client closed before auth'; exit 17 }
$auth = $null
try { $auth = $line | ConvertFrom-Json } catch { Write-BrokerLog 'auth is not json'; exit 17 }
if ([string]$auth.type -ne 'auth' -or [string]$auth.token -ne $token) {
  Write-BrokerLog 'auth token mismatch'
  Send-BrokerJson $writer @{ type = 'error'; code = 'auth'; message = 'invalid token' }
  exit 18
}

Send-BrokerJson $writer @{
  type      = 'ready'
  version   = $script:Version
  elevated  = [bool]$elevated
  pid       = $PID
  ownerPid  = $ownerPid
  user      = $identity.Name
  pipe      = $pipeName
  startedAt = (Get-Date).ToString('o')
}
Write-BrokerLog ('ready elevated=' + $elevated + ' clientPid=' + [int]$clientPid)

# ------------ request loop ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
$exitReason = 'client-closed'
while ($true) {
  $line = $reader.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }

  $msg = $null
  try { $msg = $line | ConvertFrom-Json } catch {
    Send-BrokerJson $writer @{ type = 'error'; code = 'protocol'; message = 'request is not json' }
    continue
  }

  $type = [string]$msg.type

  if ($type -eq 'ping') {
    Send-BrokerJson $writer @{ type = 'pong'; at = (Get-Date).ToString('o') }
    continue
  }

  if ($type -eq 'status') {
    Send-BrokerJson $writer @{
      type      = 'status'
      elevated  = [bool]$elevated
      pid       = $PID
      user      = $identity.Name
      startedAt = (Get-Date).ToString('o')
    }
    continue
  }

  if ($type -eq 'stop') {
    Write-BrokerLog 'stop requested'
    Send-BrokerJson $writer @{ type = 'stopped'; at = (Get-Date).ToString('o') }
    $exitReason = 'stop'
    break
  }

  if ($type -eq 'exec') {
    $id = [string]$msg.id
    $timeoutMs = 120000
    if ($msg.timeoutMs -ne $null) { $timeoutMs = [int]$msg.timeoutMs }
    if ($timeoutMs -lt 1000) { $timeoutMs = 1000 }
    if ($timeoutMs -gt 1800000) { $timeoutMs = 1800000 }
    try {
      $result = Invoke-BrokerCommand -Command ([string]$msg.command) -Cwd ([string]$msg.cwd) -TimeoutMs $timeoutMs -MaxBytes $maxBytes
      Send-BrokerJson $writer @{
        type            = 'result'
        id              = $id
        ok              = $true
        exitCode        = $result.exitCode
        timedOut        = [bool]$result.timedOut
        cancelled       = [bool]$result.cancelled
        durationMs      = [int]$result.durationMs
        stdout          = [string]$result.stdout
        stderr          = [string]$result.stderr
        stdoutTruncated = [bool]$result.stdoutTruncated
        stderrTruncated = [bool]$result.stderrTruncated
      }
      Write-BrokerLog ('exec id=' + $id + ' exit=' + $result.exitCode + ' timedOut=' + $result.timedOut + ' cancelled=' + $result.cancelled + ' ms=' + $result.durationMs)
      if ($result.cancelled) {
        $exitReason = 'cancelled'
        break
      }
    } catch {
      $message = $_.Exception.Message
      Send-BrokerJson $writer @{ type = 'result'; id = $id; ok = $false; error = $message }
      Write-BrokerLog ('exec id=' + $id + ' failed: ' + $message)
    }
    continue
  }

  Send-BrokerJson $writer @{ type = 'error'; code = 'unknown-type'; message = $type }
}

try { $writer.Flush() } catch { }
try { $writer.Dispose() } catch { }
try { $reader.Dispose() } catch { }
try { $pipe.Dispose() } catch { }
Write-BrokerLog ('exit pid=' + $PID + ' reason=' + $exitReason)
exit 0

