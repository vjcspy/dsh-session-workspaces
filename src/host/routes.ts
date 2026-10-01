/**
 * The fenced routes on the shared `/api` channel: the map, the write route, the
 * backfill control, and the advertised route catalog the settings control reads.
 *
 * The channel — not this plugin — owns admission: `connection.admit` runs in the
 * `/api` prefix handler before any route lookup, so a foreign `Host` is refused
 * with `403` and a request without the browser cookie with `401`, whether or not
 * the fenced path exists. Registering through `ctx.connection.fetch.register` is
 * therefore what fences these routes; a raw `ctx.webServer` route would receive
 * no admission at all.
 *
 * No extra CSRF layer is added on top: the browser session cookie is host-only,
 * `HttpOnly` and `SameSite=Strict`, and `api-request-trust.ts` refuses a
 * cross-site `Origin` / `sec-fetch-site` before the body is read. The
 * content-type check below is defense in depth only — it rejects a write a
 * browser form could have produced, which the trust layer already blocks.
 *
 * Each registration is an effect of this context, so plugin teardown removes the
 * routes even on a hot unload.
 *
 * @module dsh-session-workspaces/host/routes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { BACKFILL_PATH, CATALOG_PATH, MAP_PATH, MUTATE_PATH } from '../config.ts'
import type { Backfill } from './backfill.ts'
import type { RouteCatalog } from './catalog.ts'
import type { WorkspaceStore } from './store.ts'
import type { AssignmentRequest, GroupOperation, MapPayload, MutateRequest } from '../wire.ts'
import { isGroupOperation } from '../wire.ts'

/**
 * Methods registered on every fenced route.
 *
 * The channel matches a pathname first and a method second, so both verbs are
 * declared: the handler then answers the verb it does not implement with `405`
 * plus `Allow`, instead of the channel's blanket `404`, which would claim the
 * path does not exist.
 */
export const CHANNEL_METHODS: readonly ('GET' | 'POST')[] = ['GET', 'POST']

/** Longest accepted Session id, matching the sibling plugins' bound. */
const MAX_SESSION_ID_CHARS = 200

/** Longest accepted workspace label or group name. */
const MAX_LABEL_CHARS = 120

/** Everything the routes answer from. */
export interface FencedRouteDeps {
  /** The durable store. */
  readonly store: WorkspaceStore
  /** The bounded, opt-in backfill. */
  readonly backfill: Backfill
  /** The current closed candidate label set. */
  readonly candidates: () => readonly string[]
  /** The current unknown label. */
  readonly unknownLabel: () => string
  /** The current map payload; every route answers with it after a write. */
  readonly map: () => MapPayload
}

/**
 * Build the route dependencies from the store and the live settings.
 * @param input - store, backfill and live settings reads.
 * @returns the deps every route shares, with the map read derived once.
 */
export function routeDeps(input: {
  readonly store: WorkspaceStore
  readonly backfill: Backfill
  readonly candidates: () => readonly string[]
  readonly unknownLabel: () => string
}): FencedRouteDeps {
  return {
    ...input,
    map: () => input.store.snapshot({
      candidates: input.candidates(),
      unknownLabel: input.unknownLabel(),
      backfill: input.backfill.snapshot(),
    }),
  }
}

/** One JSON answer. */
function json(status: number, payload: unknown, allow?: string): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }
  if (allow !== undefined) headers['allow'] = allow
  return new Response(JSON.stringify(payload), { status, headers })
}

/** One refusal in the plugin's own envelope. */
function refuse(status: number, code: string, message: string, allow?: string): Response {
  return json(status, { success: false, error: { code, message } }, allow)
}

/** One successful answer. */
function ok(data: unknown): Response {
  return json(200, { success: true, data })
}

/** A non-blank, bounded string field. */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' || trimmed.length > max ? undefined : trimmed
}

/**
 * The map read: placements, group records, the candidate set and backfill progress.
 * @param deps - store, backfill and live settings.
 * @returns the route.
 */
