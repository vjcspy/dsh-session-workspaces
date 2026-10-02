/**
 * The plugin's Conversation-title provider.
 *
 * The title is not a second model call: `generate` awaits the SAME decision the
 * sidebar classification runs for the Session (see `./decision.ts`), and returns
 * the summary that call already produced. The core title service keeps every
 * part of its own pipeline — `validateResult`, the deterministic fallback, and
 * the Human-rename pin — so this provider only has to answer with the two facts
 * the service asks for: a title, and the seqs of the messages it came from.
 *
 * `sessionTitle` is reached OPTIONALLY. The sidebar grouping half works on hosts
 * where the title service is absent (or mounts later), so a required injection
 * would trade a working feature for a missing one.
 *
 * @module dsh-session-workspaces/host/title-provider
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  SessionTitleProviderId,
  type SessionTitleProvider,
  type SessionTitleProviderRequest,
  type SessionTitleProviderResult,
} from '@deepseek-ai/dsh-session-title'

import { PLUGIN_ID } from '../config.ts'
import type { DecisionLedger } from './decision.ts'

/**
 * The provider id the core service records with every title this plugin writes.
 *
 * Branded through the service's own constructor function, not cast: the brand is
 * what the service's provider-id comparison relies on.
 */
export const TITLE_PROVIDER_ID = SessionTitleProviderId(PLUGIN_ID)

/**
 * Build the provider the core title service holds.
 * @param ledger - the shared, keyed decision entry point.
 * @returns the provider.
 */
export function createTitleProvider(ledger: DecisionLedger): SessionTitleProvider {
  return {
    id: TITLE_PROVIDER_ID,
    // The classification cadence: one decision per Session, on its first prompt.
    automatic: 'first-prompt',
    async generate(request: SessionTitleProviderRequest): Promise<SessionTitleProviderResult> {
      const first = request.messages[0]
      if (first === undefined) {
        throw new Error(`${PLUGIN_ID}: the title request carried no human message to summarise`)
      }
      // Cancelled before it started: throw before the decision is asked for, so a
      // superseded request never spends the Session's one model call.
      request.signal.throwIfAborted()
      // The seq MUST come from this request's own snapshot: the service rejects a
      // seq it cannot find there, and only the snapshot knows what the log holds.
      const messageSeqs = [first.seq]
      const outcome = await abortable(ledger.decide(request.session), request.signal)
      if (!outcome.ok) {
        throw new Error(`${PLUGIN_ID}: no title summary (${outcome.reason}): ${outcome.message}`)
      }
      const summary = outcome.summary
      if (summary === undefined) {
        // A decided Session without a summary — a Human pin, an earlier answer
        // that omitted the field, or a call this Session never got. Answering
        // with an empty title or empty seqs would be rejected by the service
        // anyway; throwing is what hands the Session to the core fallback title.
        throw new Error(`${PLUGIN_ID}: the classification answered without a summary`)
      }
      return {
        title: summary,
        messageSeqs,
        model: { provider: outcome.route.provider, model: outcome.route.model },
      }
    },
  }
}

/**
 * Reach `sessionTitle` and register the provider, without gating this plugin on it.
 *
 * `ctx.inject` is the optional reach this vendored Cordis supports: the callback
 * is a child plugin whose only injection is `sessionTitle`, so the sidebar half
 * mounts whether or not the title service exists, and the title half attaches
 * whenever it appears — including when it appears after this plugin. A required
 * `inject` entry, by contrast, would hold the WHOLE plugin pending and take the
 * already-working grouping half down with it.
 * @param ctx - the host context.
 * @param ledger - the shared, keyed decision entry point.
 */
export function registerTitleProvider(ctx: Context, ledger: DecisionLedger): void {
  ctx.inject(['sessionTitle'], (titleCtx) => {
    try {
      titleCtx.sessionTitle.register(createTitleProvider(ledger))
    } catch (error) {
      // The service holds ONE provider (`session-title/src/index.ts:471-475`), and
      // the shipped `session-title-llm` row is enabled by default. This catch is
      // therefore the shape of a profile that was never told to disable it.
      // Warn loudly and keep booting: the grouping half and the core fallback
      // title both keep working, and the fix is a profile edit, not a crash.
      titleCtx.logger.warn(
        `${PLUGIN_ID}: could not register the conversation-title provider — ${messageOf(error)}. `
        + 'HARD PRECONDITION: the profile must disable the shipped title row '
        + '(`- id: session-title-llm` with `disabled: true` in its `cordis.patch.yml`). '
        + 'Until it does, titles come from that row and no classification-derived title appears.',
      )
    }
  })
}

/**
 * Await one promise, or the caller's cancellation.
 *
 * The core service aborts this signal when a newer revision supersedes the work,
 * when the Session is disposed, and on an explicit Human rename — so the wait
 * must end with it rather than hold a provider call open past its usefulness.
 * @param work - the decision to await.
 * @param signal - the request's cancellation.
 * @returns the decision's outcome.
 */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal)
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => { reject(abortReason(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([work, aborted])
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * The reason to reject an aborted wait with.
 * @param signal - the aborted signal.
 * @returns its reason, or a plain error when it carries none.
 */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error(`${PLUGIN_ID}: title generation was aborted`)
}

/**
 * A caught value's message.
 * @param error - the caught value.
 * @returns its message, or its string form.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
