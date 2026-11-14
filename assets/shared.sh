#!/usr/bin/env bash
# shared — DSH 共享库命令行（工具 / 开发环境 / 技能）
# 由 dsh-shared-lib 插件铺进 <root>/bin/shared，并在启动时刷新本文件。
set -uo pipefail

ROOT="${DSH_SHARED_ROOT:-/root/shared}"
BIN_DIR="$ROOT/bin"
ENV_DIR="$ROOT/env"
PY_VENV="$ENV_DIR/python"
NPM_PREFIX="$ENV_DIR/npm"
SKILLS_DIR="$ROOT/skills"
CACHE_DIR="$ROOT/cache"
STATE_DIR="$ROOT/state"
LOG_DIR="$ROOT/logs"
LINK_DIR="${SHARED_LINK_DIR:-/usr/local/bin}"
ADOPT_LOG="$LOG_DIR/adopt.log"
HOOK_LOG="$LOG_DIR/hook.log"
ADOPT_RUN_LOG=""
MANIFEST="$STATE_DIR/tools.json"
MANIFEST_SCHEMA=1
VERSION="0.5.0"

die() { printf 'shared: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }
note() { printf '   %s\n' "$*"; }

ensure_root() {
  mkdir -p "$BIN_DIR" "$PY_VENV" "$NPM_PREFIX" "$SKILLS_DIR" \
    "$ROOT/share" "$CACHE_DIR/pip" "$CACHE_DIR/npm" "$CACHE_DIR/uv" "$LOG_DIR" "$STATE_DIR" "$STATE_DIR/memory-home"
}

# ────────────────────────────── 链接 ──────────────────────────────

# link_dir <源目录> [排除模式...]：把可执行文件软链进 LINK_DIR，同名的非本库文件跳过
link_dir() {
  local src_dir="$1"; shift
  [ -d "$src_dir" ] || return 0
  local name src dst skip pattern
  for src in "$src_dir"/*; do
    [ -e "$src" ] || continue
    name="${src##*/}"
    skip=0
    for pattern in "$@"; do
      # shellcheck disable=SC2254
      case "$name" in $pattern) skip=1; break ;; esac
    done
    [ "$skip" = 1 ] && continue
    [ -f "$src" ] || continue
    chmod +x "$src" 2>/dev/null
    dst="$LINK_DIR/$name"
    if [ -L "$dst" ]; then
      local target source
      target="$(readlink -f "$dst" 2>/dev/null || true)"
      source="$(readlink -f "$src" 2>/dev/null || true)"
      [ "$target" = "$source" ] || { info "跳过 $name（$dst 是外部软链）"; continue; }
      rm -f "$dst"
    elif [ -e "$dst" ]; then
      info "跳过 $name（$dst 已存在且不是共享库软链）"
      continue
    fi
    ln -s "$src" "$dst" && info "已链接 $name → $src"
  done
}

