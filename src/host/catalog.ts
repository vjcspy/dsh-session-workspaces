/**
 * The advertised route catalog: every `provider`/`model` pair the LLM directory
 * currently advertises, read from `ctx.llm` and cached briefly.
 *
 * Why this lives on the Host: the settings control that offers the routes must
 * not depend on a core client service — an external plugin reaches core through
 * the fenced `/api` channel — so the Host samples the directory
 * (`ctx.llm.listProviders()`, then `ctx.llm.listModels(provider)` per provider)
 * and publishes the result over one more fenced route.
 *
 * Nothing here can throw into that route. A provider whose models cannot be
 * enumerated is reported as one `failed` entry and the rest of the catalog still
 * answers, and a directory that cannot even be listed answers an EMPTY catalog
 * carrying the error, because the browser has to stay usable while the catalog is
 * missing or partial.
 *
 * @module dsh-session-workspaces/host/catalog
 */

import { CATALOG_TTL_MS } from '../config.ts'
import type { CatalogFailure, CatalogPayload, CatalogRoute } from '../wire.ts'

/** One provider as the LLM directory describes it. */
export interface CatalogProvider {
  /** Provider route key: the value `GenerateOptions.provider` takes. */
  readonly id: string
}

/** One model as an adapter advertises it. */
export interface CatalogModel {
  /** Model id: the value `GenerateOptions.model` takes. */
  readonly id: string
}

/** Where the catalog is sampled from. */
export interface CatalogSource {
  /** The directory's registered providers, in registration order. */
  readonly listProviders: () => readonly CatalogProvider[]
  /**
   * The models one registered provider advertises.
   *
   * May reject: an unregistered provider throws, and an adapter that answers
   * invalid or duplicate metadata throws `LlmError` `INVALID_CATALOG`.
   */
  readonly listModels: (provider: string) => Promise<readonly CatalogModel[]>
  /** Monotonic clock used for the cache window. Defaults to `Date.now`. */
  readonly now?: (() => number) | undefined
  /** Wall clock used for `sampledAt`. Defaults to the real clock. */
  readonly iso?: (() => string) | undefined
}

/**
 * A briefly cached sample of the advertised routes.
 *
 * The cache window is the whole point of the class: sampling asks every
 * registered provider for its models, which for a remote adapter is a network
 * round trip, and the settings panel re-reads the catalog whenever it is opened.
 * Concurrent reads share one in-flight sample rather than starting a second.
 *
 * A whole-read failure is NOT cached — a directory that was momentarily
 * unlistable must retry on the next read — while a partial failure is, because a
 * provider that cannot be reached would otherwise be retried on every read.
 */
export class RouteCatalog {
  private cached: CatalogPayload | undefined
  private cachedAt = 0
  private inFlight: Promise<CatalogPayload> | undefined
  private readonly source: CatalogSource
  private readonly ttlMs: number

  /**
   * @param source - the directory and clock the catalog is sampled from.
   * @param ttlMs - how long one sample is reused.
   */
  constructor(source: CatalogSource, ttlMs: number = CATALOG_TTL_MS) {
    this.source = source
    this.ttlMs = ttlMs
  }

  /** Drop the current sample, so the next read asks the adapters again. */
  invalidate(): void {
    this.cached = undefined
    this.cachedAt = 0
  }

  /**
   * The catalog as it stands, sampling the directory when the sample is stale.
   * @returns the payload; never rejects.
   */
  async read(): Promise<CatalogPayload> {
    const now = this.now()
    if (this.cached !== undefined && now - this.cachedAt < this.ttlMs) return this.cached
    this.inFlight ??= this.sample().finally(() => { this.inFlight = undefined })
    return await this.inFlight
  }

  /** One sample of the whole directory. */
  private async sample(): Promise<CatalogPayload> {
    const sampledAt = this.iso()
    let providers: readonly CatalogProvider[]
    try {
      providers = this.source.listProviders()
    } catch (error) {
      // The error is deliberately not cached: the route still answers (an empty
      // catalog that says why), and the next read tries the directory again.
      return { routes: [], failed: [], error: messageOf(error), sampledAt }
    }
    const routes: CatalogRoute[] = []
    const failed: CatalogFailure[] = []
    const seen = new Set<string>()
    for (const provider of providers) {
      let models: readonly CatalogModel[]
      try {
        models = await this.source.listModels(provider.id)
      } catch (error) {
        failed.push({ provider: provider.id, message: messageOf(error) })
        continue
      }
      // A provider with no models advertises no route: it contributes nothing
      // here and is not a failure — `listModels` answering `[]` is a legitimate
      // catalog, so the route simply offers no option for that provider.
      for (const model of models) {
        if (typeof model?.id !== 'string' || model.id === '') continue
        const value = `${provider.id}\u0000${model.id}`
        if (seen.has(value)) continue
        seen.add(value)
        routes.push({ provider: provider.id, model: model.id })
      }
    }
    const payload: CatalogPayload = { routes, failed, sampledAt }
    this.cached = payload
    this.cachedAt = this.now()
    return payload
  }

  /** The source's monotonic clock. */
  private now(): number {
    return this.source.now?.() ?? Date.now()
  }

  /** The source's wall clock. */
  private iso(): string {
    return this.source.iso?.() ?? new Date().toISOString()
  }
}

/**
 * A caught value's message.
 * @param error - the caught value.
 * @returns its message, or its string form.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
