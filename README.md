# dsh-session-workspaces

A DSH plugin that groups the Web sidebar's Session list by **Aweave workspace**
and, under each workspace, by **plugin-owned groups** the Human creates.

The workspace is decided from each conversation's own first Human prompt, in a
hidden auxiliary model call that never enters the conversation. The plugin owns
its groups as durable records, so creating one, moving a Session into it, and
deleting it are all plugin operations that need no core surface.

```
Sessions
├─ k                        ← Aweave workspace, from the first prompt
│  ├─ Please work in the k…
│  └─ I am working in the…
├─ whill
│  └─ Please review the whill…
├─ aweave-fixture           ← the core fallback, for Sessions nothing claimed
│  └─ Check the whill storefront…
└─ Ungrouped
```

## Install

```sh
# in the plugin repository
pnpm install && pnpm run build

# into a profile (the plugin is a `file:` install like its siblings)
cd "$DSH_HOME/profiles/web"
pnpm add file:/path/to/dsh-session-workspaces
# add "dsh-session-workspaces" to dsh.profile.bundles in this profile's package.json
node /path/to/deepseek-harness/apps/cli/lib/bin.js --profile web --dump-config | grep -A2 dsh-session-workspaces
```

`dsh plugin --profile web add <path>` is `pnpm add` in the profile directory: it
installs the dependency but does **not** add the `dsh.profile.bundles` row, so
the row must be added for the plugin to compose. Verify with `--dump-config`
before restarting; a `file:` install is a hardlink tree, so a rebuild needs
`pnpm remove` + `pnpm add` to refresh it.

The plugin needs the client grouping seam (`ctx.workspaceGrouping`) from
`deepseek-harness` `packages/client/ui-workspace`, i.e. `develop` at
`0ce400ab5f883656de6ca03508cb57a3d7c16ee4` or later. Without it the browser half
logs one warning and the tree stays on core grouping; the host half still runs.

## What the host half does

**One hidden classification call per Session, on the first Human prompt.** The
cadence is `session-title`'s own: the `session/event` stream, the
`source.kind === 'user'` filter, and the "first eligible message" condition, read
from a session projection so a process restart cannot restart the count. Subagent
Sessions are ignored.

Three properties are contractual:

- **Nothing is appended to the conversation surface.** The call goes through
  `ctx.llm.stream` with its own system prompt and one user message; no Session
  event is written, so it never becomes conversation context.
- **No `sessionId`.** `session-checkpoint-policy` wraps an `llm/stream` call in a
  durable checkpoint when, and only when, it carries a `sessionId` that resolves
  to a live Session. **Verified in the container**: with no configured route, the
  Session's own logged route (`opencode-go/muse-spark-1.3-contributor`) classified
  correctly with `sessionId` omitted, so the documented contingency — pass
  `sessionId` and accept the checkpoint coupling — is **not** needed and is not
  implemented.
- **The route is never invented.** Config `provider`/`model`, else the Session's
  own logged route from its `request/header`, else **no call at all** and nothing
  recorded. A half-configured pair is treated as unconfigured.

The answer is validated against a **closed candidate set** — the directories under
the Aweave `workspaces/` root (located from the Sessions' own working
directories, or set by `workspacesRoot`) plus the configured list — and a
below-threshold or out-of-set answer becomes the configured unknown label.
Provider error, deadline or unparseable output records nothing and does not
disturb the Session, its turn, or the core title feature.

The core title provider is **not replaced**: this plugin registers no
`sessionTitle` provider at all, and the shipped
`session-title-first-prompt-llm` still titles conversations (asserted in the
session log).

## Durable state

One `ctx.storageDomain` unit, `dsh_session_workspaces`, version 1, three kv
tables:

| Table | Key | Record |
| --- | --- | --- |
| `labels` | `sessionId` | `{workspace, confidence, decidedAt}` — the classifier's answer |
| `groups` | `groupId` | `{id, name, workspace, createdAt, order}` — a plugin-owned group |
| `pins` | `sessionId` | `{workspace, group?, pinnedAt}` — a Human assignment, and therefore the pin |

Two rules follow from the storage contract:

- **A key's first write is `put`; later writes are `update`.** `update` is an
  atomic read-modify-write but rejects an absent record with `missing-key`, so the
  store reads first, chooses, and falls back to `put` if the record disappeared
  between the two (the only way `update` can lose that race).
- **A dangling group reference resolves at read time.** Deleting a group is one
  atomic `delete` and renaming it is one `put`; nothing sweeps member records. An
  assignment whose group no longer exists renders at workspace level.

A **pinned** Session is never reclassified: the pin is checked before every write.

The unit is opened once, on the plugin fiber, and released on dispose. A second
open of the same name while the first handle is live rejects with `already-open`.

> **Unit version 1 has no migration path.** A change to a table or record shape
> needs a new unit name (or an explicit migration) — the domain layer does not
> migrate, and an incompatible stored record fails the open rather than being
> reinterpreted.

## Fenced routes

