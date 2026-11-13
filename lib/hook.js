/**
 * dsh-shared-lib / hook —— 前置拦截的命令判定层（纯逻辑，可单测）。
 *
 * 设计底线（与方案一致）：
 *   · 误拦不可接受，漏拦可接受 → 看不懂的一律放行，交给事后 adopt 兜底
 *   · 只认两种语义明确的命令：pip install / npm install -g
 *   · 判定基于模型写下的原始字符串，在任何 shell 解析之前，只做保守词法扫描
 *   · 优先级：.dsh-shared-root 标记 > 清单文件 > 正向缓存（缓存在 index.js）
 */
import { createHash } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'

export const MARKER = '.dsh-shared-root'

export const DEFAULT_MANIFESTS = [
  'package.json',
  'requirements.txt',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'Pipfile',
  'go.mod',
  'Cargo.toml',
  'composer.json',
]

/** 命令前置词，剥掉后取真实命令字 */
const PREFIX_WORDS = new Set(['sudo', 'env', 'time', 'nohup', 'command', 'exec', 'builtin', 'nice', 'stdbuf', 'ionice'])
/** 出现这些就整条放行：无法可靠定界的构造 */
const UNPARSEABLE = /\$\(|`|<<|\\\r?\n/
/** 段内出现这些就放过该段 */
const SEGMENT_SKIP = /['"<>]/

/** 按 shell 分隔符切段（不解析引号：引号段反正会被放过） */
export function splitSegments(text) {
  return text.split(/\|\||&&|[;|\n]/)
}

/** 提取 `-c` 后面的字符串字面量；提取不到就是 null（该位置放行） */
export function extractInnerCommands(text) {
  const found = []
  const re = /(^|\s)-c\s+/g
  let match
  while ((match = re.exec(text)) !== null) {
    const quote = text[match.index + match[0].length]
    if (quote !== '"' && quote !== "'") {
      found.push(null)
      continue
    }
    let index = match.index + match[0].length + 1
    let buffer = ''
    let closed = false
    while (index < text.length) {
      const char = text[index]
      if (char === '\\' && quote === '"' && index + 1 < text.length) {
        buffer += text[index + 1]
        index += 2
        continue
      }
      if (char === quote) {
        closed = true
        break
      }
      buffer += char
      index += 1
    }
    found.push(closed ? buffer : null)
  }
  return found
}

/** 命令字归一：去路径、去 .exe */
export function normalizeCommand(word) {
  const withoutPath = word.split('/').pop() ?? word
  return withoutPath.replace(/\.exe$/i, '')
}

/** 取第一个非选项 token 作为子命令（pip / npm 都是这种形态） */
function firstVerb(tokens) {
  for (const token of tokens) {
    if (token.startsWith('-')) continue
    return token
  }
  return undefined
}

function assignsBypass(assignments) {
  return assignments.some(assignment => /^(?:DSH_)?SHARED_BYPASS=1$/.test(assignment))
}

/** 扫描段首：剥掉环境变量赋值与前置词，返回 { word, rest, assignments } */
export function splitHead(segment) {
  const tokens = segment.split(/\s+/).filter(Boolean)
  const assignments = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      assignments.push(token)
      index += 1
      continue
    }
    if (PREFIX_WORDS.has(token) || token === '!') {
      index += 1
      continue
    }
    if (token.startsWith('-')) {
      index += 1
      continue
    }
    break
  }
  if (index >= tokens.length) return { word: undefined, rest: [], assignments }
  return {
    word: normalizeCommand(tokens[index]),
    rest: tokens.slice(index + 1),
    assignments,
  }
}

/**
 * `cd <dir>` 会改变后续命令的落点，必须逐段跟踪（模型最常见的写法就是 `cd 项目 && pip install`）。
 * 返回 undefined = 不是 cd 段；null = 是 cd 但目标不可静态求值（~ / $VAR / glob / -）；字符串 = 可用目标。
 */
export function parseCd(segment) {
  const match = /^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))$/.exec(segment)
  if (!match) return undefined
  const target = (match[1] ?? match[2] ?? match[3] ?? '').trim()
  if (!target) return null
  if (target.startsWith('-') || target === '~' || target.startsWith('~/')) return null
  if (/[$`*?[]/.test(target)) return null
  return target
}

