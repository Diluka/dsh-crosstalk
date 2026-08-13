# Shipping dsh-crosstalk

**Scope: GitHub only — npm publishing is deferred.** The repo lives at
`https://github.com/Jesse-njx/dsh-crosstalk`. Everything below is verified
locally and pushed to that repo; `npm publish` is deliberately NOT performed.

## 0. Preflight (verified locally)

- `pnpm typecheck` (also clean under `--noUnusedLocals/--noUnusedParameters`)
  and `pnpm build` — clean.
- `pnpm test` — 49 tests green:
  - identity (slug/adjective/name/ref determinism, collision-free names),
  - registry (heartbeat round-trip, freshness + GC, live/stale/unknown
    resolution, orphan-inbox collection, crash-mid-write),
  - message codec (label framing, atomic write, corrupt tolerance, relay vs
    notice injection sources),
  - inbox watcher (wake-on-idle delivery, tmp/corrupt handling, policy
    drops, no-agent retry/drop, delivery-failure retry, reentrancy),
  - tool decoration against the **real** Cordis scoped tool registry
    (per-agent shadowing, stock delegation, restore-on-dispose),
  - two-session round-trip through a shared home directory (A→B, reply B→A),
    stale-peer rejection, status tracking, config validation.
- `pnpm pack` — tarball contains `lib/`, `cordis.patch.yml`, `README.md`,
  `README.zh.md`, `LICENSE`; manifest carries `dsh.bundle.patch` and the
  repository metadata.
- **Consumer simulation**: the packed tarball installs into a scratch npm
  project (with the `@deepseek-ai/*` peer deps) and the bundle entry,
  registry, and watcher all run against the built artifacts.
- **Dependency pattern**: all `@deepseek-ai/*` packages are
  `peerDependencies` (the ecosystem convention — regular deps would install
  duplicate copies into DSH profiles and break tool dispatch). The package
  has **zero runtime dependencies**.

## 1. GitHub repo (done)

```sh
gh repo create Jesse-njx/dsh-crosstalk --public --source . --push
```

Repo settings:

- **Topics**: `dsh-plugin` (required by deepseek-harness CONTRIBUTING.md)
  plus `deepseek-harness`, `crosstalk`, `messaging`, `multi-session`.
- **Description**: "Cross-session messaging for DSH — any session on the
  machine can list and message any other, Claude Code-style."

Post-push follow-ups:

- Add the repo to the awesome-dsh-plugin list (one line under
  **🛠️ Tools & Capabilities** in `README.md` and `README.zh.md`).
- Post a short note on
  https://github.com/deepseek-ai/deepseek-harness/discussions (the ecosystem
  channel CONTRIBUTING.md points at).
- Record the two-terminal demo GIF (Terminalizer / VHS / asciinema → GIF)
  showing: two sessions booting, `list_agents peers`, a `send_message`
  round-trip with the labeled turn appearing in the peer, and a stale entry
  disappearing.

## 2. Live DSH verification (two terminals)

With a real provider configured (your DSH web profile), install from the
repo checkout:

```sh
git clone https://github.com/Jesse-njx/dsh-crosstalk
cd dsh-crosstalk && pnpm install && pnpm build
dsh plugin --profile web add /path/to/dsh-crosstalk   # or via npm once published
```

Then start two DSH sessions in two different repos and, in either one:

```
#   list_agents peers            -> both sessions listed with names
#   send_message to="<other name>" message="hello" summary="round-trip"
```

The other session wakes, sees the `[message from session ...]` turn, replies,
and the reply wakes the sender. Also verify from the terminal that
`~/.dsh/crosstalk/registry/` shows one heartbeat per session and that a
killed session's entry disappears after `staleAfterMs`.

## 3. npm publish (deferred, not performed)

When the ecosystem flow calls for it:

```sh
pnpm publish --access public   # under the @dsh-crosstalk scope
```

`prepublishOnly` runs the build; `repository`/`homepage`/`bugs` already point
at the GitHub repo. Per the owner's instruction, publishing to npm is
deliberately skipped for now.

## 4. v0.2 follow-ups

- Structured task replies for coordinator→worker flows (typed payloads on
  top of the same inbox transport).
- Presence polish: session names stable across restarts (deterministic
  adjective from cwd), `dsh crosstalk` CLI (`list`, `send`, `inbox`).
- UI toast/notification for inbound messages (the `notifyUser` flag is
  already wired to relay/notice presentation; a browser notification is the
  natural next step).
