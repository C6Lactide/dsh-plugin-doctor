#!/usr/bin/env node
/**
 * dsh-plugin-doctor — DSH 插件树体检（预检 + 一致性）
 *
 * 治三个真实踩过的坑（都来自 DSH 用户会遇到的场景）：
 *   ① **patch 层 YAML 坏了**：插件市场/手工卸载插件时会改 `cordis.patch.yml`，
 *      只删顶层 `- id:` 行、留下缩进的子行 → 上一项变成"重复 key" → **整个 patch 层加载失败**。
 *   ② **include 写成目录式**：`name: ../plugins/foo` 会让 loader 报 `ERR_UNSUPPORTED_DIR_IMPORT`，
 *      插件树连锁重置。必须写成文件式 `../plugins/foo/foo.mjs`。
 *   ③ **双份不一致**：`profiles/plugins/`（loader 真正解析处）与 `plugins/`（备份双份）
 *      漂了，改了 A 以为生效、其实跑的是 B。
 *
 * 零依赖（`yaml` 若可解析则做完整语法校验，否则退化为重复 key 检查）。
 *
 * 用法：
 *   dsh-plugin-doctor                        # 体检默认 profile
 *   dsh-plugin-doctor --profile web          # 指定 profile
 *   dsh-plugin-doctor --dsh-home /path/.dsh  # 指定 DSH_HOME
 *   dsh-plugin-doctor --json                 # 机读
 *   dsh-plugin-doctor --strict               # 有任何问题 exit 1
 *
 * 退出码：0 全绿；1 有 FAIL（或 --strict 下有 WARN）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/* ── 参数 ─────────────────────────────────────────────── */

function parseArgs(argv) {
  const a = { dshHome: null, profile: 'desktop', json: false, strict: false }
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--dsh-home') a.dshHome = argv[++i]
    else if (v === '--profile') a.profile = argv[++i] ?? 'desktop'
    else if (v === '--json') a.json = true
    else if (v === '--strict') a.strict = true
    else if (v === '--help' || v === '-h') { console.log(helpText()); process.exit(0) }
  }
  a.dshHome = path.resolve(a.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))
  return a
}

const helpText = () => `dsh-plugin-doctor — DSH 插件树体检

用法：
  dsh-plugin-doctor [--dsh-home <目录>] [--profile <名>] [--json] [--strict]

  --dsh-home    DSH_HOME（默认 $DSH_HOME 或 ~/.dsh）
  --profile     profile 名（默认 desktop；也可写 web 等）
  --json        输出 JSON
  --strict      有任何问题（含 WARN）→ exit 1

检查项：
  A0 patch 层 YAML 语法（市场卸载会写坏它）
  A  insert 的本地 include 必须文件式（目录式会 ERR_UNSUPPORTED_DIR_IMPORT）
  B  其余本地相对路径 name 的目标存在性
  C  装机双份 md5 一致（profiles/plugins ↔ plugins）
`

/* ── 通用 ─────────────────────────────────────────────── */

const exists = (p) => { try { return fs.existsSync(p) } catch { return false } }
const md5 = (p) => { try { return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex').slice(0, 8) } catch { return null } }

function listFiles(p) {
  if (!exists(p)) return null
  if (fs.statSync(p).isFile()) return ['']
  const out = []
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (/(^|\/)(.*\.state\.json|.*\.log|node_modules\/|\.bak.*)$/.test(r)) continue
      if (e.isDirectory()) walk(path.join(dir, e.name), r)
      else out.push(r)
    }
  }
  walk(p, '')
  return out.sort()
}

/* ── patch 解析 ───────────────────────────────────────── */

/** 从 patch 文本提取 insert 条目的 {id, name}。 */
function parseInserts(text) {
  const out = []
  let cur = null
  for (const line of text.split(/\r?\n/)) {
    const idm = /^\s*-\s*id:\s*([A-Za-z0-9@/._-]+)\s*$/.exec(line)
    if (idm) { cur = { id: idm[1], name: null }; out.push(cur); continue }
    const nm = /^\s*name:\s*(\S+)\s*$/.exec(line)
    if (nm && cur && !cur.name) cur.name = nm[1]
  }
  return out.filter((r) => r.name)
}

/** YAML 语法校验：优先用可解析到的 yaml 包，否则退化查重复 key。 */
function checkYaml(text) {
  try {
    const YAML = require('yaml')
    const doc = YAML.parse(text, { customTags: [{ tag: '!!js', resolve: (v) => String(v) }] })
    if (!Array.isArray(doc)) return '顶层不是 YAML 数组'
    return null
  } catch (e) {
    if (e && (e.code === 'MODULE_NOT_FOUND' || e.code === 'ERR_MODULE_NOT_FOUND')) return detectDupKey(text)
    return String(e.message || e).split('\n')[0]
  }
}

