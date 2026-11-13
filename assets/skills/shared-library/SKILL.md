---
name: shared-library
description: 往跨工作区/跨会话共用的共享库（/root/shared）里装工具、Python/Node 依赖和技能，处理 pip/npm 安装被拦截的情况，或把工作区里散落的工具搬进共享库时使用。
whenToUse: 需要下载新工具、创建隔离的 Python 环境、安装全局 Node 包、新增技能、被 shared-lib 拦截了安装命令、或发现工作区里有该搬走的工具/依赖时。
---

# 共享库（/root/shared）

一个目录，跨所有工作区和所有新会话复用：

| 路径 | 内容 |
|---|---|
| `/root/shared/bin` | 命令行工具，插件启动时软链到 `/usr/local/bin`（本来就在 PATH） |
| `/root/shared/env/python` | Python venv，`shared pip` / `shared python` 自动创建 |
| `/root/shared/env/npm` | Node 全局包 prefix，`shared npm -g` 装到这里 |
| `/root/shared/skills` | 技能目录，每个子目录一个 `SKILL.md`，自动出现在所有会话技能目录 |
| `/root/shared/cache` | pip / npm / uv 缓存，重复安装不用重新下载 |
| `/root/shared/state` | 工作区安装模式文件（按工作区，原子写入） |
| `/root/shared/logs` | `hook.log` 拦截流水、`adopt.log` 搬迁记录 |
| `/root/shared/env.sh` | 手动 source 用的环境变量 |

环境事实（每次 shell 调用都有）：`DSH_SHARED_ROOT`、`DSH_SHARED_BIN`、`DSH_SHARED_SKILLS`、`DSH_SHARED_ENV`、`DSH_SHARED_CACHE`。

## 常用命令

```bash
shared status                      # 概况 + 模式 + 拦截对账 + 硬报错自检
shared list                        # 工具 + 技能 + npm/venv 命令
shared get <url> <name>            # 下载单文件工具进 bin 并 link；已知哈希加 --sha256 <hex>（不过不落盘），标签记 --version
shared verify                      # 离线校验 bin 与 state/tools.json 清单（missing/corrupt 非零退出）
shared export / shared import <file> [--force]  # 跨机复现工具（import 默认 dry-run）
shared uninstall <name>            # 删净 bin+软链+清单条目
shared uv|cargo|go ...             # 薄透传后端，工具缺失明确报错
shared npm install -g <pkg>        # Node 全局包
shared pip install <pkg>           # Python 包（venv）
shared python -c 'import x'        # 共享 venv 里跑
shared skill <kebab-name>          # 新建技能骨架
shared link                        # 装完手动补链接
shared mode [show|local|shared]    # 当前工作区安装模式
shared memory [status|setup-mnemon] # 记忆后端：meow-memory 随 bundle 挂载；setup-mnemon 装 mnemon CLI 进共享环境
shared adopt [目录] [--dry-run|--yes] [--class A|B|C]   # 扫描/搬迁
shared restore                     # 回滚 adopt 的 A 类搬迁
# adopt 执行后查看 logs/adopt-<run-id>.jsonl 的逐项结果
shared doctor                      # 自检
shared status --json                # 机器可读状态
shared doctor --json                # 机器可读诊断
shared list --json                  # 工具、技能和环境清单
```

## 前置拦截（重要）

插件在工具派发前装了一道 guard，只拦**两种**语义明确的命令，且仅当**当前目录向上找不到项目清单**（`package.json` / `requirements.txt` / `pyproject.toml` / `setup.py` / `setup.cfg` / `Pipfile` / `go.mod` / `Cargo.toml` / `composer.json`）或 `.dsh-shared-root` 标记时：

- `pip install ...`（含 `pip3`、`python -m pip install`）
- `npm install -g ...`（`i` / `install` / `add` 带 `-g`/`--global`）

被拦时**不要改写绕过**，按返回里给的命令重试：

| 被拦 | 改成 |
|---|---|
| `pip install requests` | `shared pip install requests` |
| `python3 -m pip install requests` | `shared pip install requests` |
| `npm install -g typescript` | `shared npm install -g typescript` |

配套语义：

