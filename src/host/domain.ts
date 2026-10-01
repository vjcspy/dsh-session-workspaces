/**
 * The plugin's durable domain: one `ctx.storageDomain` unit holding the
 * classifier's labels, the plugin-owned group records, and the Human pins.
 *
 * Three tables, each keyed by the identity the record is about:
 *
 * - `labels` — `sessionId → {workspace, confidence, decidedAt}`: what the
 *   classifier decided for a Session. Written once, then updated.
 * - `groups` — `groupId → {name, workspace, createdAt, order}`: a
 *   plugin-owned group. The record carries its workspace, which is what makes
 *   "move a Session into a group owned by another workspace" one write.
 * - `pins` — `sessionId → {workspace, group?, pinnedAt}`: a Human assignment.
 *   Its PRESENCE is the pin, so the override is not a second fact that could
 *   disagree with the placement.
 *
 * The domain name is versioned and never migrated (see the README): a change to
 * a record shape needs a new version plus an explicit migration, not a silent
 * reinterpretation of stored records.
 *
 * @module dsh-session-workspaces/host/domain
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { DOMAIN_NAME, DOMAIN_VERSION } from '../config.ts'
import type { GroupRecord, LabelRecord, PinRecord } from '../wire.ts'

/** A Session's classification. Strict: an unknown field is a corrupted record, not a forward-compatible one. */
const labelSchema: z.ZodType<LabelRecord> = z.object({
  workspace: z.string().min(1),
  confidence: z.number(),
  decidedAt: z.string().min(1),
}).strict()

/** One plugin-owned group. */
const groupSchema: z.ZodType<GroupRecord> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  workspace: z.string().min(1),
  createdAt: z.string().min(1),
  order: z.number(),
}).strict()

/** One Human assignment, which is also the pin. */
const pinSchema: z.ZodType<PinRecord> = z.object({
  workspace: z.string().min(1),
  group: z.string().min(1).optional(),
  pinnedAt: z.string().min(1),
}).strict()

/**
 * The plugin's domain declaration.
 *
 * `defineDomain` validates the name against `UNIT_NAME_RE` at module load, so a
 * malformed name fails before any medium is touched.
 */
export const sessionWorkspacesDomain = defineDomain({
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  tables: {
    labels: domainTable<string, LabelRecord>(labelSchema),
    groups: domainTable<string, GroupRecord>(groupSchema),
    pins: domainTable<string, PinRecord>(pinSchema),
  },
})
