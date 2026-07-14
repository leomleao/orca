import { readFile, readdir } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { parseAntigravityQuotaSummary } from './antigravity-quota-summary'

const LANGUAGE_SERVER_LOG_NAME = 'language_server.log'
const CLI_LOG_LIMIT = 12
const REQUEST_TIMEOUT_MS = 3_000
const MAX_RESPONSE_BYTES = 1024 * 1024
const QUOTA_SUMMARY_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'

type LocalProtocol = 'http:' | 'https:'

type AntigravityAppConfig = {
  csrfToken: string
  productName: string
}

export type AntigravityServerPorts = {
  http: number | null
  https: number | null
}

export type AntigravityLocalRateLimitOptions = {
  homePath?: string
  appDataPath?: string
}

/** Converts a listener value into a valid TCP port. */
function validPort(value: string | undefined): number | null {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null
}

/** Resolves AGY's per-user CLI log directory without platform-specific separators. */
export function getAntigravityCliLogDirectory(homePath: string): string {
  return join(homePath, '.gemini', 'antigravity-cli', 'log')
}

/** Uses the newest listener announcement when a CLI log contains server restarts. */
export function parseAntigravityCliServerPorts(log: string): AntigravityServerPorts {
  const httpsMatches = [
    ...log.matchAll(/language server listening on (?:random port at )?(\d+) for HTTPS/gi)
  ]
  const httpMatches = [
    ...log.matchAll(/language server listening on (?:random port at )?(\d+) for HTTP(?!S)/gi)
  ]
  return {
    http: validPort(httpMatches.at(-1)?.[1]),
    https: validPort(httpsMatches.at(-1)?.[1])
  }
}

/** Resolves the Antigravity desktop language-server log on supported platforms. */
export function getAntigravityLanguageServerLogPath(
  platform: NodeJS.Platform,
  homePath: string,
  appDataPath: string
): string {
  return platform === 'darwin'
    ? join(homePath, 'Library', 'Logs', 'Antigravity', LANGUAGE_SERVER_LOG_NAME)
    : join(appDataPath, 'Antigravity', 'logs', LANGUAGE_SERVER_LOG_NAME)
}

/** Returns the newest desktop HTTPS listener recorded in a language-server log. */
export function parseAntigravityLanguageServerPort(log: string): number | null {
  return parseAntigravityCliServerPorts(log).https
}

/** Accepts CSRF configuration only from a page identifying itself as Antigravity. */
export function parseAntigravityAppConfig(html: string): AntigravityAppConfig | null {
  const configJson = html.match(/window\.__APP_CONFIG__\s*=\s*(\{.*?\});<\/script>/s)?.[1]
  if (!configJson) {
    return null
  }
  try {
    const config = JSON.parse(configJson) as Record<string, unknown>
    return config.productName === 'antigravity' &&
      typeof config.csrfToken === 'string' &&
      config.csrfToken.length > 0
      ? { productName: config.productName, csrfToken: config.csrfToken }
      : null
  } catch {
    return null
  }
}

