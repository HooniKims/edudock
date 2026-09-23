param(
    [Parameter(Mandatory = $true)][string]$Helper,
    [ValidateRange(500, 10000)][int]$TimeoutMs = 10000
)

# Long-lived companion for the native helpers (ordinary-edge.ps1, edufine-draft.ps1).
#
# One-shot spawning cost about 700 ms per call in process start plus Add-Type compilation,
# on top of roughly 840 ms of real UI Automation work. While the login flow waits for the
# user's certificate password it polls continuously, so that overhead dominated and churned
# a new PowerShell process every couple of seconds.
#
# This script keeps one process alive and invokes the helper per request. The helper guards
# its Add-Type blocks with type-existence checks, so the compiled types and the loaded UIA
# assemblies survive between requests. Its `exit` calls end the invoked script only and
# return control here.
#
# Protocol: one base64 request per input line, exactly one compact JSON line per response,
# in order. The caller must keep a single request in flight so responses cannot be
# mismatched; on any protocol doubt the caller kills this process and starts a new one.

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$errorLine = '{"status":"error","windows":[]}'

function Write-Line {
    param([string]$Text)
    [Console]::Out.WriteLine($Text)
    [Console]::Out.Flush()
}

if (-not (Test-Path -LiteralPath $Helper -PathType Leaf)) {
    Write-Line $errorLine
    exit 1
}

$reader = New-Object IO.StreamReader([Console]::OpenStandardInput(), (New-Object Text.UTF8Encoding($false)))

while ($null -ne ($line = $reader.ReadLine())) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $response = $null
    try {
        $captured = & $Helper -RequestBase64 $line.Trim() -TimeoutMs $TimeoutMs 2>$null
        foreach ($item in @($captured)) {
            if ($null -eq $item) { continue }
            $text = ([string]$item).Trim()
            if ($text.Length -gt 0) { $response = $text }
        }
    } catch {
        $response = $null
    }
    if ([string]::IsNullOrWhiteSpace($response)) { $response = $errorLine }
    # A stray newline would desynchronise the stream, so collapse the response to one line.
    $response = $response -replace '\r', '' -replace '\n', ''
    Write-Line $response
}
