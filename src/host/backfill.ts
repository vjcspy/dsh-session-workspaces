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
 * Concurrency is bounded, and a failure is recorded, never thrown: one
 * unanswerable Session must not abort the pass.
 *
 * @module dsh-session-workspaces/host/backfill
 */

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { BACKFILL_CONCURRENCY } from '../config.ts'
import type { BackfillStatus } from '../wire.ts'
import { classify, resolveRoute } from './classifier.ts'
import { firstHumanPrompt, routeFromEvents, type LoggedEvent } from './session-log.ts'
import type { WorkspaceStore } from './store.ts'

/** How stale the sampled `pending` count may be before a poll refreshes it. */
const PENDING_TTL_MS = 15_000

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
      running: false, total: 0, pending: 0, done: 0, classified: 0, failed: 0, skipped: 0,
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
        ...this.progress, running: false, total: 0, pending: 0, done: 0, classified: 0, failed: 0, skipped,
        startedAt: now, finishedAt: this.now(), lastError: undefined,
      }
      return this.snapshot()
    }
    this.progress = {
      running: true, total: targets.length, pending: targets.length, done: 0, classified: 0, failed: 0, skipped,
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
      const snapshot = await this.deps.readSession(sessionId)
      const prompt = firstHumanPrompt(snapshot.events)
      if (prompt === undefined) {
        this.progress = {
          ...this.progress, done: this.progress.done + 1, failed: this.progress.failed + 1,
          lastError: `${sessionId}: no human prompt in its stored log`,
        }
        return
      }
      const live = settings()
      const route = resolveRoute(
        { provider: live.provider, model: live.model },
        routeFromEvents(snapshot.events),
      )
      if (route.source === 'none') {
        this.progress = {
          ...this.progress, done: this.progress.done + 1, failed: this.progress.failed + 1,
          lastError: `${sessionId}: no route — set provider and model in this plugin's settings`,
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
        this.progress = {
          ...this.progress, done: this.progress.done + 1, failed: this.progress.failed + 1,
          lastError: `${sessionId}: ${outcome.reason} — ${outcome.message}`,
        }
        return
      }
      const written = await store.recordLabel(sessionId, outcome.label, outcome.confidence)
      this.progress = {
        ...this.progress,
        done: this.progress.done + 1,
        classified: this.progress.classified + (written ? 1 : 0),
        skipped: this.progress.skipped + (written ? 0 : 1),
      }
    } catch (error) {
      this.progress = {
        ...this.progress, done: this.progress.done + 1, failed: this.progress.failed + 1,
        lastError: `${sessionId}: ${messageOf(error)}`,
      }
      this.deps.log(`dsh-session-workspaces: backfill failed for ${sessionId}: ${messageOf(error)}`)
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
