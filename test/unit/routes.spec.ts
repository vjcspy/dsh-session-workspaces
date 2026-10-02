/**
 * The fenced routes' contract: what each verb answers, what a malformed write is
 * refused with, and the fencing fact itself — every route is registered on the
 * admission-fenced `/api` channel and never on the unfenced server.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { BACKFILL_PATH, CATALOG_PATH, MAP_PATH, MUTATE_PATH } from '../../src/config.ts'
import { Backfill } from '../../src/host/backfill.ts'
import { RouteCatalog } from '../../src/host/catalog.ts'
import {
  backfillRoute, catalogRoute, mapRoute, mutateRoute, registerCatalogRoute, registerFencedRoutes, routeDeps,
} from '../../src/host/routes.ts'
import { WorkspaceStore } from '../../src/host/store.ts'
import type { TitleProviderStatus } from '../../src/host/title-provider.ts'
import { FakeContext } from '../support/fake-ctx.ts'
import { FakeDomain } from '../support/fake-domain.ts'

/** A store, a backfill and the route deps over the in-memory double. */
/** The title status every route case reports, so a case can vary it. */
let titleProvider: TitleProviderStatus = 'ok'

/** A store, a backfill and the route deps over the in-memory double. */
function makeDeps(): ReturnType<typeof routeDeps> & { readonly store: WorkspaceStore } {
  let next = 0
  const store = new WorkspaceStore(new FakeDomain(), {
    now: () => '2026-10-01T00:00:00.000Z',
    newId: () => `group-${++next}`,
  })
  const backfill = new Backfill({
    store,
    listSessions: async () => [],
    readSession: async () => ({ events: [] }),
    stream: () => (async function* () { /* no chunks */ })(),
    settings: () => ({ provider: '', model: '', candidates: [], unknownLabel: 'unknown workspace', threshold: 0.5 }),
    log: () => {},
    now: () => '2026-10-01T00:00:00.000Z',
  })
  return {
    ...routeDeps({
      store,
      backfill,
      candidates: () => ['k', 'tinybots'],
      unknownLabel: () => 'unknown workspace',
      titleProvider: () => titleProvider,
    }),
    store,
  }
}

/** A catalog over a fixed fixture directory, with a fixed sample instant. */
function makeCatalog(): RouteCatalog {
  return new RouteCatalog({
    listProviders: () => [{ id: 'fixture-p' }],
    listModels: async provider => provider === 'fixture-p' ? [{ id: 'fixture-m' }] : [],
    iso: () => '2026-10-01T00:00:00.000Z',
  })
}

/** POST one JSON body to a route. */
async function post(path: string, body: unknown, contentType = 'application/json'): Promise<Response> {
  const deps = makeDeps()
  const route = [mapRoute, mutateRoute, backfillRoute].map(build => build(deps)).find(candidate => candidate.path === path)
  if (route === undefined) throw new Error(`no route for ${path}`)
  return await route.fetch(new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: JSON.stringify(body),
  }))
}

/** Read the JSON body of a response. */
async function body(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>
}

describe('registration', () => {
  it('registers every route on the admission-fenced channel, and on nothing else', () => {
    const ctx = new FakeContext()
    // The catalog route is store-independent and registers first, at apply time;
    // the other three follow once the storage unit has opened.
    registerCatalogRoute(ctx as unknown as Context, makeCatalog())
    registerFencedRoutes(ctx as unknown as Context, makeDeps())
    expect(ctx.routes.map(route => route.path)).toEqual([CATALOG_PATH, MAP_PATH, MUTATE_PATH, BACKFILL_PATH])
    // Declaring both verbs is what lets the handler answer 405 rather than
    // letting the channel claim the path does not exist.
    for (const route of ctx.routes) expect(route.methods).toEqual(['GET', 'POST'])
    expect(ctx.webServerReads).toBe(0)
  })

  it('removes every route on unload', () => {
    const ctx = new FakeContext()
    registerCatalogRoute(ctx as unknown as Context, makeCatalog())
    registerFencedRoutes(ctx as unknown as Context, makeDeps())
    expect(ctx.routes).toHaveLength(4)
    ctx.disposeAll()
    expect(ctx.routes).toHaveLength(0)
  })
})

describe(`GET ${MAP_PATH}`, () => {
  it('reports whether the plugin owns the Conversation title, read per request', async () => {
    const deps = makeDeps()
    const route = mapRoute(deps)
    const read = async (): Promise<unknown> => {
      const payload = await body(await route.fetch(new Request(`http://127.0.0.1${MAP_PATH}`, { method: 'GET' })))
      return (payload['data'] as Record<string, unknown>)['titleProvider']
    }
    // The SAME registered route answers both ways: the status is read on each
    // request rather than captured at registration, because the plugin's own
    // registration attempt resolves asynchronously.
    titleProvider = 'ok'
    expect(await read()).toBe('ok')
    titleProvider = 'unavailable'
    expect(await read()).toBe('unavailable')
    titleProvider = 'ok'
  })

  it('answers the map and refuses every other verb with 405 and Allow', async () => {
    const deps = makeDeps()
    const route = mapRoute(deps)
    const response = await route.fetch(new Request(`http://127.0.0.1${MAP_PATH}`, { method: 'GET' }))
    expect(response.status).toBe(200)
    const payload = await body(response)
    expect(payload['success']).toBe(true)
    const data = payload['data'] as Record<string, unknown>
    expect(data['candidates']).toEqual(['k', 'tinybots'])
    expect(data['groups']).toEqual([])
    expect(data['sessions']).toEqual({})
    expect(data['backfill']).toMatchObject({ running: false, pending: 0 })
    // Additive field on the existing map response, so a profile whose title row
    // is still enabled is observable without a log line.
    expect(data['titleProvider']).toBe('ok')

    const refused = await route.fetch(new Request(`http://127.0.0.1${MAP_PATH}`, { method: 'POST' }))
    expect(refused.status).toBe(405)
    expect(refused.headers.get('allow')).toBe('GET')
  })
})

