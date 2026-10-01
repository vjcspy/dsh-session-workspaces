/**
 * The first-human-prompt projection.
 *
 * The live classification cadence needs exactly one fact — "is this the FIRST
 * human message of this Session?" — and it must survive a process restart:
 * an in-memory counter would forget a Session whose first prompt was already
 * committed, and the second prompt would then be classified as if it were the
 * first. A session projection is the in-repo mechanism for that: it folds every
 * committed event, and a restart replays the stored log back into the same
 * count. `session-title` answers the same question the same way.
 *
 * @module dsh-session-workspaces/host/projection
 */

import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { FIRST_PROMPT_PROJECTION } from '../config.ts'
import { humanPromptText } from './session-log.ts'

/** How many eligible human messages a Session has had, and the seq of the newest. */
export interface FirstPromptState {
  /** Total eligible human messages folded so far. */
  readonly count: number
  /** Seq of the newest eligible message, or null before any. */
  readonly seq: number | null
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
const EMPTY: FirstPromptState = { count: 0, seq: null }

/**
 * Register the projection on the calling context's fiber.
 * @param ctx - Host context owning `sessionProjections`.
 */
export function registerFirstPromptProjection(ctx: Context): void {
  ctx.sessionProjections.register({
    key: FIRST_PROMPT_PROJECTION,
    stateVersion: 1,
    stateSchema: z.object({ count: z.number(), seq: z.number().nullable() }),
    init: () => EMPTY,
    // Pure and synchronous, as the projection framework requires: it folds one
    // committed event into the previous state and nothing else.
    apply: (state, event) => {
      if (humanPromptText(event.data) === undefined) return state
      return { count: state.count + 1, seq: event.seq }
    },
  })
}
