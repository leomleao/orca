import { describe, expect, it } from 'vitest'
import {
  getAntigravityKeyringCommand,
  parseAntigravityKeyringCredentials
} from './antigravity-oauth-keyring'

function encodedKeyringValue(value: unknown): string {
  return `go-keyring-base64:${Buffer.from(JSON.stringify(value)).toString('base64')}`
}

describe('parseAntigravityKeyringCredentials', () => {
  it('parses the AGY native-keyring envelope', () => {
    const result = parseAntigravityKeyringCredentials(
      encodedKeyringValue({
        auth_method: 'consumer',
        token: {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          token_type: 'Bearer',
          expiry: '2026-07-14T12:32:24.665308+01:00'
        }
      })
    )

    expect(result).toEqual({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expiry_date: Date.parse('2026-07-14T12:32:24.665308+01:00')
    })
  })

  it.each([
    '',
    'plain-text',
    'go-keyring-base64:not-base64-json',
    encodedKeyringValue({ token: { access_token: 'access', expiry: '2026-07-14' } }),
    encodedKeyringValue({
      token: { access_token: 'access', refresh_token: 'refresh', expiry: 'not-a-date' }
    })
  ])('rejects malformed keyring data', (value) => {
    expect(parseAntigravityKeyringCredentials(value)).toBeNull()
  })
})

describe('getAntigravityKeyringCommand', () => {
  it('uses native keyring readers on each supported desktop platform', () => {
    expect(getAntigravityKeyringCommand('darwin')).toMatchObject({
      command: 'security',
      args: expect.arrayContaining(['gemini', 'antigravity']),
      output: 'text'
    })
    expect(getAntigravityKeyringCommand('linux')).toMatchObject({
      command: 'secret-tool',
      args: ['lookup', 'service', 'gemini', 'username', 'antigravity'],
      output: 'text'
    })
    expect(getAntigravityKeyringCommand('win32')).toMatchObject({
      command: 'powershell.exe',
      output: 'base64'
    })
  })

  it('returns null on unsupported platforms', () => {
    expect(getAntigravityKeyringCommand('aix')).toBeNull()
  })
})
