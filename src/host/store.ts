/**
 * The durable store: the only module that touches the domain tables.
 *
 * Two rules from the storage contract shape every write here:
 *
 * 1. **A key's first write is `put`, later writes are `update`.** `update` is an
 *    atomic read-modify-write but rejects a missing record with `missing-key`, so
 *    a blind `update` on a fresh Session loses the write. {@link WorkspaceStore}
 *    therefore reads, then chooses — and falls back to `put` when the record
 *    disappeared between the read and the write (a concurrent delete on the same
 *    key), which is the only way `update` can lose that race.
 * 2. **A dangling group reference resolves at READ time.** Deleting a group is
 *    one atomic `delete` and renaming it is one `put`; nothing sweeps member
 *    records. An assignment whose group no longer exists simply renders at
 *    workspace level, and recreating a group with the same id would resurrect the
 *    membership — which is why group ids are opaque and never reused.
 *
 * Every table access goes through {@link KvTableLike}, which the real
 * `Domain.table(...)` handle satisfies structurally: the store's unit tests
 * drive it with an in-memory double instead of a live storage backend, and the
 * adapter {@link attachDomain} is the single place the real handle is bound.
 *
 * @module dsh-session-workspaces/host/store
 */

import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { sessionWorkspacesDomain } from './domain.ts'
import type {
  BackfillStatus, GroupRecord, LabelRecord, MapPayload, PinRecord, SessionPlacement,
} from '../wire.ts'

/**
 * The slice of one kv table this store uses.
 *
 * `@deepseek-ai/dsh-storage-domain`'s `KvTable` satisfies it structurally; the
 * remaining methods (`keys`, …) are unused here.
 */
export interface KvTableLike<V> {
  /** Synchronous in-memory read. */
  get(key: string): V | undefined
  /** Snapshot iterator over every record. */
  entries(): IterableIterator<[string, V]>
  /** Record count. */
  readonly size: number
  /** Create a record; the caller has established the key is absent. */
  put(key: string, value: V): Promise<void>
  /** Remove a record; a missing key resolves `false` and writes nothing. */
  delete(key: string): Promise<boolean>
  /** Atomic read-modify-write; rejects a missing key with `missing-key`. */
  update(key: string, fn: (current: V) => V): Promise<V>
}

/** The three tables this plugin owns, plus the handle that closes them. */
export interface StoreDomain {
  readonly labels: KvTableLike<LabelRecord>
  readonly groups: KvTableLike<GroupRecord>
  readonly pins: KvTableLike<PinRecord>
  /** Release the unit. The caller owns the handle. */
  close(): Promise<void>
}

/**
 * Bind the real storage handle to the store's table shape.
 * @param domain - the opened unit.
 * @returns the tables the store reads and writes.
 */
export function attachDomain(domain: Domain<typeof sessionWorkspacesDomain>): StoreDomain {
  return {
    labels: domain.table('labels'),
    groups: domain.table('groups'),
    pins: domain.table('pins'),
    close: async () => { await domain.close() },
  }
}

/** The facility slice this plugin opens through. */
export interface DomainFacilityLike {
  open(spec: typeof sessionWorkspacesDomain): Promise<Domain<typeof sessionWorkspacesDomain>>
}

/**
 * Open the plugin's unit and wrap it.
 *
 * A second `open` of the same name while the first handle is live rejects with
 * `already-open`, and this function does not swallow it: the caller must see
 * that two live handles would fight over one unit.
 * @param facility - `ctx.storageDomain`.
 * @param options - clock and id factory overrides, for tests.
 * @returns the store, whose `close()` releases the unit.
 */
export async function openStore(
  facility: DomainFacilityLike,
  options: StoreOptions = {},
): Promise<WorkspaceStore> {
  return new WorkspaceStore(attachDomain(await facility.open(sessionWorkspacesDomain)), options)
}

/** Injectable time and identity, so a spec can assert exact records. */
export interface StoreOptions {
  /** Current instant as an ISO string. */
  readonly now?: () => string
  /** Fresh group id. */
  readonly newId?: () => string
}

/** The store's own view: effective placements plus every write this process made. */
export class WorkspaceStore {
  private readonly domain: StoreDomain
  private readonly now: () => string
  private readonly newId: () => string
  private writes = 0