/** Sends a bounded request to an Antigravity service on the loopback interface. */
function requestLocalAntigravity(
  protocol: LocalProtocol,
  port: number,
  path: string,
  options?: { body?: string; csrfToken?: string }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = options?.body
    const headers: Record<string, string | number> = { Connection: 'close' }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(body)
      headers['Connect-Protocol-Version'] = '1'
    }
    if (options?.csrfToken) {
      headers['x-codeium-csrf-token'] = options.csrfToken
    }

    // Why: older Antigravity servers expose only self-signed HTTPS. Restricting
    // the exception to a fixed loopback host prevents it from reaching a network.
    const request = protocol === 'https:' ? httpsRequest : httpRequest
    const req = request(
      {
        protocol,
        hostname: '127.0.0.1',
        port,
        path,
        method: body === undefined ? 'GET' : 'POST',
        headers,
        rejectUnauthorized: protocol === 'https:' ? false : undefined,
        timeout: REQUEST_TIMEOUT_MS
      },
      (res) => {
        const chunks: Buffer[] = []
        let byteLength = 0
        res.on('data', (chunk: Buffer) => {
          byteLength += chunk.length
          if (byteLength > MAX_RESPONSE_BYTES) {
            req.destroy(new Error('Antigravity quota response exceeded size limit'))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode !== 200) {
            reject(new Error(`Antigravity quota request failed (${res.statusCode ?? 'unknown'})`))
            return
          }
          resolve(responseBody)
        })
      }
    )
    req.on('timeout', () => {
      req.destroy(new Error('Antigravity quota request timed out'))
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** Parses a local quota response into Orca's provider rate-limit shape. */
function parseQuotaResponse(response: string): ProviderRateLimits | null {
  return parseAntigravityQuotaSummary(JSON.parse(response) as unknown)
}

/** Searches recent CLI logs for the newest reachable Antigravity server. */
async function fetchFromCliLogs(homePath: string): Promise<ProviderRateLimits | null> {
  const logDirectory = getAntigravityCliLogDirectory(homePath)
  const entries = await readdir(logDirectory, { withFileTypes: true })
  const logNames = entries
    .filter((entry) => entry.isFile() && /^cli-.*\.log$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, CLI_LOG_LIMIT)
  const attemptedEndpoints = new Set<string>()

  for (const logName of logNames) {
    let log: string
    try {
      log = await readFile(join(logDirectory, logName), 'utf8')
    } catch {
      continue
    }
    const ports = parseAntigravityCliServerPorts(log)
    const endpoints: { protocol: LocalProtocol; port: number | null }[] = [
      { protocol: 'http:', port: ports.http },
      { protocol: 'https:', port: ports.https }
    ]
    for (const endpoint of endpoints) {
      if (!endpoint.port) {
        continue
      }
      const endpointKey = `${endpoint.protocol}//127.0.0.1:${endpoint.port}`
      if (attemptedEndpoints.has(endpointKey)) {
        continue
      }
      attemptedEndpoints.add(endpointKey)
      try {
        const response = await requestLocalAntigravity(
          endpoint.protocol,
          endpoint.port,
          QUOTA_SUMMARY_PATH,
          { body: JSON.stringify({ forceRefresh: true }) }
        )
        const parsed = parseQuotaResponse(response)
        if (parsed) {
          return {
            ...parsed,
            usageMetadata: { source: 'cli', attemptedSources: ['cli'] }
          }
        }
      } catch {
        // A newer one-shot AGY command can leave a stale log above a live session.
      }
    }
  }
  return null
}

/** Reads quota from the Antigravity desktop language server. */
async function fetchFromDesktopApp(
  homePath: string,
  appDataPath: string
): Promise<ProviderRateLimits | null> {
  const logPath = getAntigravityLanguageServerLogPath(process.platform, homePath, appDataPath)
  const port = parseAntigravityLanguageServerPort(await readFile(logPath, 'utf8'))
  if (!port) {
    return null
  }
  const appConfig = parseAntigravityAppConfig(await requestLocalAntigravity('https:', port, '/'))
  if (!appConfig) {
    return null
  }
  const response = await requestLocalAntigravity('https:', port, QUOTA_SUMMARY_PATH, {
    csrfToken: appConfig.csrfToken,
    body: JSON.stringify({ forceRefresh: true })
  })
  return parseQuotaResponse(response)
}

/** Prefers a live AGY CLI, then degrades through desktop and credential sources. */
export async function fetchAntigravityLocalRateLimits(
  options?: AntigravityLocalRateLimitOptions
): Promise<ProviderRateLimits | null> {
  const homePath = options?.homePath ?? homedir()
  try {
    const cliRateLimits = await fetchFromCliLogs(homePath)
    if (cliRateLimits) {
      return cliRateLimits
    }
  } catch {
    // AGY is optional; the desktop language server may still be available.
  }

  try {
    return await fetchFromDesktopApp(homePath, options?.appDataPath ?? app.getPath('appData'))
  } catch {
    // Native keyring and Gemini OAuth sources remain the final fallback.
    return null
  }
}
