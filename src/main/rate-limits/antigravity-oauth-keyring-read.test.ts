import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileAsyncMock, execFileMock, promisifyCustom } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  execFileMock: vi.fn(),
  promisifyCustom: Symbol.for('nodejs.util.promisify.custom')
}))

vi.mock('node:child_process', () => ({
  execFile: Object.assign(execFileMock, {
    [promisifyCustom]: execFileAsyncMock
  })
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

function encodedKeyringValue(): string {
  return `go-keyring-base64:${Buffer.from(
    JSON.stringify({
      token: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expiry: '2026-07-14T14:00:00.000Z'
      }
    })
  ).toString('base64')}`
}

describe('readAntigravityCredentials', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-14T12:00:00.000Z'))
    execFileAsyncMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('reads and parses a native keyring value with bounded process options', async () => {
    setPlatform('darwin')
    execFileAsyncMock.mockResolvedValue({ stdout: encodedKeyringValue(), stderr: '' })
    const { readAntigravityCredentials } = await import('./antigravity-oauth-keyring')

    await expect(readAntigravityCredentials()).resolves.toEqual({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expiry_date: Date.parse('2026-07-14T14:00:00.000Z')
    })
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'security',
      ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'],
      {
        encoding: 'utf8',
        maxBuffer: 16 * 1024,
        timeout: 3_000,
        windowsHide: true
      }
    )
  })

  it('derives the Windows target and decodes credential-manager output', async () => {
    setPlatform('win32')
    execFileAsyncMock.mockResolvedValue({
      stdout: Buffer.from(encodedKeyringValue()).toString('base64'),
      stderr: ''
    })
    const { readAntigravityCredentials } = await import('./antigravity-oauth-keyring')

    await expect(readAntigravityCredentials()).resolves.toMatchObject({
      access_token: 'access-token'
    })
    const command = execFileAsyncMock.mock.calls[0]?.[1]?.[3] as string
    expect(command).toContain("CredRead('gemini:antigravity'")
    expect(command).not.toContain('__ORCA_CREDENTIAL_TARGET__')
  })

  it('caches native keyring failures briefly before retrying', async () => {
    setPlatform('darwin')
    execFileAsyncMock.mockRejectedValue(new Error('keyring unavailable'))
    const { readAntigravityCredentials } = await import('./antigravity-oauth-keyring')

    await expect(readAntigravityCredentials()).resolves.toBeNull()
    await expect(readAntigravityCredentials()).resolves.toBeNull()
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(60_001)
    await expect(readAntigravityCredentials()).resolves.toBeNull()
    expect(execFileAsyncMock).toHaveBeenCalledTimes(2)
  })
})
