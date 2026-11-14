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

Node planner/executor has no Bash dependency. Linux execution contracts and CLI integration are tested locally using injected executors; no real package installation was performed. macOS and Windows are declared upstream platform targets but have not been live-tested. Windows execution is explicitly blocked until native executable resolution is implemented; plan generation remains available. Legacy `shared` still requires Bash and GNU readlink; native Windows use the Node entry directly. Host plugin installation and UI activation are unverified and require separate user approval.

## Upstream references

- https://github.com/jdx/mise — runtime selection, GitHub/Aqua backends and project configuration.
- https://github.com/astral-sh/uv — isolated tool installation and tool directory environment variables.
- https://github.com/pypa/pipx — isolated Python application installations.
- https://github.com/pnpm/pnpm — global directory and binary directory selection.
- https://github.com/Phant0Meow/dsh-meow-memory — seven-layer memory plugin.
- dsh-mnemon 0.5.45 shipped cordis.patch.yml — exact provider directory. Providers must be configured through that package; this module does not duplicate its Loader entries.

## Execution history

`shared target-history` (or `node assets/targets.mjs history`) reads independent JSON records in `<root>/state/target-runs/`. Each executed install records its target, scope, argv, workspace, start/end times, outcome and exit status. Preflight failure makes no install record or destination directories. A process killed before completion leaves a `running` record, which means interrupted/unknown, never success. The history is an audit log, not proof that a package remains installed. No credentials or inherited environment are saved.

## Verifying what was installed

```sh
shared target-verify          # JSON: present / absent / unverifiable, exit 1 if anything is absent
```

Reads succeeded records from `<root>/state/target-runs/`, keeps the latest per target+spec, and probes only layouts this version knows: npm (`env/npm/**/node_modules/<pkg>/package.json`), uv-tool (`env/uv-tools/<pkg>`), pipx (`env/pipx/venvs/<pkg>/pyvenv.cfg`), cargo (`env/cargo/bin/<pkg or pkg with - → _>`), go (`bin/<last module segment>`). Everything else (pnpm, bun, conda, mise, and cargo when the binary is named differently) reports `unverifiable` — the tool never reports presence it cannot prove. Failed runs are ignored. `present` proves a path exists with the expected layout, not that the package is the version you wanted; pin exact versions in the spec for that.

## Portability

`shared export` now includes a `targets` array built from succeeded install records (target, scope, spec, workspace, finished time). `shared import` never runs upstream managers: it prints one `shared install-target <target> <spec> --execute` line per entry so you decide what to reproduce, in which order, on the new machine. Failed runs are excluded from both.