cmd_link() {
  ensure_root
  mkdir -p "$LINK_DIR"
  chmod +x "$BIN_DIR"/* 2>/dev/null
  link_dir "$BIN_DIR"
  [ -d "$NPM_PREFIX/bin" ] && link_dir "$NPM_PREFIX/bin"
  if [ -d "$PY_VENV/bin" ]; then
    link_dir "$PY_VENV/bin" 'python*' 'pip*' 'activate*' 'Activate*'
  fi
  return 0
}

cmd_unlink() {
  local name="${1:-}"
  [ -n "$name" ] || die "用法：shared unlink <名字>"
  local dst="$LINK_DIR/$name"
  if [ -L "$dst" ]; then
    rm -f "$dst" && info "已移除软链 $dst"
  else
    info "$dst 不是软链，未处理"
  fi
}

# ────────────────────────────── 清单 / 完整性 ──────────────────────────────
# 借 flox/devbox/mise 的「声明式清单 + lockfile + sha256」思路，但保持零依赖（纯 node 内置）。
# tools.json 记录每个 shared get 的 name/url/sha256/version/size/installedAt，
# 让 verify 能离线检测漂移、export/import 能跨机复现。清单是「唯一真相」，缺失即视为未登记。

sha256_of() {
  local f="$1"
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$f" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$f" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$f" | awk '{print $NF}'
  else SHA_F="$f" node -e 'const fs=require("node:fs"),c=require("node:crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.env.SHA_F)).digest("hex"))'
  fi
}

manifest_init() {
  mkdir -p "$STATE_DIR"
  [ -f "$MANIFEST" ] && return 0
  MFS="$MANIFEST" MSCH="$MANIFEST_SCHEMA" node -e 'const fs=require("node:fs");fs.writeFileSync(process.env.MFS,JSON.stringify({schema:Number(process.env.MSCH),tools:{}},null,2)+"\n")' || die "清单初始化失败：$MANIFEST"
}

manifest_set() { # name url sha version source size
  local name="$1" url="$2" sha="$3" ver="$4" src="$5" size="$6"
  MFS="$MANIFEST" MNAME="$name" MURL="$url" MSHA="$sha" MVER="$ver" MSRC="$src" MSIZE="$size" MTS="$(date -u +%Y-%m-%dT%H:%M:%SZ)" node -e '
    const fs=require("node:fs"),e=process.env;let d;try{d=JSON.parse(fs.readFileSync(e.MFS,"utf8"))}catch{d={schema:1,tools:{}}}
    d.tools=d.tools||{};d.tools[e.MNAME]={url:e.MURL||null,sha256:e.MSHA||null,version:e.MVER||null,source:e.MSRC||e.MNAME,size:Number(e.MSIZE||0),installedAt:e.MTS};
    fs.writeFileSync(e.MFS,JSON.stringify(d,null,2)+"\n");' || die "清单写入失败：$MANIFEST"
}

manifest_delete() {
  local name="$1"
  [ -f "$MANIFEST" ] || return 0
  MFS="$MANIFEST" MNAME="$name" node -e 'const fs=require("node:fs"),e=process.env;let d;try{d=JSON.parse(fs.readFileSync(e.MFS,"utf8"))}catch{process.exit(0)}if(d.tools&&d.tools[e.MNAME]){delete d.tools[e.MNAME];fs.writeFileSync(e.MFS,JSON.stringify(d,null,2)+"\n")}'
}

manifest_rows() { # name<TAB>sha<TAB>url<TAB>version
  [ -f "$MANIFEST" ] || return 0
  MFS="$MANIFEST" node -e 'const fs=require("node:fs");try{const d=JSON.parse(fs.readFileSync(process.env.MFS,"utf8"));for(const[k,t]of Object.entries(d.tools||{}))console.log([k,t.sha256||"",t.url||"",t.version||""].join("\t"))}catch{}'
}

cmd_manifest() {
  manifest_init
  case "${1:-show}" in
    show) cat "$MANIFEST" ;;
    *) die "用法：shared manifest [show]" ;;
  esac
}

# ────────────────────────────── 安装 ──────────────────────────────

cmd_get() {
  local url="" name="" want_sha="" want_ver=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --sha256) shift; want_sha="${1:-}" ;;
      --version) shift; want_ver="${1:-}" ;;
      *) if [ -z "$url" ]; then url="$1"; elif [ -z "$name" ]; then name="$1"; fi ;;
    esac
    shift
  done
  [ -n "$url" ] || die "用法：shared get <url> [落盘名字] [--sha256 <hex>] [--version <标签>]"
  ensure_root
  manifest_init
  [ -n "$name" ] || name="$(basename "${url%%\?*}")"
  case "$name" in
    .|..|*[!A-Za-z0-9._-]*) die "名字必须是单个文件名：$name" ;;
  esac
  local out="$BIN_DIR/$name" tmp="$BIN_DIR/.dl.$$.tmp"
  info "下载 $url → $out"
  curl -fL --retry 3 --connect-timeout 20 -o "$tmp" "$url" || { rm -f "$tmp"; die "下载失败"; }
  local actual
  actual="$(sha256_of "$tmp")"
  if [ -n "$want_sha" ]; then
    if [ "$actual" != "$want_sha" ]; then rm -f "$tmp"; die "sha256 校验失败：期望 $want_sha，实际 $actual（已拒绝，未落盘）"; fi
    info "sha256 校验通过"
  fi
  mv -f "$tmp" "$out" || { rm -f "$tmp"; die "落盘失败：$out"; }
  chmod +x "$out"
  local size
  size="$(wc -c < "$out" | tr -d ' ')"
  manifest_set "$name" "$url" "$actual" "$want_ver" "$name" "$size"
  cmd_link
}

cmd_uninstall() {
  local name="${1:-}"
  [ -n "$name" ] || die "用法：shared uninstall <名字>"
  case "$name" in .|..|*[!A-Za-z0-9._-]*) die "非法名字：$name" ;; esac
  local bin="$BIN_DIR/$name" link="$LINK_DIR/$name"
  [ -e "$bin" ] || [ -L "$link" ] || die "没有登记的工具：$name（bin 和软链都不存在）"
  if [ -L "$link" ]; then rm -f "$link" && info "移除软链 $link" || die "移除软链失败：$link"; fi
  if [ -e "$bin" ]; then rm -f "$bin" && info "移除 bin 文件 $bin" || die "移除 bin 失败：$bin"; fi
  manifest_delete "$name"
  info "已卸载 $name 并从清单移除"
}

cmd_verify() {
  local json=0
  [ "${1:-}" = "--json" ] && json=1
  manifest_init
  local results="" name sha url ver f actual state bad=0
  while IFS=$'\t' read -r name sha url ver; do
    [ -n "$name" ] || continue
    f="$BIN_DIR/$name"
    if [ ! -e "$f" ]; then state="missing"; bad=1
    elif [ -z "$sha" ]; then state="unpinned"
    else actual="$(sha256_of "$f")"; if [ "$actual" = "$sha" ]; then state="ok"; else state="corrupt"; bad=1; fi
    fi
    results+="$name"$'\t'"$state"$'\t'"$sha"$'\t'"$url"$'\t'"$ver"$'\n'
  done <<< "$(manifest_rows)"
  if [ "$json" = 1 ]; then
    RES="$results" MAN="$MANIFEST" node -e 'const lines=(process.env.RES||"").split("\n").filter(Boolean);const tools=lines.map(l=>{const[name,state,sha,url,version]=l.split("\t");return{name,state,sha256:sha||null,url:url||null,version:version||null}});console.log(JSON.stringify({schema:1,manifest:process.env.MAN,ok:tools.every(r=>r.state==="ok"||r.state==="unpinned"),tools},null,2))'
    return "$bad"
  fi
  if [ -z "$results" ]; then info "清单为空（还没有经 shared get 登记的工具）"; return 0; fi
  while IFS=$'\t' read -r name state sha url ver; do
    [ -n "$name" ] || continue
    case "$state" in
      ok) info "[ok]      $name${ver:+ ($ver)}" ;;
      unpinned) info "[no-sha]  $name（未 pin sha256，无法验证完整性）" ;;
      missing) info "[missing] $name：bin 里没有该文件" ;;
      corrupt) info "[corrupt] $name：sha256 漂移，疑似被改/半截下载 → shared get \"${url:-<url>}\" $name --sha256" ;;
    esac
  done <<< "$results"
  return "$bad"
}

cmd_outdated() {
  manifest_init
  local name sha url ver n=0
  while IFS=$'\t' read -r name sha url ver; do
    [ -n "$name" ] || continue
    if [ -z "$ver" ]; then info "无版本标签  $name  ← shared get 时加 --version <标签> 记录"; n=$((n+1)); fi
  done <<< "$(manifest_rows)"
  [ "$n" -eq 0 ] && info "清单里的工具都带版本标签（离线不查上游，无法判断是否有更新版）"
  return 0
}

cmd_export() {
  ensure_root; manifest_init
  ROOT="$ROOT" MANIFEST_P="$MANIFEST" NPM_PREFIX="$NPM_PREFIX" PY_VENV="$PY_VENV" SKILLS_DIR="$SKILLS_DIR" node - <<'NODE'
const fs=require("node:fs"),path=require("node:path"),e=process.env;
const readJson=p=>{try{return JSON.parse(fs.readFileSync(p,"utf8"))}catch{return null}};
const manifest=readJson(e.MANIFEST_P)||{tools:{}};
const tools=Object.entries(manifest.tools||{}).map(([name,t])=>({name,url:t.url||null,sha256:t.sha256||null,version:t.version||null,size:t.size||0}));
const npmDir=path.join(e.NPM_PREFIX,"lib","node_modules"),npm=[];
try{for(const d of fs.readdirSync(npmDir)){if(d.startsWith("."))continue;if(d.startsWith("@")){for(const s of fs.readdirSync(path.join(npmDir,d))){const j=readJson(path.join(npmDir,d,s,"package.json"))||{};if(j.name)npm.push({name:j.name,version:j.version||null})}}else{const j=readJson(path.join(npmDir,d,"package.json"))||{};if(j.name)npm.push({name:j.name,version:j.version||null})}}}catch{}
const python={venv:e.PY_VENV,exists:fs.existsSync(path.join(e.PY_VENV,"bin","python")),packages:[]};
const pipBin=path.join(e.PY_VENV,"bin","pip");
if(fs.existsSync(pipBin)){try{const r=require("node:child_process").spawnSync(pipBin,["list","--format=json"],{encoding:"utf8",timeout:5000});python.packages=(JSON.parse(r.stdout||"[]")||[]).map(x=>({name:x.name,version:x.version}))}catch{}}
const runDir=path.join(e.ROOT,"state","target-runs"),targets=[];
try{for(const n of fs.readdirSync(runDir)){if(!n.endsWith(".json"))continue;let r;try{r=JSON.parse(fs.readFileSync(path.join(runDir,n),"utf8"))}catch{continue}if(r.state!=="succeeded")continue;targets.push({target:r.target,scope:r.scope||"shared",spec:(r.args||[]).at(-1)||null,cwd:r.cwd||null,finishedAt:r.finishedAt||null})}}catch{}
const skills=[];const walk=d=>{let xs=[];try{xs=fs.readdirSync(d,{withFileTypes:true})}catch{return}for(const x of xs){if(x.name.startsWith("."))continue;const p=path.join(d,x.name);if(x.isDirectory()){if(fs.existsSync(path.join(p,"SKILL.md")))skills.push(x.name);else walk(p)}else if(x.isFile()&&x.name.endsWith(".md")&&x.name!=="README.md")skills.push(x.name.slice(0,-3))}};walk(e.SKILLS_DIR);
console.log(JSON.stringify({schema:1,generatedAt:new Date().toISOString(),root:e.ROOT,tools,npmPackages:npm,python,skills,targets},null,2))
NODE
}

cmd_import() {
  local file="" mode="dry"
  while [ $# -gt 0 ]; do
    case "$1" in
      --yes|-y|--force) mode="force" ;;
      --dry-run) mode="dry" ;;
      *) file="$1" ;;
    esac
    shift
  done
  [ -f "$file" ] || die "清单文件不存在：$file（用 shared export 生成）"
  ensure_root; manifest_init
  local list
  list="$(FILE="$file" node -e 'const fs=require("node:fs");const d=JSON.parse(fs.readFileSync(process.env.FILE,"utf8"));for(const t of (d.tools||[]))if(t.url)console.log([t.name,t.url,t.sha256||"",t.version||""].join("\t"))')"
  local name url sha ver got=0 skipped=0 restored=0
  while IFS=$'\t' read -r name url sha ver; do
    [ -n "$name" ] || continue
    case "$name" in .|..|*[!A-Za-z0-9._-]*) info "跳过非法名：$name"; continue ;; esac
    local out="$BIN_DIR/$name"
    if [ "$mode" != force ] && [ -e "$out" ]; then
      if [ -n "$sha" ] && [ "$(sha256_of "$out")" = "$sha" ]; then skipped=$((skipped+1)); info "已存在且校验通过：$name"; continue
      elif [ -z "$sha" ]; then skipped=$((skipped+1)); info "已存在（无 sha 可验）：$name"; continue
      else info "sha256 不符，将重取：$name"
      fi
    fi
    if [ "$mode" = dry ]; then got=$((got+1)); info "[dry] 将下载 $name ← $url"; continue; fi
    local tmp="$BIN_DIR/.dl.$$.tmp"
    curl -fL --retry 3 --connect-timeout 20 -o "$tmp" "$url" || { rm -f "$tmp"; info "下载失败：$name"; continue; }
    local actual; actual="$(sha256_of "$tmp")"
    if [ -n "$sha" ] && [ "$actual" != "$sha" ]; then rm -f "$tmp"; die "sha256 校验失败：$name（期望 $sha 实际 $actual）"; fi
    mv -f "$tmp" "$out"; chmod +x "$out"
    manifest_set "$name" "$url" "$actual" "$ver" "$name" "$(wc -c < "$out" | tr -d ' ')"
    restored=$((restored+1)); info "已复现 $name"
  done <<< "$list"
  [ "$mode" = dry ] && { info "预演：$got 个待下载，$skipped 个已就位（执行去掉 --dry-run）"; return 0; }
  [ "$restored" -gt 0 ] && cmd_link
  info "完成：复现 $restored 个，跳过 $skipped 个"
  local np pc
  np="$(FILE="$file" node -e 'const d=JSON.parse(require("node:fs").readFileSync(process.env.FILE,"utf8"));console.log((d.npmPackages||[]).length)')"
  pc="$(FILE="$file" node -e 'const d=JSON.parse(require("node:fs").readFileSync(process.env.FILE,"utf8"));console.log((d.python&&d.python.packages||[]).length)')"
  [ "${np:-0}" -gt 0 ] && info "npm 全局包 $np 个需手动：shared npm install -g $(FILE="$file" node -e 'const d=JSON.parse(require("node:fs").readFileSync(process.env.FILE,"utf8"));console.log((d.npmPackages||[]).map(x=>x.name+(x.version?"@"+x.version:"")).join(" "))')"
  local tn
  tn="$(FILE="$file" node -e 'const d=JSON.parse(require("node:fs").readFileSync(process.env.FILE,"utf8"));console.log((d.targets||[]).length)')"
  if [ "${tn:-0}" -gt 0 ]; then
    info "上游目标 $tn 个需显式安装（不会自动执行）："
    FILE="$file" node -e 'const d=JSON.parse(require("node:fs").readFileSync(process.env.FILE,"utf8"));for(const t of (d.targets||[]))console.log(`  shared install-target ${t.target} ${t.spec||"<spec>"}${t.scope&&t.scope!=="shared"?" --scope "+t.scope:""} --execute`)'
  fi
  [ "${pc:-0}" -gt 0 ] && info "python 包 $pc 个需手动：shared pip install $(FILE="$file" node -e 'const d=JSON.parse(require("node:fs").readFileSync(process.env.FILE,"utf8"));console.log((d.python.packages||[]).map(x=>x.name+(x.version?"=="+x.version:"")).join(" "))')"
  return 0
}

# 薄透传后端：工具不在就明确报错（不静默吞掉，避免掩盖主流程缺失）。
cmd_uv() { command -v uv >/dev/null 2>&1 || die "uv 未安装：先 shared get <uv二进制> uv --sha256 <hex>，或 pipx/系统安装 uv 后重跑"; UV_CACHE_DIR="$CACHE_DIR/uv" uv "$@"; }
cmd_cargo() { command -v cargo >/dev/null 2>&1 || die "cargo 未安装（rustup 或系统包）后重跑：shared cargo install <crate>"; cargo "$@"; }
cmd_go() { command -v go >/dev/null 2>&1 || die "go 未安装：shared get <go 二进制> 或系统安装后重跑：shared go install <module>"; go "$@"; }


ensure_venv() {
  ensure_root
  if [ -x "$PY_VENV/bin/python" ] && [ -x "$PY_VENV/bin/pip" ]; then return 0; fi
  if [ ! -x "$PY_VENV/bin/python" ]; then
    info "创建 python venv：$PY_VENV"
    if python3 -c 'import ensurepip' >/dev/null 2>&1 && python3 -m venv "$PY_VENV" >/dev/null 2>&1; then
      :
    else
      info "ensurepip 缺失，改用 --without-pip + get-pip 引导"
      rm -rf "$PY_VENV"; mkdir -p "$PY_VENV"
      python3 -m venv --without-pip "$PY_VENV" || die "venv 创建失败"
      local gp="/tmp/get-pip.$$.py"
      curl -fsSL --connect-timeout 20 https://bootstrap.pypa.io/get-pip.py -o "$gp" || die "get-pip.py 下载失败"
      "$PY_VENV/bin/python" "$gp" >/dev/null 2>&1 || die "pip 引导失败"
      rm -f "$gp"
    fi
  fi
  [ -x "$PY_VENV/bin/pip" ] || die "venv 里没有 pip"
}

cmd_pip() {
  ensure_venv
  PIP_CACHE_DIR="$CACHE_DIR/pip" "$PY_VENV/bin/pip" "$@"
  local code=$?
  if [ $code -eq 0 ]; then
    cmd_link
    note "已装进 $PY_VENV；用 shared python 运行（系统 python3 看不到这个 venv 的包）"
  fi
  return $code
}

cmd_python() {
  ensure_venv
  "$PY_VENV/bin/python" "$@"
}

# 透传给 npm，并对 install/i/add 自动补 -g（prefix 已指向共享库）
cmd_npm() {
  ensure_root
  local args=("$@") has_g=0 a
  for a in "${args[@]:-}"; do
    case "$a" in -g|--global|--location=global) has_g=1 ;; esac
  done
  case "${args[0]:-}" in
    install|i|add) [ "$has_g" = 1 ] || args=("${args[0]}" -g "${args[@]:1}") ;;
  esac
  NPM_CONFIG_PREFIX="$NPM_PREFIX" NPM_CONFIG_CACHE="$CACHE_DIR/npm" npm "${args[@]}"
  local code=$?
  [ $code -eq 0 ] && cmd_link
  return $code
}

cmd_skill() {
  local name="${1:-}"
  [ -n "$name" ] || die "用法：shared skill <kebab-name>"
  case "$name" in
    *[!a-z0-9-]*|-*|*-) die "技能名必须是 kebab-case：小写字母、数字、连字符" ;;
  esac
  ensure_root
  local dir="$SKILLS_DIR/$name"
  if [ -f "$dir/SKILL.md" ]; then
    info "已存在：$dir/SKILL.md"
    return 0
  fi
  mkdir -p "$dir"
  cat > "$dir/SKILL.md" <<EOF
---
name: $name
description: 一句话说明这个技能解决什么问题（会进所有会话的技能目录）。
---

# $name

## 何时使用

（触发条件）

## 步骤

1.
EOF
  info "已创建 $dir/SKILL.md，保存后自动出现在所有会话的技能目录"
}

# ────────────────────────────── 工作区模式 ──────────────────────────────

# 与插件一致：最近的 .git 或 .dsh-shared-root 目录，否则目录本身
ws_key() {
  local dir="$1" i=0
  while [ $i -lt 8 ]; do
    [ -d "$dir/.git" ] && { printf '%s' "$dir"; return 0; }
    [ -f "$dir/.dsh-shared-root" ] && { printf '%s' "$dir"; return 0; }
    [ "$dir" = "/" ] && break
    dir="$(dirname "$dir")"
    i=$((i + 1))
  done
  printf '%s' "$1"
}

ws_mode_file() {
  local key id
  key="$(ws_key "$1")"
  id="$(printf '%s' "$key" | sha1sum | cut -c1-16)"
  printf '%s\n%s\n' "$ROOT/state/mode-$id.txt" "$key"
}

cmd_mode() {
  local arg="${1:-show}"
  ensure_root
  local file key
  { IFS= read -r file; IFS= read -r key; } <<< "$(ws_mode_file "$(pwd)")"
  case "$arg" in
    show|"")
      local value="shared"
      [ -f "$file" ] && value="$(head -1 "$file")"
      info "工作区 $key"
      info "模式   $value"
      info "状态   $file"
      ;;
    local|shared)
      printf '%s\n' "$arg" > "$file.tmp.$$"
      mv -f "$file.tmp.$$" "$file"
      info "工作区 $key → 模式 $arg"
      ;;
    *) die "用法：shared mode [show|local|shared]" ;;
  esac
}

# ────────────────────────────── adopt / restore ──────────────────────────────

is_elf() { [ -f "$1" ] && [ "$(head -c 4 "$1" 2>/dev/null | od -An -c | tr -d ' \n')" = '177ELF' ]; }

# ldd 干净：没有 not found，也不引用被扫描目录（避免搬完找不到库）
ldd_clean() {
  local file="$1" dir="$2" out
  is_elf "$file" || return 1
  out="$(ldd "$file" 2>/dev/null)"
  case "$out" in *"not found"*) return 1 ;; esac
  case "$out" in *"$dir"*) return 1 ;; esac
  return 0
}

json_record() {
  local file="$1" json
  shift
  json="$(node -e 'const [event, runId, klass, status, source, target, item, version] = process.argv.slice(1); console.log(JSON.stringify({ts:new Date().toISOString(),event,runId,class:klass,status,source,target,item,version}))' "$@")" || return 1
  printf '%s\n' "$json" >> "$file"
}

adopt_record() {
  local run_id="$1" klass="$2" status="$3" source="$4" target="$5" item="${6:-}" version="${7:-}"
  mkdir -p "$LOG_DIR"
  json_record "$ADOPT_LOG" adopt "$run_id" "$klass" "$status" "$source" "$target" "$item" "$version" || return 1
  [ -n "$ADOPT_RUN_LOG" ] && json_record "$ADOPT_RUN_LOG" adopt "$run_id" "$klass" "$status" "$source" "$target" "$item" "$version"
}

scan_dir() {
  local dir="$1" depth_left="$2"
  [ -d "$dir" ] || return 0
  local entry name
  for entry in "$dir"/*; do
    [ -e "$entry" ] || continue
    name="${entry##*/}"
    case "$name" in
      target|dist|build|.git|__pycache__|node_modules|.venv|venv|.cache|logs|state) continue ;;
    esac
    if [ -d "$entry" ]; then
      # 只下探一层常见工具目录
      case "$name" in
        bin|tools|tool|scripts)
          [ "$depth_left" -gt 0 ] && scan_dir "$entry" $((depth_left - 1)) ;;
      esac
      continue
    fi
    [ -x "$entry" ] || continue
    if is_elf "$entry"; then
      if ldd_clean "$entry" "$1"; then
        info "[A] $entry （ELF，依赖干净）→ 可搬迁到 $BIN_DIR/$name"
        candidates_a+=("$entry")
      else
        info "[A] $entry （ELF，但依赖缺失或引用工作区路径）→ 不搬迁，建议在目标环境重装"
      fi
    elif head -c 2 "$entry" 2>/dev/null | grep -q '#!'; then
      info "[A] $entry （脚本，可能写死工作区路径）→ 需人工确认，不自动搬"
    fi
  done
}

