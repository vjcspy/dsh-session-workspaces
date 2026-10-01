/**
 * The pure half of the browser-side grouping provider: map → root-to-leaf path.
 *
 * A provider answers one question — which group rows own this Session — as a path
 * root first, and the seam turns that into the sidebar's rows. Two of the seam's
 * rules are enforced here rather than discovered at runtime:
 *
 * - A row key may not contain `:`, because the seam namespaces keys by joining
 *   the provider path with `:`. A workspace label comes from a directory name and
 *   is rendered verbatim, so the KEY is sanitized while the LABEL stays exact.
 * - An unclaimed Session answers `undefined`, which leaves it on the core
 *   Workspace grouping. That is also what an unclassified Session answers, so a
 *   partially classified list stays coherent instead of jumping.
 *
 * @module dsh-session-workspaces/client/grouping
 */

import type { MapPayload } from '../wire.ts'

/** One level of the path the seam consumes. */
export interface GroupingElement {
  /** Provider-local row identity, free of `:`. */
  readonly key: string
  /** Row label, rendered verbatim. */
  readonly label: string
  /** Ascending sibling position; omitted sorts as `0`, ties by key. */
  readonly order?: number
}

/** Fallback key for a label that sanitizes away to nothing. */
const EMPTY_KEY = 'workspace'

/**
 * The row key of one workspace label.
 *
 * The label stays verbatim in the tree; only this key is normalized, because a
 * key is joined into a namespaced path and an unescaped `:` would make the seam
 * drop the whole level.
 * @param label - the workspace label.
 * @returns a key with no `:` and at least one character.
 */
export function workspaceKey(label: string): string {
  const cleaned = label
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned === '' ? EMPTY_KEY : cleaned
}

/**
 * Resolve one Session's grouping path.
 * @param map - the last map read, or undefined before the first.
 * @param sessionId - the Session to place.
 * @returns the path, or undefined to leave the Session on the core grouping.
 */
export function resolveGroupingPath(
  map: MapPayload | undefined,
  sessionId: string,
): readonly GroupingElement[] | undefined {
  if (map === undefined) return undefined
  const placement = map.sessions[sessionId]
  if (placement === undefined) return undefined
  const root: GroupingElement = { key: workspaceKey(placement.workspace), label: placement.workspace }
  if (placement.group === undefined) return [root]
  const group = map.groups.find(candidate => candidate.id === placement.group)
  // A dangling group reference cannot reach here — the host resolves it at read
  // time — but a group deleted between two polls can, and the honest answer is
  // the workspace level rather than a row with no label.
  if (group === undefined) return [root]
  return [root, { key: group.id, label: group.name, order: group.order }]
}
