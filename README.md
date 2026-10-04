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
`5611288ef2` or later. Without it the browser half logs one warning and the tree
stays on core grouping; the host half still runs.

## What the host half does

**One hidden classification call per Session, on the first Human prompt.** The
eligibility predicate is `session-title`'s own: the `source.kind === 'user'`
filter and the "first eligible message" condition, read from a session
projection so a process restart cannot restart the count. Subagent Sessions are
ignored.

**That one call also returns the Conversation title.** Its answer carries a
`summary` beside the label — at most **7 words**, or at most **14 characters**
when the language does not separate words with spaces — and the plugin's own
`sessionTitle` provider hands that summary to the core title service. Both
readers await ONE keyed decision, keyed by Session id (`src/host/decision.ts`),
so a Session still costs exactly one model call — see
[The conversation title](#the-conversation-title).

**The backfill is outside that guarantee** (documented, not fixed): see
[Backfill (opt-in)](#backfill-opt-in).

**The work runs when the Session's `request/header` is committed, not when the
prompt is.** `packages/core/agent-loop/src/agent.ts` appends the first
`user/message` at `:421` and only then calls `buildRequest` at `:425`, which
appends the header carrying the Session's route — so at the instant a brand-new
Session's first prompt exists, the Session has **no** logged route at all. The
route, the prompt and every eligibility condition are therefore read at the one
instant the route exists, from `session.requestHeader()` and from this plugin's
own projection.

**There is no wait and no timer.** A Session that never commits a
`request/header` is a Session that never dispatched a request: it makes no call
and records nothing, and it stays on core grouping — the contract's
"no route → no call at all" branch. An earlier revision instead armed its work
at the first `user/message` and kept it for a bounded 300 s; that arm could not
be created at all while the plugin's storage unit was still opening, and the
Session then recorded nothing **forever**, because the later header found no
armed entry. Resolving at the header removes the window: a header that arrives
while the plugin cannot act (storage still opening, feature disabled) simply
classifies on the next one.

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
  recorded. A half-configured pair is treated as unconfigured. **Measured truth
  for the default path (2026-10-01, `dsh-session-workspaces-route`,
  `127.0.0.1:3190`)**: with both fields left empty — the out-of-the-box default —
  a brand-new Session whose first prompt is its first turn classifies from its
  own logged route, with no Human override and no restart. On the previous
  revision the same path was already reached in the plain case, but a first turn
  whose prompt landed before the storage unit opened recorded nothing at all;
  that case is now covered by `test/composition/route-ordering.spec.ts`, which
  fails on the previous revision and passes on this one.

The answer is validated against a **closed candidate set** — the directories under
the Aweave `workspaces/` root (located from the Sessions' own working
directories, or set by `workspacesRoot`) plus the configured list — and a
below-threshold or out-of-set answer becomes the configured unknown label. That
label is a recorded **decision**, not a bucket: the sentinel is written like any
other label, so the Session is never re-decided and costs no second call — while
the browser half serves no row for it, so the Session renders where dsh puts an
unclaimed Session, under the core Workspace grouping.
Provider error, deadline or unparseable output records nothing and does not
disturb the Session, its turn, or the core title feature.

The plugin **owns the Conversation title now**, by registering its own
`sessionTitle` provider. That is why the shipped provider row
(`session-title-llm`) must be disabled in the profile — a hard precondition, see
[The conversation title](#the-conversation-title).

## The conversation title

The same call carries the title. The model-facing answer is exactly:

```json
{"label": "<one candidate label>", "confidence": <number between 0 and 1>, "summary": "<at most 7 words>"}
```

`summary` is normalized — invisible characters stripped, surrounding quotes
stripped, internal whitespace collapsed — and then bounded by three rules
(`normalizeSummary`, `src/host/classifier.ts`):

1. **A summary written with word spaces is at most 7 words**
   (`MAX_SUMMARY_WORDS`), truncated to its first seven.
2. **A CJK summary — one that contains CJK characters and no whitespace at all —
   is at most 14 characters** (`MAX_SUMMARY_CJK_CHARACTERS`). A whitespace-token
   cap says nothing about a script that does not separate words with spaces: a
   Chinese sentence counts as ONE word, and without this budget the core would
   cut the accepted title itself, silently and mid-phrase, at `maxTitleBytes`.
   14 keeps the core's own ratio for the same case — the shipped sibling
   provider aims for `targetCjkCharacters: 10` beside `targetWords: 5`
   (`deepseek-harness` `packages/bundle/base/cordis.patch.yml:63-68`,
   `packages/session/session-title-llm/src/index.ts:200`), two characters per
   word — applied to this plugin's seven-word cap.
3. **Every summary is at most 80 bytes** (`MAX_SUMMARY_BYTES`, mirroring the
   shipped `maxTitleBytes`), truncated on a **character** boundary so the partial
   word survives instead of being dropped. This is the backstop that makes the
   "the core never silently cuts our title" claim true for a long Latin word too:
   seven 40-character words are 280 bytes, and rule 1 alone would let the core
   do the cutting.

The 14-character budget applies to CJK only, deliberately: a single long LATIN
word is a word, and fourteen characters is not a shorter form of it, so such a word is
bounded by rule 3 alone. Invisible-only content (`U+200B`, `U+FEFF`, `U+2060`,
`U+00AD`, controls) is stripped **before** the quote strip, so a value wrapped in
quotes across a zero-width character still has its quotes recognised, and a
summary that is nothing but invisible characters is reported as **no summary** —
never as a title the core would strip to empty and reject.

A missing, mistyped, empty, invisible-only or over-long `summary` never costs the
Session its classification: the label is judged by the label rules alone.

The plugin registers `{id: 'dsh-session-workspaces', automatic: 'first-prompt'}`
with `ctx.sessionTitle`, and reaches that service **optionally** through
`ctx.inject(['sessionTitle'], …)`: the registration lives in a child plugin that
waits for the service, so a host **without** it still mounts the grouping half.
`generate` awaits the Session's one decision and answers with the summary, the
seq of the FIRST element of `request.messages` (never an invented seq), and the
route the classification actually ran on. It **throws** whenever no summary can be
produced — no route, a provider error, the deadline, a malformed answer, an
already-decided Session, an aborted request — which is what leaves the core's
deterministic fallback title in place instead of writing an empty one. A Human
rename still wins: the core's `source.kind === 'user'` pin is untouched.

The summary is **never persisted**. The durable unit keeps its exact record
shapes, so no migration and no orphaned classification.

### HARD PRECONDITION — the shipped title row must be disabled

`SessionTitleService.register` is a **singleton**: a second registration throws
`session-title provider "<id>" is already registered`. The shipped
`session-title-first-prompt-llm` provider (row id `session-title-llm`) is enabled
by default through `dsh-base`, so the `web` profile MUST disable it:

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: session-title-llm
  disabled: true
```

Without that row the plugin logs one loud warning naming this precondition and
**keeps booting**: the sidebar grouping half and the core fallback title both
keep working, and no classification-derived title appears. The disable and the
plugin install belong in the same profile change.

**The warning is invisible on a successful boot, and the state is published on the
map route instead.** Measured in the container on 2026-10-02: with the
`session-title-llm` row re-enabled, `error`, `warn`, `info` and `debug` probes
logged from the plugin's own injection produced **zero** lines in the boot log,
while a `process.stderr.write` marker beside them did appear — so **no logger
level is visible**, and the reason is structural rather than a threshold:

- the vendored `LoggerService` ships exactly one built-in exporter and it only
  pushes into an in-memory ring buffer (`vendor/cordis/src/logger.ts:213-221`);
- the only other exporter is `app-boot`'s startup collector, and its records are
  read **solely when startup fails** (`packages/boot/app-boot/src/index.ts:984-988,1019-1021`);
- the `dsh: …` lines a boot does print are written to stderr by the launcher and
  the startup audit, not through `ctx.logger`.

So the condition is also carried on the existing map response, as one additive
field:

```json
{"success": true, "data": { "…": "…", "titleProvider": "ok" }}
```

`"ok"` means this plugin registered its `sessionTitle` provider; `"unavailable"`
means the service refused the registration — in practice because it already had a
provider, i.e. the precondition above — so titles come from that provider. The
field is the OUTCOME of the register call, not an optimistic guess, and it is read
per request rather than captured, so a map read that raced the registration does
not freeze a stale answer. (An earlier revision probed the slot with a throwaway
provider first; that probe was removed because its disposer does not free the
core's slot synchronously, so the plugin ended up refused by its own probe while
the map route still reported `unavailable`.) The log line is kept for hosts that
do install a sink.

**Only the duplicate gets the precondition message.** `SessionTitleService`
validates a candidate *before* it looks for a duplicate
(`session-title/src/index.ts:471-477`), so a bad `automatic` mode, a missing
`generate`, or another plugin's provider all throw from the same call. Only the
refusal carrying ``is already registered`` — the service's own singleton wording —
is reported as this precondition; every other error is logged as itself and
unmasked. The one coupling is that wording: the plugin cannot read which provider
holds the slot, so the message is the only discriminant the service exposes.

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
| `GET /api/dsh-session-workspaces/map` | — | placements, groups, the candidate set, backfill progress, and `titleProvider` (`ok`/`unavailable`) |
| `POST /api/dsh-session-workspaces/mutate` | `{sessionId, workspace, group?}` or `{op: 'group.create'\|'group.rename'\|'group.delete'\|'group.removeMember', …}` | the map as it stands after the write |
| `POST /api/dsh-session-workspaces/backfill` | `{action: 'start'\|'status'}` | backfill progress and the map |
| `GET /api/dsh-session-workspaces/catalog` | — | the advertised `provider`/`model` routes, the providers that could not be enumerated, and the sample instant |

No extra CSRF layer is added: the browser session cookie is host-only, `HttpOnly`
and `SameSite=Strict`, and `api-request-trust.ts` refuses a cross-site `Origin`
before the body is read. The JSON content-type check is defense in depth.

The catalog route is the one route that does **not** read the durable store, so it
registers at apply time: the settings control has to be able to offer routes even
when the storage unit failed to open. It never fails — a provider whose models
cannot be enumerated is reported per provider and the rest of the catalog still
answers, and a directory that cannot even be listed answers an **empty** catalog
carrying the reason. A provider that advertises no models simply contributes no
option and is not a failure. The host samples it through `ctx.llm.listProviders()`
and `ctx.llm.listModels(provider)` and reuses one sample for 60 s, because a
remote adapter's model list is a network round trip.

Moving a Session into a group **owned by another workspace** moves the Session's
workspace too, in the same write: the group record carries its workspace.

Dropping a Session this plugin claimed onto a **core** row — a Workspace, or
`Ungrouped` — is a **release**: the browser posts
`{sessionId, workspace: <the undecided sentinel>}` with **no** group, which pins
the sentinel and lets the Session fall back to the core grouping without a second
model call. The write route accepts it — a plain assignment checks nothing about
the workspace beyond it being non-blank — while `group.create` **refuses** the
sentinel workspace with `UNKNOWN_WORKSPACE`, because a group under it would
recreate the `unknown workspace` root row the grouping deliberately stopped
serving. That asymmetry is what makes the release possible: the sentinel is
assignable, and only group creation is fenced from it.

## The browser half

The map is polled every 4 s (there is no push), and the grouping provider answers
a root-to-leaf path: `workspace › group` when a group exists, `workspace` alone
otherwise, and `undefined` in two cases — an unclassified Session, and a Session
whose classification recorded the undecided sentinel (the classifier could not
decide, answered outside the candidate set, or answered below the confidence
threshold) — so core grouping applies to both. The provider also declares the
seam's `drop` handler, which is what makes its rows drop targets and what
carries a move or a release to [the fenced write](#fenced-routes).

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

### Reload persistence (seam-owned; fixed in `deepseek-harness` `bd44518c48`)

Earlier builds pruned a provider group's persisted collapsed state and manual order
on the render that runs before this plugin's client bundle has registered its
provider (~60 ms after DOMContentLoaded), so a provider group reloaded expanded and
lost its saved Session order. **That is fixed in the seam**: since
`deepseek-harness` `49e9ef006e` retention is ownership-scoped — it prunes only the
keys the browser owns itself and leaves every key namespaced by a provider id
(`<providerId>:…`) untouched, registered or not.

Re-verified in a real browser against this plugin at `c939db4f` on
`deepseek-harness` `bd44518c48`: a collapsed provider workspace row and its collapsed
nested group both reloaded collapsed (`aria-expanded="false"`), and the group's
`sessionOrderByAccount` entry survived the reload.

A manual drag **inside** a provider row is deliberately **not** a reorder: the
seam gives a provider row no in-row order — its members render in the provider's
own membership order — so its same-row insert marker is suppressed and a same-row
drag commits nothing, while the same synthetic drag still reorders a Workspace or
`Ungrouped` row. A drop on **another** row is a cross-row drop, and that one is a
**move**: `WorkspaceGrouping.canDrop` decides whether a provider owns it,
`WorkspaceGrouping.drop` routes it to that provider, and this plugin's
`GroupingProvider.drop` posts the resulting assignment to its fenced write.
Releasing a claimed Session onto a **core** row is the same path with a different
target — see [Fenced routes](#fenced-routes).

## Settings

`settings.section` "Session workspaces": `enabled`, ONE compact, single-line
`<select>` for the classification route, the additional candidate list (with the
discovered labels shown read-only), the unknown label, the minimum confidence, and
the backfill action.

The unknown label is a **decision sentinel**, not a display bucket. It is the
label recorded when the classifier cannot decide, so a Session carrying it is
decided and never re-decided; it is not rendered as a row of its own, because the
browser half leaves such a Session on the core grouping; and it is the workspace
value a **release** writes when a claimed Session is dropped back onto a core row
([Fenced routes](#fenced-routes)).

The route control replaces the separate `provider` and `model` text fields and
offers, in order:

1. **Auto** — `Auto — use the Session's own route` — which writes EMPTY `provider`
   and `model`. That is the default path, where every Session classifies through
   its own logged route; making a value mandatory here would put that path out of
   reach from the UI.
2. one option per advertised route, labelled `provider/model` with the technical
   tokens verbatim and no decoration;
3. the route that is currently stored, when nothing advertises it, labelled
   `… (unavailable)` — so a configured route stays visible, and stays savable,
   while the catalog is missing or partial instead of the control silently
   dropping it.

A route is a **pair**, so the control carries ONE value for both fields
(`JSON.stringify([provider, model])`; the empty string is Auto) and the two Config
fields are read back out of the option list when the draft is written. A
mismatched pair is therefore not representable, and a value the list does not
carry writes nothing at all. The catalog itself comes from the Host's own fenced
`…/catalog` route — this half takes no dependency on a core client service — and a
read that fails or comes back empty leaves the control usable with the stored
value intact.

Every writable field is declared **`volatile`** in the Host `Config`, because a
non-volatile field is refused by the settings write gate; a write commits into
the running reference and emits `loader/volatile-update` instead of remounting the
plugin, and the plugin re-reads its live values at each use. Measured: setting a
bogus `provider`/`model` pair and saving made the very next Session unclassifiable
without a restart, and clearing them made the Session after that classify again.

## Backfill (opt-in)

Existing Sessions keep the core fallback group until they are classified. The
settings section offers an explicit, Human-triggered pass that:

- states its cost before it starts — one model call per Session it decides to
  classify, i.e. per Session whose stored log holds a human prompt; the undecided
  count it names is a sample — and requires a second confirmation;
- reads each stored Session's first Human prompt through
  `ctx.sessionQuery.readSession`, which replays the stored log without resuming
  the Session, and takes the route from the configured `provider`/`model` pair,
  falling back to that Session's own last `request/header` only while both are
  empty (`resolveRoute`);
- never runs automatically;
- bounds concurrency (`BACKFILL_CONCURRENCY`, default 2);
- resumes by skipping every Session that already carries a label or a pin, so a
  re-run costs nothing for settled work.

### The backfill is OUTSIDE the one-call-per-Session guarantee

Documented rather than fixed. The "exactly one model call per Session" promise
holds for the live path, where the header-driven work and the title provider
await ONE keyed decision. A Human-triggered backfill breaks it in two ways:

- **It can classify a Session concurrently with a live decision that has not yet
  been written durably.** The backfill reads stored Sessions and decides each
  before it sees a label, while a live Session that has just committed its first
  `request/header` may be mid-decision and not yet recorded — so the same Session
  can be classified twice, in two calls, and the later write wins.
- **It retries after a ledger failure.** A pass re-attempts Sessions that carry
  no label, so a decision that failed and was never persisted is attempted again
  on the next pass instead of being remembered as attempted.

The cost stays bounded (the pass spends at most one call per Session it decides
to classify and requires a second confirmation), and only the Human-triggered path
is affected:
no automatic path runs a second call for a Session.

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
channel and never on `webServer`), the route control's option union (Auto first,
then every advertised route, then a stored-but-unadvertised route as
`(unavailable)`, with no duplicates — and the empty pair Auto writes, which is the
default-path regression guard), the route catalog (a provider with no models, a
provider that fails while the rest of the catalog still answers, a directory that
cannot be listed at all, the cache window, and the browser state that keeps the
last good routes when a read fails), the provider's one-level / two-level /
unclassified paths, the map cache, the menu actions, and one real-composition boot
test through a generated `cordis.yml` that loads the BUILT artifact.

The title half is covered in that same composition: the provider's result contract
(title = summary, seqs from the request snapshot, throw when there is no summary,
abort on the request signal), the summary parser's every shape (in-limit,
over-long, quoted, padded, missing, empty, non-string, CJK without whitespace,
zero-width-only, and long Latin words that overrun the byte budget), the
exactly-one-call dedup when the header-driven path and the title provider ask for
the same Session, the registration guard (a duplicate warns with the precondition
and the host still boots; any other refusal is reported as itself), and the
`titleProvider` field on the map route in both states.

An external plugin does not run the harness's `verify-client-ui-i18n` or its
coverage gate; this plugin carries its own locale namespace and its own tests
instead.