- `shared pip` 装的包只有 `shared python` 能看到，系统 `python3` 看不到 —— 装完就用 `shared python your_script.py`。
- 项目里确实要装本地依赖：目录里有清单就自动放行；没有清单就 `cd` 到项目根，或用 `SHARED_BYPASS=1` 前缀（只对该条命令生效），或 `shared mode local`（本工作区长期放行，`shared mode shared` 恢复）。
- 设计原则：**宁可漏拦，绝不误拦**。带引号、`$(...)`、heredoc、取不到内容的 `-c`、动态重定向目标（`> $OUT`）、其他包管理器（`uv`/`cargo`/`go`/`conda`）一律放行，漏掉的交给 `shared adopt` 兜底。可读的输出管道（`2>&1`、`>/dev/null`、`> 具体文件`）会先剥掉再判定，所以带 `| tail` 照样会被拦。
- **两个看起来像故障的正常现象**：
  1. 本机系统 python **没有 pip**（`pip`、`python3 -m pip` 都不可用）。被放行之后看到 `command not found` 或 `No module named pip`，那是命令本身跑不起来，不是守卫坏了 —— 这也说明拦截在这里的作用是**纠正方向**，不是防系统被污染。
  2. 守卫拒绝会**中止整条命令**：命令后半截的 `echo`、`&&`、管道都不会执行，看到的输出就是拦截文案本身。
- `shared_lib(status)` 报的「工作区」= **会话工作区**（不是宿主进程 cwd）。跨工作区判断 mode 时以它为准。

## 事后兜底：adopt

工作区里已经下载/安装的东西不会自己搬进来，用扫描：

```bash
shared adopt .                    # 预演，只看不改
shared adopt . --yes --class A    # 只搬单文件可执行
```

| 类 | 对象 | 处理 |
|---|---|---|
| A | 单文件可执行 | `ldd` 检查无 `not found`、不引用工作区路径才 `mv` 进 `bin/` 并 link；脚本不自动搬 |
| B | `node_modules` | 不拷贝目录，读每个顶层包的 name@version，在共享 prefix 重装 |
| C | venv | 目录不可搬（写死绝对路径），`pip freeze` 在共享 venv 重建 |
| D | 有清单的项目依赖、编译产物 | 不动，也不该动 |

`shared restore` 回滚 A 类；B/C 用 `shared npm uninstall -g` / `shared pip uninstall -y`。

## 纪律

1. **不要把工具或依赖装进工作区目录**。工作区是临时的；`~/xxx/tools/`、项目内 `node_modules`、项目内 `.venv` 里的东西换工作区就没了。
2. **系统级已存在的能力优先用**：`node`、`npm`、`python3`、`git`、`curl` 都在系统 PATH 上；共享库只管「系统没有的」「想隔离的」「下载下来的」。
3. **单文件工具**走 `shared get`；压缩包解出来的可执行文件 `cp` 到 `/root/shared/bin/` 再 `shared link`。
4. **技能写完即生效**：插件递归监听 `/root/shared/skills`，新建或改动后失效缓存，不用重启 App。技能名 kebab-case，frontmatter 必须有 `name` 和 `description`（`description` 会进技能目录，写清「什么时候用」）。
5. `shared status` 退出码非零 = 有「装上了但用不了」的硬问题（未进 PATH、同名占用、`ldd` 依赖缺失），必须修完再往下做。

## 新增技能

```bash
shared skill my-tool-usage
$EDITOR /root/shared/skills/my-tool-usage/SKILL.md
```

```markdown
---
name: my-tool-usage
description: 一句话说明解决什么问题、什么时候该用。
whenToUse: 可选，触发条件更细的描述。
---

# 正文

按需加载的完整步骤。
```

带脚本的技能把文件放同一目录，正文用相对路径引用，加载时会给出 `resourceBase` 目录。

## 排错

- `shared: 命令不存在` → `shared link` 重新铺链接。
- 工具装了但 `command not found` → `shared list` 里 `[—]` 表示没链接；`/usr/local/bin` 被同名系统命令占了就换名字装（`shared get <url> <新名字>`）。
- 技能没出现 → 检查 frontmatter 的 `name` 是否 kebab-case、`description` 是否为空；只认 `skills/<name>/SKILL.md` 和 `skills/<name>.md`。
- venv 建不起来 → 缺 `python3-venv`；CLI 会自动改用 `--without-pip` + get-pip 引导。
- 拦截太频繁挡住正常活 → `shared mode local`（当前工作区）；规则本身有问题就改插件里的 `lib/hook.js` 并跑 `node --test test/*.test.js`。
- 被放行后 `pip: command not found` / `No module named pip` → 正常，本机就没有系统 pip（`shared status` 会直接标出来）。