describe(`GET ${CATALOG_PATH}`, () => {
  it('answers the advertised routes and refuses every other verb with 405 and Allow', async () => {
    const route = catalogRoute(makeCatalog())
    const response = await route.fetch(new Request(`http://127.0.0.1${CATALOG_PATH}`, { method: 'GET' }))
    expect(response.status).toBe(200)
    const payload = await body(response)
    expect(payload['success']).toBe(true)
    expect(payload['data']).toEqual({
      routes: [{ provider: 'fixture-p', model: 'fixture-m' }],
      failed: [],
      sampledAt: '2026-10-01T00:00:00.000Z',
    })

    const wrongVerb = await route.fetch(new Request(`http://127.0.0.1${CATALOG_PATH}`, { method: 'POST' }))
    expect(wrongVerb.status).toBe(405)
    expect(wrongVerb.headers.get('allow')).toBe('GET')
  })
})

describe(`POST ${MUTATE_PATH}`, () => {
  it('accepts an assignment and answers with the map after it', async () => {
    const response = await post(MUTATE_PATH, { sessionId: 's1', workspace: 'k' })
    expect(response.status).toBe(200)
    const data = (await body(response))['data'] as Record<string, unknown>
    expect((data['map'] as { sessions: Record<string, unknown> }).sessions['s1'])
      .toEqual({ workspace: 'k', pinned: true })
  })

  it('creates, renames and deletes a group', async () => {
    const deps = makeDeps()
    const route = mutateRoute(deps)
    const call = async (payload: unknown): Promise<Record<string, unknown>> => await body(await route.fetch(
      new Request(`http://127.0.0.1${MUTATE_PATH}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      }),
    ))
    const created = await call({ op: 'group.create', workspace: 'k', name: 'Release' })
    const group = (created['data'] as { group: { id: string } }).group
    expect(group.id).toBeTruthy()

    const renamed = await call({ op: 'group.rename', group: group.id, name: 'Shipped' })
    expect((renamed['data'] as { group: { name: string } }).group.name).toBe('Shipped')

    await call({ sessionId: 's1', workspace: 'k', group: group.id })
    const deleted = await call({ op: 'group.delete', group: group.id })
    const map = (deleted['data'] as { map: { sessions: Record<string, { group?: string }>; groups: unknown[] } }).map
    expect(map.groups).toHaveLength(0)
    expect(map.sessions['s1']).toEqual({ workspace: 'k', pinned: true })
  })

  it('refuses a non-JSON body, a malformed body, blank fields and unknown references', async () => {
    const deps = makeDeps()
    const route = mutateRoute(deps)
    const send = async (payload: string, contentType = 'application/json'): Promise<Response> => await route.fetch(
      new Request(`http://127.0.0.1${MUTATE_PATH}`, { method: 'POST', headers: { 'content-type': contentType }, body: payload }),
    )
    expect((await send('sessionId=s1', 'application/x-www-form-urlencoded')).status).toBe(415)
    expect((await send('{oops')).status).toBe(400)
    expect((await send('[]')).status).toBe(400)
    expect((await send(JSON.stringify({ sessionId: '  ', workspace: 'k' }))).status).toBe(400)
    expect((await send(JSON.stringify({ sessionId: 's1', workspace: 'k', group: 'ghost' }))).status).toBe(404)
    expect((await send(JSON.stringify({ op: 'group.delete', group: 'ghost' }))).status).toBe(404)
    expect((await send(JSON.stringify({ op: 'group.rename', group: 'ghost', name: 'x' }))).status).toBe(404)
    expect((await send(JSON.stringify({ op: 'group.nonsense' }))).status).toBe(400)
    expect((await send(JSON.stringify({ op: 'group.create', workspace: 'k', name: '  ' }))).status).toBe(400)

    const wrongVerb = await route.fetch(new Request(`http://127.0.0.1${MUTATE_PATH}`, { method: 'GET' }))
    expect(wrongVerb.status).toBe(405)
    expect(wrongVerb.headers.get('allow')).toBe('POST')
  })
})

describe(`POST ${BACKFILL_PATH}`, () => {
  it('answers progress and accepts a start request', async () => {
    const status = await post(BACKFILL_PATH, { action: 'status' })
    expect(status.status).toBe(200)
    expect(((await body(status))['data'] as { backfill: unknown }).backfill).toMatchObject({ running: false, pending: 0 })

    const started = await post(BACKFILL_PATH, { action: 'start' })
    expect(started.status).toBe(200)
    expect(((await body(started))['data'] as { backfill: unknown }).backfill).toMatchObject({ running: false, total: 0 })

    expect((await post(BACKFILL_PATH, { action: 'nope' })).status).toBe(400)
    expect((await post(BACKFILL_PATH, {})).status).toBe(400)
  })
})
