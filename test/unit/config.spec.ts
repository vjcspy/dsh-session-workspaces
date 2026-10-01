/**
 * Identity and wiring facts that would otherwise drift silently: the unit name
 * inside the storage grammar, the projection key that a module augmentation has
 * to spell as a literal, the fenced paths, and — the one the settings page
 * depends on — that every field the Settings section writes is VOLATILE.
 *
 * A non-volatile field is refused by the settings write gate, so a writable
 * control backed by one renders a field that can never be saved. This is the
 * assertion that keeps the schema and the page in step.
 */

import { describe, expect, it } from 'vitest'
import { UNIT_NAME_RE } from '@deepseek-ai/dsh-storage'
import { Config as PluginConfigSchema } from '../../src/schema.ts'
import { sessionWorkspacesDomain } from '../../src/host/domain.ts'
import {
  BACKFILL_PATH, DOMAIN_NAME, DOMAIN_VERSION, FIRST_PROMPT_PROJECTION, GROUPING_PROVIDER_ID,
  LOCALE_NAMESPACE, MAP_PATH, MUTATE_PATH, PLUGIN_ID, SETTINGS_NAMESPACE,
} from '../../src/config.ts'

/** The schemastery node shape this spec walks. */
interface SchemaNode {
  readonly type?: string
  readonly meta?: { readonly volatile?: boolean }
  readonly dict?: Record<string, SchemaNode>
}

describe('identity', () => {
  it('keeps the plugin, settings, grouping and locale identities aligned', () => {
    expect(PLUGIN_ID).toBe('dsh-session-workspaces')
    expect(SETTINGS_NAMESPACE).toBe(PLUGIN_ID)
    expect(GROUPING_PROVIDER_ID).toBe(PLUGIN_ID)
    // The seam rejects a provider id containing ':'.
    expect(GROUPING_PROVIDER_ID.includes(':')).toBe(false)
    expect(LOCALE_NAMESPACE).toBe('dshSessionWorkspaces')
  })

  it('names the storage unit inside the storage grammar', () => {
    expect(DOMAIN_NAME).toBe('dsh_session_workspaces')
    expect(UNIT_NAME_RE.test(DOMAIN_NAME)).toBe(true)
    expect(sessionWorkspacesDomain.name).toBe(DOMAIN_NAME)
    expect(sessionWorkspacesDomain.version).toBe(DOMAIN_VERSION)
  })

  it('spells the projection key exactly as the module augmentation declares it', () => {
    // A `declare module` augmentation cannot be computed from a constant, so the
    // literal in `src/host/projection.ts` and this constant are two spellings of
    // one fact; this assertion is what keeps them equal.
    expect(FIRST_PROMPT_PROJECTION).toBe('dshSessionWorkspacesFirstPrompt')
  })

  it('publishes three distinct fenced paths under /api', () => {
    const paths = [MAP_PATH, MUTATE_PATH, BACKFILL_PATH]
    expect(new Set(paths).size).toBe(3)
    for (const path of paths) expect(path.startsWith('/api/')).toBe(true)
  })
})

describe('settings schema', () => {
  it('marks every field the Settings section writes as volatile', () => {
    const schema = PluginConfigSchema as unknown as SchemaNode
    expect(schema.type).toBe('object')
    const dict = schema.dict ?? {}
    for (const field of ['enabled', 'provider', 'model', 'candidates', 'unknownLabel', 'confidence']) {
      expect(dict[field]?.meta?.volatile, `${field} must be volatile`).toBe(true)
    }
  })

  it('leaves the composition-only fields ordinary', () => {
    const dict = (PluginConfigSchema as unknown as SchemaNode).dict ?? {}
    expect(dict['workspacesRoot']?.meta?.volatile).not.toBe(true)
  })
})