/**
 * 剥掉「可读的输出管道」再判定：`2>&1`、`>/dev/null`、`> 具体文件`、`< 具体文件`。
 * 目标不可静态求值（`> $OUT`、`> "my log"`）时不剥，整段按看不懂放行。
 */
const PLUMBING = [
  /\d?>&\d/g,
  /\d?>>?\s*\/dev\/null/g,
  /\d?>>?\s*[\w.\-\/]+/g,
  /\d?<\s*[\w.\-\/]+/g,
]

export function stripPlumbing(segment) {
  let out = segment
  for (const pattern of PLUMBING) out = out.replace(pattern, ' ')
  return out
}

/** 一次性判定一条命令。context: { cwd, resolveProject, mode } */
export function analyzeCommand(command, context) {
  const verdict = analyze(command, context, 0)
  if (verdict.action === 'deny' && context.resolveProject) {
    verdict.project = verdict.project ?? context.resolveProject(verdict.cwd ?? context.cwd)
  }
  return verdict
}

function analyze(command, context, depth) {
  const text = String(command ?? '')
  if (!text.trim()) return { action: 'pass', rule: 'empty' }
  if (context.mode === 'local') return { action: 'pass', rule: 'mode-local' }
  if (depth > 3) return { action: 'pass', rule: 'depth-limit' }

  // `bash -c "..."` 不构成豁免：能提取就递归判定
  for (const inner of extractInnerCommands(text)) {
    if (inner === null) continue
    const verdict = analyze(inner, { ...context, mode: context.mode }, depth + 1)
    if (verdict.action === 'deny') return { ...verdict, viaDashC: true }
  }

  if (UNPARSEABLE.test(text)) return { action: 'pass', rule: 'unparseable' }

  let cwd = context.cwd
  for (const raw of splitSegments(text)) {
    const segment = raw.trim()
    if (!segment) continue
    // cd 段即使带引号也要处理：它改变后面所有段的落点
    const target = parseCd(segment)
    if (target !== undefined) {
      if (target !== null) cwd = resolvePath(cwd, target)
      continue
    }
    const cleaned = stripPlumbing(segment)
    if (SEGMENT_SKIP.test(cleaned)) continue
    if (/\bshared\b/.test(cleaned)) continue
    const { word, rest, assignments } = splitHead(cleaned)
    if (!word) continue
    if (assignsBypass(assignments)) continue
    const hit = classify(word, rest, { ...context, cwd })
    if (hit) return hit
  }
  return { action: 'pass', rule: 'no-match' }
}

/** 只认 pip install / python -m pip install / npm install -g */
function classify(word, rest, context) {
  if (/^pip(\d+(?:\.\d+)?)?$/.test(word)) {
    const verb = firstVerb(rest)
    if (verb !== 'install') return undefined
    return judge('pip-install', rest.slice(rest.indexOf(verb) + 1), context)
  }

  if (/^python(\d+(?:\.\d+)?)?$/.test(word)) {
    const at = rest.indexOf('-m')
    if (at === -1) return undefined
    if (normalizeCommand(rest[at + 1] ?? '') !== 'pip') return undefined
    const tail = rest.slice(at + 2)
    const verb = firstVerb(tail)
    if (verb !== 'install') return undefined
    return judge('python-m-pip', tail.slice(tail.indexOf(verb) + 1), context)
  }

  if (word === 'npm') {
    const flags = rest.filter(token => token === '-g' || token === '--global' || token === '--location=global')
    if (flags.length === 0) return undefined
    const verb = firstVerb(rest)
    if (verb === undefined || !['i', 'install', 'add'].includes(verb)) return undefined
    const packages = rest
      .slice(rest.indexOf(verb) + 1)
      .filter(token => !['-g', '--global', '--location=global'].includes(token))
    return judge('npm-global', packages, context)
  }

  return undefined
}

/** 落点判定：有项目根就放行（项目内依赖本就该落项目），否则拒绝并给正确命令 */
function judge(rule, packages, context) {
  const project = context.resolveProject?.(context.cwd)
  const gatedOnProject = rule !== 'npm-global' || !context.npmGlobalIgnoreManifest
  if (project && gatedOnProject) return undefined
  return { action: 'deny', rule, packages, project, cwd: context.cwd }
}

