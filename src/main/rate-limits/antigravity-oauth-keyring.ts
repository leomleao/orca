import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GeminiCredentials } from './gemini-oauth-sources'

const execFileAsync = promisify(execFile)
const KEYRING_SERVICE = 'gemini'
const KEYRING_ACCOUNT = 'antigravity'
const KEYRING_VALUE_PREFIX = 'go-keyring-base64:'
const KEYRING_TIMEOUT_MS = 3_000
const KEYRING_MISS_CACHE_MS = 60_000
const WINDOWS_TARGET_PLACEHOLDER = '__ORCA_CREDENTIAL_TARGET__'

let keyringMissExpiresAt = 0

type KeyringCommand = {
  command: string
  args: string[]
  output: 'text' | 'base64'
}

const WINDOWS_CREDENTIAL_SCRIPT = String.raw`
$signature = @'
using System;
using System.Runtime.InteropServices;
public static class OrcaCredentialReader {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Credential {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr credential);
}
'@
Add-Type -TypeDefinition $signature
$pointer = [IntPtr]::Zero
if ([OrcaCredentialReader]::CredRead('${WINDOWS_TARGET_PLACEHOLDER}', 1, 0, [ref]$pointer)) {
  try {
    $credential = [Runtime.InteropServices.Marshal]::PtrToStructure(
      $pointer,
      [type][OrcaCredentialReader+Credential]
    )
    $bytes = New-Object byte[] $credential.CredentialBlobSize
    [Runtime.InteropServices.Marshal]::Copy(
      $credential.CredentialBlob,
      $bytes,
      0,
      $credential.CredentialBlobSize
    )
    [Convert]::ToBase64String($bytes)
  } finally {
    [OrcaCredentialReader]::CredFree($pointer)
  }
}
`.trim()

/** Builds the Windows credential reader from the same service and account used elsewhere. */
function buildWindowsCredentialScript(): string {
  return WINDOWS_CREDENTIAL_SCRIPT.replace(
    WINDOWS_TARGET_PLACEHOLDER,
    `${KEYRING_SERVICE}:${KEYRING_ACCOUNT}`
  )
}

/** Keeps native credential-store access behind fixed, platform-specific commands. */
export function getAntigravityKeyringCommand(platform: NodeJS.Platform): KeyringCommand | null {
  switch (platform) {
    case 'darwin':
      return {
        command: 'security',
        args: ['find-generic-password', '-s', KEYRING_SERVICE, '-a', KEYRING_ACCOUNT, '-w'],
        output: 'text'
      }
    case 'linux':
    case 'freebsd':
    case 'openbsd':
      return {
        command: 'secret-tool',
        args: ['lookup', 'service', KEYRING_SERVICE, 'username', KEYRING_ACCOUNT],
        output: 'text'
      }
    case 'win32':
      return {
        command: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-Command', buildWindowsCredentialScript()],
        output: 'base64'
      }
    case 'aix':
    case 'android':
    case 'cygwin':
    case 'haiku':
    case 'netbsd':
    case 'sunos':
      return null
  }
}

/** Rejects incomplete or malformed keyring values before they reach Google APIs. */
export function parseAntigravityKeyringCredentials(rawValue: string): GeminiCredentials | null {
  const trimmed = rawValue.trim()
  if (!trimmed.startsWith(KEYRING_VALUE_PREFIX)) {
    return null
  }

  try {
    const decoded = Buffer.from(trimmed.slice(KEYRING_VALUE_PREFIX.length), 'base64').toString(
      'utf8'
    )
    const parsed = JSON.parse(decoded) as {
      token?: {
        access_token?: unknown
        refresh_token?: unknown
        expiry?: unknown
      }
    }
    const accessToken = parsed.token?.access_token
    const refreshToken = parsed.token?.refresh_token
    const expiry = parsed.token?.expiry
    const expiryDate = typeof expiry === 'string' ? Date.parse(expiry) : Number.NaN
    if (
      typeof accessToken !== 'string' ||
      accessToken.length === 0 ||
      typeof refreshToken !== 'string' ||
      refreshToken.length === 0 ||
      !Number.isFinite(expiryDate)
    ) {
      return null
    }

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expiry_date: expiryDate
    }
  } catch {
    return null
  }
}

/** Reads Antigravity credentials without making keyring availability a hard dependency. */
export async function readAntigravityCredentials(): Promise<GeminiCredentials | null> {
  const command = getAntigravityKeyringCommand(process.platform)
  if (!command) {
    return null
  }
  const now = Date.now()
  if (now < keyringMissExpiresAt) {
    return null
  }

  try {
    // Why: AGY moved OAuth state into the OS keyring, so the legacy Gemini file
    // can stay expired even while Antigravity has a current session.
    const { stdout } = await execFileAsync(command.command, command.args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024,
      timeout: KEYRING_TIMEOUT_MS,
      windowsHide: true
    })
    const keyringValue =
      command.output === 'base64' ? Buffer.from(stdout.trim(), 'base64').toString('utf8') : stdout
    const credentials = parseAntigravityKeyringCredentials(keyringValue)
    // Why: background refreshes should not repeatedly spawn native keyring tools
    // when Antigravity is absent, locked, or contains an unreadable value.
    keyringMissExpiresAt = credentials ? 0 : now + KEYRING_MISS_CACHE_MS
    return credentials
  } catch {
    // A locked or unavailable keyring should fall through to legacy Gemini sources.
    keyringMissExpiresAt = now + KEYRING_MISS_CACHE_MS
    return null
  }
}
