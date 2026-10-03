/**
 * The browser store's contract.
 *
 * Two things beyond the cache are proven here, and both are orderings a busy
 * page hits in practice:
 *
 * - The cache is load-bearing rather than an optimisation: the sidebar prunes its
 *   persisted expansion and manual-order entries to the keys the CURRENT
 *   derivation produced, and a reload renders before the first map read resolves.
 *   Seeding from the cache is what keeps a provider group's collapsed state and
 *   manual order alive across a reload.
 * - Requests are numbered and a write response sets a barrier, so a poll that was
 *   already in flight when a write landed cannot paint the state the write
 *   replaced; and a Human placement is an OVERLAY over whatever map is current,
 *   so a poll answering mid-write cannot displace it and a refusal drops it
 *   instead of restoring a superseded snapshot.
 */

import { describe, expect, it } from 'vitest'
import { MAP_CACHE_KEY } from '../../src/config.ts'
import { MapStore, optimisticPlacement, startMapPolling, type MapCache } from '../../src/client/state.ts'
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
    titleProvider: 'ok',
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

/** A promise whose settlement the spec controls. */
function deferred<T>(): {
  readonly promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: Error) => void
} {
  let resolve: (value: T) => void = () => {}
  let reject: (reason: Error) => void = () => {}
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail })
  return { promise, resolve, reject }
}

/** A map read the spec answers by hand, one pending request at a time. */
function controlledReader(): {
  readonly read: () => Promise<MapPayload>
  readonly answer: (map: MapPayload) => void
} {
  let pending: ((map: MapPayload) => void) | undefined
  return {
    read: () => new Promise<MapPayload>((resolve) => { pending = resolve }),
    answer: (next) => {
      const resolve = pending
      pending = undefined
      resolve?.(next)
    },
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

describe('the poll guard', () => {
  it('drops the answer to a poll a write has superseded, and applies a later one', async () => {
    const reader = controlledReader()
    const store = new MapStore(fakeCache(undefined), reader.read)
    const poll = store.refresh()
    const write = store.assign({
      request: { sessionId: 's1', workspace: 'tinybots' },
      send: async () => map('written'),
    })
    await write
    // The poll went out BEFORE the write answered, so its map is the state the
    // write replaced: applying it would snap the row back.
    reader.answer(map('stale'))
    await poll
    expect(store.payload()).toEqual(map('written'))

    const later = store.refresh()
    reader.answer(map('newer'))
    await later
    expect(store.payload()).toEqual(map('newer'))
  })

  it('needs no special case after a host restart: a fresh store applies its first poll', async () => {
    const before = new MapStore(fakeCache(map('before')), async () => map('unused'))
    await before.assign({ request: { sessionId: 's1', workspace: 'tinybots' }, send: async () => map('written') })
    // Nothing about the barrier is persisted — the host's write counter is
    // per-process — so a store built after a restart starts with no barrier and
    // cannot read its own first poll as stale.
    const restarted = new MapStore(fakeCache(undefined), async () => map('after-restart'))
    await restarted.refresh()
    expect(restarted.payload()).toEqual(map('after-restart'))
  })
})

describe('the optimistic placement', () => {
  it('shows an assignment over the standing map, then folds the answered map in', async () => {
    const store = new MapStore(fakeCache(map('before')), async () => map('unused'))
    const write = store.assign({
      request: { sessionId: 's1', workspace: 'tinybots', group: 'g1' },
      send: async () => map('answered'),
    })
    expect(store.payload()?.sessions['s1']).toEqual({ workspace: 'tinybots', group: 'g1', pinned: true })
    await write
    expect(store.payload()).toEqual(map('answered'))
  })

  it('keeps a pending placement over a poll that answers while the write is in flight', async () => {
    const reader = controlledReader()
    const store = new MapStore(fakeCache(map('before')), reader.read)
    const answer = deferred<MapPayload>()
    const write = store.assign({
      request: { sessionId: 's1', workspace: 'tinybots', group: 'g1' },
      send: () => answer.promise,
    })
    expect(store.payload()?.sessions['s1']).toEqual({ workspace: 'tinybots', group: 'g1', pinned: true })

    const poll = store.refresh()
    reader.answer(map('polled'))
    await poll
    // The poll replaced the map UNDER the placement; the placement still stands.
    expect(store.payload()?.sessions['s1']).toEqual({ workspace: 'tinybots', group: 'g1', pinned: true })

    answer.resolve(map('answered'))
    await write
    expect(store.payload()).toEqual(map('answered'))
  })

  it('drops the overlay on a refused write, leaving the map the poll delivered', async () => {
    const reader = controlledReader()
    const store = new MapStore(fakeCache(map('before')), reader.read)
    const refusal = deferred<MapPayload>()
    const write = store.assign({
      request: { sessionId: 's1', workspace: 'tinybots' },
      send: () => refusal.promise,
    })
    // The rejection is claimed before it can happen, so the refusal is asserted
    // rather than reported as an unhandled one.
    const refused = expect(write).rejects.toThrow('the Host refused the write')

    const poll = store.refresh()
    reader.answer(map('polled'))
    await poll
    expect(store.payload()?.sessions['s1']).toEqual({ workspace: 'tinybots', pinned: true })

    refusal.reject(new Error('the Host refused the write'))
    await refused
    // NOT a snapshot restore: the map the poll delivered is what stands, so a
    // rollback cannot resurrect a state the poll has already superseded.
    expect(store.payload()).toEqual(map('polled'))
  })
})

describe('optimisticPlacement', () => {
  it('reads a Human assignment as the pin the write records', () => {
    expect(optimisticPlacement({ sessionId: 's1', workspace: 'k' })).toEqual({ workspace: 'k', pinned: true })
    expect(optimisticPlacement({ sessionId: 's1', workspace: 'k', group: 'g1' }))
      .toEqual({ workspace: 'k', group: 'g1', pinned: true })
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
