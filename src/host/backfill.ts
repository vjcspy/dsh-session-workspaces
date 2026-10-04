/**
 * The opt-in backfill: classify the Sessions that predate activation.
 *
 * It is an explicit Human action, never automatic, because it spends one model
 * call per Session. Its three behavioural contracts:
 *
 * - **It states its own cost.** {@link Backfill.snapshot} reports `pending`, the
 *   number of undecided top-level Sessions, which the settings section renders
 *   before the Human confirms.
 * - **It reads Sessions that are not loaded.** The live cadence only ever sees
 *   Sessions this process has observed; a stored Session's first human prompt is
 *   read through `ctx.sessionQuery.readSession`, which replays the stored log
 *   without resuming the Session.
 * - **It resumes by skipping.** A Session that already carries a label or a pin
 *   is never considered, so re-running a pass costs nothing for settled work and
 *   the core fallback group is left alone until each Session is classified.
 *
 * - **It reports what it actually did.** A Session whose stored log holds no
 *   human prompt is its own outcome, never a failure — that is a property of the
 *   log as it stands, and a stored Session can gain its first prompt later. Every
 *   failure is counted under the classifier's own reason, beside a bounded
 *   in-memory list, because two failures in flight overwrite the single
 *   `lastError` string in a scheduling-dependent order.
 *
 * Concurrency is bounded, and a failure is recorded, never thrown: one
 * unanswerable Session must not abort the pass.
 *
 * @module dsh-session-workspaces/host/backfill
 */

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { BACKFILL_CONCURRENCY } from '../config.ts'
import type { BackfillFailure, BackfillFailureTally, BackfillStatus } from '../wire.ts'
import { classify, resolveRoute } from './classifier.ts'
import { firstHumanPrompt, routeFromEvents, type LoggedEvent } from './session-log.ts'
import type { WorkspaceStore } from './store.ts'

/** How stale the sampled `pending` count may be before a poll refreshes it. */
const PENDING_TTL_MS = 15_000

/** How many recent failures the snapshot keeps, newest first. */
const RECENT_FAILURES_CAP = 10

/** Longest message kept in the in-memory list, counted AFTER the Session id prefix. */
const RECENT_FAILURE_CHARS = 200

/** One Session the corpus reports. */
export interface StoredSessionRecord {
  readonly id: string
  readonly cwd: string | undefined
  readonly parent: unknown
}

/** Everything the backfill needs from the host, injected so it is testable without one. */
export interface BackfillDeps {
  /** The durable store: labels are written here, and pins are read here. */
  readonly store: WorkspaceStore
  /** Every stored Session this process can see, newest first. */
  readonly listSessions: (signal?: AbortSignal) => Promise<readonly StoredSessionRecord[]>
  /** One stored Session's complete event log, without making it live. */
  readonly readSession: (sessionId: string) => Promise<{ readonly events: readonly LoggedEvent[] }>
  /** `ctx.llm.stream`. */
  readonly stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  /** Live settings, read at the moment of each call. */
  readonly settings: () => {
    readonly provider: string
    readonly model: string
    readonly candidates: readonly string[]
    readonly unknownLabel: string
    readonly threshold: number
  }
  /** Diagnostic sink. */
  readonly log: (message: string) => void
  /** Deadline per call, in milliseconds. */
  readonly timeoutMs?: number | undefined
  /** In-flight call bound. */
  readonly concurrency?: number | undefined
  /** Current instant, for the status timestamps. */
  readonly now?: (() => string) | undefined
}

/** Progress plus the sampled pending count the settings section states before a pass starts. */
export type BackfillSnapshot = BackfillStatus

/** The backfill pass: one at a time, resumable by construction, bounded in flight. */
export class Backfill {
  private readonly deps: BackfillDeps
  private running = false
  private progress: BackfillStatus
  private pending = 0
  private pendingSampledAt = 0
  private pendingInFlight = false

  /**
   * @param deps - host capabilities.
   */
  constructor(deps: BackfillDeps) {
    this.deps = deps
    this.progress = {
      running: false, total: 0, pending: 0, done: 0, classified: 0, unknown: 0, failed: 0, skipped: 0,
      noPrompt: 0, failures: noFailures(), recentFailures: [],
    }
  }

  /**
   * Current progress, plus the sampled pending count.
   *
   * A stale sample schedules a refresh instead of blocking the read: this is
   * called from the map route, which every open browser polls.
   * @returns the snapshot the settings section renders.
   */
  snapshot(): BackfillSnapshot {
    if (!this.running && Date.now() - this.pendingSampledAt > PENDING_TTL_MS) void this.refreshPending()
    return { ...this.progress, pending: this.pending }
  }

