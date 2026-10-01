/**
 * The browser half's client for the three fenced routes.
 *
 * Every call goes to the Host's own `/api/dsh-session-workspaces/…` paths. The
 * channel's admission — the browser cookie, and a `Host` the deployment trusts —
 * is what makes the call allowed at all; this half adds nothing to that and
 * relies on the same-origin cookie the page already holds.
 *
 * Decoding is bounded: a body that does not carry the fields this half reads is
 * a failure, reported as one, never rendered half-built.
 *
 * @module dsh-session-workspaces/client/api
 */

import { BACKFILL_PATH, MAP_PATH, MUTATE_PATH } from '../config.ts'
import type { BackfillStatus, MapPayload, MutateRequest } from '../wire.ts'

/** One read or write that did not produce a usable value. */
export class TransportError extends Error {
  /** Why the call produced no value. */
  readonly kind: 'unreachable' | 'refused' | 'malformed'

  /**
   * @param kind - the failure class.
   * @param message - the message shown to the Human.
   */
  constructor(kind: 'unreachable' | 'refused' | 'malformed', message: string) {
    super(message)
    this.name = 'TransportError'
    this.kind = kind
  }
}

/** The success envelope every route answers with. */
interface Envelope {
  readonly success?: unknown
  readonly data?: unknown
  readonly error?: { readonly code?: unknown; readonly message?: unknown }
}

/**
 * Call one fenced route and unwrap its envelope.
 * @param path - the fenced pathname.
 * @param init - fetch options.
 * @returns the `data` payload.
 */
async function call(path: string, init: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(path, { credentials: 'same-origin', ...init })
  } catch (error) {
    throw new TransportError('unreachable', error instanceof Error ? error.message : String(error))
  }
  let body: Envelope | undefined
  try {
    body = await response.json() as Envelope
  } catch {
    body = undefined
  }
  if (!response.ok || body?.success !== true) {
    const message = typeof body?.error?.message === 'string'
      ? body.error.message
      : `the Host answered ${String(response.status)}`
    throw new TransportError('refused', message)
  }
  if (typeof body.data !== 'object' || body.data === null) {
    throw new TransportError('malformed', `${path} answered without a data payload`)
  }
  return body.data
}

/** Narrow one payload to a map, or fail. */
function toMap(value: unknown): MapPayload {
  const candidate = value as Partial<MapPayload> | undefined
  if (candidate === undefined || typeof candidate.sessions !== 'object' || candidate.sessions === null
    || !Array.isArray(candidate.groups) || !Array.isArray(candidate.candidates)
    || typeof candidate.unknownLabel !== 'string' || typeof candidate.backfill !== 'object') {
    throw new TransportError('malformed', `${MAP_PATH} answered without a usable map`)
  }
  return candidate as MapPayload
}

/**
 * Read the map.
 * @returns the current map.
 */
export async function readMap(): Promise<MapPayload> {
  return toMap(await call(MAP_PATH, { method: 'GET' }))
}

/**
 * Apply one write and take the map it answers with.
 * @param body - the assignment or group operation.
 * @returns the map as it stands after the write.
 */
export async function mutate(body: MutateRequest): Promise<MapPayload> {
  const data = await call(MUTATE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return toMap((data as { map?: unknown }).map)
}

/**
 * Create one group.
 *
 * Separate from {@link mutate} because the created record lives in this
 * response's own payload: the assignment that follows must name a group that
 * exists, so the id is read here and the map is folded here too.
 * @param input - owning workspace and group name.
 * @returns the created group's id and the map as it stands after the write.
 */
export async function createGroup(input: {
  readonly workspace: string
  readonly name: string
}): Promise<{ readonly id: string; readonly map: MapPayload }> {
  const data = await call(MUTATE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'group.create', workspace: input.workspace, name: input.name }),
  })
  const id = (data as { group?: { id?: unknown } }).group?.id
  if (typeof id !== 'string' || id === '') {
    throw new TransportError('malformed', `${MUTATE_PATH} answered without the created group`)
  }
  return { id, map: toMap((data as { map?: unknown }).map) }
}

/**
 * Drive the backfill.
 * @param action - start a pass, or read its progress.
 * @returns the progress and the map as it stands.
 */
export async function backfill(action: 'start' | 'status'): Promise<{ readonly backfill: BackfillStatus; readonly map: MapPayload }> {
  const data = await call(BACKFILL_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  const status = (data as { backfill?: unknown }).backfill
  if (typeof status !== 'object' || status === null) {
    throw new TransportError('malformed', `${BACKFILL_PATH} answered without progress`)
  }
  return { backfill: status as BackfillStatus, map: toMap((data as { map?: unknown }).map) }
}
