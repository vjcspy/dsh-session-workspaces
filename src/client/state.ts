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
 * @module dsh-session-workspaces/client/state
 */

import { MAP_CACHE_KEY, MAP_POLL_INTERVAL_MS } from '../config.ts'
import { readMap } from './api.ts'
import type { MapPayload } from '../wire.ts'

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
  /** The last good map. */
  readonly map: MapPayload | undefined
  /** The last failure's message, while one stands. */
  readonly error: string | undefined
}

/** A pollable, subscribable view of the host's map. */
export class MapStore {
  private readonly listeners = new Set<() => void>()
  private readonly cache: MapCache
  private state: MapState = { status: 'loading', map: undefined, error: undefined }
  private signature: string | undefined
  private inFlight = false

  /**
   * @param cache - where the last map is kept between page loads.
   */
  constructor(cache: MapCache = browserMapCache) {
    this.cache = cache
    const seed = cache.read()
    if (seed !== undefined) {
      this.state = { status: 'ready', map: seed, error: undefined }
      this.signature = JSON.stringify(seed)
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

  /** The last good map, for the synchronous grouping provider. */
  payload(): MapPayload | undefined {
    return this.state.map
  }

  /**
   * Fold one map into the store, publishing only a real change.
   * @param map - the map a read or write answered with.
   */
  accept(map: MapPayload): void {
    const signature = JSON.stringify(map)
    if (signature === this.signature) return
    this.signature = signature
    this.state = { status: 'ready', map, error: undefined }
    this.cache.write(map)
    this.publish()
  }

  /**
   * Read the map once, unless a read is already in flight.
   * @returns the read's completion.
   */
  async refresh(): Promise<void> {
    if (this.inFlight) return
    this.inFlight = true
    try {
      this.accept(await readMap())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A failed poll keeps the last good map standing: a transient read failure
      // must not empty the tree. Only a store that never had one reports error.
      this.state = this.state.map === undefined
        ? { status: 'error', map: undefined, error: message }
        : { status: 'ready', map: this.state.map, error: message }
      this.publish()
    } finally {
      this.inFlight = false
    }
  }

  /** Notify every subscriber of the current snapshot. */
  private publish(): void {
    for (const listener of [...this.listeners]) listener()
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
 * @param options - poll interval override, for tests.
 * @returns the store and the disposer.
 */
export function startMapPolling(options: {
  readonly intervalMs?: number | undefined
  readonly cache?: MapCache | undefined
} = {}): MapPolling {
  const store = new MapStore(options.cache ?? browserMapCache)
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