  /**
   * @param domain - the opened unit's tables.
   * @param options - clock and id factory overrides.
   */
  constructor(domain: StoreDomain, options: StoreOptions = {}) {
    this.domain = domain
    this.now = options.now ?? (() => new Date().toISOString())
    this.newId = options.newId ?? (() => crypto.randomUUID())
  }

  /** Monotonic count of writes this process made, for the browser's poll comparison. */
  revision(): number {
    return this.writes
  }

  /** One Session's classification, when the model recorded one. */
  labelOf(sessionId: string): LabelRecord | undefined {
    return this.domain.labels.get(sessionId)
  }

  /** One Session's Human assignment, when one was made. Its presence is the pin. */
  pinOf(sessionId: string): PinRecord | undefined {
    return this.domain.pins.get(sessionId)
  }

  /** Whether a Human assignment pins this Session against reclassification. */
  isPinned(sessionId: string): boolean {
    return this.domain.pins.get(sessionId) !== undefined
  }

  /** Whether any record already decides this Session. */
  isDecided(sessionId: string): boolean {
    return this.domain.pins.get(sessionId) !== undefined || this.domain.labels.get(sessionId) !== undefined
  }

  /** One group record. */
  group(groupId: string): GroupRecord | undefined {
    return this.domain.groups.get(groupId)
  }