scan_venv() {
  local dir="$1"
  local venv=""
  for candidate in "$dir/.venv" "$dir/venv" "$dir/env"; do
    [ -f "$candidate/pyvenv.cfg" ] && venv="$candidate" && break
  done
  [ -n "$venv" ] || return 0
  local count
  count="$("$venv/bin/pip" freeze 2>/dev/null | wc -l | tr -d ' ')"
  info "[C] $venv （venv 内写死绝对路径，不能搬）→ 可在共享 venv 重建 $count 个包"
  candidates_c+=("$venv")
}

scan_node() {
  local dir="$1"
  local modules="$dir/node_modules"
  [ -d "$modules" ] || return 0
  local pkg count=0
  local list=()
  for pkg in "$modules"/*/package.json; do
    [ -f "$pkg" ] || continue
    case "$pkg" in */node_modules/.bin/*) continue ;; esac
    local name version
    name="$(sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pkg" | head -1)"
    version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pkg" | head -1)"
    [ -n "$name" ] || continue
    list+=("$name${version:+@$version}")
    count=$((count + 1))
  done
  [ $count -gt 0 ] || return 0
  info "[B] $modules （$count 个顶层包，不拷贝目录）→ shared npm install -g ${list[*]}"
  candidates_b+=("$dir")
}

cmd_adopt() {
  local target="." mode="dry" want_class=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) mode="dry" ;;
      --yes|-y) mode="yes" ;;
      --class) shift; want_class="${1:-}" ;;
      -h|--help) info "用法：shared adopt [目录] [--dry-run|--yes] [--class A|B|C]"; return 0 ;;
      *) target="$1" ;;
    esac
    shift
  done
  [ -d "$target" ] || die "目录不存在：$target"
  ensure_root
  local dir abs
  dir="$target"
  abs="$(cd "$dir" && pwd)"

  candidates_a=(); candidates_b=(); candidates_c=()
  info "扫描 $abs（$( [ "$mode" = dry ] && echo 'dry-run，不改动任何文件' || echo '执行模式' )）"
  scan_dir "$abs" 1
  scan_venv "$abs"
  scan_node "$abs"

  if [ ${#candidates_a[@]} -eq 0 ] && [ ${#candidates_c[@]} -eq 0 ] && [ ${#candidates_b[@]} -eq 0 ]; then
    info "没有发现可搬迁的工具或环境"
    return 0
  fi

  if [ "$mode" = dry ]; then
    info ""
    info "预演结束。执行：shared adopt $abs --yes [--class A|B|C]"
    return 0
  fi

  local didA=0 didB=0 didC=0 run_id
  run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mkdir -p "$LOG_DIR"
  manifest_init
  ADOPT_RUN_LOG="$LOG_DIR/adopt-$run_id.jsonl"
  : > "$ADOPT_RUN_LOG"
  json_record "$ADOPT_RUN_LOG" run-start "$run_id" '' started "$abs" "$ROOT" || die "无法写入迁移清单"
  if [ -z "$want_class" ] || [ "$want_class" = "A" ]; then
    local file name dest ts
    for file in "${candidates_a[@]:-}"; do
      [ -n "$file" ] || continue
      name="${file##*/}"
      dest="$BIN_DIR/$name"
      if [ -e "$dest" ]; then
        info "跳过 $name：$dest 已存在"
        adopt_record "$run_id" A skipped "$file" "$dest" "$name" || true
        continue
      fi
      if mv "$file" "$dest"; then
        adopt_record "$run_id" A succeeded "$file" "$dest" "$name" || info "迁移记录写入失败：$ADOPT_RUN_LOG"
        manifest_set "$name" "" "$(sha256_of "$dest")" "" "$file" "$(wc -c < "$dest" | tr -d ' ')"
        info "已搬迁 $file → $dest"
      else
        info "搬迁失败：$file"
        adopt_record "$run_id" A failed "$file" "$dest" "$name" || true
        continue
      fi
      didA=$((didA + 1))
    done
    [ $didA -gt 0 ] && cmd_link
  fi

  if { [ -z "$want_class" ] || [ "$want_class" = "B" ]; } && [ ${#candidates_b[@]} -gt 0 ]; then
    local d pkgfile name version
    for d in "${candidates_b[@]:-}"; do
      [ -n "$d" ] || continue
      for pkgfile in "$d"/node_modules/*/package.json; do
        [ -f "$pkgfile" ] || continue
        name="$(sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pkgfile" | head -1)"
        version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pkgfile" | head -1)"
        [ -n "$name" ] || continue
        local spec="$name${version:+@$version}"
        if NPM_CONFIG_PREFIX="$NPM_PREFIX" NPM_CONFIG_CACHE="$CACHE_DIR/npm" \
          npm install -g "$spec" >/dev/null 2>&1; then
          didB=$((didB + 1))
          adopt_record "$run_id" B succeeded "$pkgfile" "$NPM_PREFIX" "$name" "$version" || true
        else
          info "重装失败：$spec"
          adopt_record "$run_id" B failed "$pkgfile" "$NPM_PREFIX" "$name" "$version" || true
        fi
      done
    done
    [ $didB -gt 0 ] && cmd_link
    info "已按版本重装 $didB 个 node 包到 $NPM_PREFIX"
  fi

  if { [ -z "$want_class" ] || [ "$want_class" = "C" ]; } && [ ${#candidates_c[@]} -gt 0 ]; then
    local venv line
    for venv in "${candidates_c[@]:-}"; do
      [ -n "$venv" ] || continue
      while IFS= read -r line; do
        [ -n "$line" ] || continue
        case "$line" in \#*|-e*) continue ;; esac
        if PIP_CACHE_DIR="$CACHE_DIR/pip" "$PY_VENV/bin/pip" install "$line" >/dev/null 2>&1; then
          didC=$((didC + 1))
          adopt_record "$run_id" C succeeded "$venv" "$PY_VENV" "$line" || true
        else
          info "重建失败：$line"
          adopt_record "$run_id" C failed "$venv" "$PY_VENV" "$line" || true
        fi
      done <<< "$("$venv/bin/pip" freeze 2>/dev/null)"
    done
    [ $didC -gt 0 ] && cmd_link
    info "已重建 $didC 个 python 包到 $PY_VENV"
  fi

  json_record "$ADOPT_RUN_LOG" run-end "$run_id" '' completed "$abs" "$ROOT" "A=$didA B=$didB C=$didC" || true
  info "迁移清单：$ADOPT_RUN_LOG"
  info "回滚：shared restore（B/C 按清单中的 succeeded 项手动卸载）"
}

cmd_restore() {
  [ -f "$ADOPT_LOG" ] || { info "没有 adopt 记录（$ADOPT_LOG）"; return 0; }
  local line
  # 只回滚 A 类：把文件搬回原处
  while IFS= read -r line; do
    case "$line" in *'"class":"A"'*) ;; *) continue ;; esac
    local from to
    if command -v node >/dev/null 2>&1; then
      IFS=$'\t' read -r from to < <(LINE="$line" node -e 'try { const x=JSON.parse(process.env.LINE); process.stdout.write(`${x.from}\t${x.to}`) } catch {}')
    else
      continue
    fi
    [ -n "$from" ] && [ -n "$to" ] || continue
    if [ -e "$to" ] && [ ! -e "$from" ]; then
      mv "$to" "$from" && info "已回滚 $to → $from"
      local link="$LINK_DIR/${to##*/}"
      if [ -L "$link" ]; then
        local target source
        target="$(readlink -f "$link" 2>/dev/null || true)"
        source="$(readlink -f "$from" 2>/dev/null || true)"
        [ "$target" = "$source" ] && rm -f "$link"
      fi
    fi
  done < "$ADOPT_LOG"
  info "B/C 类回滚：shared npm uninstall -g <包名> / shared pip uninstall -y <包名>"
}

