import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn() } }))

import {
  getAntigravityCliLogDirectory,
  getAntigravityLanguageServerLogPath,
  parseAntigravityAppConfig,
  parseAntigravityCliServerPorts,
  parseAntigravityLanguageServerPort
} from './antigravity-local-quota'

describe('Antigravity language-server discovery', () => {
  it('uses AGY CLI logs beneath the cross-platform home directory', () => {
    expect(getAntigravityCliLogDirectory('/home/lee')).toBe('/home/lee/.gemini/antigravity-cli/log')
  })

  it('uses Antigravity application log locations on desktop platforms', () => {
    expect(getAntigravityLanguageServerLogPath('darwin', '/Users/lee', '/app-data')).toBe(
      '/Users/lee/Library/Logs/Antigravity/language_server.log'
    )
    expect(getAntigravityLanguageServerLogPath('linux', '/home/lee', '/home/lee/.config')).toBe(
      '/home/lee/.config/Antigravity/logs/language_server.log'
    )
  })

  it('uses the most recent HTTPS port from a restarted language server', () => {
    const log = [
      'Language server listening on random port at 40100 for HTTPS (gRPC)',
      'Language server listening on random port at 40200 for HTTPS (gRPC)'
    ].join('\n')

    expect(parseAntigravityLanguageServerPort(log)).toBe(40200)
    expect(parseAntigravityLanguageServerPort('no listener')).toBeNull()
  })

  it('discovers both loopback ports exposed by the AGY CLI', () => {
    const log = [
      'Language server listening on random port at 58601 for HTTPS (gRPC)',
      'Language server listening on random port at 58602 for HTTP'
    ].join('\n')

    expect(parseAntigravityCliServerPorts(log)).toEqual({ http: 58602, https: 58601 })
    expect(parseAntigravityCliServerPorts('no listener')).toEqual({ http: null, https: null })
  })

  it('accepts only Antigravity app configuration with a CSRF token', () => {
    expect(
      parseAntigravityAppConfig(
        '<script>window.__APP_CONFIG__ = {"productName":"antigravity","csrfToken":"token"};</script>'
      )
    ).toEqual({ productName: 'antigravity', csrfToken: 'token' })
    expect(
      parseAntigravityAppConfig(
        '<script>window.__APP_CONFIG__ = {"productName":"other","csrfToken":"token"};</script>'
      )
    ).toBeNull()
  })
})
