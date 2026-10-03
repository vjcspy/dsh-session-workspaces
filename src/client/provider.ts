/**
 * Registration of the browser half's grouping provider into the client seam.
 *
 * Two registrations, not one, and the reason is a subtlety of the seam:
 *
 * - The **real provider** is registered ONCE and never disposed. Its group keys
 *   are what the sidebar's view store retains: on every ready render the store
 *   prunes its persisted expansion and manual-order entries down to the keys the
 *   current derivation produced. A provider that is momentarily absent — the
 *   window a dispose-then-register pair opens — produces no rows for that render,
 *   and the Human's collapsed state and manual order are discarded before the
 *   re-registration can restore them. Measured on a reload and on every map
 *   change before this split.
 * - The **revision lever** is a second provider that claims no Session. The seam
 *   recomputes the tree when a REGISTRATION changes, not when a provider's data
 *   changes, so a changed map needs a registration event; re-registering the
 *   lever moves the seam's revision without ever removing the rows the retention
 *   set depends on.
 *
 * The real provider also declares the seam's drop handler, which is what makes
 * one of its rows a drop target at all: the seam routes a drop onto a provider
 * row to that provider, and a drop onto a CORE row back to the provider the
 * Session came from. The lever declares no handler, and a drop it owned would be
 * refused rather than reported as done — exactly the seam's rule.
 *
 * @module dsh-session-workspaces/client/provider
 */

import type { AssignmentRequest, MapPayload } from '../wire.ts'
import { resolveGroupingPath } from './grouping.ts'

/** One level of the path the seam consumes. */
export interface GroupingElement {
  /** Provider-local row identity, free of `:`. */
  readonly key: string
  /** Row label, rendered verbatim. */
  readonly label: string
  /** Ascending sibling position; omitted sorts as `0`, ties by key. */
  readonly order?: number
}

/** One row identity as a drop event reports it. */
export interface GroupingRowIdentity {
  /** The row's key: this provider's namespaced row key, or a core row's own key. */
  readonly key: string
  /** The provider that contributed the row; absent on a Workspace row and on the ungrouped bucket. */
  readonly providerId?: string | undefined
  /** The row's rendered label; absent when the caller holds only the key. */
  readonly label?: string | undefined
}

/** One Session dropped from one row onto another. */
export interface GroupingRowDrop {
  /** The dropped Session. */
  readonly sessionId: string
  /** The row the drag started in. */
  readonly source: GroupingRowIdentity
  /** The row the pointer was released on. */
  readonly target: GroupingRowIdentity
}

/**
 * The slice of the seam this half uses.
 *
 * Declared structurally instead of importing the seam's own types: this package's
 * `./client` entry does not re-export the service's declaration, so what crosses
 * the boundary is what this plugin calls — `register`, with the three members a
 * provider may declare. No member is optional in the seam itself except the drop
 * handler, so a provider that omits it is registered and simply never receives a
 * move.
 */
export interface GroupingSeam {
  /** @param provider - identity, its Session-to-path rule, and its drop handler. @returns its disposer. */
  register(provider: {
    readonly id: string
    readonly resolve: (session: { readonly id: unknown }) => readonly GroupingElement[] | undefined
    readonly drop?: (event: GroupingRowDrop) => void
  }): () => void
}

/** The map state the provider answers from. */
export interface GroupingSourceStore {
  /** The last map, or undefined before the first. */
  payload(): MapPayload | undefined
  /** @param listener - called after the map changes. @returns the disposer. */
  subscribe(listener: () => void): () => void
}

/**
 * The fenced write a drop posts through.
 *
 * One method, because a drop produces exactly one write: the assignment is the
 * plugin's existing Human-placement record, and the store shows it over the
 * current map until the Host answers.
 */
export interface GroupingWritePort {
  /** @param request - the assignment the drop asks for. */
  assign(request: AssignmentRequest): Promise<void>
}

/** One live registration. */
export interface GroupingRegistration {
  /** Remove both registrations and stop observing the store. */
  dispose(): void
}

/**
 * The path one of this provider's row keys carries.
 *
 * The seam namespaces a provider row as `<providerId>:<root key>[:<child key>]`,
 * so stripping the prefix leaves the provider-local path. A key under another
 * provider, or one that carries no level at all, is not this provider's row.
 * @param key - the namespaced row key from the drop event.
 * @param providerId - this provider's id.
 * @returns the provider-local path elements, or undefined for a foreign key.
 */
function localPath(key: string, providerId: string): readonly string[] | undefined {
  const prefix = `${providerId}:`
  if (!key.startsWith(prefix)) return undefined
  const path = key.slice(prefix.length).split(':')
  return path.some(element => element === '') ? undefined : path
}

