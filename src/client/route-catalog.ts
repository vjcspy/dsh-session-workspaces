/**
 * The browser half's view of the advertised route catalog.
 *
 * The read is asynchronous and can come back empty, partial or in error, and the
 * settings control must stay usable in every one of those states. So this state
 * is deliberately total: a FAILED read keeps the last good routes and only
 * records the failure, and a partial failure is kept as a hint rather than
 * treated as "no catalog" — because an empty catalog would drop the Human's
 * configured route out of the option list.
 *
 * @module dsh-session-workspaces/client/route-catalog
 */

import type { CatalogFailure, CatalogPayload, CatalogRoute } from '../wire.ts'

/** One stable snapshot of the catalog view. */
export interface RouteCatalogSnapshot {
  /** The advertised routes, empty until (or unless) a read resolves. */
  readonly routes: readonly CatalogRoute[]
  /** The last failure's message, while one stands. */
  readonly error: string | undefined
}

/** A subscribable view of the Host's advertised route catalog. */
export class RouteCatalogState {
  private routes: readonly CatalogRoute[] = []
  private error: string | undefined
  private snapshotCache: RouteCatalogSnapshot = { routes: [], error: undefined }
  private readonly listeners = new Set<() => void>()
  private readonly load: () => Promise<CatalogPayload>
  private inFlight = false

  /**
   * @param load - the read of the catalog route.
   */
  constructor(load: () => Promise<CatalogPayload>) {
    this.load = load
  }

  /**
   * The stable snapshot the settings view reads.
   *
   * `useSyncExternalStore` compares snapshots by identity on every render, so the
   * object is replaced only when a read settles.
   * @returns the current snapshot.
   */
  readonly snapshot = (): RouteCatalogSnapshot => this.snapshotCache

  /**
   * Subscribe to replacements.
   * @param listener - called after the snapshot changes.
   * @returns the disposer removing the listener.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Read the catalog once, unless a read is already in flight.
   * @returns the read's completion; this never rejects.
   */
  async refresh(): Promise<void> {
    if (this.inFlight) return
    this.inFlight = true
    try {
      const payload = await this.load()
      this.routes = payload.routes
      this.error = payload.error ?? failureText(payload.failed)
    } catch (error) {
      // The routes are kept on purpose: a failed read must not empty the option
      // list, or the configured route would disappear from the control it is
      // configured in.
      this.error = error instanceof Error ? error.message : String(error)
    } finally {
      this.inFlight = false
    }
    this.snapshotCache = { routes: this.routes, error: this.error }
    for (const listener of [...this.listeners]) listener()
  }
}

/**
 * One line naming every provider that could not be enumerated.
 * @param failed - the payload's per-provider failures.
 * @returns the hint text, or `undefined` when nothing failed.
 */
function failureText(failed: readonly CatalogFailure[]): string | undefined {
  if (failed.length === 0) return undefined
  return failed.map(failure => `${failure.provider}: ${failure.message}`).join('; ')
}
