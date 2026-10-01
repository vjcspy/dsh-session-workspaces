/**
 * Plugin entry configuration schema (schemastery — plugin `Config` is
 * schemastery, while domain record schemas are zod; see
 * `@deepseek-ai/dsh-storage-domain/src/spec.ts` for the split rationale).
 *
 * The plugin declares a schema for ONE reason: the settings provider projects a
 * plugin's VOLATILE Config fields into its configuration form, so every field
 * the Settings section writes (`provider`, `model`, `candidates`,
 * `unknownLabel`, `confidence`) must be volatile. A non-volatile field is
 * refused by the settings write gate. `enabled` is declared and read by both
 * halves but is not volatile here: it is a composition fact (a deployment that
 * wants the classifier off removes it from the profile), and a volatile
 * `enabled` would let a settings write flip a field the classification pass
 * reads on a hot path.
 *
 * @module dsh-session-workspaces/schema
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_CONFIDENCE, DEFAULT_UNKNOWN_LABEL } from './config.ts'

/**
 * Live plugin entry configuration.
 *
 * Every volatile field is a reference the Loader keeps live across a settings
 * write: read it with `.get()` at the moment of use, never once at mount.
 */
export interface Config {
  /** Whether the first-prompt classification pass runs at all. */
  readonly enabled?: Volatile<boolean>
  /**
   * Classification route provider, or empty for "resolve it from the Session's
   * own logged request header".
   */
  readonly provider?: Volatile<string>
  /** Classification route model, or empty for "resolve it from the Session's own logged route". */
  readonly model?: Volatile<string>
  /** Extra candidate labels, added to the directories discovered under the workspaces root. */
  readonly candidates?: Volatile<readonly string[]>
  /** Label recorded for an undecidable, out-of-set or low-confidence answer. */
  readonly unknownLabel?: Volatile<string>
  /** Minimum accepted confidence; below it the answer becomes the unknown label. */
  readonly confidence?: Volatile<number>
  /**
   * The Aweave `workspaces/` root, or empty to locate it from each Session's own
   * working directory (`<cwd>/workspaces`, then `<cwd>` when its basename is
   * already the workspaces directory).
   */
  readonly workspacesRoot?: string
}

/** The plugin entry schema. */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  provider: z.string().default('').volatile(),
  model: z.string().default('').volatile(),
  candidates: z.array(z.string()).default([]).volatile(),
  unknownLabel: z.string().default(DEFAULT_UNKNOWN_LABEL).volatile(),
  confidence: z.number().default(DEFAULT_CONFIDENCE).volatile(),
  workspacesRoot: z.string().default(''),
})
