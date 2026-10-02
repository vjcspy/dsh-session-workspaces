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
 * Whether the plugin owns the Conversation title on this host.
 *
 * `unavailable` is the observable form of the precondition
 * {@link registerTitleProvider} warns about. It is published on the fenced map
 * route, because that `warn` is NOT visible on a successful boot — see
 * {@link registerTitleProvider} for the measurement.
 */
export type TitleProviderStatus = 'ok' | 'unavailable'

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
 * The fragment the core's own singleton refusal carries.
 *
 * Coupled to the service's wording on purpose. The service validates a candidate
 * BEFORE it looks for a duplicate (`session-title/src/index.ts:471-477`), so an
 * error is only evidence of the ONE-provider precondition when it is that
 * refusal — and it names the provider already holding the slot, which is how it
 * reads. Every other error is a different condition and is reported as itself.
 */
const ALREADY_REGISTERED = ' is already registered'

/** The profile edit that clears the precondition, named in the log line. */
const TITLE_PROVIDER_PRECONDITION =
  'HARD PRECONDITION: the profile must disable the shipped title row '
  + '(`- id: session-title-llm` with `disabled: true` in its `cordis.patch.yml`)'

/**
 * Whether a caught registration error is the core's singleton refusal.
 *
 * The service holds ONE provider (`session-title/src/index.ts:471-475`) and says
 * so with the id that already holds the slot, so the message is the only
 * discriminant it exposes — it throws plain `Error`s and the plugin has no way to
 * read the incumbent.
 * @param error - the caught registration error.
 * @returns true when the slot is already taken.
 */
function isAlreadyRegistered(error: unknown): boolean {
  return messageOf(error).includes(ALREADY_REGISTERED)
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
 *
 * **On the log line.** A successful boot has NO visible log sink: the vendored
 * `LoggerService` ships a buffer-only exporter (`vendor/cordis/src/logger.ts:213-221`),
 * the only other exporter is `app-boot`'s startup collector, which is read solely
 * when startup FAILS (`packages/boot/app-boot/src/index.ts:984-988,1019-1021`), and
 * the `dsh: …` lines a boot does print are written to stderr by the launcher and
 * the startup audit rather than through `ctx.logger`. Measured in the container
 * on 2026-10-02 with `session-title-llm` re-enabled: `error`, `warn`, `info` and
 * `debug` probes logged from exactly this injection produced ZERO lines in the
 * boot log, while a `process.stderr.write` marker beside them did appear and
 * named `session-title provider "session-title-first-prompt-llm" is already
 * registered`. The log line is therefore kept for hosts that DO sink it, and the
 * same condition is also published as `titleProvider` on the fenced map route
 * (`./routes.ts`) so it is observable without one.
 *
 * **There is no separate "is the slot free?" probe.** One was written and then
 * removed: registering a throwaway provider and disposing it does NOT free the
 * core's slot synchronously — the service assigns `registration` from inside a
 * synchronous effect, but the disposer only CLEARS it from a later microtask — so
 * the plugin's own registration, running in the same turn, was refused by its own
 * probe. The map route reported `unavailable` while the plugin actually owned the
 * title. The registration is therefore the single source of that status: `ok`
 * only when the register call returned.
 * @param ctx - the host context.
 * @param ledger - the shared, keyed decision entry point.
 * @param onStatus - receives whether the plugin ended up owning the title.
 */
export function registerTitleProvider(
  ctx: Context,
  ledger: DecisionLedger,
  onStatus: (status: TitleProviderStatus) => void,
): void {
  ctx.inject(['sessionTitle'], (titleCtx) => {
    try {
      titleCtx.sessionTitle.register(createTitleProvider(ledger))
      onStatus('ok')
    } catch (error) {
      onStatus('unavailable')
      // TWO different conditions reach here, and only one of them is this
      // plugin's precondition. Naming the profile edit for a validation error or
      // for a foreign plugin's provider would send the Human to the wrong fix,
      // so the duplicate is the only case that gets the precondition message.
      if (isAlreadyRegistered(error)) {
        titleCtx.logger.warn(
          `${PLUGIN_ID}: could not register the conversation-title provider — ${messageOf(error)}. `
          + `${TITLE_PROVIDER_PRECONDITION}. `
          + 'Until it does, titles come from that row and no classification-derived title appears.',
        )
        return
      }
      titleCtx.logger.warn(
        `${PLUGIN_ID}: could not register the conversation-title provider — ${messageOf(error)}.`,
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
