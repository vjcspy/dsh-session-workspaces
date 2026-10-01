/**
 * The provider registration's contract, and specifically the reason it is TWO
 * registrations: the real provider must never be disposed while the sidebar is
 * rendering, or the keys it contributes leave the view store's retained set.
 */

import { describe, expect, it } from 'vitest'
import { registerGroupingProvider, type GroupingSeam } from '../../src/client/provider.ts'
import { MapStore, type MapCache } from '../../src/client/state.ts'
import type { MapPayload } from '../../src/wire.ts'

/** A seam that records registration order and every live provider. */
function fakeSeam(): GroupingSeam & {
  readonly registered: string[]
  readonly live: string[]
  readonly disposals: string[]
} {
  const registered: string[] = []
  const live: string[] = []
  const disposals: string[] = []
  return {
    registered,
    live,
    disposals,
    register: (provider) => {
      registered.push(provider.id)
      live.push(provider.id)
      return () => {
        disposals.push(provider.id)
        const at = live.indexOf(provider.id)
        if (at >= 0) live.splice(at, 1)
      }
    },
  }
}

/** A store with no cache and one placed Session. */
function store(): MapStore {
  const cache: MapCache = { read: () => undefined, write: () => {} }
  return new MapStore(cache)
}

/** One map placing `s1` under a workspace and a group. */
function map(workspace: string): MapPayload {
  return {
    sessions: { s1: { workspace, group: 'g1', pinned: true } },
    groups: [{ id: 'g1', name: 'Release', workspace, createdAt: 'T', order: 0 }],
    candidates: [workspace],
    unknownLabel: 'unknown workspace',
    backfill: { running: false, total: 0, pending: 0, done: 0, classified: 0, failed: 0, skipped: 0 },
  }
}

describe('registerGroupingProvider', () => {
  it('registers the provider once and a revision lever beside it', () => {
    const seam = fakeSeam()
    registerGroupingProvider({ seam, store: store(), providerId: 'p' })
    expect(seam.registered).toEqual(['p', 'p-revision'])
    expect(seam.live).toEqual(['p', 'p-revision'])
  })

  it('re-registers ONLY the lever when the map changes, so the provider never leaves the seam', () => {
    const seam = fakeSeam()
    const state = store()
    registerGroupingProvider({ seam, store: state, providerId: 'p' })
    state.accept(map('k'))
    state.accept(map('whill'))
    // The provider was registered exactly once; every change moved the lever.
    expect(seam.registered.filter(id => id === 'p')).toHaveLength(1)
    expect(seam.registered.filter(id => id === 'p-revision').length).toBe(3)
    expect(seam.live).toContain('p')
    expect(seam.disposals).not.toContain('p')
  })

  it('answers the path from the current map, and undefined when nothing claims the Session', () => {
    const state = store()
    let resolve: ((session: { readonly id: unknown }) => readonly { key: string; label: string }[] | undefined) | undefined
    const capturing: GroupingSeam = {
      register: (provider) => {
        if (provider.id === 'p') resolve = provider.resolve
        return () => {}
      },
    }
    registerGroupingProvider({ seam: capturing, store: state, providerId: 'p' })
    // Before the first map: the Session keeps the core grouping.
    expect(resolve?.({ id: 's1' })).toBeUndefined()
    state.accept(map('k'))
    expect(resolve?.({ id: 's1' })).toEqual([
      { key: 'k', label: 'k' },
      { key: 'g1', label: 'Release', order: 0 },
    ])
    expect(resolve?.({ id: 'unclassified' })).toBeUndefined()
  })

  it('removes both registrations and stops observing on dispose', () => {
    const seam = fakeSeam()
    const state = store()
    const registration = registerGroupingProvider({ seam, store: state, providerId: 'p' })
    registration.dispose()
    expect(seam.live).toEqual([])
    state.accept(map('k'))
    expect(seam.registered).toEqual(['p', 'p-revision'])
  })
})
