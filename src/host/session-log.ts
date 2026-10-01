/**
 * Reading the ONE fact both host paths need out of a Session: its first human
 * prompt, and the route its own log says it ran on.
 *
 * The predicate is `session-title`'s own — a `user/message` whose
 * `source.kind === 'user'`, with at least one non-blank text block — and it is
 * shared here so the live cadence and the stored-history backfill cannot drift
 * apart. Falling through unknown source kinds matters: the message-source union
 * is merge-extensible, and only `'user'` is a human prompt.
 *
 * @module dsh-session-workspaces/host/session-log
 */

import type { SessionRoute } from './classifier.ts'
import { routeFromHeader } from './classifier.ts'

/** One Session event as this plugin reads it. */
export interface LoggedEvent {
  /** Event discriminant. */
  readonly type: string
  /** Event payload. */
  readonly data?: unknown
}

/**
 * The human text of one `user/message` payload.
 *
 * Only `type: 'text'` blocks count: an image-only or tool-result message is not
 * a prompt, and treating it as one would classify a Session from nothing.
 * @param data - the event's `data` payload, of unknown shape.
 * @returns the joined text, or undefined when the message is not a human prompt.
 */
export function humanPromptText(data: unknown): string | undefined {
  const payload = data as { source?: { kind?: unknown }; content?: unknown } | undefined
  if (payload?.source?.kind !== 'user') return undefined
  const content = payload.content
  if (!Array.isArray(content)) return undefined
  const text = content
    .filter((block): block is { readonly type: string; readonly text: string } => {
      const candidate = block as { type?: unknown; text?: unknown }
      return candidate.type === 'text' && typeof candidate.text === 'string'
    })
    .map(block => block.text)
    .join('\n')
    .trim()
  return text === '' ? undefined : text
}

/**
 * The first human prompt in a stored Session's log.
 * @param events - the Session's events, in order.
 * @returns the prompt text, or undefined when the log holds no human message.
 */
export function firstHumanPrompt(events: readonly LoggedEvent[]): string | undefined {
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const text = humanPromptText(event.data)
    if (text !== undefined) return text
  }
  return undefined
}

/**
 * The Session's own logged route, read from the LAST `request/header` in its log.
 *
 * A stored Session is not live, so `session.requestHeader()` does not exist for
 * it; the header event is the same fact, and the newest one is the route the
 * Session most recently ran on.
 * @param events - the Session's events, in order.
 * @returns the route, or undefined when the log carries no complete header.
 */
export function routeFromEvents(events: readonly LoggedEvent[]): SessionRoute | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'request/header') continue
    const route = routeFromHeader((event.data as { header?: unknown } | undefined)?.header)
    if (route !== undefined) return route
  }
  return undefined
}
