# dsh-shared-lib

开发分支的新目标目录与安装计划入口见 [TARGETS.md](TARGETS.md)；问题与验证方案的复用入口见 [CASE-MEMORY.md](CASE-MEMORY.md)。

跨工作区、跨会话共用的共享库：**工具 bin、开发环境、技能** 三样东西放一个目录里，
外加一道前置 guard，拦住「`pip install` / `npm install -g` 装到系统、换个工作区就丢」这条最常见的坑。

v0.5.x（开发分支 feature/target-matrix，未合并未安装）新增目标矩阵与排障案例：`shared targets`/`shared install-target`（默认仅出计划，--execute 才动上游管理器，每次执行留 JSON 记录）、`shared_cases` 排障案例库（详见 TARGETS.md 与 CASE-MEMORY.md）。

v0.4.x 起共享库工具面补齐「声明式清单 + 完整性 + 跨机复现」（借 flox/devbox/mise 的思路，纯 Node 内置实现，零新增运行时 import）：`shared get` 可选 `--sha256`/`--version` 并在通过后写入 `state/tools.json` 清单，`verify` 离线检测缺失/sha256 漂移，`export`/`import` 跨机复现工具，`outdated` 看没记版本的项，`uninstall` 一次删净 bin+软链+清单，另加 `uv/cargo/go` 薄透传（缺失即明确报错，不静默）。`doctor --json` 的 issues 现在是 `{code,message,fix}` 对象，直接给出可执行修复命令（basic-memory doctor 风格）。

v0.3.x 起融合两套上游记忆系统（见文末「记忆后端」，分工=shared-lib 是手、记忆是脑子）：meow-memory 七层 SQLite 跨会话记忆随 bundle 自动挂载且数据家收进 `<root>/state/memory-home`，dsh-mnemon 记忆空间作为可选独立 bundle。共享库本体（工具 / 环境 / 技能 / guard）不新增运行时 import，只用 Node 内置模块；记忆后端作为 `dependencies` 随 bundle 带入 profile。

## 装

这个运行时里 bundle 必须是「一个可被 `plugin_manager` 挂载的目录」，压缩包不能直接导入。三步：

```bash
# 候选包需由用户明确确认后，再通过 Harness 插件管理器安装。
# 当前目录安装目标：/root/dsh-shared-lib-audit/dsh-shared-lib
# 安装/升级后按 Harness 返回的 application 和 warnings 核验生效状态。
```

装完自检：

```bash
shared status          # 概况 + 模式 + 拦截对账 + 硬报错
shared status --json   # 机器可读状态
shared doctor          # 依赖与链接自检
shared doctor --json   # 机器可读诊断和退出状态
shared list --json     # 工具、技能、Node/Python 清单
shared memory status   # 记忆后端探测（meow-memory / mnemon）
shared verify          # 清单完整性离线校验（missing/corrupt 非零退出）
node --test test/*.test.js   # 47 项回归测试
```

## 目录

| 路径 | 内容 |
|---|---|
| `<root>/bin` | 命令行工具，插件启动时软链到 `<linkDir>`（默认 `/usr/local/bin`，已在 PATH） |
| `<root>/env/python` | Python venv（`shared pip` 首次自动创建；ensurepip 缺失时自动 get-pip 引导） |
| `<root>/env/npm` | Node 全局 prefix（`shared npm -g` 装这里） |
| `<root>/skills` | 技能根，注册成**全局**技能 provider，所有会话可见，递归监听、改完即时生效 |
| `<root>/cache` | pip / npm / uv 缓存 |
| `<root>/state` | 工作区安装模式（一工作区一文件，临时文件 + rename 原子写入，无锁）；`tools.json` 声明式清单（每个 `shared get` 的 url/sha256/version，verify/export/import 的依据） |
| `<root>/logs` | `hook.log` 拦截流水（含 corrected 对账）、`adopt.log` 历史、`adopt-<run>.jsonl` 单次迁移清单 |

根目录默认 `/root/shared`，`linkDir` 默认 `/usr/local/bin`，都在 `cordis.patch.yml` 的 config 里。

## 前置 guard

只拦两种语义明确的命令，且只在**当前目录向上找不到项目清单**（`package.json`、`requirements.txt`、
`pyproject.toml`、`setup.py`、`setup.cfg`、`Pipfile`、`go.mod`、`Cargo.toml`、`composer.json`）
或 `.dsh-shared-root` 标记时：

- `pip install ...`（含 `pip3`、`python -m pip install`）
- `npm install -g ...`（`i` / `install` / `add` 带 `-g` / `--global`）

被拦时**只拒绝、不改写**，返回可直接复制的正确命令。判定基于模型写下的原始字符串（shell 解析之前），
只做保守词法扫描；带引号、重定向、`$(...)`、反引号、heredoc、取不到内容的 `-c` 一律放行。

设计底线：**误拦不可接受，漏拦可接受**。漏掉的交给 `shared adopt` 兜底。
`-c` 的内容会递归判定（`bash -c "pip install x"` 同样被拦）。

判定优先级：`.dsh-shared-root` 标记 > 清单文件 > 正向缓存（只缓存命中，否定结果每次重算）。

## 逃逸

| 方式 | 作用范围 |
|---|---|
| `SHARED_BYPASS=1 pip install ...` | 只这一条命令（必须写在同行前缀） |
| `shared mode local` | 当前工作区长期放行；`shared mode shared` 恢复 |
| `intercept: false`（config） | 全局关掉前置拦截，退回纯引导 |

不要用 `bash -c`、heredoc、脚本包装去绕——规则会递归检查，绕过去只会让日志和对账失真。

## adopt / restore