  /**
   * Start one pass, unless one is already running.
   * @returns the snapshot as the pass starts.
   */
  async start(): Promise<BackfillSnapshot> {
    if (this.running) return this.snapshot()
    const now = this.now()
    let records: readonly StoredSessionRecord[]
    try {
      records = await this.deps.listSessions()
    } catch (error) {
      this.progress = {
        ...this.progress, running: false, lastError: `listing Sessions failed: ${messageOf(error)}`,
      }
      return this.snapshot()
    }
    const top = records.filter(record => record.parent === undefined)
    const targets = top.filter(record => !this.deps.store.isDecided(record.id))
    const skipped = top.length - targets.length
    this.pending = targets.length
    this.pendingSampledAt = Date.now()
    if (targets.length === 0) {
      this.progress = {
        ...this.progress, running: false, total: 0, pending: 0, done: 0, classified: 0, unknown: 0, failed: 0,
        skipped, noPrompt: 0, failures: noFailures(), recentFailures: [],
        startedAt: now, finishedAt: this.now(), lastError: undefined,
      }
      return this.snapshot()
    }
    this.progress = {
      running: true, total: targets.length, pending: targets.length, done: 0, classified: 0, unknown: 0,
      failed: 0, skipped, noPrompt: 0, failures: noFailures(), recentFailures: [],
      startedAt: now,
    }
    this.running = true
    void this.run(targets.map(record => record.id))
    return this.snapshot()
  }

  /** Walk the targets with a bounded number of calls in flight. */
  private async run(ids: readonly string[]): Promise<void> {
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor
        cursor += 1
        const id = ids[index]
        if (id === undefined) return
        await this.classifyOne(id)
      }
    }
    const width = Math.max(1, this.deps.concurrency ?? BACKFILL_CONCURRENCY)
    try {
      await Promise.all(Array.from({ length: Math.min(width, ids.length) }, async () => { await worker() }))
    } finally {
      this.running = false
      this.progress = {
        ...this.progress, running: false, done: this.progress.total, finishedAt: this.now(),
      }
      void this.refreshPending()
    }
  }

  /** Classify one stored Session; every failure is counted, never thrown. */
  private async classifyOne(sessionId: string): Promise<void> {
    const { store, settings } = this.deps
    try {
      if (store.isDecided(sessionId)) {
        this.progress = { ...this.progress, done: this.progress.done + 1, skipped: this.progress.skipped + 1 }
        return
      }
      let snapshot: { readonly events: readonly LoggedEvent[] }
      try {
        snapshot = await this.deps.readSession(sessionId)
      } catch (error) {
        // A read failure is its own class, and it keeps the diagnostic the outer
        // catch writes: `log` is the only sink a read failure has.
        const message = messageOf(error)
        this.progress = {
          ...this.progress, done: this.progress.done + 1, failed: this.progress.failed + 1,
          lastError: `${sessionId}: ${message}`,
          failures: countFailure(this.progress.failures, 'read'),
          recentFailures: recordFailure(this.progress.recentFailures, sessionId, 'read', message),
        }
        this.deps.log(`dsh-session-workspaces: backfill failed for ${sessionId}: ${message}`)
        return
      }
      const prompt = firstHumanPrompt(snapshot.events)
      if (prompt === undefined) {
        // Not a failure: this log holds no human prompt today, and it stays a
        // target of every later pass because a stored Session can gain one.
        this.progress = {
          ...this.progress, done: this.progress.done + 1, noPrompt: this.progress.noPrompt + 1,
        }
        return
      }
      const live = settings()
      const route = resolveRoute(
        { provider: live.provider, model: live.model },
        routeFromEvents(snapshot.events),
      )
      if (route.source === 'none') {
        const message = "no route — set provider and model in this plugin's settings"
        this.progress = {
          ...this.progress, done: this.progress.done + 1, failed: this.progress.failed + 1,
          lastError: `${sessionId}: ${message}`,
          failures: countFailure(this.progress.failures, 'route'),
          recentFailures: recordFailure(this.progress.recentFailures, sessionId, 'route', message),
        }
        return
      }
      const outcome = await classify({ stream: this.deps.stream }, {
        provider: route.provider,
        model: route.model,
        prompt,
        candidates: live.candidates,
        unknownLabel: live.unknownLabel,
        threshold: live.threshold,
        ...this.deps.timeoutMs === undefined ? {} : { timeoutMs: this.deps.timeoutMs },
      })
      if (!outcome.ok) {
        const message = `${outcome.reason} — ${outcome.message}`
        this.progress = {
          ...this.progress, done: this.progress.done + 1, failed: this.progress.failed + 1,
          lastError: `${sessionId}: ${message}`,
          failures: countFailure(this.progress.failures, outcome.reason),
          recentFailures: recordFailure(this.progress.recentFailures, sessionId, outcome.reason, message),
        }
        return
      }
      const written = await store.recordLabel(sessionId, outcome.label, outcome.confidence)
      // The sentinel is a real write, so it stays inside `classified`; the subset
      // is what tells a placement from a fallback. Nothing was written when the
      // store refused (the Session was pinned in flight), so `unknown` stays put.
      const unknown = written && outcome.label === live.unknownLabel ? 1 : 0
      this.progress = {
        ...this.progress,
        done: this.progress.done + 1,
        classified: this.progress.classified + (written ? 1 : 0),
        unknown: this.progress.unknown + unknown,
        skipped: this.progress.skipped + (written ? 0 : 1),
      }
    } catch (error) {
      const message = messageOf(error)
      this.progress = {
        ...this.progress, done: this.progress.done + 1, failed: this.progress.failed + 1,
        lastError: `${sessionId}: ${message}`,
        failures: countFailure(this.progress.failures, 'other'),
        recentFailures: recordFailure(this.progress.recentFailures, sessionId, 'other', message),
      }
      this.deps.log(`dsh-session-workspaces: backfill failed for ${sessionId}: ${message}`)
    }
  }

  /** Re-sample how many stored top-level Sessions are undecided. */
  private async refreshPending(): Promise<void> {
    if (this.pendingInFlight) return
    this.pendingInFlight = true
    this.pendingSampledAt = Date.now()
    try {
      const records = await this.deps.listSessions()
      this.pending = records.filter(record => record.parent === undefined && !this.deps.store.isDecided(record.id)).length
    } catch {
      // A corpus read failure leaves the last sample standing; the next poll retries.
    } finally {
      this.pendingInFlight = false
    }
  }

  /** Current instant. */
  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString()
  }
}