  /** Every group, in render order. */
  groupsInOrder(): GroupRecord[] {
    return [...this.domain.groups.entries()]
      .map(entry => entry[1])
      .sort((left, right) => left.order - right.order || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  }

  /**
   * The effective placement of one Session: the pin over the label, with a
   * group that no longer exists dropped so the Session renders at workspace
   * level.
   * @param sessionId - Session to place.
   * @returns its placement, or undefined when nothing has decided it.
   */
  placementOf(sessionId: string): SessionPlacement | undefined {
    const pin = this.domain.pins.get(sessionId)
    const label = this.domain.labels.get(sessionId)
    const workspace = pin?.workspace ?? label?.workspace
    if (workspace === undefined) return undefined
    const pinned = pin !== undefined
    const group = pin?.group
    if (group !== undefined && this.domain.groups.get(group) !== undefined) {
      return { workspace, group, pinned }
    }
    return { workspace, pinned }
  }

  /**
   * Every decided Session's placement, keyed by Session id.
   * @returns the placement map a map read publishes.
   */
  placements(): Map<string, SessionPlacement> {
    const placed = new Map<string, SessionPlacement>()
    for (const sessionId of this.decidedSessionIds()) {
      const placement = this.placementOf(sessionId)
      if (placement !== undefined) placed.set(sessionId, placement)
    }
    return placed
  }

  /**
   * Record the classifier's answer for one Session.
   *
   * A pinned Session is never reclassified: this is the single place that rule
   * is enforced, and it returns without writing.
   * @param sessionId - Session the label belongs to.
   * @param workspace - accepted label.
   * @param confidence - the confidence the answer carried.
   * @returns true when a record was written.
   */
  async recordLabel(sessionId: string, workspace: string, confidence: number): Promise<boolean> {
    if (this.isPinned(sessionId)) return false
    const decidedAt = this.now()
    await this.upsert(this.domain.labels, sessionId, () => ({ workspace, confidence, decidedAt }))
    return true
  }

  /**
   * Move one Session, and pin it against every later automatic decision.
   *
   * A named group decides the workspace, because the group record carries its
   * own: moving a Session into a group owned by another workspace therefore
   * moves both in this one write.
   * @param input - the Session, the target group (when any), and the fallback workspace.
   * @returns the placement as stored, or undefined when the group does not exist.
   */
  async assign(input: {
    readonly sessionId: string
    readonly workspace: string
    readonly group?: string | undefined
  }): Promise<SessionPlacement | undefined> {
    let workspace = input.workspace
    if (input.group !== undefined) {
      const group = this.domain.groups.get(input.group)
      if (group === undefined) return undefined
      workspace = group.workspace
    }
    const pinnedAt = this.now()
    const record: PinRecord = input.group === undefined
      ? { workspace, pinnedAt }
      : { workspace, group: input.group, pinnedAt }
    await this.upsert(this.domain.pins, input.sessionId, () => record)
    return input.group === undefined ? { workspace, pinned: true } : { workspace, group: input.group, pinned: true }
  }

  /**
   * Return one Session to the workspace level, keeping it pinned.
   * @param sessionId - Session to unpin from its group.
   * @param workspace - workspace to leave it in.
   */
  async removeMember(sessionId: string, workspace: string): Promise<void> {
    await this.assign({ sessionId, workspace })
  }

  /**
   * Create one group inside a workspace.
   * @param input - the owning workspace and the group's label.
   * @returns the created record.
   */
  async createGroup(input: { readonly workspace: string; readonly name: string }): Promise<GroupRecord> {
    const record: GroupRecord = {
      id: this.newId(),
      name: input.name,
      workspace: input.workspace,
      createdAt: this.now(),
      order: this.domain.groups.size,
    }
    await this.upsert(this.domain.groups, record.id, () => record)
    return record
  }

  /**
   * Relabel one group without touching its members.
   *
   * A rename is one `put`: the id — which is what member records and grouping
   * keys point at — does not change, so expansion state and membership survive.
   * @param groupId - group to rename.
   * @param name - the new label.
   * @returns the stored record, or undefined when the group does not exist.
   */
  async renameGroup(groupId: string, name: string): Promise<GroupRecord | undefined> {
    const current = this.domain.groups.get(groupId)
    if (current === undefined) return undefined
    const next: GroupRecord = { ...current, name }
    await this.upsert(this.domain.groups, groupId, () => next)
    return next
  }

  /**
   * Delete one group.
   *
   * One atomic `delete`; members are not swept. Their assignment keeps pointing
   * at the id, and {@link placementOf} stops resolving it, so they render at
   * workspace level.
   * @param groupId - group to delete.
   * @returns true when a record was removed.
   */
  async deleteGroup(groupId: string): Promise<boolean> {
    const removed = await this.domain.groups.delete(groupId)
    if (removed) this.writes += 1
    return removed
  }

  /**
   * The payload one map read publishes.
   * @param input - candidate set, unknown label and backfill progress.
   * @returns the map.
   */
  snapshot(input: {
    readonly candidates: readonly string[]
    readonly unknownLabel: string
    readonly backfill: BackfillStatus
  }): MapPayload {
    const sessions: Record<string, SessionPlacement> = {}
    for (const [sessionId, placement] of this.placements()) sessions[sessionId] = placement
    return {
      sessions,
      groups: this.groupsInOrder(),
      candidates: [...input.candidates],
      unknownLabel: input.unknownLabel,
      backfill: input.backfill,
    }
  }

  /** Release the unit. */
  async close(): Promise<void> {
    await this.domain.close()
  }

  /** Every Session id either table mentions. */
  private decidedSessionIds(): Set<string> {
    const ids = new Set<string>()
    for (const [sessionId] of this.domain.pins.entries()) ids.add(sessionId)
    for (const [sessionId] of this.domain.labels.entries()) ids.add(sessionId)
    return ids
  }

  /**
   * Write one record as `put` when the key is fresh and `update` when it is not.
   * @param table - the table to write.
   * @param key - record key.
   * @param build - the next value, given the current one.
   * @returns the stored value.
   */
  private async upsert<T>(
    table: KvTableLike<T>,
    key: string,
    build: (current: T | undefined) => T,
  ): Promise<T> {
    const current = table.get(key)
    const value = build(current)
    if (current === undefined) {
      await table.put(key, value)
    } else {
      try {
        await table.update(key, () => value)
      } catch (error) {
        // The record vanished between the read and the write. `update` refuses a
        // missing key, and the correct repair is the first write of a new record.
        if (!isMissingKey(error)) throw error
        await table.put(key, value)
      }
    }
    this.writes += 1
    return value
  }
}

/**
 * Whether a rejection is the storage layer's `missing-key` refusal.
 *
 * Checked structurally rather than with `instanceof`: the error crosses the
 * domain facility, and a duplicate module instance would break identity.
 * @param error - the caught value.
 * @returns true for `DomainError('missing-key', …)`.
 */
function isMissingKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'missing-key'
}
