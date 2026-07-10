import type { UsageLimitStallReason } from '../../shared/agent-auto-resume-types'
import { extractClaudePtyResetMetadata } from '../rate-limits/claude-pty-reset-parser'

export type UsageLimitStallSignal = {
  reason: UsageLimitStallReason
  /** Offset of the match in the scanned (lowercased) tail. Used to decide when
   *  an appended chunk introduced a *newer* stall than the previous tail held. */
  index: number
}

// Why: match the wait-for-reset menu option. `\s*` between tokens tolerates the
// space-collapsed render the PTY sometimes emits ("Stopandwaitforlimittoreset")
// as well as normal spacing. The reset option is the strongest menu signal.
const MENU_RESET_OPTION_RE = /stop\s*and\s*wait\s*for\s*(?:the\s*)?limit\s*to\s*reset/
// Why: the admin option co-occurs with the reset option; matching it too keeps
// detection alive if the reset line scrolls just out of the retained tail.
const MENU_ADMIN_OPTION_RE = /ask\s*your\s*admin\s*for\s*more\s*usage/

// Why: the idle banner states the agent is blocked BY a limit. Requiring
// "hit/reached your … limit" (or "… limit reached") keeps this specific enough
// to skip the /usage table and the "Show plan usage limits" command palette,
// which also contain the word "limit" and even "resets" lines. Whitespace is
// tolerant for the same collapsed-render reason as the menu patterns.
const BANNER_HIT_LIMIT_RE =
  /(?:hit|hitting|reached|reaching)\s*your\s*(?:(?:5-?\s*hour|5h|weekly|session|usage|rate)\s*)*limit/
const BANNER_LIMIT_REACHED_RE = /(?:session|usage|weekly|rate)\s*limit\s*(?:has\s*been\s*)?reached/

function firstMatchIndex(text: string, patterns: RegExp[]): number | null {
  let best: number | null = null
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match && (best === null || match.index < best)) {
      best = match.index
    }
  }
  return best
}

/**
 * Detect whether an agent CLI is stalled on a provider usage limit.
 *
 * @param normalizedTail the retained PTY tail, ANSI-stripped and lowercased
 *   (the same text `findActionableTerminalWaitBlockedSignal` scans).
 *
 * Menu wins over banner: the interactive chooser is the actionable state and
 * its "limit to reset" text never matches the banner patterns, so the two
 * classifications stay disjoint. The returned index is the latest match so the
 * caller's "did this chunk add a newer stall?" comparison stays monotonic.
 */
export function detectUsageLimitStall(normalizedTail: string): UsageLimitStallSignal | null {
  const menuIndex = firstMatchIndex(normalizedTail, [MENU_RESET_OPTION_RE, MENU_ADMIN_OPTION_RE])
  if (menuIndex !== null) {
    return { reason: 'usage-limit-menu', index: menuIndex }
  }
  const bannerIndex = firstMatchIndex(normalizedTail, [
    BANNER_HIT_LIMIT_RE,
    BANNER_LIMIT_REACHED_RE
  ])
  if (bannerIndex !== null) {
    return { reason: 'usage-limit-banner', index: bannerIndex }
  }
  return null
}

const BANNER_LABEL_RE =
  /(?:session|usage|weekly|rate|5-?\s*hour|5h)\s*limit|hit\s*your|limit\s*reset/i

// Why: Codex phrases its reset as "…or try again at Apr 23rd, 2026 10:42 AM.",
// which the Claude "resets …" parser doesn't recognize. Match the date after
// the retry marker; [\s\S]*? lets the copy between the prefix and marker wrap.
const CODEX_RETRY_AT_RE =
  /or\s+try\s+again\s+at\s+([A-Z][a-z]{2,8}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM))\.?/i
const DAY_ORDINAL_RE = /(\d{1,2})(?:st|nd|rd|th)/i

function parseCodexRetryAt(text: string): number | null {
  const match = CODEX_RETRY_AT_RE.exec(text)
  if (!match) {
    return null
  }
  // "Apr 23rd, 2026 10:42 AM" -> "Apr 23, 2026 10:42 AM" so Date can parse it.
  // The text carries no timezone, so this resolves in the runtime host's local
  // zone; the service prefers the provider's structured resets_at when present.
  const normalized = match[1].replace(DAY_ORDINAL_RE, '$1')
  const timestamp = new Date(normalized).getTime()
  return Number.isFinite(timestamp) ? timestamp : null
}

/**
 * Parse the reset timestamp out of a usage-limit banner's tail. Handles Codex's
 * "or try again at <date>" and Claude's "resets 3:50pm" / "resets Jan 5 at 4pm"
 * / relative "3h 20m" (with time zones). Returns null when the banner carries
 * no parseable reset (e.g. the menu, which never prints a time).
 */
export function extractUsageLimitResetAt(tailLines: string[]): number | null {
  return (
    parseCodexRetryAt(tailLines.join('\n')) ??
    extractClaudePtyResetMetadata(
      tailLines,
      (line) => BANNER_LABEL_RE.test(line),
      () => false
    ).resetsAt
  )
}
