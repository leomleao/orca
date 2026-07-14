import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { getPath: vi.fn() } }))

import {
  fetchAntigravityLocalRateLimits,
  getAntigravityCliLogDirectory,
  getAntigravityLanguageServerLogPath,
  parseAntigravityAppConfig,
  parseAntigravityCliServerPorts,
  parseAntigravityLanguageServerPort
} from './antigravity-local-quota'

describe('Antigravity language-server discovery', () => {
  it('falls past a newer stale AGY log to a live CLI quota service', async () => {
    const homePath = await mkdtemp(join(tmpdir(), 'orca-antigravity-cli-'))
    const logDirectory = getAntigravityCliLogDirectory(homePath)
    let requestBody = ''
    const server = createServer((request, response) => {
      request.on('data', (chunk: Buffer) => {
        requestBody += chunk.toString('utf8')
      })
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            response: {
              groups: [
                {
                  displayName: 'Gemini Models',
                  buckets: [
                    {
                      bucketId: 'gemini-weekly',
                      displayName: 'Weekly Limit',
                      window: 'weekly',
                      remainingFraction: 0.92
                    },
                    {
                      bucketId: 'gemini-5h',
                      displayName: 'Five Hour Limit',
                      window: '5h',
                      remainingFraction: 1
                    }
                  ]
                }
              ]
            }
          })
        )
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP listener')
    }

    try {
      await mkdir(logDirectory, { recursive: true })
      await writeFile(
        join(logDirectory, 'cli-20260714_123131.log'),
        'Language server listening on random port at 1 for HTTP'
      )
      await writeFile(
        join(logDirectory, 'cli-20260714_103225.log'),
        `Language server listening on random port at ${address.port} for HTTP`
      )

      const result = await fetchAntigravityLocalRateLimits({
        homePath,
        appDataPath: join(homePath, 'app-data')
      })

      expect(requestBody).toBe('{"forceRefresh":true}')
      expect(result).toMatchObject({
        provider: 'gemini',
        session: { usedPercent: 0 },
        weekly: { usedPercent: 8 },
        usageMetadata: { source: 'cli' }
      })
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      await rm(homePath, { recursive: true, force: true })
    }
  })

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
