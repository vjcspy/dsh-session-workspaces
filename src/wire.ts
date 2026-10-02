/**
 * The plugin's wire vocabulary: the durable record shapes and every payload
 * that crosses the fenced `/api` channel.
 *
 * Both halves import this module, so a change to a payload shape is a compile
 * error on the producing AND the consuming side instead of a runtime surprise.
 * Record shapes here are the authoritative ones: the zod schemas in
 * `host/domain.ts` derive from them and validate every read and write.
 *
 * @module dsh-session-workspaces/wire
 */

import type { TitleProviderStatus } from './host/title-provider.ts'

/** One Session's classification, as the model decided it. */
export interface LabelRecord {
  /** The accepted workspace label, verbatim. */
  readonly workspace: string
  /** Confidence the model reported, kept for diagnostics. */
  readonly confidence: number
  /** ISO instant the label was recorded. */
  readonly decidedAt: string
}

/**
 * One plugin-owned group.
 *
 * The group carries its own workspace: a group belongs to exactly one
 * workspace, which is what makes "move this Session into a group owned by
 * another workspace" a single unambiguous write.
 */
export interface GroupRecord {
  /** Group id: opaque, stable across renames, and safe inside a grouping key. */
  readonly id: string
  /** Label shown verbatim in the tree and in the sidebar menu. */
  readonly name: string
  /** The workspace label this group belongs to. */
  readonly workspace: string
  /** ISO instant the group was created. */
  readonly createdAt: string
  /** Ascending sibling position among the groups of one workspace. */
  readonly order: number
}

/**
 * One Human assignment — and therefore the pin.
 *
 * A pin's presence is the whole override contract: it wins over the classifier's
 * label, it is never re-decided, and it carries the workspace explicitly so a
 * dangling group reference still renders at workspace level.
 */
export interface PinRecord {
  /** Workspace label the Session was moved to. */
  readonly workspace: string
  /** Group id the Session was moved into, when the assignment names one. */
  readonly group?: string | undefined
  /** ISO instant the Human made the assignment. */
  readonly pinnedAt: string
}

/** One Session's effective placement, after the pin over the label and dangling-group resolution. */
export interface SessionPlacement {
  /** Workspace label the sidebar shows as the Session's top-level row. */
  readonly workspace: string
  /** Group id the Session sits in, or absent when it sits at workspace level. */
  readonly group?: string | undefined
  /** True when a Human assignment set this placement. */
  readonly pinned: boolean
}

/** Progress of the opt-in backfill, as the settings section reports it. */
export interface BackfillStatus {
  /** True while a backfill pass is walking the corpus. */
  readonly running: boolean
  /** How many Sessions the last pass decided to consider. */
  readonly total: number
  /**
   * How many stored top-level Sessions are still undecided, sampled by the host.
   *
   * This is the cost the settings section states before a pass starts: one model
   * call per undecided Session.
   */
  readonly pending: number
  /** How many of those it has finished (classified, skipped or failed). */
  readonly done: number
  /** How many Sessions it recorded a label for. */
  readonly classified: number
  /** How many Sessions it could not classify (no route, provider error, malformed answer). */
  readonly failed: number
  /** How many it skipped because they were already classified or pinned. */
  readonly skipped: number
  /** ISO instant the last pass started, when one has. */
  readonly startedAt?: string | undefined
  /** ISO instant the last pass finished, when one has. */
  readonly finishedAt?: string | undefined
  /** The last failure's reason, for the settings section to show. */
  readonly lastError?: string | undefined
}

/** One advertised route: a provider and one model that provider advertises. */
export interface CatalogRoute {
  /** Provider route key, verbatim as the adapter registers it. */
  readonly provider: string
  /** Model id, verbatim as the adapter advertises it. */
  readonly model: string
}

/** One provider whose models could not be enumerated. */
export interface CatalogFailure {
  /** Provider route key that failed. */
  readonly provider: string
  /** Why it failed, for the settings control's hint. */
  readonly message: string
}

/**
 * One catalog read: every `provider`/`model` pair the LLM directory advertises.
 *
 * The settings control builds its options from this, so the payload describes its
 * own incompleteness: `routes` may be empty or partial, `failed` names the
 * providers that could not be enumerated, and `error` is set when the directory
 * could not even be listed — and the browser keeps whatever route it already had
 * in every one of those cases.
 */
export interface CatalogPayload {
  /** Every advertised pair, in provider registration order, then adapter order. */
  readonly routes: readonly CatalogRoute[]
  /** Providers whose models could not be enumerated; the catalog is then partial. */
  readonly failed: readonly CatalogFailure[]
  /** Set when the whole read failed, so an empty `routes` has a reason. */
  readonly error?: string | undefined
  /** ISO instant the payload was sampled. */
  readonly sampledAt: string
}

/** One map read: everything the browser half needs to group and to offer the menu. */
export interface MapPayload {
  /** Effective placement per Session id. A Session absent here is unclassified. */
  readonly sessions: Readonly<Record<string, SessionPlacement>>
  /** Every plugin-owned group record, in render order. */
  readonly groups: readonly GroupRecord[]
  /**
   * The closed candidate label set: the directories discovered under the
   * workspaces root, plus the configured list, plus the unknown label. This is
   * the set the sidebar's "Move to workspace…" chooser offers, and the set the
   * classifier prompt is built over.
   */
  readonly candidates: readonly string[]
  /** Label recorded for an undecidable answer. */
  readonly unknownLabel: string
  /** Backfill progress. */
  readonly backfill: BackfillStatus
  /**
   * Whether this plugin owns the Conversation title on this host.
   *
   * `unavailable` means the core `sessionTitle` service already had a provider
   * when this plugin asked — in practice the shipped `session-title-llm` row
   * still being enabled — so titles come from that provider. It is published here
   * because a successful boot has no visible log sink for the plugin's own
   * `warn`, so a misconfigured profile would otherwise fail silently.
   */
  readonly titleProvider: TitleProviderStatus
}

/** One group operation the fenced write route accepts. */
export type GroupOperation =
  | { readonly op: 'group.create'; readonly workspace: string; readonly name: string }
  | { readonly op: 'group.rename'; readonly group: string; readonly name: string }
  | { readonly op: 'group.delete'; readonly group: string }
  | { readonly op: 'group.removeMember'; readonly sessionId: string; readonly workspace: string }

/** One Session assignment the fenced write route accepts. */
export interface AssignmentRequest {
  readonly sessionId: string
  readonly workspace: string
  /** When present the group decides the workspace, so both move in one write. */
  readonly group?: string | undefined
}

/** The fenced write route's request: an assignment, or one group operation. */
export type MutateRequest = AssignmentRequest | GroupOperation

/** The fenced write route's answer. */
export interface MutateResult {
  /** The map as it stands after the write, so the caller needs no second round trip. */
  readonly map: MapPayload
}

/** Narrow one parsed JSON body to a group operation. */
export function isGroupOperation(body: MutateRequest): body is GroupOperation {
  return 'op' in body
}
