/**
 * Facts both halves of the plugin agree on: the identity it is registered
 * under, the fenced paths it publishes, and the numbers that bound its work.
 *
 * Nothing here is deployment-specific. The candidate workspace labels are
 * DISCOVERED (the directories under the Aweave `workspaces/` root) or
 * CONFIGURED; no label, path or model is compiled into this file.
 *
 * @module dsh-session-workspaces/config
 */

/** Cordis plugin name and bundle id. */
export const PLUGIN_ID = 'dsh-session-workspaces'

/**
 * Settings namespace: the profile entry id the settings form is keyed by.
 *
 * The client half reads `ctx.configForms.get(SETTINGS_NAMESPACE)`, so this must
 * equal the `id` this plugin's row carries in the profile's `cordis.patch.yml`
 * — which is why the bundle patch names that id explicitly.
 */
export const SETTINGS_NAMESPACE = PLUGIN_ID

/**
 * The grouping provider id the browser half registers into the client seam.
 *
 * The seam namespaces every group key by this id and rejects an id containing
 * `:`, so it is the plugin id unchanged.
 */
export const GROUPING_PROVIDER_ID = PLUGIN_ID

/**
 * Locale namespace owned by this plugin's browser half.
 *
 * An external plugin does not run the harness's `verify-client-ui-i18n`, so
 * this namespace is the plugin's own bookkeeping: product strings resolve
 * through it, while group labels and workspace labels stay verbatim data.
 */
export const LOCALE_NAMESPACE = 'dshSessionWorkspaces'

/**
 * The `ctx.storageDomain` unit holding every durable record.
 *
 * `DomainSpec.name` must match `/^[a-z][a-z0-9_]*$/` — hence underscores, not
 * the hyphenated plugin id.
 */
export const DOMAIN_NAME = 'dsh_session_workspaces'

/** Current domain format version. Version 1 has no migration path (see README). */
export const DOMAIN_VERSION = 1

/** Fenced read: the classification map plus the plugin-owned group records. */
export const MAP_PATH = '/api/dsh-session-workspaces/map'

/** Fenced write: one Session assignment, or one group operation. */
export const MUTATE_PATH = '/api/dsh-session-workspaces/mutate'

/** Fenced control for the opt-in, Human-triggered backfill. */
export const BACKFILL_PATH = '/api/dsh-session-workspaces/backfill'

/** Fenced read: the advertised `provider`/`model` catalog the settings control offers. */
export const CATALOG_PATH = '/api/dsh-session-workspaces/catalog'

/** Label recorded when the model cannot decide, answers out of set, or answers below the threshold. */
export const DEFAULT_UNKNOWN_LABEL = 'unknown workspace'

/** Minimum reported confidence for a label to be accepted instead of the unknown label. */
export const DEFAULT_CONFIDENCE = 0.5

/** Deadline for one classification call. A call past it records nothing. */
export const CLASSIFY_TIMEOUT_MS = 30_000

/**
 * How long one sampled route catalog is reused before the adapters are asked
 * again.
 *
 * Sampling asks every registered provider for its models, which for a remote
 * adapter is a network round trip, so without a window a settings panel that
 * re-reads the catalog would turn into a burst of discovery calls. A whole-read
 * failure is deliberately NOT cached: a directory that was momentarily
 * unlistable is retried by the next read.
 */
export const CATALOG_TTL_MS = 60_000

/**
 * Local-storage key holding the last map the browser read.
 *
 * Versioned: a payload-shape change must not be read by a newer client as if it
 * were current.
 */
export const MAP_CACHE_KEY = 'dsh-session-workspaces.map.v1'

/** How often the browser half re-reads the map. There is no push channel. */
export const MAP_POLL_INTERVAL_MS = 4_000

/** How many classification calls the backfill keeps in flight at once. */
export const BACKFILL_CONCURRENCY = 2

/** Directory under the Aweave root whose children name the workspaces. */
export const WORKSPACES_DIR_NAME = 'workspaces'

/** Session projection key carrying the first eligible human prompt of a Session. */
export const FIRST_PROMPT_PROJECTION = 'dshSessionWorkspacesFirstPrompt'