# ────────────────────────────── 状态与自检 ──────────────────────────────

skill_desc() {
  awk '/^description:[[:space:]]*/{sub(/^description:[[:space:]]*/, ""); print; exit}' "$1" 2>/dev/null
}

# 记忆后端尽力探测（不代表插件运行时状态；挂载真相看 shared_lib action=memory）：
#   meow-memory：随 bundle 挂载；数据家优先 <root>/state/memory-home（本包新配置），
#   旧 ~/.dsh-meow 有内容说明插件还没按新配置迁移过——迁移是插件 apply 时自动完成的。
#   mnemon CLI：可选，仅 Memory Spaces 的 Mnemon Native provider 需要，shared memory setup-mnemon 安装
probe_memory() {
  local cfg_home="$ROOT/state/memory-home" legacy_home="${HOME:-/root}/.dsh-meow"
  MEOW_MIGRATE_NOTE=""
  if [ -n "$(ls -A "$cfg_home" 2>/dev/null)" ]; then
    MEOW_HOME="$cfg_home"; MEOW_STATE="present"
  elif [ -n "$(ls -A "$legacy_home" 2>/dev/null)" ]; then
    MEOW_HOME="$legacy_home"; MEOW_STATE="present"
    MEOW_MIGRATE_NOTE="（legacy，meow-memory 在新配置下首次 apply 会自动迁入 $cfg_home）"
  else
    MEOW_HOME="$cfg_home"; MEOW_STATE="not-created"
  fi
  if command -v mnemon >/dev/null 2>&1; then
    MNEMON_STATE="present"
    MNEMON_VER="$(mnemon --version 2>/dev/null | head -1)"
  else
    MNEMON_STATE="absent"
    MNEMON_VER=""
  fi
}

