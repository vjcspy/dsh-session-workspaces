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
  // A live group is a Human placement and carries its own workspace, so the ROOT
  // row comes from the group rather than from the placement: a placement whose
  // workspace is the undecided sentinel still renders where its group lives, and
  // the sentinel rule below never swallows a real grouping. A dangling group
  // reference cannot reach here — the host resolves it at read time — but a group
  // deleted between two polls can, and the honest answer is the workspace level
  // rather than a row with no label.
  const group = placement.group === undefined
    ? undefined
    : map.groups.find(candidate => candidate.id === placement.group)
  if (group !== undefined) {
    return [
      { key: workspaceKey(group.workspace), label: group.workspace },
      { key: group.id, label: group.name, order: group.order },
    ]
  }
  // The undecided sentinel is not a row of its own. A Session the classifier
  // could not decide leaves the plugin grouping exactly like an unclassified
  // one, so it lands where dsh itself puts an unclaimed Session — the core
  // Workspace grouping — instead of inventing an `unknown workspace` row. The
  // label is read from the payload this Session was placed by, never a literal.
  if (placement.workspace === map.unknownLabel) return undefined
  return [{ key: workspaceKey(placement.workspace), label: placement.workspace }]
}

/**
 * The workspace the "New group" flow may default to for one Session.
 *
 * The undecided sentinel is not a workspace a group can live in: the flow
 * inherits the placement's workspace, so on an undecided Session it would
 * inherit the sentinel, create a group there, and recreate the very
 * `unknown workspace` root row this grouping no longer serves. The Host refuses
 * that write too, and this is what keeps the refusal unreachable in normal use.
 * @param map - the last map read, or undefined before the first.
 * @param sessionId - the Session the menu belongs to.
 * @returns the default target, or undefined to require an explicit choice.
 */
export function newGroupTarget(map: MapPayload | undefined, sessionId: string): string | undefined {
  const workspace = map?.sessions[sessionId]?.workspace
  if (workspace === undefined) return undefined
  return workspace === map?.unknownLabel ? undefined : workspace
}