Registered on the shared `/api` channel (`ctx.connection.fetch.register`), which
is what fences them: the channel's admission runs before any route lookup, so a
foreign `Host` is refused and a request without the browser cookie is refused —
measured, `401` without the cookie, `200` from the page.

| Route | Body | Answer |
| --- | --- | --- |
| `GET /api/dsh-session-workspaces/map` | — | placements, groups, the candidate set, backfill progress |
| `POST /api/dsh-session-workspaces/mutate` | `{sessionId, workspace, group?}` or `{op: 'group.create'\|'group.rename'\|'group.delete'\|'group.removeMember', …}` | the map as it stands after the write |
| `POST /api/dsh-session-workspaces/backfill` | `{action: 'start'\|'status'}` | backfill progress and the map |

No extra CSRF layer is added: the browser session cookie is host-only, `HttpOnly`
and `SameSite=Strict`, and `api-request-trust.ts` refuses a cross-site `Origin`
before the body is read. The JSON content-type check is defense in depth.

Moving a Session into a group **owned by another workspace** moves the Session's
workspace too, in the same write: the group record carries its workspace.

## The browser half

The map is polled every 4 s (there is no push), and the grouping provider answers
a root-to-leaf path: `workspace › group` when a group exists, `workspace` alone
otherwise, and `undefined` for an unclassified Session so core grouping applies.

Two implementation notes that are load-bearing rather than stylistic:

- **The provider is registered once and never disposed; a second provider is the
  revision lever.** The seam recomputes the tree when a REGISTRATION changes, so a
  changed map needs a registration event. Re-registering the real provider would
  open a window in which it claims nothing, and the sidebar's view store prunes
  its persisted expansion and manual-order entries down to the keys the current
  derivation produced — the Human's collapsed state would be discarded.
- **The last map is cached in `localStorage` and seeds the store synchronously.**
  A reload renders before the first map read resolves, and without a
  synchronously available map the provider produces no rows on that render.

### Reload persistence (seam-owned; fixed in `deepseek-harness` `45ac428677`)

Earlier builds pruned a provider group's persisted collapsed state and manual order
on the render that runs before this plugin's client bundle has registered its
provider (~60 ms after DOMContentLoaded), so a provider group reloaded expanded and
lost its saved Session order. **That is fixed in the seam**: since
`deepseek-harness` `0003b94848` retention is ownership-scoped — it prunes only the
keys the browser owns itself and leaves every key namespaced by a provider id
(`<providerId>:…`) untouched, registered or not.

Re-verified in a real browser against this plugin at `c939db4f` on
`deepseek-harness` `45ac428677`: a collapsed provider workspace row and its collapsed
nested group both reloaded collapsed (`aria-expanded="false"`), and the group's
`sessionOrderByAccount` entry survived the reload.

One gap in the same area remains, and it is core, not this plugin: a manual drag
**inside** a provider group does not reorder its members. `WorkspaceBrowser`'s
`commitSessionDrag` resolves the dragged account to `ungroupedSessionIds` or a
Workspace `sessionIds` and returns early for any other account key, so the drag is
discarded — the same synthetic drag reorders the flat list correctly, and a provider
group's recorded order therefore always mirrors its natural order.

## Settings

`settings.section` "Session workspaces": `enabled`, `provider`, `model`, the
additional candidate list (with the discovered labels shown read-only), the
unknown label, the minimum confidence, and the backfill action.

Every writable field is declared **`volatile`** in the Host `Config`, because a
non-volatile field is refused by the settings write gate; a write commits into
the running reference and emits `loader/volatile-update` instead of remounting the
plugin, and the plugin re-reads its live values at each use. Measured: setting a
bogus `provider`/`model` pair and saving made the very next Session unclassifiable
without a restart, and clearing them made the Session after that classify again.

## Backfill (opt-in)

Existing Sessions keep the core fallback group until they are classified. The
settings section offers an explicit, Human-triggered pass that:

- states its cost before it starts — one model call per undecided Session — and
  requires a second confirmation;
- reads each stored Session's first Human prompt through
  `ctx.sessionQuery.readSession`, which replays the stored log without resuming
  the Session, and takes the route from that Session's own last `request/header`;
- never runs automatically;
- bounds concurrency (`BACKFILL_CONCURRENCY`, default 2);
- resumes by skipping every Session that already carries a label or a pin, so a
  re-run costs nothing for settled work.

## Gates

```sh
pnpm run build && pnpm run check && pnpm run test
```

`check` runs all three tsconfigs (host, client, tests). The suite covers the
classifier's every branch (in-set, out-of-set, low confidence, malformed,
deadline, provider error, and every route-resolution branch including "no route →
no call"), the store (record layout, put-then-update, pin, group CRUD, lazy
dangling references, handle lifetime, second-open rejection), the fenced routes
(verbs, statuses, malformed writes, and that they are registered on the fenced
channel and never on `webServer`), the provider's one-level / two-level /
unclassified paths, the map cache, the menu actions, and one real-composition boot
test through a generated `cordis.yml` that loads the BUILT artifact.

An external plugin does not run the harness's `verify-client-ui-i18n` or its
coverage gate; this plugin carries its own locale namespace and its own tests
instead.
