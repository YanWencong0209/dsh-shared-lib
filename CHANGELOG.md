# Changelog

## 0.7.0 — 案例检索覆盖方案与失败尝试

- `search` 同时匹配 `attempts`/`solution`（权重 0.5，头部字段 1.0），返回 `matchedIn: ['head'|'body']` 让调用方知道命中来源。
- 新增 `limit`（1–20，默认 5，超出夹紧）；排序说明写进返回的 `ranking` 字段。
- 实测：仅写在 attempts 里的关键词也能命中，且排在头部命中之后。

## 0.6.9 — 版本漂移检测

- `target-verify` 在能读到版本时给出 `requestedVersion` / `installedVersion` / `matchesSpec`（范围版本或布局无版本时为 `null`），并统计 `drifted`。
- `shared doctor` 把 `matchesSpec:false` 报为 `TARGET_DRIFT`，附「卸载 + 重装」修复命令。
- 实测（npm 11.17.0）：装 `left-pad@1.3.0` → `matches true`；把已装 `package.json` 改成 `1.3.1` → `drifted:1` 且 doctor 输出修复命令；卸载后 verify 归零。
- `targets --summary` 增加 drifted 计数。

## 0.6.8 — 紧凑目标视图与安装边界记录

- 新增 `shared targets --summary`（约 0.5 KB，对比完整 JSON 约 5 KB）：管理器/来源/未实现项/声明安装计数/最近三次执行。
- 记录实测环境限制：**bun 1.3.3 在本容器段错误**（`bun pm ls -g` 亦报 EBADF），bun 仍标 `unverifiable`；pipx/uv 未安装，同样只有契约测试。

## 0.6.7 — pnpm 真实冒烟与可核验

- pnpm 安装/卸载固定 `store` 到 `env/pnpm/store`：此前 `PNPM_HOME=bin` 会把 1.9MB store 建进工具目录。
- `pnpm remove` 要求 global bin dir 在 PATH：两份计划统一 `PNPM_HOME=<root>/bin`（`executePlan` 已注入 PATH）。
- pnpm 由 `unverifiable` 改为可探测：真实布局是 `env/pnpm/<pnpm-major>/node_modules/<pkg>`；bun/conda/mise 仍标 unverifiable。
- 真实端到端（pnpm 10.34.5）：装 left-pad → verify present → 卸 → 0 项、bin 干净、store 留在 env。

## 0.6.6 — 修复活体调用暴露的两个缺陷

重启后真实调用 `shared_lib(action:"targets")` 与 `shared_cases(action:"stats")` 各报一个错，均已修：

- `targets`/`memory` 报告返回 `{text, exitCode, state}`，但输出 schema `additionalProperties:false` 只声明 `text`/`exitCode` → 校验拒绝。已在 schema 声明 `state`，并加测试断言返回值不含未声明键。
- `caseTool` 的转发代理写死 `save/read/search/pending`，schema 里的 `archive/stats/prune` 调用即崩（`store.stats is not a function`）→ 改为通用 Proxy，缺方法时给出明确错误；测试遍历 schema 枚举逐个调用。

## 0.6.5 — 状态与诊断覆盖目标矩阵/案例库

- `shared status --json` 增 `targets {runs, declared}` 与 `cases {active, archived}`；文本输出加"目标/案例"两行。
- `shared doctor` 把"已声明但磁盘找不到"的安装列为 `TARGET_ABSENT` 问题（退出码非零），并给出 `shared install-target <t> "<spec>" --execute` 修复命令。
- 读取用只读打开（`node:sqlite` readOnly），数据库缺失时降级为 `null` 而不是谎报 0。

## 0.6.4 — 案例库 CLI

- `shared cases search|read|save|stats|archive|prune|pending`：不依赖插件重载即可用，工作区语义与模型工具一致。
- 插件铺盘时把案例模块作为隐藏文件 `.shared-cases.mjs` 放到 `bin/`，与 `targets.mjs` 同一模式。
- 实测：保存→检索→读取→统计→归档全链路；跨工作区不可见；`prune 0` 与不完整 `save` 均退出码 1。

## 0.6.3 — 目标可卸载

- 新增 `shared uninstall-target <target> <spec> [--execute]` 与 `targets.mjs uninstall`：按管理器给出卸载 argv，`go` 明确返回 `supported:false`。
- 安装/卸载记录统一以 target+spec 为键；卸载成功写 `uninstalled`，同时从 `target-verify` 与 `shared export` 中移除该声明。
- 修复：卸载键与安装键不一致导致声明清不掉；`export` 仍列出已卸载包。
- 真实端到端验证（npm 11.17.0）：装 `left-pad@1.3.0` → verify `present` → 卸载 → verify 0 项、磁盘清空、export 为空。

## 0.6.2 — 目标矩阵进工具面

- `shared_lib(action:"targets")`：一次返回管理器/来源/记忆目标规模、已声明安装的核验摘要、最近 5 条执行记录；只读，安装仍需 CLI `--execute`。
- 报告在存在 absent 声明时退出码非零，但不阻断渲染（verify 的 1 与"命令失败"区分开）。

## 0.6.1 — 修复安装期激活失败

- **移除** `cordis.patch.yml` 里的 meow-memory 行：`link:` 安装不会把被链接包的 dependencies 装进 profile，
  Loader 解析 `meow-memory` 得到 `ERR_MODULE_NOT_FOUND`，导致整包 `application: failed`（0.6.0 实测）。
- **移除** `package.json` 的 `dependencies`：同上原因，声明了也不会被安装，反而误导。
- 记忆后端改为各自独立 bundle：`plugin_manager(install_bundle, target:"meow-memory" | "dsh-mnemon")`，
  由上游自带 patch 负责挂载；本包 patch 只保留注释说明。
- 回归测试改为断言 patch 中**没有** memory 行，防止再次引入。


## 0.6.0 — 目标可核验与排障记忆（开发分支，未合并 main、未安装）

- 目标矩阵：9 个管理器/运行时适配器、6 类可用来源、10 个记忆后端配置目标；`shared targets` 查询，`shared install-target` 默认只出计划，`--execute` 才调用上游 CLI。
- `shared target-verify`：按已知布局保守探测 present/absent/unverifiable，不猜成功；有 absent 时退出码 1。
- `shared export` 增 `targets` 数组（仅成功记录），`shared import` 只打印复现命令，不代跑上游管理器。
- Windows：计划层给出 `npm.cmd`/`npm.exe` 候选；执行仍显式阻断（无真机验证）。
- 执行历史：`<root>/state/target-runs/*.json`，原子写入，记录 target/scope/argv/cwd/起止/退出码；不含环境变量与凭据。
- `shared_cases` 排障案例库：search（≤5 条短摘要）/read/save（六字段+证据）/pending/archive/stats/prune；项目隔离、跨项目需显式 shared；失败事件只记元数据且可被案例认领。
- 检索排序 = 关键词 × 90 天半衰期；`prune` 只归档不删除，必须显式给天数。
- 记忆状态分 declared / active / data 三层，只有 `memory_*` 工具可见才算激活。

## 0.5.0

- 目标矩阵、执行历史、案例记忆首次落地。

## 0.4.0

- 工具清单 `state/tools.json` + sha256 校验、`verify`/`export`/`import`/`outdated`/`uninstall`；`doctor --json` 输出 `{code,message,fix}`。
- 融合 meow-memory（数据家入 `state/memory-home`）与可选 dsh-mnemon。