/** 退化检查：按顶层条目切块，块内 2 空格缩进的同名 key 出现两次即报。 */
function detectDupKey(text) {
  const seen = new Map()
  let inItem = false
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^- /.test(l)) { inItem = true; seen.clear(); continue }
    if (!inItem) continue
    const m = /^ {2}([A-Za-z0-9_-]+):/.exec(l)
    if (!m) continue
    if (seen.has(m[1])) return `第 ${i + 1} 行重复 key「${m[1]}」（首次在 ${seen.get(m[1]) + 1} 行）——多半是删顶层条目时留下了缩进子行`
    seen.set(m[1], i)
  }
  return null
}

/* ── 主流程 ───────────────────────────────────────────── */

function main() {
  const a = parseArgs(process.argv)
  const profileDir = path.join(a.dshHome, 'profiles', a.profile)
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  const installRoot = path.join(a.dshHome, 'profiles', 'plugins')   // loader 解析基准
  const backupRoot = path.join(a.dshHome, 'plugins')                 // 备份双份

  const fails = []
  const warns = []
  const oks = []

  if (!exists(patchFile)) {
    console.log(`[跳过] ${patchFile} 不存在（该 profile 未启用）`)
    process.exit(0)
  }

  const text = fs.readFileSync(patchFile, 'utf8')

  // A0 YAML 语法
  const yerr = checkYaml(text)
  if (yerr) {
    fails.push(`[FAIL] patch YAML 语法错：${yerr}`)
  } else {
    oks.push('[OK ] patch YAML 语法通过')
  }

  const entries = parseInserts(text)
  if (!entries.length) warns.push('[WARN] patch 里没有可解析的 insert 条目（可能全是 disabled/覆盖项，正常）')

  for (const e of entries) {
    if (!e.name.startsWith('../') && !e.name.startsWith('./')) {
      oks.push(`[OK ] ${e.id}: ${e.name}（包名，跳过）`)
      continue
    }
    const resolved = path.resolve(profileDir, e.name)
    const ext = path.extname(e.name)
    if (!ext) {
      fails.push(`[FAIL] ${e.id}: 目录式 include「${e.name}」——loader 会报 ERR_UNSUPPORTED_DIR_IMPORT，改成文件式 ../plugins/<名>/<名>.mjs`)
      continue
    }
    if (!exists(resolved)) {
      fails.push(`[FAIL] ${e.id}: 目标不存在 → ${resolved}`)
      continue
    }
    oks.push(`[OK ] ${e.id}: ${e.name} → ${resolved}`)

    // C 双份 md5
    const rel = e.name.replace(/^\.\.\//, '')
    const inst = path.resolve(profileDir, e.name)
    const back = path.join(a.dshHome, rel)
    if (!exists(back)) {
      warns.push(`[WARN] ${e.id}: 备份双份不存在 → ${back}`)
      continue
    }
    const isDirStyle = path.basename(path.dirname(inst)) === e.id
    if (!isDirStyle) {
      const x = md5(inst); const y = md5(back)
      if (x !== y) fails.push(`[FAIL] ${e.id}: 双份不一致（${path.basename(inst)} 装机 ${x} / 备份 ${y}）`)
      else oks.push(`[OK ] ${e.id}: 双份一致`)
    } else {
      const files = listFiles(path.dirname(inst)) ?? []
      let bad = 0
      for (const f of files) {
        const x = md5(path.join(path.dirname(inst), f))
        const y = md5(path.join(path.dirname(back), f))
        if (y === null) { fails.push(`[FAIL] ${e.id}: 备份双份缺文件 ${f}`); bad++ }
        else if (x !== y) { fails.push(`[FAIL] ${e.id}: 双份不一致 ${f}（装机 ${x} / 备份 ${y}）`); bad++ }
      }
      if (!bad) oks.push(`[OK ] ${e.id}: 双份一致（${files.length} 个文件）`)
    }
  }

  const result = { dshHome: a.dshHome, profile: a.profile, patch: patchFile, ok: oks.length, warn: warns.length, fail: fails.length, oks, warns, fails }

  if (a.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log('── dsh-plugin-doctor ──')
    console.log(`  DSH_HOME ${a.dshHome}`)
    console.log(`  profile  ${a.profile}`)
    console.log(`  patch    ${patchFile}`)
    console.log('')
    for (const l of fails) console.log('  ' + l)
    for (const l of warns) console.log('  ' + l)
    for (const l of oks) console.log('  ' + l)
    console.log('')
    console.log(`  结果：通过 ${oks.length} · 提醒 ${warns.length} · 不合格 ${fails.length}`)
    if (fails.length) console.log('  → 先修 FAIL 再重启 DSH（patch 层坏了会导致整个插件层加载失败）。')
  }

  process.exit(fails.length || (a.strict && warns.length) ? 1 : 0)
}

main()
