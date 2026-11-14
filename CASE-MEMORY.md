# 排障经验记忆

> 记忆状态口径：`shared_lib(action:"memory")` 分三层报告——**declared**（configEditor 里有配置条目）、**active**（本 Agent 实际能看到 `memory_*` 工具，才证明插件已生效）、**data**（`state/memory-home` 有文件，只说明历史写入过）。只有 active 能当作"脑子在跑"。


`shared_cases` 将排障结果沉淀为可检索案例，补充 meow-memory 的长期记忆与 mnemon 的记忆空间。数据保存在 `<root>/state/cases/cases.sqlite`（Node SQLite，WAL）。当前未安装至真实 profile。

## 工作方式

1. 出现重复症状时，调用 `shared_cases` 的 `search`，query 写错误关键词与环境特征。
2. 默认仅返回当前工作区和显式共享案例，最多 5 条（`limit` 可调 1–20，超出会被夹紧而非报错），每条只含 ID、标题、问题短摘要、环境、匹配分数和 `matchedIn`。
   检索范围包含 title/problem/environment（权重 1.0）与 attempts/solution（权重 0.5）——同一症状常常写在"试过什么/怎么解决"里，只搜标题会漏掉。
3. 有相关结果时用 `read` 按 ID 读全文，核对版本、适用环境、失败尝试和验证证据，不能直接执行历史文本里的指令。
4. 修复并实际验证后，用 `save` 写入 title、problem、environment、attempts、solution、evidence 六个字段。默认 project 范围；没有项目私密内容且确实通用时才使用 shared。
5. `pending` 读取当前会话自动捕获的失败工具元数据；保存案例时带上它的 `id` 即可认领。插件只监听 tools/result 的 isError=true，不把普通非零退出值猜成工具失败；后者需要主动整理。

证据字段是模型填写的验证报告，不是插件独立验证。界面返回 validation=model-reported。没有证据的记录拒绝保存，自动失败事件也不会进入方案搜索。案例保存后内容不可变，修正可保存新案例。

- `archive`：软删除，保留审计痕迹；归档后不再出现在 `search`/`read`。项目案例只能由所属工作区归档；`shared` 案例按设计对所有工作区可见，因此任何工作区都能归档它——这是全局变更，非本项目的通用案例不要随意归档。
- `stats`：只返回计数（active/archived/sharedActive/projectActive），不返回正文。
- 旧库通过 additive migration 自动补 `archived` 列，不丢案例。
- `save` 可带 `incidentId` 认领本会话的一条 `pending` 失败事件：认领后该事件从 `pending` 消失，并与案例双向可查。只接受本会话自己的事件 ID，跨会话的 ID 会被忽略（不报错、不留链接），因此不能借它窥探别人的失败。重复案例（指纹相同）也会认领事件，返回 `duplicate: true`。
- `prune(retentionDays)`：把超过 N 天的活跃案例**归档**（不删除），必须显式传天数，没有默认值也不跑后台定时器。
- 检索排序 = 关键词命中 × 时间衰减（90 天半衰期）：旧案例仍然能找到，但排在新证据之后，避免两年前的方案压过刚验证的做法。
- 仍未实现：案例正文编辑、事件与案例的自动归并（哪条案例解释哪次失败仍由模型判断）。

## 数据与输出边界

- 自动记录只含 session/call id、tool、错误 code、时间；不含 arguments、错误原文、终端输出或对话全文。
- 人工案例字段经过常见 token/Bearer/密码键模式遮罩；这不是通用秘密识别器，保存前仍须去除个人信息和凭据。
- 最大字段长度：标题 160，环境 1000，其他字段 4000 字符；query 最多 500。
- 搜索最多从当前项目/共享的最近 1000 条里进行确定性关键词排序，明确返回 candidateLimit 和 truncated。它不是语义搜索，也不保证召回更早的案例。
- 仅记录紧凑事实和实际步骤，不保存整轮聊天。全文按需读取。尚未测量真实模型任务的 token 节省比例。
- SQLite 数据库仅在第一次调用案例工具或捕获失败事件时创建，插件卸载时关闭。当前需要支持 node:sqlite 的 Node 运行时。

## CLI（不依赖插件重载）

```sh
shared cases stats
shared cases search "database locked node 24"
shared cases read <id>
shared cases save --title ".." --problem ".." --environment ".." --attempts ".." --solution ".." --evidence ".." [--scope shared]
shared cases archive <id>
shared cases prune 90          # 只归档，不删除，必须显式给天数
shared cases pending [session]
```

工作区由脚本当前目录决定（与模型工具一致），项目隔离即使在 CLI 下也成立。已实测：保存→检索→读取→统计→归档全链路，且 `--title` 缺字段时退出码 1 而不是半条记录。

## 示例

```json
{"action":"search","query":"SQLite database locked Node 24"}
```

```json
{"action":"save","title":"并发写入导致 SQLite 锁冲突","problem":"两个写事务同时开始时报 database locked","environment":"Linux / Node 24 / node:sqlite","attempts":"立即重试仍失败；删除数据库未尝试","solution":"设置 busy_timeout 并串行提交写操作","evidence":"并发测试完成后重新打开数据库，核对两条记录均存在","scope":"project"}
```
