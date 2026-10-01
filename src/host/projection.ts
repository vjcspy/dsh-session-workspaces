/**
 * The first-human-prompt projection.
 *
 * The live classification needs two facts about a Session — "is this its FIRST
 * human message?" and "what did it say?" — and both must survive a process
 * restart: an in-memory counter would forget a Session whose first prompt was
 * already committed, and the second prompt would then be classified as if it
 * were the first. A session projection is the in-repo mechanism for that: it
 * folds every committed event, and a restart replays the stored log back into
 * the same state. `session-title` answers the same question the same way.
 *
 * Carrying the prompt TEXT here rather than in an in-memory map beside the
 * event listener is what lets the classification resolve its input at the
 * instant the route exists instead of at the instant the prompt was observed —
 * see `../index.ts`. It also keeps this plugin off the deprecated synchronous
 * session-log reads (`Session.eventAt`), which the harness prohibits for new
 * callers.
 *
 * @module dsh-session-workspaces/host/projection
 */

import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { FIRST_PROMPT_PROJECTION } from '../config.ts'
import { humanPromptText } from './session-log.ts'

/** How many eligible human messages a Session has had, and the first one's text. */
export interface FirstPromptState {
  /** Total eligible human messages folded so far. */
  readonly count: number
  /** Seq of the newest eligible message, or null before any. */
  readonly seq: number | null
  /** Text of the FIRST eligible message, or null before any. */
  readonly prompt: string | null
}

/**
 * The projection key this unit owns.
 *
 * A module augmentation cannot be computed from a constant, so this literal must
 * equal {@link FIRST_PROMPT_PROJECTION}; `test/unit/config.spec.ts` asserts it,
 * which is what keeps the two from drifting.
 */
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Eligible human messages of one Session, folded over its whole log. */
    dshSessionWorkspacesFirstPrompt: FirstPromptState
  }
}

/** The state before any event. */
const EMPTY: FirstPromptState = { count: 0, seq: null, prompt: null }

/**
 * Register the projection on the calling context's fiber.
 * @param ctx - Host context owning `sessionProjections`.
 */
export function registerFirstPromptProjection(ctx: Context): void {
  ctx.sessionProjections.register({
    key: FIRST_PROMPT_PROJECTION,
    // Version 2 adds `prompt`. The framework discards a checkpoint row whose
    // `ver` does not match and refolds the cell from the Session's log, so the
    // bump is a refold, not a migration — and it costs one log pass per Session.
    stateVersion: 2,
    stateSchema: z.object({ count: z.number(), seq: z.number().nullable(), prompt: z.string().nullable() }),
    init: () => EMPTY,
    // Pure and synchronous, as the projection framework requires: it folds one
    // committed event into the previous state and nothing else.
    apply: (state, event) => {
      const text = humanPromptText(event.data)
      if (text === undefined) return state
      // The FIRST eligible message wins the text; `count` keeps rising so the
      // cadence can still ask "is this the first one?".
      return { count: state.count + 1, seq: event.seq, prompt: state.prompt ?? text }
    },
  })
}
