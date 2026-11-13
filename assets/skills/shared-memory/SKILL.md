---
name: shared-memory
description: 使用共享库融合的跨会话记忆后端：meow-memory 七层 SQLite 记忆（写入/检索/反思/dream）与可选的 dsh-mnemon 记忆空间；处理记忆相关命令、数据目录和故障排查时使用。
whenToUse: 需要记住/检索跨会话事实与项目决策、用户提到记忆/memory/记忆空间/dream/meow-trust、shared memory status 报告异常、或要启用 mnemon 后端时。
---

# 共享库记忆后端

分工定死：**dsh-shared-lib=手**（工具/开发环境/技能/guard/adopt 管理面），**记忆插件=脑子**。
本 bundle 融合两个上游记忆系统，二者定位不同，**默认只启用一套注入链**避免互相打架：

| 后端 | 上游 | 许可 | 挂载方式 | 数据落点 |
|---|---|---|---|---|
| meow-memory | github.com/Phant0Meow/dsh-meow-memory | MIT | 随本 bundle 的 `cordis.patch.yml` 自动挂载 | 数据家 `<root>/state/memory-home`（patch 已配 `homeDir`，首次 apply 自动从 `~/.dsh-meow` 迁移）+ 每工作区 `.dsh-meow/memory.db` |
| dsh-mnemon | github.com/mnemon-dev/mnemon（Go 引擎 + omdsh-dev 集成） | Apache-2.0 / MIT | **独立 bundle，默认不启用**（其自带分组 patch，禁止复制插行——重复条目 id 会卡死 Settings 保存，上游 issue #470） | 默认本地存储；Memory Spaces 的 Mnemon Native 需要 mnemon CLI |

## 常用操作

```bash
shared memory status              # 两套后端 shell 侧尽力探测
shared memory setup-mnemon        # 把 mnemon CLI 装进共享 npm 环境并软链进 PATH
shared status --json              # memory 字段含 meow/mnemon 状态与迁移注记
shared doctor --json              # mnemon CLI 缺失只算 warning，不算失败
# 模型侧 shared_lib(action:"memory") 直接读 Loader 条目：脑子挂载真相（含 disabled 状态）
```

## meow-memory（默认生效）

- 工具：`memory_remember`（写入，自动去重）、`memory_search`（BM25×衰减检索）、`memory_project`（项目全景）、`memory_find_similar`（查重）、`memory_read` / `memory_update`、`memory_dream`（手动整理）、`memory_home`（数据目录）。
- 会话首轮自动注入长期记忆快照；第二条消息起按关键词命中 top-2；压缩后自动重注入。
- `/dream` 在输入框手动整理本窗口记忆；空闲 ≥3h 自动触发（峰时抑制）。
- clone 来的仓库自带 `.dsh-meow` 会触发信任门：输入 `/meow-trust` 确认后才注入/检索。
- 配置在 `cordis.patch.yml` 的 `meow-memory` 行（`homeDir` 已由本包指向 `<root>/state/memory-home`；`enabled`/`hitTopK`/`promptLang`/`dream.*` 等全表见上游 docs/配置参考.md）。改 shared-lib 的 `root` 时 `homeDir` 要一起改。

## dsh-mnemon（可选启用）

1. 本 bundle 安装后，用 `plugin_manager(action:"install_bundle", target:"dsh-mnemon")` 或等效方式启用其独立 bundle（会带上 sources/strategies/providers 全套行）。
2. 需要 Memory Spaces 本地 provider 时：`shared memory setup-mnemon` 安装 Go CLI，再 `mnemon --version` 验证。
3. 启用两套记忆前想清楚：双插件都会往首轮注入内容，token 翻倍且可能互相覆盖。二选一为主。

## 排错

- `shared memory status` 显示 meow 全局目录 not-created：正常，首个启用 meow 的会话运行时自动创建。
- 工作区里出现非自己建的 `.dsh-meow`：先别信，输入 `/meow-trust` 之前插件会暂停注入（信任门设计）。
- Settings 页保存不了且 profile 里有重复的 `mnemon` 行：说明复制过 dsh-mnemon 的插行——删掉重复行，只保留其自带 bundle。
- 记忆检索不准：先改条目的 keywords/importance（写入时填全），再考虑 `hitTopK`。
