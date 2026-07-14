import { describe, expect, it } from 'vitest'
import { parseAntigravityQuotaSummary } from './antigravity-quota-summary'

const quotaSummary = {
  response: {
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          {
            bucketId: 'gemini-weekly',
            displayName: 'Weekly Limit',
            window: 'weekly',
            remainingFraction: 0.916,
            resetTime: '2026-07-16T21:59:04Z'
          },
          {
            bucketId: 'gemini-5h',
            displayName: 'Five Hour Limit',
            window: '5h',
            remainingFraction: 1,
            resetTime: '2026-07-14T16:30:11Z'
          }
        ]
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          {
            bucketId: '3p-weekly',
            displayName: 'Weekly Limit',
            window: 'weekly',
            remainingFraction: 0.988,
            resetTime: '2026-07-21T11:28:50Z'
          },
          {
            bucketId: '3p-5h',
            displayName: 'Five Hour Limit',
            window: '5h',
            remainingFraction: 0.964,
            resetTime: '2026-07-14T16:28:50Z'
          }
        ]
      }
    ]
  }
}

describe('parseAntigravityQuotaSummary', () => {
  it('preserves model families with their five-hour and weekly limits', () => {
    const result = parseAntigravityQuotaSummary(quotaSummary, 1234)

    expect(result).toMatchObject({
      provider: 'gemini',
      session: { usedPercent: 4, windowMinutes: 300 },
      weekly: { usedPercent: 8, windowMinutes: 10_080 },
      updatedAt: 1234,
      status: 'ok'
    })
    expect(result?.groups?.map((group) => group.id)).toEqual(['gemini-models', 'claude-gpt-models'])
    expect(result?.groups?.[0]?.windows.map((window) => window.id)).toEqual(['session', 'weekly'])
    expect(result?.groups?.[1]?.windows.map((window) => window.window.usedPercent)).toEqual([4, 1])
  })

  it('rejects responses without usable groups', () => {
    expect(parseAntigravityQuotaSummary({ response: { groups: [] } })).toBeNull()
    expect(parseAntigravityQuotaSummary({ response: { groups: [{ displayName: 'Empty' }] } })).toBe(
      null
    )
    expect(parseAntigravityQuotaSummary(null)).toBeNull()
  })

  it('keeps usable windows when AGY omits reset metadata', () => {
    const withoutReset = structuredClone(quotaSummary)
    delete (withoutReset.response.groups[0].buckets[0] as { resetTime?: string }).resetTime

    expect(
      parseAntigravityQuotaSummary(withoutReset)?.groups?.[0]?.windows[1]?.window
    ).toMatchObject({
      usedPercent: 8,
      resetsAt: null
    })
  })
})