export function mapRoute(deps: FencedRouteDeps): ConnectionFetchRoute {
  return {
    path: MAP_PATH,
    methods: CHANNEL_METHODS,
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method !== 'GET') {
        return refuse(405, 'METHOD_NOT_ALLOWED', `${request.method} is not implemented on ${MAP_PATH}`, 'GET')
      }
      return ok(deps.map())
    },
  }
}

/**
 * The write route: one Session assignment, or one group operation.
 *
 * Both halves answer with the map as it stands after the write, so the caller
 * needs no second round trip and the tree updates from one response.
 * @param deps - store, backfill and live settings.
 * @returns the route.
 */
export function mutateRoute(deps: FencedRouteDeps): ConnectionFetchRoute {
  return {
    path: MUTATE_PATH,
    methods: CHANNEL_METHODS,
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method !== 'POST') {
        return refuse(405, 'METHOD_NOT_ALLOWED', `${request.method} is not implemented on ${MUTATE_PATH}`, 'POST')
      }
      const contentType = request.headers.get('content-type') ?? ''
      if (!contentType.toLowerCase().includes('application/json')) {
        return refuse(415, 'UNSUPPORTED_MEDIA_TYPE', `${MUTATE_PATH} accepts application/json only`)
      }
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return refuse(400, 'INVALID_BODY', `${MUTATE_PATH} requires a JSON request body`)
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return refuse(400, 'INVALID_BODY', `${MUTATE_PATH} requires a JSON object request body`)
      }
      const input = body as MutateRequest
      return isGroupOperation(input)
        ? await applyGroupOperation(deps, input)
        : await applyAssignment(deps, input)
    },
  }
}

/**
 * The backfill control: start a pass, or report progress.
 * @param deps - store, backfill and live settings.
 * @returns the route.
 */
export function backfillRoute(deps: FencedRouteDeps): ConnectionFetchRoute {
  return {
    path: BACKFILL_PATH,
    methods: CHANNEL_METHODS,
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method !== 'POST') {
        return refuse(405, 'METHOD_NOT_ALLOWED', `${request.method} is not implemented on ${BACKFILL_PATH}`, 'POST')
      }
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return refuse(400, 'INVALID_BODY', `${BACKFILL_PATH} requires a JSON request body`)
      }
      const action = (body as { action?: unknown } | null)?.action
      if (action === 'status') return ok({ backfill: deps.backfill.snapshot(), map: deps.map() })
      if (action !== 'start') return refuse(400, 'INVALID_ACTION', `${BACKFILL_PATH} accepts {"action":"start"|"status"}`)
      const backfill = await deps.backfill.start()
      return ok({ backfill, map: deps.map() })
    },
  }
}

/** Apply one Session assignment, which also pins it. */
async function applyAssignment(deps: FencedRouteDeps, input: AssignmentRequest): Promise<Response> {
  const sessionId = text(input.sessionId, MAX_SESSION_ID_CHARS)
  if (sessionId === undefined) return refuse(400, 'INVALID_INPUT', 'sessionId must be a non-blank string')
  const workspace = text(input.workspace, MAX_LABEL_CHARS)
  if (workspace === undefined) return refuse(400, 'INVALID_INPUT', 'workspace must be a non-blank string')
  const rawGroup = input.group
  if (rawGroup === undefined || rawGroup === null) {
    await deps.store.assign({ sessionId, workspace })
    return ok({ map: deps.map() })
  }
  const group = text(rawGroup, MAX_SESSION_ID_CHARS)
  if (group === undefined) return refuse(400, 'INVALID_INPUT', 'group must be a non-blank string when present')
  const placement = await deps.store.assign({ sessionId, workspace, group })
  if (placement === undefined) return refuse(404, 'UNKNOWN_GROUP', `group "${group}" does not exist`)
  return ok({ map: deps.map() })
}

