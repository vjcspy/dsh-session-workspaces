/**
 * An in-memory stand-in for the opened storage unit.
 *
 * It reproduces the two behaviours this plugin's store depends on and nothing
 * else: `update` rejects an absent key with the `missing-key` code the domain
 * layer uses, and a facility rejects a second `open` of a live name with
 * `already-open`. Both are contracts the plugin must honour, so a spec drives
 * them here instead of against a real medium.
 *
 * @module dsh-session-workspaces/test/support/fake-domain
 */

import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { KvTableLike, StoreDomain } from '../../src/host/store.ts'
import type { GroupRecord, LabelRecord, PinRecord } from '../../src/wire.ts'
import { sessionWorkspacesDomain } from '../../src/host/domain.ts'

/** The rejection the domain layer uses for an absent key. */
export function missingKey(key: string): Error & { code: string } {
  const error = new Error(`table has no record '${key}' to update`) as Error & { code: string }
  error.code = 'missing-key'
  return error
}

/** One table, over a Map, recording every write in order. */
export class FakeTable<V> implements KvTableLike<V> {
  /** Stored records. */
  readonly records = new Map<string, V>()
  /** Write trace, as `put:<key>` / `update:<key>` / `delete:<key>`. */
  readonly writes: string[] = []

  /** @returns the record, or undefined. */
  get(key: string): V | undefined {
    return this.records.get(key)
  }

  /** @returns every record. */
  entries(): IterableIterator<[string, V]> {
    return this.records.entries()
  }

  /** @returns the record count. */
  get size(): number {
    return this.records.size
  }

  /** @param key - record key. @param value - record value. */
  async put(key: string, value: V): Promise<void> {
    this.writes.push(`put:${key}`)
    this.records.set(key, value)
  }

  /** @param key - record key. @returns whether a record was removed. */
  async delete(key: string): Promise<boolean> {
    this.writes.push(`delete:${key}`)
    return this.records.delete(key)
  }

  /**
   * @param key - record key.
   * @param fn - the read-modify-write.
   * @returns the stored value.
   * @throws with `code: 'missing-key'` when the record is absent.
   */
  async update(key: string, fn: (current: V) => V): Promise<V> {
    this.writes.push(`update:${key}`)
    const current = this.records.get(key)
    if (current === undefined) throw missingKey(key)
    const next = fn(current)
    this.records.set(key, next)
    return next
  }
}

/** The three tables plus the handle. */
export class FakeDomain implements StoreDomain {
  readonly labels = new FakeTable<LabelRecord>()
  readonly groups = new FakeTable<GroupRecord>()
  readonly pins = new FakeTable<PinRecord>()
  /** How many times the unit was released. */
  closes = 0

  /** Release the unit. */
  async close(): Promise<void> {
    this.closes += 1
  }
}

/** A facility that owns at most one live handle per domain name. */
export class FakeFacility {
  /** The handle the facility currently serves, when one is live. */
  domain: FakeDomain | undefined
  /** Every opened name, in order; a second open of a live name is refused. */
  readonly opened: string[] = []

  /**
   * @param spec - the domain declaration.
   * @returns the live handle.
   * @throws with `code: 'already-open'` when the name is already held.
   */
  async open(spec: typeof sessionWorkspacesDomain): Promise<Domain<typeof sessionWorkspacesDomain>> {
    if (this.domain !== undefined) {
      const error = new Error(`domain '${spec.name}' is already open`) as Error & { code: string }
      error.code = 'already-open'
      throw error
    }
    this.opened.push(spec.name)
    const domain = new FakeDomain()
    this.domain = domain
    const release = async (): Promise<void> => {
      this.domain = undefined
      await domain.close()
    }
    const handle = {
      name: spec.name,
      table: (tableName: string) => {
        if (tableName === 'labels') return domain.labels
        if (tableName === 'groups') return domain.groups
        if (tableName === 'pins') return domain.pins
        throw new Error(`unexpected table '${tableName}'`)
      },
      close: release,
    }
    // Only the members the store's adapter reads are needed; the cast is the
    // price of standing in for a generic facility.
    return handle as unknown as Domain<typeof sessionWorkspacesDomain>
  }
}
