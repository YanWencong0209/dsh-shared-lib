# Target expansion — development branch

The v0.4 main branch remains unchanged. This branch adds a native Node target planner and executor, separate from the legacy Bash CLI.

## Commands

```sh
node assets/targets.mjs list
node assets/targets.mjs install uv-tool ruff==0.9.0
node assets/targets.mjs install mise node@24 --scope project
# Executes upstream package installation, including upstream install hooks:
node assets/targets.mjs install uv-tool ruff==0.9.0 --execute

# Same interface through legacy shared:
shared targets
shared install-target pipx ruff==0.9.0
shared install-target pipx ruff==0.9.0 --execute
```

Default behavior is plan-only: JSON reports executable, argv, environment, shared destination, workspace, effects and PATH entries. Execution first checks the upstream CLI, then invokes it without a shell and returns its exit status. Missing CLIs are not silently installed. No system PATH links are changed. Existing v0.4 export/verify currently cover downloaded binary tools only, not this module's managed package environments.

## Managers and scopes

| Target | Upstream operation | Destination / scope |
|---|---|---|
| npm | install --global --prefix | env/npm, shared |
| pnpm | add --global --global-dir --global-bin-dir | env/pnpm + bin, shared |
| bun | add --global | BUN_INSTALL + BUN_INSTALL_BIN, shared |
| uv-tool | tool install | UV_TOOL_DIR + UV_TOOL_BIN_DIR, shared |
| pipx | install | PIPX_HOME + PIPX_BIN_DIR, shared |
| cargo | install --root | env/cargo, shared |
| go | install module@version | GOBIN, shared |
| conda | create --prefix | env/conda, shared |
| mise | install / use | MISE_DATA_DIR; shared installs or project mise.toml |

Mise shared install does not select an active version. Use upstream `mise exec` with the reported environment. Conda environments need upstream activation. This is not a reproducible lockfile for all managers; pass pinned upstream package identifiers where available.

## Memory and sources

Catalog lists meow-memory and the nine providers declared in dsh-mnemon 0.5.45: mnemon-native, openviking, honcho, mem0, hindsight, holographic, retaindb, byterover and supermemory. These are configuration targets, not verified activations or automatically provisioned cloud services. Existing backend activation is unchanged.

Sources mapped to upstream managers: npm, PyPI, crates, Go modules, plus mise GitHub Releases (`github:owner/repo@version`) and Aqua backends. Arbitrary archive extraction, source builds, containers and remote hosts remain explicitly unimplemented.

## Platforms and verification

Node planner/executor has no Bash dependency. Linux execution contracts and CLI integration are tested locally using injected executors; no real package installation was performed. macOS and Windows are declared upstream platform targets but have not been live-tested. Windows execution is explicitly blocked. Plans now carry `commandCandidates` (`npm.cmd`, `npm.exe`, `npm` on win32) so the resolution contract is explicit, but no Windows machine was available to verify spawning; enabling execution needs a real test there first. Legacy `shared` still requires Bash and GNU readlink; native Windows use the Node entry directly. Host plugin installation and UI activation are unverified and require separate user approval.

## Upstream references

- https://github.com/jdx/mise — runtime selection, GitHub/Aqua backends and project configuration.
- https://github.com/astral-sh/uv — isolated tool installation and tool directory environment variables.
- https://github.com/pypa/pipx — isolated Python application installations.
- https://github.com/pnpm/pnpm — global directory and binary directory selection.
- https://github.com/Phant0Meow/dsh-meow-memory — seven-layer memory plugin.
- dsh-mnemon 0.5.45 shipped cordis.patch.yml — exact provider directory. Providers must be configured through that package; this module does not duplicate its Loader entries.

## Execution history