/** Apply one group operation. */
async function applyGroupOperation(deps: FencedRouteDeps, input: GroupOperation): Promise<Response> {
  switch (input.op) {
    case 'group.create': {
      const workspace = text(input.workspace, MAX_LABEL_CHARS)
      const name = text(input.name, MAX_LABEL_CHARS)
      if (workspace === undefined || name === undefined) {
        return refuse(400, 'INVALID_INPUT', 'group.create requires a non-blank workspace and name')
      }
      const group = await deps.store.createGroup({ workspace, name })
      return ok({ group, map: deps.map() })
    }
    case 'group.rename': {
      const group = text(input.group, MAX_SESSION_ID_CHARS)
      const name = text(input.name, MAX_LABEL_CHARS)
      if (group === undefined || name === undefined) {
        return refuse(400, 'INVALID_INPUT', 'group.rename requires a non-blank group and name')
      }
      const renamed = await deps.store.renameGroup(group, name)
      if (renamed === undefined) return refuse(404, 'UNKNOWN_GROUP', `group "${group}" does not exist`)
      return ok({ group: renamed, map: deps.map() })
    }
    case 'group.delete': {
      const group = text(input.group, MAX_SESSION_ID_CHARS)
      if (group === undefined) return refuse(400, 'INVALID_INPUT', 'group.delete requires a non-blank group')
      const removed = await deps.store.deleteGroup(group)
      if (!removed) return refuse(404, 'UNKNOWN_GROUP', `group "${group}" does not exist`)
      // Members are not swept: their assignment keeps pointing at the id, and
      // the map already renders them at workspace level.
      return ok({ map: deps.map() })
    }
    case 'group.removeMember': {
      const sessionId = text(input.sessionId, MAX_SESSION_ID_CHARS)
      const workspace = text(input.workspace, MAX_LABEL_CHARS)
      if (sessionId === undefined || workspace === undefined) {
        return refuse(400, 'INVALID_INPUT', 'group.removeMember requires a non-blank sessionId and workspace')
      }
      await deps.store.removeMember(sessionId, workspace)
      return ok({ map: deps.map() })
    }
    default:
      return refuse(400, 'UNKNOWN_OPERATION', `unsupported operation "${String((input as { op?: unknown }).op)}"`)
  }
}

/**
 * Register every fenced route this plugin publishes.
 * @param ctx - Host context owning the `connection` service.
 * @param deps - store, backfill and live settings.
 */
export function registerFencedRoutes(ctx: Context, deps: FencedRouteDeps): void {
  for (const route of [mapRoute(deps), mutateRoute(deps), backfillRoute(deps)]) {
    ctx.effect(() => {
      const dispose = ctx.connection.fetch.register(route)
      return () => { void dispose() }
    }, `dsh-session-workspaces: ${route.path}`)
  }
}

/**
 * The catalog read: every `provider`/`model` pair the LLM directory advertises.
 *
 * This is the one route that does not read the durable store, so it is registered
 * at apply time rather than behind the store's asynchronous open: the settings
 * control has to be able to offer routes even when the storage unit failed to
 * open, and the route answers an EMPTY catalog carrying the reason rather than
 * failing, because a `500` would leave the control with nothing to render.
 * @param catalog - the sampled catalog.
 * @returns the route.
 */
export function catalogRoute(catalog: RouteCatalog): ConnectionFetchRoute {
  return {
    path: CATALOG_PATH,
    methods: CHANNEL_METHODS,
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method !== 'GET') {
        return refuse(405, 'METHOD_NOT_ALLOWED', `${request.method} is not implemented on ${CATALOG_PATH}`, 'GET')
      }
      return ok(await catalog.read())
    },
  }
}

/**
 * Register the store-independent catalog route.
 * @param ctx - Host context owning the `connection` service.
 * @param catalog - the sampled catalog.
 */
export function registerCatalogRoute(ctx: Context, catalog: RouteCatalog): void {
  const route = catalogRoute(catalog)
  ctx.effect(() => {
    const dispose = ctx.connection.fetch.register(route)
    return () => { void dispose() }
  }, `dsh-session-workspaces: ${route.path}`)
}
