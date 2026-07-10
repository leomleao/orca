import { describe, expect, it } from 'vitest'
import { detectUsageLimitStall, extractUsageLimitResetAt } from './usage-limit-stall-detection'

// The runtime passes an ANSI-stripped, lowercased tail to detectUsageLimitStall.
const lc = (text: string): string => text.toLowerCase()

describe('detectUsageLimitStall', () => {
  it('detects the Claude Code idle session-limit banner', () => {
    const signal = detectUsageLimitStall(
      lc("You've hit your session limit · resets 3:50pm (Europe/London)")
    )
    expect(signal?.reason).toBe('usage-limit-banner')
  })

  it('detects a usage-limit banner phrased "hit your usage limit"', () => {
    expect(detectUsageLimitStall(lc("You've hit your usage limit. Try again later."))?.reason).toBe(
      'usage-limit-banner'
    )
  })

  it('detects a "usage limit reached" banner', () => {
    expect(detectUsageLimitStall(lc('Weekly limit reached — resets Thu'))?.reason).toBe(
      'usage-limit-banner'
    )
  })

  it('detects the Codex usage-limit error banner', () => {
    const codex =
      "You've hit your usage limit. Upgrade to Plus to continue using Codex " +
      '(https://chatgpt.com/explore/plus), or try again at Apr 23rd, 2026 10:42 AM.'
    expect(detectUsageLimitStall(lc(codex))?.reason).toBe('usage-limit-banner')
  })

  it('detects the wait-for-reset menu', () => {
    const menu = [
      'What do you want to do?',
      '❯ 1. Stop and wait for limit to reset',
      '  2. Ask your admin for more usage',
      '  Enter to confirm · Esc to cancel'
    ].join('\n')
    expect(detectUsageLimitStall(lc(menu))?.reason).toBe('usage-limit-menu')
  })

  it('detects the menu even when the PTY collapses the spaces', () => {
    // The menu text sometimes renders with collapsed whitespace.
    expect(detectUsageLimitStall('stopandwaitforlimittoreset')?.reason).toBe('usage-limit-menu')
    expect(detectUsageLimitStall('askyouradminformoreusage')?.reason).toBe('usage-limit-menu')
  })

  it('classifies the menu over a banner when both are in the tail', () => {
    const tail = [
      "You've hit your session limit · resets 3pm",
      '❯ 1. Stop and wait for limit to reset'
    ].join('\n')
    expect(detectUsageLimitStall(lc(tail))?.reason).toBe('usage-limit-menu')
  })

  it('ignores the "Show plan usage limits" command palette entry', () => {
    expect(detectUsageLimitStall(lc('> Show plan usage limits'))).toBeNull()
  })

  it('ignores a /usage table that merely lists reset times', () => {
    const usage = [
      'Current session   45% used   resets 3:00pm',
      'Weekly            12% used   resets Thu'
    ].join('\n')
    expect(detectUsageLimitStall(lc(usage))).toBeNull()
  })

  it('ignores an ordinary idle prompt', () => {
    expect(detectUsageLimitStall(lc('> \n╭─ claude ─╮'))).toBeNull()
  })
})

describe('extractUsageLimitResetAt', () => {
  it('parses the reset time from a banner into a future timestamp', () => {
    const resetsAt = extractUsageLimitResetAt([
      "You've hit your session limit · resets 3:50pm (Europe/London)"
    ])
    expect(typeof resetsAt).toBe('number')
    expect(resetsAt).toBeGreaterThan(Date.now())
  })

  it('parses a relative reset duration', () => {
    const resetsAt = extractUsageLimitResetAt(['Usage limit reached. Resets in 3h 20m'])
    expect(resetsAt).toBeGreaterThan(Date.now())
  })

  it('returns null when the tail carries no reset (e.g. the menu)', () => {
    expect(extractUsageLimitResetAt(['❯ 1. Stop and wait for limit to reset'])).toBeNull()
  })

  it('parses Codex "or try again at <date>" including the ordinal suffix', () => {
    const resetsAt = extractUsageLimitResetAt([
      "You've hit your usage limit. Upgrade to Plus to continue using Codex " +
        '(https://chatgpt.com/explore/plus), or try again at Apr 23rd, 2026 10:42 AM.'
    ])
    expect(resetsAt).toBe(new Date('Apr 23, 2026 10:42 AM').getTime())
  })

  it('parses a Codex reset with a PM time', () => {
    const resetsAt = extractUsageLimitResetAt(['or try again at May 14th, 2026 2:32 PM.'])
    expect(resetsAt).toBe(new Date('May 14, 2026 2:32 PM').getTime())
  })
})
