/**
 * The provider registration's contract: the reason it is TWO registrations (the
 * real provider must never be disposed while the sidebar is rendering, or the
 * keys it contributes leave the view store's retained set), and the drop handler
 * that turns a dropped Session into the one fenced assignment the plugin writes.
 *
 * The drop handler is the seam's only inbound path for a move, so what is proven
 * here is which ROW each drop resolves to, what the release posts, and that a
 * refused write rolls the optimistic placement back instead of leaving the row
 * where nobody put it.
 */

import { describe, expect, it } from 'vitest'
import {
  dropAssignment, registerGroupingProvider, type GroupingRowDrop, type GroupingSeam, type GroupingWritePort,
} from '../../src/client/provider.ts'
import { MapStore, optimisticPlacement, type MapCache } from '../../src/client/state.ts'
import type { AssignmentRequest, MapPayload } from '../../src/wire.ts'

/** Let every pending write promise settle before asserting. */
async function settle(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

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

/** A store with no cache. */
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
    backfill: {
      running: false, total: 0, pending: 0, done: 0, classified: 0, unknown: 0, failed: 0, skipped: 0,
      noPrompt: 0,
      failures: { read: 0, route: 0, timeout: 0, providerError: 0, malformed: 0, other: 0 },
      recentFailures: [],
    },
    titleProvider: 'ok',
  }
}

/** One placement under a workspace, with no group, and one unrelated group record. */
function placed(workspace: string): MapPayload {
  return {
    sessions: { s1: { workspace, pinned: false } },
    groups: [{ id: 'g9', name: 'Later', workspace: 'k', createdAt: 'T', order: 2 }],
    candidates: ['k', workspace],
    unknownLabel: 'unknown workspace',
    backfill: {
      running: false, total: 0, pending: 0, done: 0, classified: 0, unknown: 0, failed: 0, skipped: 0,
      noPrompt: 0,
      failures: { read: 0, route: 0, timeout: 0, providerError: 0, malformed: 0, other: 0 },
      recentFailures: [],
    },
    titleProvider: 'ok',
  }
}

/** One drop event: a Session dragged out of `source` and released on `target`. */
function drop(source: GroupingRowDrop['source'], target: GroupingRowDrop['target']): GroupingRowDrop {
  return { sessionId: 's1', source, target }
}

/**
 * The write port as the browser wires it: the real store's optimistic `assign`
 * over the fenced call, where the Host's answer is `base` with the assignment
 * applied — or a refusal.
 */
function writePort(input: {
  readonly state: MapStore
  readonly base: MapPayload
  readonly refuse?: boolean
}): GroupingWritePort & { readonly posted: AssignmentRequest[] } {
  const posted: AssignmentRequest[] = []
  return {
    posted,
    assign: async (request) => {
      posted.push(request)
      await input.state.assign({
        request,
        send: async () => {
          if (input.refuse === true) throw new Error('the Host refused the write')
          return {
            ...input.base,
            sessions: { ...input.base.sessions, [request.sessionId]: optimisticPlacement(request) },
          }
        },
      })
    },
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

  it('declares no drop handler without a write port, so no drop is claimed', () => {
    let declared: { readonly id: string; readonly drop?: (event: GroupingRowDrop) => void } | undefined
    const capturing: GroupingSeam = {
      register: (provider) => {
        if (provider.id === 'p') declared = provider
        return () => {}
      },
    }
    registerGroupingProvider({ seam: capturing, store: store(), providerId: 'p' })
    expect(declared?.id).toBe('p')
    expect(declared?.drop).toBeUndefined()
  })
})

