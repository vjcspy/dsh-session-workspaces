/**
 * The browser half's map store and poller.
 *
 * There is no push channel from a plugin's host half to the page, so the state
 * is a POLL: one read every {@link MAP_POLL_INTERVAL_MS}, plus an immediate read
 * after every write (each write route answers with the map, so the tree moves on
 * the response and the poll is only a safety net for another browser's writes).
 *
 * The store publishes ONE snapshot object and replaces it only when the map
 * actually changed. That matters twice over: `useSyncExternalStore` compares
 * snapshots by identity, so a store that minted a fresh object per poll would
 * re-render every subscriber every four seconds; and the grouping seam reads the
 * same identity to decide whether re-registering its provider — which recomputes
 * the whole tree — is warranted.
 *
 * Two orderings are settled here rather than left to luck:
 *
 * - **Every request is numbered as it is sent, and a write response sets a
 *   barrier.** A poll whose request went out at or before that barrier answered
 *   from the state the write replaced, so its response is dropped instead of
 *   applying a stale tree on top of the new one. Nothing here is persisted, so a
 *   host restart needs no special case: the first poll after it is simply newer
 *   than the barrier.
 * - **A Human placement is an OVERLAY over whatever map is current until its
 *   write settles.** A poll answering while the write is in flight therefore
 *   cannot displace it, and a refused write drops the overlay instead of
 *   restoring a snapshot the poll has already superseded.
 *
 * @module dsh-session-workspaces/client/state
 */

import { MAP_CACHE_KEY, MAP_POLL_INTERVAL_MS } from '../config.ts'
import { readMap } from './api.ts'
import type { AssignmentRequest, MapPayload, SessionPlacement } from '../wire.ts'

/**
 * Where the last map is kept between page loads.
 *
 * This is load-bearing, not an optimisation. The sidebar's view store prunes its
 * persisted expansion and manual-order entries down to the keys the CURRENT
 * derivation produced, on every ready render. A reload renders before the first
 * map read resolves, so without a synchronously available map the provider claims
 * no Session, produces no rows, and every group key — with the Human's collapsed
 * state and manual order — is discarded before the poll can restore it. Seeding
 * the store from this cache means the provider answers from the first render.
 */
export interface MapCache {
  /** The last map, or undefined when nothing usable is stored. */
  read(): MapPayload | undefined
  /** Keep this map for the next page load. */
  write(map: MapPayload): void
}

/** The browser's own storage; every access is guarded, because it can be denied. */
export const browserMapCache: MapCache = {
  read: () => {
    try {
      const raw = globalThis.localStorage?.getItem(MAP_CACHE_KEY)
      if (raw === null || raw === undefined) return undefined
      const parsed = JSON.parse(raw) as Partial<MapPayload> | undefined
      // Shape-checked rather than trusted: an older or corrupted entry must not
      // reach the provider.
      if (parsed === undefined || typeof parsed.sessions !== 'object' || parsed.sessions === null
        || !Array.isArray(parsed.groups) || !Array.isArray(parsed.candidates)) return undefined
      return parsed as MapPayload
    } catch {
      return undefined
    }
  },
  write: (map) => {
    try {
      globalThis.localStorage?.setItem(MAP_CACHE_KEY, JSON.stringify(map))
    } catch {
      // A full or disabled store costs a jump on the next reload and nothing else.
    }
  },
}

/** The store's published state. */
export interface MapState {
  /** `loading` before the first answer, `ready` while one stands, `error` after a failed read. */
  readonly status: 'loading' | 'ready' | 'error'
  /** The last good map, with any pending Human placement applied. */
  readonly map: MapPayload | undefined
  /** The last failure's message, while one stands. */
  readonly error: string | undefined
}

/** One Human placement shown over the map until its write settles. */
interface PendingPlacement {
  /** The Session being moved. */
  readonly sessionId: string
  /** What the Session looks like while the write is in flight. */
  readonly placement: SessionPlacement
}

/**
 * The placement one assignment shows before the Host answers.
 *
 * A Human assignment is a pin by definition, and a request that names a group
 * carries the group's own workspace — the pair the host store resolves the write
 * to — so the projection is the request's own fields.
 * @param request - the assignment being posted.
 * @returns the placement to show until the write settles.
 */
export function optimisticPlacement(request: AssignmentRequest): SessionPlacement {
  return request.group === undefined
    ? { workspace: request.workspace, pinned: true }
    : { workspace: request.workspace, group: request.group, pinned: true }
}

/** A pollable, subscribable view of the host's map. */
export class MapStore {
  private readonly listeners = new Set<() => void>()
  private readonly cache: MapCache
  private readonly fetchMap: () => Promise<MapPayload>
  private state: MapState = { status: 'loading', map: undefined, error: undefined }
  /** The last map as the Host answered it, without any overlay. */
  private raw: MapPayload | undefined
  private rawSignature: string | undefined
  /** Signature of the projection last published, so an unchanged map never republishes. */
  private published: string | undefined
  private overlay: PendingPlacement | undefined
  private inFlight = false
  /** How many requests this store has sent. */
  private sent = 0
  /** Highest request number a write response has superseded. */
  private barrier = 0

