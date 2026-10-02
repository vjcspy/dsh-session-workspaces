/**
 * The single decision a Session gets: the keyed entry point that BOTH the
 * `request/header`-driven path and the `sessionTitle` provider call.
 *
 * One Session produces exactly ONE `ctx.llm.stream` call even when both callers
 * ask at the same moment, because neither of them runs the classifier: they
 * join one in-flight promise keyed by Session id. That is the whole reason this
 * module exists — the sidebar label and the Conversation title are two readers
 * of ONE answer, so a second call would restore exactly the two-call cost the
 * merge removes.
 *
 * The eligibility rules are the ones the event path always had, and every one of
 * them is re-read at the instant of the decision rather than captured earlier: a
 * Session that already carries a decision or a Human pin is never re-decided, a
 * child Session is never classified, a Session past its first human message is
 * never classified, and a Session with no resolvable route gets no call at all.
 * The summary rides that one answer and is NEVER persisted — it is returned to
 * whichever caller is still waiting, and forgotten.
 *
 * @module dsh-session-workspaces/host/decision
 */

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'

import { PLUGIN_ID } from '../config.ts'
import { classify, resolveRoute, type ClassificationRoute, type SessionRoute } from './classifier.ts'
import type { WorkspaceStore } from './store.ts'

/** Live configuration, read at the moment of the decision: every field is volatile. */
export interface DecisionSettings {
  /** Whether the classification pass runs at all. */
  readonly enabled: boolean
  /** Configured provider id, empty when unset. */
  readonly provider: string
  /** Configured model id, empty when unset. */
  readonly model: string
  /** The configured ADDITION to the discovered candidate labels. */
  readonly candidates: readonly string[]
  /** Label recorded for undecidable answers. */
  readonly unknownLabel: string
  /** Minimum accepted confidence. */
  readonly threshold: number
}

/** Why a Session was never offered to the model. Nothing was called, nothing recorded. */
export type DecisionSkip =
  | 'store-unavailable'
  | 'disabled'
  | 'already-decided'
  | 'child-session'
  | 'not-first-prompt'
  | 'no-route'
  | 'attempted'

/** Why the one call a Session was allowed to make produced nothing. */
export type DecisionFailure = 'timeout' | 'provider-error' | 'malformed'

/** What one decision produced. A non-`ok` outcome records nothing and disturbs nothing. */
export type DecisionOutcome =
  | {
    readonly ok: true
    /** The accepted label, always a member of the candidate set. */
    readonly label: string
    /** Confidence the model reported, clamped to `[0, 1]`. */
    readonly confidence: number
    /** The model's summary, at most five words. Never persisted. */
    readonly summary?: string | undefined
    /** The route the call actually ran on. */
    readonly route: ClassificationRoute
    /** Whether the label reached the durable store; false when a Human pin owns the Session. */
    readonly recorded: boolean
  }
  | {
    readonly ok: false
    /** `skipped` never called the model; `failed` called it and got nothing usable. */
    readonly stage: 'skipped'
    readonly reason: DecisionSkip
    readonly message: string
  }
  | {
    readonly ok: false
    readonly stage: 'failed'
    readonly reason: DecisionFailure
    readonly message: string
  }

/** Every host fact a decision reads. Each is re-read at the decision instant. */
export interface DecisionDeps {
  /** `ctx.llm.stream`, injected so a spec scripts every outcome. */
  readonly stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  /** The durable store, or undefined while its unit is still opening. */
  readonly store: () => WorkspaceStore | undefined
  /** Live configuration. */
  readonly settings: () => DecisionSettings
  /** The Session's first human prompt, when exactly one is committed. */
  readonly promptOf: (session: Session) => string | undefined
  /** The Session's own logged route, from its live request header. */
  readonly routeOf: (session: Session) => SessionRoute | undefined
  /** Debug channel. The ledger reports each decision ONCE, whoever asked for it. */
  readonly debug: (message: string) => void
}

/** Builder for the `skipped` arm. */
function skipped(reason: DecisionSkip, message: string): DecisionOutcome {
  return { ok: false, stage: 'skipped', reason, message }
}

/**
 * The keyed, in-flight-deduplicated decision entry point.
 *
 * One instance per mounted host half. It owns two pieces of state and nothing
 * else: the in-flight map that makes the one-call guarantee structural, and the
 * set of Sessions whose one allowed attempt already failed — which is what keeps
 * a provider failure from spending a call per `request/header` event forever.
 */
export class DecisionLedger {
  /** Decisions being made right now, keyed by Session id. */
  private readonly inFlight = new Map<string, Promise<DecisionOutcome>>()
  /** Sessions whose attempt is spent: failed, or the failure is still settling. */
  private readonly attempted = new Set<string>()
  /** The host facts every decision reads. */
  private readonly deps: DecisionDeps