/**
 * A caught value's message.
 * @param error - the caught value.
 * @returns its message, or its string form.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Every failure class the backfill can produce: the classifier's own three
 * reasons, plus the two exits that never reach a model and the outer catch.
 */
type FailureReason = 'read' | 'route' | 'timeout' | 'provider-error' | 'malformed' | 'other'

/**
 * The tally a fresh pass starts from.
 * @returns every class at zero.
 */
function noFailures(): BackfillFailureTally {
  return { read: 0, route: 0, timeout: 0, providerError: 0, malformed: 0, other: 0 }
}

/**
 * The tally key one failure reason is counted under.
 * @param reason - the reason, in the vocabulary its producer uses.
 * @returns the key of {@link BackfillFailureTally} it belongs to.
 */
function tallyKey(reason: FailureReason): keyof BackfillFailureTally {
  return reason === 'provider-error' ? 'providerError' : reason
}

/**
 * One more failure, counted in its own class.
 *
 * The tally is replaced with a spread, never mutated: it is part of a frozen
 * wire object.
 * @param tally - the tally as it stands.
 * @param reason - the class the failure belongs to.
 * @returns a new tally with that class one higher.
 */
function countFailure(tally: BackfillFailureTally, reason: FailureReason): BackfillFailureTally {
  const key = tallyKey(reason)
  return { ...tally, [key]: tally[key] + 1 }
}

/**
 * One failure prepended to the bounded newest-first list.
 *
 * The message carries the Session id and is truncated AFTER that prefix, so the
 * id always survives the cap. Callers build the counter and the list in ONE
 * synchronous assignment: with two calls in flight, a read-modify-write across
 * an `await` would drop one of them.
 * @param previous - the list as it stands.
 * @param sessionId - the Session that failed.
 * @param reason - the class the failure belongs to.
 * @param message - the failure's message, without the id prefix.
 * @returns the new list, newest first, capped at {@link RECENT_FAILURES_CAP}.
 */
function recordFailure(
  previous: readonly BackfillFailure[],
  sessionId: string,
  reason: FailureReason,
  message: string,
): readonly BackfillFailure[] {
  const entry: BackfillFailure = {
    sessionId,
    kind: tallyKey(reason),
    message: `${sessionId}: ${message}`.slice(0, RECENT_FAILURE_CHARS),
  }
  return [entry, ...previous].slice(0, RECENT_FAILURES_CAP)
}
