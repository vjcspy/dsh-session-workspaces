/**
 * The advertised route catalog, both halves: the Host's sampling of the LLM
 * directory (a provider with no models, one provider failing while the rest still
 * answer, a directory that cannot be listed at all, and the cache window) and the
 * browser's view of it (a failed read keeps the last good routes, so the settings
 * control never loses the route it already showed).
 */

import { describe, expect, it } from 'vitest'
import { RouteCatalog } from '../../src/host/catalog.ts'
import { RouteCatalogState } from '../../src/client/route-catalog.ts'
import type { CatalogPayload } from '../../src/wire.ts'

/** A catalog source with a scripted clock and scripted per-provider answers. */
function source(script: {
  readonly providers?: readonly string[]
  readonly models?: (provider: string) => Promise<readonly { id: string }[]>
  readonly listProvidersThrows?: string
}): { listProviders: () => readonly { id: string }[], listModels: (provider: string) => Promise<readonly { id: string }[]>, now: () => number, iso: () => string, readonly calls: string[], tick: (ms: number) => void } {
  const calls: string[] = []
  let clock = 1_000
  return {
    listProviders: () => {
      if (script.listProvidersThrows !== undefined) throw new Error(script.listProvidersThrows)
      return (script.providers ?? []).map(id => ({ id }))
    },
    listModels: async (provider: string) => {
      calls.push(provider)
      return await (script.models?.(provider) ?? Promise.resolve([{ id: 'm' }]))
    },
    now: () => clock,
    iso: () => '2026-10-01T00:00:00.000Z',
    calls,
    tick: (ms: number) => { clock += ms },
  }
}