cmd_memory() {
  local sub="${1:-status}"
  probe_memory
  case "$sub" in
    status)
      info "记忆后端（best-effort 探测，不代表插件运行时状态）"
      info "  meow-memory   随包声明（激活未验证）；数据家 $MEOW_HOME（$MEOW_STATE）$MEOW_MIGRATE_NOTE；记忆库本体按工作区 .dsh-meow/memory.db 隔离"
      if [ "$MNEMON_STATE" = present ]; then
        info "  mnemon CLI    $MNEMON_VER（可选；Memory Spaces 的 Mnemon Native provider 需要）"
      else
        info "  mnemon CLI    未安装（可选）；启用：shared memory setup-mnemon"
      fi
      info "  dsh-mnemon    独立 bundle，需另用 plugin_manager 启用（本包不插行，避免条目 id 冲突）"
      info "  真相来源      以上为 shell 尽力探测；模型侧 shared_lib(action=memory) 直接读 Loader 条目"
      ;;
    setup-mnemon)
      info "安装 mnemon CLI 到共享 npm 环境并软链进 PATH（可选，仅 Memory Spaces native provider 需要）"
      NPM_CONFIG_PREFIX="$NPM_PREFIX" NPM_CONFIG_CACHE="$CACHE_DIR/npm" \
        npm install -g @mnemon-dev/mnemon || die "mnemon CLI 安装失败"
      cmd_link
      info "完成；跑 mnemon --version 验证"
      ;;
    *) die "用法：shared memory [status|setup-mnemon]" ;;
  esac
}