```bash
shared adopt .                    # 预演，只看不改
shared adopt . --yes --class A    # 只搬单文件可执行
shared restore                    # 回滚 A 类
# 执行 adopt 会生成 logs/adopt-<run-id>.jsonl，含逐项成功/失败记录
```

| 类 | 对象 | 处理 |
|---|---|---|
| A | 单文件可执行 | `ldd` 无 `not found`、不引用工作区路径才 `mv` 进 `bin/` 并 link；脚本不自动搬 |
| B | `node_modules` | 不拷贝目录，读顶层包 name@version 在共享 prefix 重装；默认需 `--class B` |
| C | venv | 目录写死绝对路径不可搬，`pip freeze` 在共享 venv 重建；默认需 `--class C` |
| D | 有清单的项目依赖 / 编译产物 | 不动，也不该动 |

B/C 重装按包逐项执行；失败时记录本次成功项并手动卸载回滚。自动回滚尚不支持。

## 工具清单与跨机复现（v0.4）

`state/tools.json` 是工具的唯一真相（name/url/sha256/version/size/installedAt）。

```bash
shared get <url> <name> --sha256 <hex> --version 1.2.3   # 校验通过才落盘，失败拒绝且不写
shared verify [--json]      # 离线：missing/corrupt→非零；unpinned 提醒补 --sha256
shared export > snap.json   # 工具+包+技能的可移植清单
shared import snap.json     # 默认 dry-run；--force 才下载复现（sha256 不符直接中止）
shared outdated             # 列出没记版本标签的工具
shared uninstall <name>     # 删净 bin + 软链 + 清单条目
shared uv|cargo|go ...      # 薄透传，工具没装明确报错（不静默、不改写）
```

`doctor --json` 的 issues 为 `{code,message,fix}`：如 `NOT_LINKED→shared link`、`INTEGRITY_corrupt→shared get "<url>" <name> --sha256`。跨机时 npm/python 包在 import 末尾给出手动 `shared npm/pip install` 命令，不静默改动目标机环境。

## 配置（cordis.patch.yml）

```yaml
- insert:
    - id: shared-lib
      name: 'dsh-shared-lib'
      config:
        root: /root/shared
        linkDir: /usr/local/bin
        intercept: true              # false = 关掉前置拦截
        # npmGlobalIgnoreManifest: true  # -g 安装不再看项目清单，永远拦
        # manifests: [package.json, requirements.txt]   # 覆盖清单白名单
```

## 边界

- 只覆盖模型侧的 `bash` 工具；用户自己终端、`/app` 设备通道不经过 guard。
- `uv add`、`cargo install`、`go install`、`conda` 不拦，靠 adopt 兜底。
- `shared pip` 装的包只有 `shared python` 能看到，系统 `python3` 看不到。

## 记忆后端（融合，手脑分工）

**dsh-shared-lib=手**（工具/开发环境/技能/guard/adopt 管理面），**记忆插件=脑子**。

| 后端 | 上游 | 许可 | 挂载 | 数据 |
|---|---|---|---|---|
| meow-memory | github.com/Phant0Meow/dsh-meow-memory | MIT | 本 bundle 的 `cordis.patch.yml` 插行，安装即生效 | 数据家 `<root>/state/memory-home`（patch 配 `homeDir`，首次 apply 自动从 `~/.dsh-meow` 迁移）+ 每工作区 `.dsh-meow/memory.db` |
| dsh-mnemon | github.com/mnemon-dev/mnemon（Go 引擎 + omdsh-dev 集成，npm 包 `dsh-mnemon`） | Apache-2.0（引擎）/ MIT（集成） | 依赖带入 profile；**作为独立 bundle 由用户另行启用，默认关闭** | 本地存储；Mnemon Native provider 需 mnemon CLI |

约束与理由（按上游文档实证，非猜测）：

- **dsh-mnemon 刻意不插行**：其自带 bundle patch 是「分组 + `!!js` 表达式」的完整结构，其文档明确警告复制插块会重复条目 id、导致 Settings 无法保存（上游 issue #470）。启用方式：`plugin_manager(action:"install_bundle", target:"dsh-mnemon")`。
- **meow-memory 不要再单独启用其官方 bundle**：同理，重复 id 会冲突；本包已代其插行。
- mnemon 的 Memory Spaces 本地 provider（Mnemon Native）需要 mnemon CLI：`shared memory setup-mnemon` 会把它装进共享 npm 环境（`<root>/env/npm`）并软链进 PATH。
- 双记忆后端同时启用会各注入一份首轮上下文（token 翻倍、互相不知情），建议以一套为主。
- 版本兼容实证：`meow-memory@0.32.7` CHANGELOG 记录其在 dsh 0.2.1-rc.2 真机端到端验证（本 profile 线 0.2.2-rc.1）；`dsh-mnemon@0.5.45` engines 要求 `dsh >=0.2.1-rc.1 <0.3.0-0`，与当前宿主一致；`node:sqlite` 在本机 Node 24 可用。
- 状态探测：shell 侧 `shared memory status` / `shared status --json` / `shared doctor --json` 的 `memory` 字段（best-effort，含 legacy→共享数据家迁移注记）；模型侧 `shared_lib(action:"memory")` 直接读 Loader 条目，是脑子挂载真相（含 disabled）。mnemon CLI 缺失只算 warning。

## 开发

```bash
node --test test/*.test.js   # commands/interceptor=拦截规则，hardening/diagnostics=CLI 加固与 JSON，manifest=清单/完整性/复现，fusion=记忆后端配置（手脑分工），seed/provider=资产与技能（47 项，含 targets/cases 模块）
```

改代码后已安装的 profile 需要按 Harness 返回状态决定是否重启；不要通过改入口名规避模块缓存。
`lib/index.js` 是兼容入口，实现放在 `lib/bundle.js`，`main` / `exports` / `cordis.entry` 指向实现文件。
