/**
 * The browser store's cache contract.
 *
 * The cache is load-bearing rather than an optimisation: the sidebar prunes its
 * persisted expansion and manual-order entries to the keys the CURRENT
 * derivation produced, and a reload renders before the first map read resolves.
 * Seeding from the cache is what keeps a provider group's collapsed state and
 * manual order alive across a reload.
 */

import { describe, expect, it } from 'vitest'
import { MAP_CACHE_KEY } from '../../src/config.ts'
import { MapStore, startMapPolling, type MapCache } from '../../src/client/state.ts'
import { resolveGroupingPath } from '../../src/client/grouping.ts'
import type { MapPayload } from '../../src/wire.ts'

/** One map with a placed Session and a group. */
function map(revision: string): MapPayload {
  return {
    sessions: { s1: { workspace: 'k', group: 'g1', pinned: true } },
    groups: [{ id: 'g1', name: 'Release', workspace: 'k', createdAt: revision, order: 0 }],
    candidates: ['k'],
    unknownLabel: 'unknown workspace',
    backfill: { running: false, total: 0, pending: 0, done: 0, classified: 0, failed: 0, skipped: 0 },
  }
}

/** An in-memory cache, recording writes. */
function fakeCache(seed?: MapPayload): MapCache & { readonly writes: MapPayload[] } {
  let value = seed
  const writes: MapPayload[] = []
  return {
    writes,
    read: () => value,
    write: (next) => { value = next; writes.push(next) },
  }
}

describe('MapStore', () => {
  it('seeds from the cache, so the provider answers on the very first render', () => {
    const cache = fakeCache(map('seeded'))
    const store = new MapStore(cache)
    expect(store.read().status).toBe('ready')
    // The fact that matters: the grouping path resolves before any read.
    expect(resolveGroupingPath(store.payload(), 's1')).toEqual([
      { key: 'k', label: 'k' },
      { key: 'g1', label: 'Release', order: 0 },
    ])
  })

  it('starts empty without a cache entry', () => {
    const store = new MapStore(fakeCache(undefined))
    expect(store.read().status).toBe('loading')
    expect(store.payload()).toBeUndefined()
  })

  it('publishes only a real change and keeps the last map for the next load', () => {
    const cache = fakeCache(undefined)
    const store = new MapStore(cache)
    let notifications = 0
    store.subscribe(() => { notifications += 1 })
    store.accept(map('first'))
    store.accept(map('first'))
    expect(notifications).toBe(1)
    expect(cache.writes).toHaveLength(1)
    store.accept(map('second'))
    expect(notifications).toBe(2)
    expect(cache.writes).toHaveLength(2)
  })

  it('keeps the last good map standing when a read fails', async () => {
    const cache = fakeCache(undefined)
    const store = new MapStore(cache)
    store.accept(map('first'))
    // No fetch is served in this process, so the refresh must fail and leave the
    // map in place rather than emptying the tree.
    await store.refresh()
    expect(store.read().map).toBeDefined()
    expect(store.read().status).toBe('ready')
  })

  it('reports an error only when it never had a map', async () => {
    const store = new MapStore(fakeCache(undefined))
    await store.refresh()
    expect(store.read()).toMatchObject({ status: 'error' })
    expect(store.read().map).toBeUndefined()
  })
})

describe('the browser cache', () => {
  it('namespaces the entry under a versioned key', () => {
    expect(MAP_CACHE_KEY).toBe('dsh-session-workspaces.map.v1')
  })

  it('is not consulted when a cache is injected, so a spec needs no storage', () => {
    const polling = startMapPolling({ intervalMs: 60_000, cache: fakeCache(undefined) })
    expect(polling.store.read().status).toBe('loading')
    polling.dispose()
  })
})