json_status() {
  local modefile="$1" key="$2" mode="$3" tools="$4" skills="$5" linked="$6" deny="$7" corrected="$8" issues="$9"
  ROOT="$ROOT" LINK_DIR="$LINK_DIR" MODEFILE="$modefile" WORKSPACE="$key" MODE="$mode" TOOLS="$tools" SKILLS="$skills" LINKED="$linked" DENY="$deny" CORRECTED="$corrected" ISSUES="$issues" VERSION="$VERSION" PY_VENV="$PY_VENV" NPM_PREFIX="$NPM_PREFIX" CACHE_DIR="$CACHE_DIR" MEOW_HOME="$MEOW_HOME" MEOW_STATE="$MEOW_STATE" MEOW_MIGRATE_NOTE="$MEOW_MIGRATE_NOTE" MNEMON_STATE="$MNEMON_STATE" MNEMON_VER="$MNEMON_VER" MANIFEST_P="$MANIFEST" \
    node -e 'const e=process.env; const fs=require("node:fs"); const lines=(e.ISSUES||"").split("\n").filter(Boolean).map(l=>{const i=l.indexOf("|");const j=l.indexOf("|",i+1);return i<0?{code:"UNKNOWN",message:l,fix:null}:{code:l.slice(0,i),message:l.slice(i+1,j<0?undefined:j),fix:j<0?null:l.slice(j+1)}}); let mpin=0,munpin=0;try{const d=JSON.parse(fs.readFileSync(e.MANIFEST_P,"utf8"));for(const t of Object.values(d.tools||{})){if(t.sha256)mpin++;else munpin++}}catch{} console.log(JSON.stringify({version:e.VERSION,root:e.ROOT,linkDir:e.LINK_DIR,workspace:e.WORKSPACE,mode:e.MODE,tools:Number(e.TOOLS),skills:Number(e.SKILLS),linkedTools:Number(e.LINKED),python:{path:e.PY_VENV,created:fs.existsSync(`${e.PY_VENV}/bin/python`)},npm:{prefix:e.NPM_PREFIX},cache:e.CACHE_DIR,interception:{denied:Number(e.DENY),corrected:Number(e.CORRECTED)},manifest:{pinned:mpin,unpinned:munpin},memory:{meow:{bundled:true,home:e.MEOW_HOME,homeState:e.MEOW_STATE,dbExists:fs.existsSync(`${e.MEOW_HOME}/memory.db`),migrationNote:e.MEOW_MIGRATE_NOTE||null},mnemon:{cliInstalled:e.MNEMON_STATE==="present",version:e.MNEMON_VER||null,bundle:"separate-enable-optional"}},issues:lines}))'
}

cmd_status() {
  local json=0
  [ "${1:-}" = "--json" ] && json=1
  ensure_root
  local tools skills linked f name
  tools=$(find "$BIN_DIR" -maxdepth 1 -type f ! -name '.*' 2>/dev/null | wc -l | tr -d ' ')
  skills=$(find "$SKILLS_DIR" -maxdepth 2 -name SKILL.md 2>/dev/null | wc -l | tr -d ' ')
  linked=0
  for f in "$BIN_DIR"/*; do
    [ -e "$f" ] || continue
    [ -L "$LINK_DIR/${f##*/}" ] && linked=$((linked + 1))
  done
  local modefile key value="shared"
  { IFS= read -r modefile; IFS= read -r key; } <<< "$(ws_mode_file "$(pwd)")"
  [ -f "$modefile" ] && value="$(head -1 "$modefile")"

  local deny=0 corrected=0
  if [ -f "$HOOK_LOG" ]; then
    deny=$(grep -c '"event":"deny"' "$HOOK_LOG" 2>/dev/null || true)
    corrected=$(grep -c '"event":"corrected"' "$HOOK_LOG" 2>/dev/null || true)
  fi

  probe_memory

  if [ "$json" = 1 ]; then
    local issues
    issues="$(_health_issues)"
    json_status "$modefile" "$key" "$value" "$tools" "$skills" "$linked" "$deny" "$corrected" "$issues"
    [ -n "$issues" ] && return 1
    return 0
  fi

  info "共享库   $ROOT"
  info "PATH     $LINK_DIR（bin 里的工具软链到这里）"
  info "工具     $tools 个，已进 PATH $linked 个"
  local mpin=0 munpin=0
  if [ -f "$MANIFEST" ]; then
    { IFS=$'\t' read -r mpin munpin; } < <(MFS="$MANIFEST" node -e 'const d=JSON.parse(require("node:fs").readFileSync(process.env.MFS,"utf8"));const t=Object.values(d.tools||{});console.log(t.filter(x=>x.sha256).length+"\t"+t.filter(x=>!x.sha256).length)')
  fi
  info "清单     $MANIFEST（sha256 已 pin $mpin，未 pin $munpin；verify/export 复现）"
  info "开发环境 venv=$PY_VENV$([ -x "$PY_VENV/bin/python" ] && echo '（已创建）' || echo '（未创建）')"
  info "         npm=$NPM_PREFIX"
  info "技能     $skills 个（$SKILLS_DIR）"
  info "缓存     $CACHE_DIR"
  if command -v pip >/dev/null 2>&1 || python3 -c 'import pip' >/dev/null 2>&1; then
    info "系统 pip 有"
  else
    info "系统 pip 无（裸 pip install 被放行后会报 command not found，属正常）"
  fi
  info "模式     $value（工作区 $key）"
  info "拦截     $deny 次，其中模型改用 shared 命令 $corrected 次"
  local mem_mnemon
  if [ "$MNEMON_STATE" = present ]; then mem_mnemon="已装（$MNEMON_VER）"; else mem_mnemon="未装（可选：shared memory setup-mnemon）"; fi
  info "记忆     meow-memory 随包声明（$MEOW_HOME：$MEOW_STATE$MEOW_MIGRATE_NOTE）；mnemon CLI $mem_mnemon"

  local issues
  issues="$(_health_issues)"
  if [ -n "$issues" ]; then
    info ""
    info "!! 以下问题必须修，否则「装上了但用不了」："
    while IFS='|' read -r code msg fix; do [ -n "$code" ] || continue; info "!! $msg（修：$fix）"; done <<< "$issues"
    return 1
  fi
  return 0
}

