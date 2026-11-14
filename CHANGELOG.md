# Changelog

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