  /**
   * @param deps - the host facts every decision reads.
   */
  constructor(deps: DecisionDeps) {
    this.deps = deps
  }

  /**
   * Answer for one Session, once.
   *
   * Two concurrent callers for the same Session — the header-driven path and the
   * title provider — receive the SAME promise, so between them the Session
   * reaches `ctx.llm.stream` exactly once. The entry is dropped as soon as the
   * decision settles: the result is not cached here, only the concurrent calls
   * are joined, so a Session whose route appeared only later is still classified.
   *
   * The outcome is REPORTED here, once, rather than by each caller: either
   * caller may be the one that started the decision, and a Session that commits
   * several headers must not produce several lines about the same outcome.
   * @param session - the Session to decide.
   * @returns the outcome; never a rejection caused by the model or the store.
   */
  decide(session: Session): Promise<DecisionOutcome> {
    const sessionId = String(session.id)
    const joined = this.inFlight.get(sessionId)
    if (joined !== undefined) return joined
    const decision = this.run(session, sessionId)
    this.inFlight.set(sessionId, decision)
    decision.then(
      () => { this.forget(sessionId, decision) },
      () => { this.forget(sessionId, decision) },
    )
    return decision
  }

  /** Release the in-flight map and the remembered failures, as an unload does. */
  clear(): void {
    this.inFlight.clear()
    this.attempted.clear()
  }

  /** Drop one in-flight entry, unless a newer decision already replaced it. */
  private forget(sessionId: string, decision: Promise<DecisionOutcome>): void {
    if (this.inFlight.get(sessionId) === decision) this.inFlight.delete(sessionId)
  }

  /**
   * Run the eligibility rules and, when they all pass, the one model call.
   * @param session - the Session to decide.
   * @param sessionId - its id, already stringified for the key.
   * @returns the outcome.
   */
  private async run(session: Session, sessionId: string): Promise<DecisionOutcome> {
    const store = this.deps.store()
    if (store === undefined) return skipped('store-unavailable', 'the storage unit is not open yet')
    // A Session spends ONE attempt. Without this a provider failure would be
    // retried by every later `request/header` event (`initial`/`change`/`series`),
    // forever.
    if (this.attempted.has(sessionId)) return skipped('attempted', 'this Session already spent its one attempt')
    const live = this.deps.settings()
    if (!live.enabled) return skipped('disabled', 'the classification pass is disabled')
    // A decision already exists, or a Human pinned the Session: never re-decide.
    if (store.isDecided(sessionId)) {
      return skipped('already-decided', 'the Session already carries a decision or a Human pin')
    }
    // Subagent Sessions are children of the Session that spawned them; the
    // first-count condition is the one `session-title` uses.
    if (session.header.parentSession !== undefined) {
      return skipped('child-session', 'a child Session is grouped with the Session that spawned it')
    }
    // The prompt comes from this plugin's own projection, so it is the SAME fact
    // a restart replays rather than an in-memory capture a reload would lose.
    const prompt = this.deps.promptOf(session)
    if (prompt === undefined) {
      return skipped('not-first-prompt', 'the Session is not on its first human message')
    }
    // Resolved HERE, where the route exists — never earlier and never guessed.
    const route = resolveRoute({ provider: live.provider, model: live.model }, this.deps.routeOf(session))
    // No route even now (an incomplete header, or a request that dispatched on
    // nothing): record nothing and leave the Session on core grouping.
    if (route.source === 'none') {
      return skipped('no-route', 'neither Config nor the Session resolved a route')
    }
    this.attempted.add(sessionId)
    const outcome = await classify({ stream: this.deps.stream }, {
      provider: route.provider,
      model: route.model,
      prompt,
      candidates: live.candidates,
      unknownLabel: live.unknownLabel,
      threshold: live.threshold,
    })
    if (!outcome.ok) {
      // The eligibility rules that said no are not failures and are not
      // reported; a call that was made and produced nothing is.
      this.deps.debug(`${PLUGIN_ID}: ${sessionId} not classified (${outcome.reason}): ${outcome.message}`)
      return { ok: false, stage: 'failed', reason: outcome.reason, message: outcome.message }
    }
    const recorded = await store.recordLabel(sessionId, outcome.label, outcome.confidence)
    // The decision is durable now, so the in-memory guard is no longer needed.
    this.attempted.delete(sessionId)
    this.deps.debug(
      `${PLUGIN_ID}: ${sessionId} → ${outcome.label} (${String(outcome.confidence)}) via ${route.source} ${route.provider}/${route.model}${recorded ? '' : ' — pinned, not written'}${outcome.summary === undefined ? '' : ` — title "${outcome.summary}"`}`,
    )
    return {
      ok: true,
      label: outcome.label,
      confidence: outcome.confidence,
      route,
      recorded,
      ...(outcome.summary === undefined ? {} : { summary: outcome.summary }),
    }
  }
}