  /**
   * @param cache - where the last map is kept between page loads.
   * @param fetchMap - the fenced map read; injected so a spec can order answers.
   */
  constructor(cache: MapCache = browserMapCache, fetchMap: () => Promise<MapPayload> = readMap) {
    this.cache = cache
    this.fetchMap = fetchMap
    const seed = cache.read()
    if (seed !== undefined) {
      this.raw = seed
      this.rawSignature = JSON.stringify(seed)
      this.published = this.rawSignature
      this.state = { status: 'ready', map: seed, error: undefined }
    }
  }

  /** The stable snapshot the hooks read. */
  readonly read = (): MapState => this.state

  /**
   * Subscribe to replacements.
   * @param listener - called after the snapshot object changes.
   * @returns the disposer removing the listener.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** The last good map — with any pending placement applied — for the synchronous grouping provider. */
  payload(): MapPayload | undefined {
    return this.state.map
  }

  /**
   * Fold one map into the store, publishing only a real change.
   * @param map - the map a read or write answered with.
   */
  accept(map: MapPayload): void {
    const signature = JSON.stringify(map)
    if (signature !== this.rawSignature) {
      this.rawSignature = signature
      this.raw = map
      this.cache.write(map)
    }
    // Re-projected rather than published verbatim: a pending Human placement
    // outranks whatever map this answer carries until its write settles.
    this.reproject()
  }

  /**
   * Post one Human assignment and show it over the current map until it settles.
   *
   * The optimistic placement is an OVERLAY, never a snapshot of the map: a poll
   * that lands while the write is in flight replaces the raw map underneath and
   * leaves the placement standing, and a refused write drops the overlay — so
   * the Session returns to whatever the CURRENT map says, which is exactly what a
   * rollback of a snapshot would have got wrong.
   * @param input - the assignment and the fenced call that posts it.
   * @returns the map the Host answered with.
   */
  async assign(input: {
    readonly request: AssignmentRequest
    readonly send: () => Promise<MapPayload>
  }): Promise<MapPayload> {
    this.overlay = { sessionId: input.request.sessionId, placement: optimisticPlacement(input.request) }
    this.reproject()
    this.sent += 1
    try {
      const map = await input.send()
      // The barrier covers every request sent up to this instant — including a
      // poll that was in flight when the write landed, whose answer was sampled
      // from the state the write replaced.
      this.barrier = this.sent
      this.overlay = undefined
      this.accept(map)
      return map
    } catch (error) {
      this.overlay = undefined
      this.reproject()
      throw error
    }
  }

  /**
   * Read the map once, unless a read is already in flight.
   * @returns the read's completion.
   */
  async refresh(): Promise<void> {
    if (this.inFlight) return
    this.inFlight = true
    this.sent += 1
    const seq = this.sent
    try {
      const map = await this.fetchMap()
      // A response to a request that was already in flight when a write landed is
      // not authoritative: it answers from the state that write replaced.
      if (seq > this.barrier) this.accept(map)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A failed poll keeps the last good map standing: a transient read failure
      // must not empty the tree. Only a store that never had one reports error.
      this.state = this.raw === undefined
        ? { status: 'error', map: undefined, error: message }
        : { status: 'ready', map: this.project(), error: message }
      this.publish()
    } finally {
      this.inFlight = false
    }
  }

  /** Notify every subscriber of the current snapshot. */
  private publish(): void {
    for (const listener of [...this.listeners]) listener()
  }

  /** The map as published: the raw answer, with a pending Human placement over it. */
  private project(): MapPayload | undefined {
    if (this.raw === undefined || this.overlay === undefined) return this.raw
    return {
      ...this.raw,
      sessions: { ...this.raw.sessions, [this.overlay.sessionId]: this.overlay.placement },
    }
  }

  /** Publish the projection of the raw map and the overlay — and only when it really changed. */
  private reproject(): void {
    const projected = this.project()
    const signature = projected === undefined
      ? undefined
      : projected === this.raw ? this.rawSignature : JSON.stringify(projected)
    if (signature === this.published) return
    this.published = signature
    this.state = { status: 'ready', map: projected, error: undefined }
    this.publish()
  }
}

/** A map store plus the poll and the immediate first read, owned by the plugin fiber. */
export interface MapPolling {
  /** The store the grouping provider and the surfaces read. */
  readonly store: MapStore
  /** Stop the poll. */
  dispose(): void
}

/**
 * Start polling the host's map.
 * @param options - poll interval and injected ports, for tests.
 * @returns the store and the disposer.
 */
export function startMapPolling(options: {
  readonly intervalMs?: number | undefined
  readonly cache?: MapCache | undefined
  readonly fetchMap?: (() => Promise<MapPayload>) | undefined
} = {}): MapPolling {
  const store = new MapStore(options.cache ?? browserMapCache, options.fetchMap)
  void store.refresh()
  const timer = setInterval(() => { void store.refresh() }, options.intervalMs ?? MAP_POLL_INTERVAL_MS)
  // Node answers a Timeout object and the DOM a number, and this module compiles
  // against the DOM lib; the unref is for a non-browser composition (the unit
  // tests), where a repeating poll must not hold the event loop open.
  ;(timer as unknown as { unref?: () => void }).unref?.()
  return {
    store,
    dispose: () => { clearInterval(timer) },
  }
}
