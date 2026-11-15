# meow-memory 提示词覆盖层

## 为什么要这个

meow-memory 每轮注入一段固定文案，其中三行是**工具用法说明**：

```
需要时用 memory_search 检索（必须传 query 检索词，不能空查）、memory_read 读取。
当有项目相关任务时，应先用 memory_project 查项目全景（记得带上项目名，不能空参），这样可以对项目有整体理解。
用户的所有 project：dsh-shared-lib
```

问题：`memory_search` / `memory_read` / `memory_project` 的工具描述里已经写清了参数和用法，
再每轮重复一遍属于纯浪费——既占 token，也挤占真正的记忆内容。

用户原话："提示词太长了"。

## 改了什么

只动 4 个键，其余 45 个键保持随包默认值：

| 键 | 之前 | 之后 |
|---|---|---|
| `inject.guide` | 记忆导引 | 记忆 |
| `inject.guideSearchLine` | 需要时用 memory_search 检索（必须传 query…）、memory_read 读取。 | 按需 memory_search / memory_project 检索。 |
| `inject.guideProjectLine` | 当有项目相关任务时，应先用 memory_project 查项目全景… | 项目相关任务先查项目全景。 |
| `inject.guideProjects` | 用户的所有 project：{list} | project：{list} |

注入文本从 **160 字符压到 79 字符**，省 50.6%。

## 怎么安装

```bash
HOME_DIR=/root/shared/state/memory-home   # 你配置的 meow homeDir
mkdir -p "$HOME_DIR/prompts/zh"
cp assets/meow-overlay/zh/labels.md "$HOME_DIR/prompts/zh/labels.md"
```

改完立即生效，不需要重启。

## 两个必须知道的坑（都实测过）

1. **覆盖层是整文件替换，不是合并。**
   `readSlotFile()` 一旦发现覆盖文件存在就只读它，不会和随包文案合并。
   所以覆盖文件必须是**完整副本**，只改需要的键。只写 4 个键会让其余 45 个键消失，
   `keyedValue()` 遇到缺失键直接抛错，工具全部不可用（实测报错：
   `prompt 文案缺失：labels.md 的 "project.unlabeled"`）。

2. **想删掉某行文案不能写空值。**
   解析器会跳过空值行，键等于不存在，同样触发上面的抛错。
   必须给一个简短的真实文案，哪怕只留一个词。

## 升级注意

meow-memory 升级后如果新增了 `labels.md` 的键，覆盖文件会缺键并导致工具报错。
升级后请重新执行一次：

```bash
cp /root/.dsh/profiles/web/node_modules/meow-memory/lib/prompts/zh/labels.md \
   "$HOME_DIR/prompts/zh/labels.md"
# 然后重新应用上面的 4 处改动
```