describe('dropAssignment', () => {
  const root = { key: 'p:k', label: 'k', providerId: 'p' }

  it('moves a Session onto the workspace row it was dropped on', () => {
    expect(dropAssignment({
      event: drop({ key: 'p:whill', label: 'whill', providerId: 'p' }, root), providerId: 'p', map: map('whill'),
    })).toEqual({ sessionId: 's1', workspace: 'k' })
  })

  it('names the group record, not the sanitized key, when the target is a group row', () => {
    // The key's first element is a sanitized workspace key and is therefore lossy;
    // the group record owns the exact workspace the write must carry.
    expect(dropAssignment({
      event: drop({ key: 'p:k', label: 'k', providerId: 'p' }, { key: 'p:k:g9', label: 'Later', providerId: 'p' }),
      providerId: 'p',
      map: placed('k'),
    })).toEqual({ sessionId: 's1', workspace: 'k', group: 'g9' })
  })

  it('RELEASES to the core grouping when a claimed Session is dropped on a core row', () => {
    // No workspace and no group is posted but the sentinel: the Session stays
    // decided — so nothing re-classifies it — and the sentinel rule hands it back
    // to the core Workspace grouping.
    expect(dropAssignment({
      event: drop({ key: 'p:k', label: 'k', providerId: 'p' }, { key: 'some-workspace-id', label: 'aweave' }),
      providerId: 'p',
      map: map('k'),
    })).toEqual({ sessionId: 's1', workspace: 'unknown workspace' })
  })

  it('takes the release workspace from the payload, never from a literal', () => {
    expect(dropAssignment({
      event: drop({ key: 'p:k', label: 'k', providerId: 'p' }, { key: '', label: 'Ungrouped' }),
      providerId: 'p',
      map: { ...map('k'), unknownLabel: 'chua ro' },
    })).toEqual({ sessionId: 's1', workspace: 'chua ro' })
  })

  it('accepts a drop onto its own row from a Session no provider claims', () => {
    // The source is a core row: dragging an unclassified Session into this
    // provider's workspace is the same move, and the seam routes it by target.
    expect(dropAssignment({
      event: drop({ key: 'some-workspace-id', label: 'aweave' }, root),
      providerId: 'p',
      map: placed('unknown workspace'),
    })).toEqual({ sessionId: 's1', workspace: 'k' })
  })

  it('refuses a row of another provider, a foreign source, and a row it cannot name', () => {
    const other = { key: 'q:k', label: 'k', providerId: 'q' }
    expect(dropAssignment({ event: drop(root, other), providerId: 'p', map: map('k') })).toBeUndefined()
    expect(dropAssignment({ event: drop(other, other), providerId: 'p', map: map('k') })).toBeUndefined()
    expect(dropAssignment({
      event: drop(root, { key: 'other:k', label: 'k', providerId: 'p' }),
      providerId: 'p',
      map: map('k'),
    })).toBeUndefined()
    // A drop nobody can name is refused rather than guessed from a lossy key.
    expect(dropAssignment({ event: drop(root, { key: 'p:k', providerId: 'p' }), providerId: 'p', map: map('k') }))
      .toBeUndefined()
    expect(dropAssignment({ event: drop(root, root), providerId: 'p', map: undefined })).toBeUndefined()
  })
})

describe('the registered drop handler', () => {
  /** A seam capturing the real provider's drop handler. */
  function capture(): { readonly seam: GroupingSeam; readonly fire: (event: GroupingRowDrop) => void } {
    let handler: ((event: GroupingRowDrop) => void) | undefined
    return {
      seam: {
        register: (provider) => {
          if (provider.id === 'p') handler = provider.drop
          return () => {}
        },
      },
      fire: (event) => { handler?.(event) },
    }
  }

  it('posts ONE assignment per drop, and shows it over the map before the answer lands', async () => {
    const state = store()
    const base = placed('whill')
    state.accept(base)
    const { seam, fire } = capture()
    const write = writePort({ state, base })
    registerGroupingProvider({ seam, store: state, providerId: 'p', write })

    fire(drop({ key: 'p:whill', label: 'whill', providerId: 'p' }, { key: 'p:k', label: 'k', providerId: 'p' }))
    // The optimistic overlay is visible before the write answers.
    expect(state.payload()?.sessions['s1']).toEqual({ workspace: 'k', pinned: true })
    await settle()
    expect(write.posted).toEqual([{ sessionId: 's1', workspace: 'k' }])
    expect(state.payload()?.sessions['s1']).toEqual({ workspace: 'k', pinned: true })
  })

  it('posts the sentinel release for a drop on a core row, and keeps the Session decided', async () => {
    const state = store()
    const base = placed('k')
    state.accept(base)
    const { seam, fire } = capture()
    const write = writePort({ state, base })
    registerGroupingProvider({ seam, store: state, providerId: 'p', write })

    fire(drop({ key: 'p:k', label: 'k', providerId: 'p' }, { key: 'workspace-1', label: 'aweave' }))
    await settle()
    expect(write.posted).toEqual([{ sessionId: 's1', workspace: 'unknown workspace' }])
    // The release is a PIN, which is what keeps the Session decided.
    expect(state.payload()?.sessions['s1']).toEqual({ workspace: 'unknown workspace', pinned: true })
  })

  it('drops the overlay and reports the reason when the write is refused', async () => {
    const state = store()
    const base = placed('whill')
    state.accept(base)
    const { seam, fire } = capture()
    const logged: string[] = []
    registerGroupingProvider({
      seam,
      store: state,
      providerId: 'p',
      write: writePort({ state, base, refuse: true }),
      log: (message) => { logged.push(message) },
    })

    fire(drop({ key: 'p:whill', label: 'whill', providerId: 'p' }, { key: 'p:k', label: 'k', providerId: 'p' }))
    expect(state.payload()?.sessions['s1']).toEqual({ workspace: 'k', pinned: true })
    await settle()
    // Rolled back to the map that stands, and the refusal is reported rather than
    // escaping as an unhandled rejection.
    expect(state.payload()?.sessions['s1']).toEqual({ workspace: 'whill', pinned: false })
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('refused')
  })

  it('posts nothing for a drop it does not own', async () => {
    const state = store()
    const base = placed('k')
    state.accept(base)
    const { seam, fire } = capture()
    const write = writePort({ state, base })
    registerGroupingProvider({ seam, store: state, providerId: 'p', write })

    fire(drop({ key: 'q:k', label: 'k', providerId: 'q' }, { key: 'q:other', label: 'other', providerId: 'q' }))
    await settle()
    expect(write.posted).toEqual([])
    expect(state.payload()?.sessions['s1']).toEqual({ workspace: 'k', pinned: false })
  })
})