# _health_issues：每行 code|message|fix（供 status/doctor 出可执行修复；basic-memory doctor 风格）
_health_issues() {
  local out="" f name link
  for f in "$BIN_DIR"/*; do
    [ -e "$f" ] || continue
    name="${f##*/}"; link="$LINK_DIR/$name"
    if [ -L "$link" ]; then
      if is_elf "$f" && ldd "$f" 2>/dev/null | grep -q 'not found'; then
        out+="DEP_MISSING|${name} 依赖缺失（ldd 有 not found）|补齐动态库，或用静态构建重新 shared get ${name} <url>"$'\n'
      fi
      continue
    fi
    if [ -e "$link" ]; then
      out+="PATH_OCCUPIED|${name} 未进 PATH：$link 被非本库文件占用|换名安装：shared get <url> ${name}-shared；或先 shared unlink ${name} 再 shared link"$'\n'
    else
      out+="NOT_LINKED|${name} 未进 PATH：缺少软链|shared link"$'\n'
    fi
  done
  if [ -d "$NPM_PREFIX/bin" ]; then
    for f in "$NPM_PREFIX"/bin/*; do
      [ -e "$f" ] || continue
      name="${f##*/}"
      [ -L "$LINK_DIR/$name" ] || out+="NPM_NOT_LINKED|npm 命令 ${name} 未进 PATH|shared link"$'\n'
    done
  fi
  if [ -d "$PY_VENV/bin" ]; then
    for f in "$PY_VENV"/bin/*; do
      [ -e "$f" ] || continue
      name="${f##*/}"
      case "$name" in python*|pip*|activate*|Activate*) continue ;; esac
      [ -L "$LINK_DIR/$name" ] || out+="VENV_NOT_LINKED|venv 命令 ${name} 未进 PATH|shared link"$'\n'
    done
  fi
  if [ -f "$MANIFEST" ]; then
    local vj integ
    vj="$(cmd_verify --json 2>/dev/null)"
    integ="$(RES="$vj" node -e 'try{const d=JSON.parse(process.env.RES||"{}");for(const t of d.tools||[])if(t.state==="missing"||t.state==="corrupt")console.log(["INTEGRITY_"+t.state,t.name+" "+(t.state==="missing"?"缺失":"sha256 漂移"),"shared get \""+(t.url||"<url>")+"\" "+t.name+(t.sha256?" --sha256 "+t.sha256:"")].join("|"))}catch{}')"
    [ -n "$integ" ] && out+="$integ"$'\n'
  fi
  printf '%s' "$out"
}



inventory_json() {
  ROOT="$ROOT" BIN_DIR="$BIN_DIR" NPM_PREFIX="$NPM_PREFIX" PY_VENV="$PY_VENV" SKILLS_DIR="$SKILLS_DIR" LINK_DIR="$LINK_DIR" node -e '
const fs=require("node:fs"),path=require("node:path"),e=process.env;
const files=(dir)=>{try{return fs.readdirSync(dir,{withFileTypes:true}).filter(x=>x.isFile()||x.isSymbolicLink()).map(x=>x.name).sort()}catch{return[]}};
const skills=[];
const walk=(dir)=>{let entries=[];try{entries=fs.readdirSync(dir,{withFileTypes:true})}catch{return} for(const x of entries){if(x.name.startsWith("."))continue;const p=path.join(dir,x.name);if(x.isDirectory()){const f=path.join(p,"SKILL.md");if(fs.existsSync(f))skills.push({name:x.name,path:f});else walk(p)}else if(x.isFile()&&x.name.endsWith(".md")&&x.name!=="README.md")skills.push({name:x.name.slice(0,-3),path:p})}};
walk(e.SKILLS_DIR);
const tools=files(e.BIN_DIR).map(name=>({name,path:path.join(e.BIN_DIR,name),linked:fs.existsSync(path.join(e.LINK_DIR,name))&&fs.lstatSync(path.join(e.LINK_DIR,name)).isSymbolicLink()}));
const packageNames=[];for(const p of files(path.join(e.NPM_PREFIX,"lib","node_modules"))){if(p.startsWith("@")){for(const n of files(path.join(e.NPM_PREFIX,"lib","node_modules",p)))packageNames.push(`${p}/${n}`)}else packageNames.push(p)}
const pythonPackages=(()=>{const pip=path.join(e.PY_VENV,"bin","pip");if(!fs.existsSync(pip))return[];const r=require("node:child_process").spawnSync(pip,["list","--format=json"],{encoding:"utf8",timeout:5000});try{return JSON.parse(r.stdout||"[]").map(x=>({name:x.name,version:x.version}))}catch{return[]}})();
console.log(JSON.stringify({tools,skills:skills.sort((a,b)=>a.name.localeCompare(b.name)),npmPackages:packageNames,pythonPackages},null,2));'
}

cmd_list() {
  ensure_root
  if [ "${1:-}" = "--json" ]; then inventory_json; return $?; fi
  local f name mark
  info "== 工具（$BIN_DIR）=="
  for f in "$BIN_DIR"/*; do
    [ -e "$f" ] || continue
    name="${f##*/}"
    if [ -L "$LINK_DIR/$name" ]; then mark="PATH"; else mark="—"; fi
    info "  [$mark] $name"
  done
  info "== 技能（$SKILLS_DIR）=="
  local d
  for d in "$SKILLS_DIR"/*/; do
    [ -f "$d/SKILL.md" ] || continue
    info "  ${d%/}  —  $(skill_desc "$d/SKILL.md")"
  done
  if [ -d "$NPM_PREFIX/bin" ]; then
    info "== Node 全局命令（$NPM_PREFIX/bin）=="
    for f in "$NPM_PREFIX"/bin/*; do
      [ -e "$f" ] || continue
      info "  ${f##*/}"
    done
  fi
  if [ -d "$PY_VENV/bin" ]; then
    info "== venv 命令（$PY_VENV/bin，python/pip 之外）=="
    for f in "$PY_VENV"/bin/*; do
      [ -e "$f" ] || continue
      case "${f##*/}" in python*|pip*|activate*|Activate*) continue ;; esac
      info "  ${f##*/}"
    done
  fi
  return 0
}

cmd_env() {
  local qroot qbin qpip qnpm qcache quv
  printf -v qroot '%q' "$ROOT"
  printf -v qbin '%q' "$BIN_DIR"
  printf -v qpip '%q' "$CACHE_DIR/pip"
  printf -v qnpm '%q' "$NPM_PREFIX"
  printf -v qcache '%q' "$CACHE_DIR/npm"
  printf -v quv '%q' "$CACHE_DIR/uv"
  info "# source 进交互 shell 用："
  info "export DSH_SHARED_ROOT=$qroot"
  info "export PATH=$qbin:\$PATH"
  info "export PIP_CACHE_DIR=$qpip"
  info "export NPM_CONFIG_PREFIX=$qnpm"
  info "export NPM_CONFIG_CACHE=$qcache"
  info "export UV_CACHE_DIR=$quv"
}