describe('the host catalog sample', () => {
  it('lists every advertised pair in provider order, then adapter order', async () => {
    const catalog = new RouteCatalog(source({
      providers: ['opencode-go', 'deepseek-official'],
      models: async provider => provider === 'opencode-go'
        ? [{ id: 'muse-spark-1.3-contributor' }, { id: 'muse-spark-1.4' }]
        : [{ id: 'deepseek-flash' }],
    }))
    const payload = await catalog.read()
    expect(payload.routes).toEqual([
      { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' },
      { provider: 'opencode-go', model: 'muse-spark-1.4' },
      { provider: 'deepseek-official', model: 'deepseek-flash' },
    ])
    expect(payload.failed).toEqual([])
    expect(payload.error).toBeUndefined()
    expect(payload.sampledAt).toBe('2026-10-01T00:00:00.000Z')
  })

  it('offers no route for a provider with no models, and does not call it a failure', async () => {
    const catalog = new RouteCatalog(source({
      providers: ['empty-provider', 'opencode-go'],
      models: async provider => provider === 'empty-provider' ? [] : [{ id: 'muse-spark-1.3-contributor' }],
    }))
    const payload = await catalog.read()
    expect(payload.routes).toEqual([{ provider: 'opencode-go', model: 'muse-spark-1.3-contributor' }])
    expect(payload.failed).toEqual([])
    expect(payload.error).toBeUndefined()
  })

  it('reports one provider whose catalog failed, and still answers the others', async () => {
    const catalog = new RouteCatalog(source({
      providers: ['broken', 'fine'],
      models: async provider => {
        if (provider === 'broken') throw new Error('adapter returned invalid or duplicate model metadata')
        return [{ id: 'ok' }]
      },
    }))
    const payload = await catalog.read()
    expect(payload.routes).toEqual([{ provider: 'fine', model: 'ok' }])
    expect(payload.failed).toEqual([{ provider: 'broken', message: 'adapter returned invalid or duplicate model metadata' }])
    expect(payload.error).toBeUndefined()
  })

  it('answers an empty catalog carrying the reason when the directory cannot be listed', async () => {
    const catalog = new RouteCatalog(source({ listProvidersThrows: 'no directory' }))
    const payload = await catalog.read()
    expect(payload.routes).toEqual([])
    expect(payload.failed).toEqual([])
    expect(payload.error).toBe('no directory')
    // Not cached: the next read asks the directory again.
    const second = await catalog.read()
    expect(second.error).toBe('no directory')
  })

  it('skips an entry an adapter does not name properly', async () => {
    const catalog = new RouteCatalog(source({
      providers: ['p'],
      models: async () => [{ id: 'good' }, { id: '' }, { id: 'good' }],
    }))
    const payload = await catalog.read()
    expect(payload.routes).toEqual([{ provider: 'p', model: 'good' }])
  })

  it('reuses one sample inside the window, samples again after it, and honours invalidate', async () => {
    const scripted = source({ providers: ['p'], models: async () => [{ id: 'm' }] })
    const catalog = new RouteCatalog(scripted, 60_000)
    await catalog.read()
    await catalog.read()
    expect(scripted.calls).toEqual(['p'])
    scripted.tick(59_999)
    await catalog.read()
    expect(scripted.calls).toEqual(['p'])
    scripted.tick(2)
    await catalog.read()
    expect(scripted.calls).toEqual(['p', 'p'])
    catalog.invalidate()
    await catalog.read()
    expect(scripted.calls).toEqual(['p', 'p', 'p'])
  })

  it('shares one in-flight sample between concurrent reads', async () => {
    const scripted = source({ providers: ['p'], models: async () => [{ id: 'm' }] })
    const catalog = new RouteCatalog(scripted, 60_000)
    const [first, second] = await Promise.all([catalog.read(), catalog.read()])
    expect(first).toBe(second)
    expect(scripted.calls).toEqual(['p'])
  })
})

/** One payload, for the browser-state tests. */
function payload(routes: readonly { readonly provider: string; readonly model: string }[], failed: readonly { readonly provider: string; readonly message: string }[] = [], error?: string): CatalogPayload {
  return { routes, failed, ...(error === undefined ? {} : { error }), sampledAt: '2026-10-01T00:00:00.000Z' }
}

describe('the browser catalog state', () => {
  it('publishes the advertised routes', async () => {
    const state = new RouteCatalogState(async () => payload([{ provider: 'p', model: 'm' }]))
    await state.refresh()
    expect(state.snapshot().routes).toEqual([{ provider: 'p', model: 'm' }])
    expect(state.snapshot().error).toBeUndefined()
  })

  it('reports a partial failure as one hint and still offers the routes it got', async () => {
    const state = new RouteCatalogState(async () => payload(
      [{ provider: 'fine', model: 'ok' }],
      [{ provider: 'broken', message: 'unreachable' }],
    ))
    await state.refresh()
    expect(state.snapshot().routes).toEqual([{ provider: 'fine', model: 'ok' }])
    expect(state.snapshot().error).toBe('broken: unreachable')
  })

  it('reports a whole-read error', async () => {
    const state = new RouteCatalogState(async () => payload([], [], 'no directory'))
    await state.refresh()
    expect(state.snapshot().routes).toEqual([])
    expect(state.snapshot().error).toBe('no directory')
  })

  it('keeps the last good routes when a read FAILS, so the control never loses a route', async () => {
    let fail = false
    const state = new RouteCatalogState(async () => {
      if (fail) throw new Error('the Host answered 401')
      return payload([{ provider: 'p', model: 'm' }])
    })
    await state.refresh()
    expect(state.snapshot().routes).toEqual([{ provider: 'p', model: 'm' }])
    fail = true
    await state.refresh()
    expect(state.snapshot().routes).toEqual([{ provider: 'p', model: 'm' }])
    expect(state.snapshot().error).toBe('the Host answered 401')
  })

  it('keeps an empty catalog usable and notifies its subscribers once per read', async () => {
    let reads = 0
    const state = new RouteCatalogState(async () => { reads += 1; return payload([]) })
    let notifications = 0
    const unsubscribe = state.subscribe(() => { notifications += 1 })
    await state.refresh()
    expect(state.snapshot()).toEqual({ routes: [], error: undefined })
    expect(notifications).toBe(1)
    const before = state.snapshot()
    await state.refresh()
    expect(reads).toBe(2)
    expect(before).not.toBe(state.snapshot())
    unsubscribe()
    await state.refresh()
    expect(notifications).toBe(2)
  })
})