`shared target-history` (or `node assets/targets.mjs history`) reads independent JSON records in `<root>/state/target-runs/`. Each executed install records its target, scope, argv, workspace, start/end times, outcome, exit status and `commandVersion` — the upstream CLI that actually ran it (e.g. `go version go1.24.0 linux/arm64`, `npm 11.17.0`), so a later failure can be attributed to a toolchain change. pipx installs now report their version from the venv's `dist-info/METADATA`, the same helper uv uses. Preflight failure makes no install record or destination directories. A process killed before completion leaves a `running` record, which means interrupted/unknown, never success. The history is an audit log, not proof that a package remains installed. No credentials or inherited environment are saved.

## Removing a declared install

```sh
shared uninstall-target npm left-pad@1.3.0            # plan only
shared uninstall-target npm left-pad@1.3.0 --execute  # runs the upstream uninstall
```

npm/pnpm/bun/uv-tool/pipx/cargo/conda/mise each get their own uninstall argv in the same isolated root. `go install` has no uninstall verb: the command returns `supported: false` with a note instead of pretending. A successful uninstall writes an `uninstalled` record; it removes the entry from both `target-verify` and `shared export` (latest record per target+spec wins).

**Real end-to-end check (2026-11-14, `npm` 11.17.0):** installed `left-pad@1.3.0` into `/root/shared/env/npm` → `target-verify` reported `present` with evidence `env/npm/lib/node_modules/left-pad/package.json` → `uninstall-target --execute` removed it → `target-verify` returned 0 items, disk empty, `export.targets` empty. Before that check, two defects were found and fixed: uninstall records did not clear the declaration (key mismatch `left-pad@1.3` vs `left-pad`), and `export` still advertised uninstalled packages.

## Verifying what was installed

```sh
shared target-verify          # JSON: present / absent / unverifiable, exit 1 if anything is absent
```

Reads succeeded records from `<root>/state/target-runs/`, keeps the latest per target+spec, and probes only layouts this version knows: npm (`env/npm/**/node_modules/<pkg>/package.json`), pnpm (`env/pnpm/<pnpm-major>/node_modules/<pkg>/package.json`), uv-tool (`env/uv-tools/<name>` plus version from `lib/pythonX.Y/site-packages/<name>-<ver>.dist-info/METADATA`), pipx (`env/pipx/venvs/<pkg>/pyvenv.cfg`), cargo (`env/cargo/bin/<pkg or pkg with - → _>`), go (`bin/<last module segment>`). Everything else (bun, conda, mise, and cargo when the binary is named differently) reports `unverifiable` — the tool never reports presence it cannot prove. Failed runs are ignored. `present` proves a path exists with the expected layout, not that the package is the version you wanted; pin exact versions in the spec for that.

## Portability

`shared export` now includes a `targets` array built from succeeded install records (target, scope, spec, workspace, finished time). `shared import` never runs upstream managers: it prints one `shared install-target <target> <spec> --execute` line per entry so you decide what to reproduce, in which order, on the new machine. Failed runs are excluded from both.

## Install status (verified 2026-11-14)

Bundle installed into profile `web` as `dsh-shared-lib@0.6.1`: `application: applied`, `warnings: []`. `shared_lib` and `shared_cases` are registered for the agent, both skills appear in the catalog, and the CLI is seeded at `/root/shared/bin/shared`. Verified commands: `status`, `targets` (9 managers / 10 memory targets / 10 sources), `install-target uv-tool ruff==0.9` (plan only, `executed:false`), `target-verify` (empty history → 0 items), `memory status`.

## Upgrading an installed link bundle (observed 2026-11-14)

`install_bundle` on an already-installed bundle returns `already-installed`; the way to switch versions is `remove_bundle` then `install_bundle`. With a `link:` target both calls reported `application: restart-required` (`restartReason: unmanaged-plugin`) — the running process holds the old module, so the new code only becomes live after restarting DSH. Profile registration and seeded CLI assets update immediately (`shared version` read 0.6.2), but that is not proof the running plugin is 0.6.2. Treat `restart-required` as "not live yet".

## pnpm specifics (observed on real installs, 2026-11-14)

Two problems only a real install exposes:

1. pnpm derived its **store** from `PNPM_HOME`, so pointing that at `bin/` created `bin/store` (1.9 MB of cache inside the tool directory). Both plans now pin `--store-dir <root>/env/pnpm/store` (install) and `--config.store-dir=<root>/env/pnpm/store` (remove); `remove` has no `--store-dir` flag.
2. `pnpm remove` aborts with *"The configured global bin directory ... is not in PATH"* unless the global bin dir is on `PATH`. `executePlan` already prepends `<root>/bin`, so both plans set `PNPM_HOME=<root>/bin` — no PATH mutation outside the child process.

Real cycle verified through `shared`: install `left-pad@1.3.0` → `target-verify` `present` (`env/pnpm/5/node_modules/left-pad/package.json`) → `uninstall-target --execute` → verify 0 items, `bin/` clean, store kept under `env/pnpm/store`. An inconsistent store (e.g. deleting it behind pnpm's back) makes both add and remove fail — wipe `env/pnpm` and reinstall rather than patching the store.

## Version drift, not just presence

`present` only proves the path exists. When the spec pins an exact version (`pkg@1.2.3`), `target-verify` also reads the installed `package.json` version and reports `requestedVersion`, `installedVersion` and `matchesSpec` (`true`/`false`/`null` when the spec is a range or the layout exposes no version). `shared doctor` turns `matchesSpec:false` into a `TARGET_DRIFT` issue with an uninstall+reinstall fix command.

Verified live on npm 11.17.0: install `left-pad@1.3.0` → `matches true`; editing the installed `package.json` to `1.3.1` → `drifted: 1` and doctor printed the repair command. After uninstalling, `target-verify` returned 0 items.

## Reading the matrix cheaply

`shared targets` prints the full catalog JSON (~5 KB). `shared targets --summary` prints one screen (~0.5 KB): manager list, wired sources, unimplemented sources, declared-install counts and the last three runs. Use `--summary` when you only need to know what is supported; reach for the full JSON (or `shared target-verify`) only when you need per-item evidence paths.

## Environment limits observed (2026-11-14)

- **bun 1.3.3 segfaults in this container** (`panic: Segmentation fault at address 0x7F7F7F7F7F8017`; `bun pm ls -g` also fails with `EBADF`). The bun adapter's argv/env contract is unit-tested, but no real install could be verified here, so bun stays `unverifiable`.
- pipx and uv are not installed in this container, so those two adapters likewise remain contract-tested only.

## Staleness detection (added 0.7.1)

`apply` writes `<root>/state/runtime.json` with the version of the module this process actually imported. A process that was started before a package update keeps the old value, so `shared status` prints `CLI <version> / 运行中 <version>` and flags a mismatch, and `shared doctor` reports `PLUGIN_STALE` with "restart DSH". This exists because the 0.6.6→0.7.0 fixes were pushed and seeded while the live process kept answering from 0.6.5 for four rounds.

## uv-tool specifics (real run, 2026-11-14)

Bootstrapped `uv 0.13.8` through `shared get` with the release `.sha256` (checksum accepted), then exercised the adapter in a throwaway root so the user's shared library stayed untouched:

```sh
shared install-target uv-tool ruff==0.9.0 --execute   # uv tool install
shared target-verify                                  # present, installedVersion 0.9.0, matchesSpec true
shared uninstall-target uv-tool ruff==0.9.0 --execute # Uninstalled 1 executable: ruff
shared target-verify                                  # 0 items
```

Three defects only real use exposed, all fixed:

1. `packageOf('ruff==0.9.0')` returned the whole string, so the probe looked for `env/uv-tools/ruff==0.9.0` (absent) and `uv tool uninstall` received a version selector it rejects. It now strips `==`/`>=`/`~=`/extras as well as npm's `@`.
2. `verify` computed the version only from `package.json`, discarding the probe's dist-info result → `installedVersion: null` for every Python tool. Probe-reported versions now win.
3. `shared get` linked downloaded **archives** (`uv.tar.gz`) into the PATH directory as if they were commands. Archive extensions are now skipped by `link`.

Version comparison for pip-style pins works end to end: `requestedVersion 0.9.0`, `installedVersion 0.9.0`, `matchesSpec true`.
