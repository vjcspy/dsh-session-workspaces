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
 * @module dsh-session-workspaces/client/provider
 */

import type { MapPayload } from '../wire.ts'
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

/**
 * The slice of the seam this half uses.
 *
 * Declared structurally instead of importing the seam's own types: this package's
 * `./client` entry does not re-export the service's declaration, so what crosses
 * the boundary is the one method this plugin calls.
 */
export interface GroupingSeam {
  /** @param provider - identity plus its Session-to-path rule. @returns its disposer. */
  register(provider: {
    readonly id: string
    readonly resolve: (session: { readonly id: unknown }) => readonly GroupingElement[] | undefined
  }): () => void
}

/** The map state the provider answers from. */
export interface GroupingSourceStore {
  /** The last map, or undefined before the first. */
  payload(): MapPayload | undefined
  /** @param listener - called after the map changes. @returns the disposer. */
  subscribe(listener: () => void): () => void
}

/** One live registration. */
export interface GroupingRegistration {
  /** Remove both registrations and stop observing the store. */
  dispose(): void
}

/**
 * Register the provider and its revision lever, and keep the tree in step with
 * the map.
 * @param input - the seam, the map store, and the provider id to register under.
 * @returns the live registration.
 */
export function registerGroupingProvider(input: {
  readonly seam: GroupingSeam
  readonly store: GroupingSourceStore
  readonly providerId: string
}): GroupingRegistration {
  const { seam, store } = input
  const provider = {
    id: input.providerId,
    resolve: (session: { readonly id: unknown }): readonly GroupingElement[] | undefined =>
      resolveGroupingPath(store.payload(), String(session.id)),
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