cmd_doctor() {
  local json=0 ok=0 issues="" warnings=""
  [ "${1:-}" = "--json" ] && json=1
  [ -d "$ROOT" ] || { issues+="ROOT_MISSING|root directory is missing: $ROOT|检查 cordis.patch.yml 的 root 配置"$'\n'; ok=1; }
  [ -w "$LINK_DIR" ] || { issues+="LINK_NOWRITE|link directory is not writable: $LINK_DIR|修目录权限或在 config 改 linkDir"$'\n'; ok=1; }
  command -v curl >/dev/null || warnings+="curl is missing; shared get is unavailable"$'\n'
  command -v npm >/dev/null || warnings+="npm is missing; shared npm is unavailable"$'\n'
  command -v python3 >/dev/null || warnings+="python3 is missing; shared pip is unavailable"$'\n'
  [ -x "$BIN_DIR/shared" ] || { issues+="CLI_MISSING|shared CLI is missing: $BIN_DIR/shared|重跑 install_bundle 让插件重新铺资产，或 shared link"$'\n'; ok=1; }
  probe_memory
  [ "$MNEMON_STATE" = present ] || warnings+="mnemon CLI is optional for Memory Spaces native provider; install via: shared memory setup-mnemon"$'\n'
  local health
  health="$(_health_issues)"
  [ -n "$health" ] && { issues+="$health"$'\n'; ok=1; }
  if [ "$json" = 1 ]; then
    ROOT="$ROOT" LINK_DIR="$LINK_DIR" BIN_DIR="$BIN_DIR" PY_VENV="$PY_VENV" NPM_PREFIX="$NPM_PREFIX" CACHE_DIR="$CACHE_DIR" ISSUES="$issues" WARNINGS="$warnings" OK="$ok" VERSION="$VERSION" MEOW_HOME="$MEOW_HOME" MEOW_STATE="$MEOW_STATE" MNEMON_STATE="$MNEMON_STATE" MNEMON_VER="$MNEMON_VER" node -e 'const e=process.env;const issues=(e.ISSUES||"").split("\n").filter(Boolean).map(l=>{const i=l.indexOf("|");const j=l.indexOf("|",i+1);return i<0?{code:"UNKNOWN",message:l,fix:null}:{code:l.slice(0,i),message:l.slice(i+1,j<0?undefined:j),fix:j<0?null:l.slice(j+1)}});const warnings=(e.WARNINGS||"").split("\n").filter(Boolean);console.log(JSON.stringify({version:e.VERSION,ok:e.OK==="0",root:e.ROOT,linkDir:e.LINK_DIR,cliExists:require("node:fs").existsSync(e.BIN_DIR+"/shared"),pythonAvailable:require("node:fs").existsSync(e.PY_VENV+"/bin/python"),npmAvailable:!!require("node:child_process").spawnSync("npm",["--version"],{encoding:"utf8",timeout:3000}).stdout,memory:{meow:{bundled:true,home:e.MEOW_HOME,homeState:e.MEOW_STATE},mnemon:{cliInstalled:e.MNEMON_STATE==="present",version:e.MNEMON_VER||null}},issues,warnings},null,2))'
    return "$ok"
  fi
  [ -n "$warnings" ] && printf '%s' "$warnings"
  [ -n "$issues" ] && while IFS='|' read -r code msg fix; do [ -n "$code" ] || continue; printf '%s（修：%s）\n' "$msg" "$fix"; done <<< "$issues"
  [ "$ok" -eq 0 ] && info "检查通过"
  return "$ok"
}

cmd_help() {
  cat <<EOF
shared $VERSION — 共享库：工具 / 开发环境 / 技能

现状
  status [--json]     概况 + 模式 + 拦截对账 + 硬报错自检
  list [--json]       列出工具、技能和环境包清单
  doctor [--json]     自检并输出机器可读诊断

安装
  get <url> [名字] [--sha256 <hex>] [--version <标签>]
                      下载单个可执行文件到 bin，自动 link；给了 --sha256 就校验后才落盘
  uninstall <名字>    删 bin 文件 + 软链 + 清单条目
  npm install -g ...  装 Node 全局包到 $NPM_PREFIX
  pip install ...     装 Python 包到 venv $PY_VENV
  python ...          用共享 venv 跑 python
  uv ... / cargo ... / go ...   薄透传（工具没装会明确报错，不静默）
  link                把 bin / npm bin / venv 里的命令重新软链进 $LINK_DIR
  unlink <名字>       移除某个软链
  skill <名字>        新建技能骨架 $SKILLS_DIR/<名字>/SKILL.md

清单与复现
  manifest [show]     查看 state/tools.json（每个工具的 url/sha256/version）
  verify [--json]     离线校验：missing/corrupt 非零退出；unpinned 提醒补 pin
  outdated            列出没记版本标签的工具（离线不查上游）
  export              输出可移植清单 JSON（工具+包+技能）
  import <file> [--dry-run|--force]   按导出清单跨机复现工具；npm/pip 给出手动命令

落点治理
  mode [show|local|shared]  当前工作区的安装模式；local = 不做前置拦截
  memory [status|setup-mnemon]
                      记忆后端：meow-memory 随 bundle 挂载；setup-mnemon 把 mnemon CLI 装进共享 npm 环境
  adopt [目录] [--dry-run|--yes] [--class A|B|C]
                      扫描工作区里该进共享库的东西（默认只预演）
                      A=单文件可执行（ldd 干净才搬） B=node 包（按版本重装） C=venv（freeze 重建）
  restore             回滚 adopt 的 A 类搬迁

其它
  env                 打印可 source 的环境变量
  help                本帮助

约定
  · 工作区是临时的：工具和依赖装进共享库，新工作区/新会话直接可用
  · 技能放 $SKILLS_DIR/<kebab-name>/SKILL.md，frontmatter 至少写 name 和 description
  · 前置拦截只拦 pip install / npm install -g（无项目清单时）；逃逸用 SHARED_BYPASS=1 前缀或 shared mode local
EOF
}

target_module() {
  local base
  base="$(dirname "$(readlink -f "$0")")"
  if [ -f "$base/.shared-targets.mjs" ]; then printf '%s' "$base/.shared-targets.mjs"
  else printf '%s' "$base/targets.mjs"; fi
}

main() {
  local cmd="${1:-help}"; shift || true
  case "$cmd" in
    target-verify) DSH_SHARED_ROOT="$ROOT" node "$(target_module)" verify ;;
    target-history) DSH_SHARED_ROOT="$ROOT" node "$(target_module)" history ;;
    targets) DSH_SHARED_ROOT="$ROOT" node "$(target_module)" list "$@" ;;
    install-target) DSH_SHARED_ROOT="$ROOT" node "$(target_module)" install "$@" ;;
    status) cmd_status "$@" ;;
    list|ls) cmd_list "$@" ;;
    doctor) cmd_doctor "$@" ;;
    verify) cmd_verify "$@" ;;
    outdated) cmd_outdated "$@" ;;
    export) cmd_export "$@" ;;
    import) cmd_import "$@" ;;
    manifest) cmd_manifest "$@" ;;
    link) cmd_link ;;
    unlink|rm) cmd_unlink "$@" ;;
    uninstall) cmd_uninstall "$@" ;;
    get|add) cmd_get "$@" ;;
    npm) cmd_npm "$@" ;;
    pip) cmd_pip "$@" ;;
    python|py) cmd_python "$@" ;;
    uv) cmd_uv "$@" ;;
    cargo) cmd_cargo "$@" ;;
    go) cmd_go "$@" ;;
    skill|new-skill) cmd_skill "$@" ;;
    mode) cmd_mode "$@" ;;
    memory) cmd_memory "$@" ;;
    adopt) cmd_adopt "$@" ;;
    restore) cmd_restore "$@" ;;
    env) cmd_env ;;
    help|-h|--help) cmd_help ;;
    version|-v|--version) info "shared $VERSION" ;;
    *) die "未知子命令 $cmd，跑 shared help" ;;
  esac
}

main "$@"
