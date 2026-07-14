import type {
  ProviderRateLimits,
  RateLimitGroup,
  RateLimitWindow
} from '../../shared/rate-limit-types'

type QuotaSummaryBucket = {
  bucketId: string
  displayName: string
  window: string
  remainingFraction: number
  resetTime: string | null
}

type QuotaSummaryGroup = {
  displayName: string
  buckets: QuotaSummaryBucket[]
}

function parseBucket(value: unknown): QuotaSummaryBucket | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const bucket = value as Record<string, unknown>
  if (
    typeof bucket.bucketId !== 'string' ||
    typeof bucket.displayName !== 'string' ||
    typeof bucket.window !== 'string' ||
    typeof bucket.remainingFraction !== 'number' ||
    !Number.isFinite(bucket.remainingFraction) ||
    (bucket.resetTime !== undefined &&
      bucket.resetTime !== null &&
      typeof bucket.resetTime !== 'string')
  ) {
    return null
  }
  return {
    bucketId: bucket.bucketId,
    displayName: bucket.displayName,
    window: bucket.window,
    remainingFraction: bucket.remainingFraction,
    resetTime: typeof bucket.resetTime === 'string' ? bucket.resetTime : null
  }
}

function getGroupId(group: QuotaSummaryGroup): string {
  if (group.buckets.some((bucket) => bucket.bucketId.startsWith('gemini-'))) {
    return 'gemini-models'
  }
  if (group.buckets.some((bucket) => bucket.bucketId.startsWith('3p-'))) {
    return 'claude-gpt-models'
  }
  return group.displayName
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '')
}

function getWindowId(bucket: QuotaSummaryBucket): 'session' | 'weekly' | null {
  if (bucket.window === '5h' || bucket.bucketId.endsWith('-5h')) {
    return 'session'
  }
  if (bucket.window === 'weekly' || bucket.bucketId.endsWith('-weekly')) {
    return 'weekly'
  }
  return null
}

function toRateLimitWindow(bucket: QuotaSummaryBucket): RateLimitWindow {
  const remainingFraction = Math.min(1, Math.max(0, bucket.remainingFraction))
  const resetsAt = bucket.resetTime ? new Date(bucket.resetTime).getTime() : Number.NaN
  return {
    usedPercent: Math.round((1 - remainingFraction) * 100),
    windowMinutes: getWindowId(bucket) === 'weekly' ? 10_080 : 300,
    resetsAt: Number.isNaN(resetsAt) ? null : resetsAt,
    resetDescription: null
  }
}

function parseGroup(value: unknown): RateLimitGroup | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const rawGroup = value as Record<string, unknown>
  if (typeof rawGroup.displayName !== 'string' || !Array.isArray(rawGroup.buckets)) {
    return null
  }
  const parsedGroup: QuotaSummaryGroup = {
    displayName: rawGroup.displayName,
    buckets: rawGroup.buckets.map(parseBucket).filter((bucket) => bucket !== null)
  }
  const windows = parsedGroup.buckets
    .map((bucket) => {
      const id = getWindowId(bucket)
      return id ? { id, name: bucket.displayName, window: toRateLimitWindow(bucket) } : null
    })
    .filter((window) => window !== null)
    .sort((a, b) => {
      const rank = { session: 0, weekly: 1 }
      return rank[a.id] - rank[b.id]
    })
  if (windows.length === 0) {
    return null
  }
  return {
    id: getGroupId(parsedGroup),
    name: parsedGroup.displayName,
    windows
  }
}

function mostConstrainedWindow(groups: RateLimitGroup[], id: string): RateLimitWindow | null {
  const windows = groups.flatMap((group) =>
    group.windows.filter((entry) => entry.id === id).map((entry) => entry.window)
  )
  return windows.reduce<RateLimitWindow | null>((worst, window) => {
    return !worst || window.usedPercent > worst.usedPercent ? window : worst
  }, null)
}

/** Converts AGY's grouped remaining quotas into Orca's consumption-based model. */
export function parseAntigravityQuotaSummary(
  value: unknown,
  updatedAt = Date.now()
): ProviderRateLimits | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const response = (value as { response?: unknown }).response
  if (!response || typeof response !== 'object') {
    return null
  }
  const rawGroups = (response as { groups?: unknown }).groups
  if (!Array.isArray(rawGroups)) {
    return null
  }
  const groups = rawGroups.map(parseGroup).filter((group) => group !== null)
  if (groups.length === 0) {
    return null
  }
  return {
    provider: 'gemini',
    session: mostConstrainedWindow(groups, 'session'),
    weekly: mostConstrainedWindow(groups, 'weekly'),
    groups,
    updatedAt,
    error: null,
    status: 'ok'
  }
}