export function describe(verdict, root) {
  if (verdict.action !== 'deny') return ''
  const pkgs = (verdict.packages ?? []).join(' ')
  const tail = pkgs ? ` ${pkgs}` : ' <包名>'

  if (verdict.rule === 'npm-global') {
    return [
      '[shared-lib] 已拦截：npm install -g 会装进系统 prefix /usr/local，不进共享库，换工作区就找不到。',
      `改用：shared npm install -g${tail}`,
      `（落到 ${root}/env/npm，并自动软链进 PATH）`,
      '确实要装系统级：同一条命令加前缀 SHARED_BYPASS=1，或在本工作区执行 shared mode local',
    ].join('\n')
  }

  return [
    `[shared-lib] 已拦截：${verdict.rule === 'python-m-pip' ? 'python -m pip install' : 'pip install'} 会装进系统 site-packages，不在共享库里，换工作区/新会话就丢。`,
    `改用：shared pip install${tail}`,
    `（落到 ${root}/env/python 的 venv，用 shared python 运行；系统 python3 看不到这个 venv 的包）`,
    '确实要在系统里装：同一条命令加前缀 SHARED_BYPASS=1，或在本工作区执行 shared mode local',
  ].join('\n')
}

/* ────────────────────────── 工作区 / 模式 / 日志 ────────────────────────── */

/**
 * 项目根判定：从起始目录向上逐级走，每级先看标记、再看清单，最近的先命中。
 * 只缓存正向命中（清单/标记），否定结果不缓存 —— npm init 当场生成清单能立刻放行。
 */
export function createProjectResolver({ manifests = DEFAULT_MANIFESTS, exists, cache = new Map(), maxDepth = 6 }) {
  return function resolveProject(startDir) {
    let dir = startDir
    for (let depth = 0; depth < maxDepth; depth += 1) {
      if (!dir || dir === '/') return undefined
      const cached = cache.get(dir)
      if (cached) return { root: dir, kind: cached }
      if (exists(`${dir}/${MARKER}`)) {
        cache.set(dir, 'marker')
        return { root: dir, kind: 'marker' }
      }
      for (const manifest of manifests) {
        if (exists(`${dir}/${manifest}`)) {
          cache.set(dir, 'manifest')
          return { root: dir, kind: 'manifest', file: manifest }
        }
      }
      const parent = dir.replace(/\/[^/]+$/, '') || '/'
      if (parent === dir) return undefined
      dir = parent
    }
    return undefined
  }
}

/** 工作区标识：最近的 .git 或标记目录，否则目录本身（bash CLI 用同一套算法） */
export function workspaceKey(startDir, exists) {
  let dir = startDir
  for (let depth = 0; depth < 8; depth += 1) {
    if (!dir || dir === '/') break
    if (exists(`${dir}/.git`) || exists(`${dir}/${MARKER}`)) return dir
    const parent = dir.replace(/\/[^/]+$/, '') || '/'
    if (parent === dir) break
    dir = parent
  }
  return startDir
}

export function modeId(workspace) {
  return createHash('sha1').update(workspace).digest('hex').slice(0, 16)
}

export function modePath(root, workspace) {
  return `${root}/state/mode-${modeId(workspace)}.txt`
}

/** 只读一次，读不到就是 shared；写入走临时文件 + rename，读者永远看到完整值 */
export function readModeAt(path, readFile) {
  try {
    const value = readFile(path, 'utf8').trim()
    return value === 'local' ? 'local' : 'shared'
  } catch {
    return 'shared'
  }
}

export function logLine(entry) {
  return `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`
}

/** 从 JSONL 统计拦截与纠正次数（只读尾部，避免大文件全扫） */
export function summarize(text, limit = 4000) {
  const lines = text.split('\n').slice(-limit)
  let deny = 0
  let corrected = 0
  let lastDeny
  for (const line of lines) {
    if (!line.trim()) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    if (entry.event === 'deny') {
      deny += 1
      lastDeny = entry
    }
    if (entry.event === 'corrected') corrected += 1
  }
  return { deny, corrected, lastDeny }
}
