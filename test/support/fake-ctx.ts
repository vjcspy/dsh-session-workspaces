/**
 * A stand-in for the Cordis host context, recording what a plugin registers.
 *
 * Two things it makes assertable that a real composition would hide: the fenced
 * routes go to `connection.fetch` (the channel that owns admission) and NOT to
 * `webServer` (which would publish them unfenced) — reading `webServer` throws.
 *
 * @module dsh-session-workspaces/test/support/fake-ctx
 */

/** One route as the channel registry receives it. */
export interface RegisteredRoute {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: string
  fetch(request: Request): Promise<Response>
}

/** The host context slice this plugin touches. */
export class FakeContext {
  /** Routes registered on the fenced channel, in order. */
  readonly routes: RegisteredRoute[] = []
  /** Effect labels, in registration order. */
  readonly effects: string[] = []
  /** Disposers returned by the effects. */
  private readonly disposers: (() => void)[] = []
  /** Set when the plugin reaches for the unfenced server. */
  webServerReads = 0

  /** The fenced channel. */
  readonly connection = {
    fetch: {
      /** @param route - the route to own. @returns its asynchronous disposer. */
      register: (route: RegisteredRoute): (() => Promise<void>) => {
        this.routes.push(route)
        return async () => {
          const at = this.routes.indexOf(route)
          if (at >= 0) this.routes.splice(at, 1)
        }
      },
    },
  }

  /** Any read of this is a fencing bug. */
  get webServer(): never {
    this.webServerReads += 1
    throw new Error('the plugin must register on connection.fetch, never on webServer')
  }

  /**
   * Run one effect and keep its disposer.
   * @param callback - the effect body.
   * @param label - the effect's label.
   * @returns a no-op; {@link disposeAll} releases everything.
   */
  effect(callback: () => (() => void) | void, label?: string): () => void {
    this.effects.push(label ?? '')
    const disposer = callback()
    if (typeof disposer === 'function') this.disposers.push(disposer)
    return () => {}
  }

  /** Release every effect's disposer, as a plugin unload does. */
  disposeAll(): void {
    for (const disposer of this.disposers.splice(0)) disposer()
  }
}