/**
 * The assignment one drop asks for, or undefined when this provider does not own
 * the move — which the seam has already refused before the Session was released.
 *
 * Two shapes arrive. A drop onto a row this provider contributed — a workspace
 * root row, or one of its group rows — is a move into that row. A drop onto a
 * CORE row from a Session this provider had claimed is a **release**: the seam
 * routes it to the source's provider because no provider stands behind a core
 * row, and the release posts the undecided sentinel as the workspace with no
 * group. The Session therefore stays decided — nothing re-classifies it, so no
 * second model call — while the sentinel rule hands it back to the core
 * Workspace grouping.
 *
 * @param input - the drop event, this provider's id, and the current map.
 * @returns the fenced write to post, or undefined to refuse the move.
 */
export function dropAssignment(input: {
  readonly event: GroupingRowDrop
  readonly providerId: string
  readonly map: MapPayload | undefined
}): AssignmentRequest | undefined {
  const { event, providerId, map } = input
  if (map === undefined) return undefined
  if (event.target.providerId === providerId) {
    const path = localPath(event.target.key, providerId)
    if (path === undefined) return undefined
    if (path.length === 1) {
      // A root row is a workspace, and its LABEL is the workspace name: the key
      // is sanitized by construction and therefore lossy, so the label is what
      // the write must carry.
      return event.target.label === undefined
        ? undefined
        : { sessionId: event.sessionId, workspace: event.target.label }
    }
    // A group row: the group record owns the exact workspace, and naming it is
    // what keeps the move inside the group rather than at a sanitized root.
    const group = map.groups.find(candidate => candidate.id === path[path.length - 1])
    return group === undefined
      ? undefined
      : { sessionId: event.sessionId, workspace: group.workspace, group: group.id }
  }
  // Not a row of this provider: the only move left is the release of a Session
  // this provider had claimed, onto a row nothing behind it can own.
  if (event.target.providerId !== undefined || event.source.providerId !== providerId) return undefined
  return { sessionId: event.sessionId, workspace: map.unknownLabel }
}

/**
 * Post one drop through the fenced write.
 *
 * The write is fire-and-forget because the seam's drop is synchronous and its
 * own refusal was already reported as a `dropEffect` of `none`; a write the Host
 * refuses rolls the optimistic placement back in the store, so the row snaps
 * back and the reason is logged rather than swallowed.
 * @param input - the write port, the log sink, this provider's id, the map store and the event.
 */
function applyDrop(input: {
  readonly write: GroupingWritePort
  readonly log: ((message: string) => void) | undefined
  readonly providerId: string
  readonly store: GroupingSourceStore
  readonly event: GroupingRowDrop
}): void {
  const request = dropAssignment({
    event: input.event,
    providerId: input.providerId,
    map: input.store.payload(),
  })
  if (request === undefined) return
  void input.write.assign(request).catch((error: unknown) => {
    input.log?.(`${input.providerId}: the drop of ${request.sessionId} was refused (${error instanceof Error ? error.message : String(error)})`)
  })
}

/**
 * Register the provider and its revision lever, and keep the tree in step with
 * the map.
 * @param input - the seam, the map store, the provider id, and the drop wiring.
 * @returns the live registration.
 */
export function registerGroupingProvider(input: {
  readonly seam: GroupingSeam
  readonly store: GroupingSourceStore
  readonly providerId: string
  /** The fenced write a drop posts through; without it no drop is claimed. */
  readonly write?: GroupingWritePort | undefined
  /** Where a refused write is reported; the rollback is visible without it. */
  readonly log?: ((message: string) => void) | undefined
}): GroupingRegistration {
  const { seam, store, write, log } = input
  const provider = {
    id: input.providerId,
    resolve: (session: { readonly id: unknown }): readonly GroupingElement[] | undefined =>
      resolveGroupingPath(store.payload(), String(session.id)),
    // Declared only when a write port exists: the seam refuses a provider that
    // declares no handler, so a drop nobody can apply is never reported as done.
    ...(write === undefined ? {} : {
      drop: (event: GroupingRowDrop): void => {
        applyDrop({ write, log, providerId: input.providerId, store, event })
      },
    }),
  }
  // Claims nothing, and therefore contributes no row and no key: it exists only
  // to move the seam's revision when the map changes.
  const lever = {
    id: `${input.providerId}-revision`,
    resolve: (): readonly GroupingElement[] | undefined => undefined,
  }
  const disposeProvider = seam.register(provider)
  let disposeLever = seam.register(lever)
  const unsubscribe = store.subscribe(() => {
    disposeLever()
    disposeLever = seam.register(lever)
  })
  return {
    dispose: () => {
      unsubscribe()
      disposeLever()
      disposeProvider()
    },
  }
}
