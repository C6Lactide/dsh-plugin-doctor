# dsh-plugin-doctor

DSH（DeepSeek Harness）插件树体检工具。**零依赖**，一条命令查三件最容易把插件层搞坏的事。

```bash
# 直接从 GitHub 跑（不需要 npm 仓库）
npx github:C6Lactide/dsh-plugin-doctor

# 或 clone 下来跑
git clone https://github.com/C6Lactide/dsh-plugin-doctor
node dsh-plugin-doctor/bin/dsh-plugin-doctor.mjs --profile web
node dsh-plugin-doctor/bin/dsh-plugin-doctor.mjs --json
```

> 需要 Node ≥ 18。**不依赖 npm 仓库**——`npx github:` 直接从 GitHub 取包运行。

## 它查什么（都来自真实踩坑）

### ① patch 层 YAML 坏了 —— 整个插件层加载失败

插件市场卸载插件、或手工删条目时，容易只删掉顶层的 `- id: xxx`，把下面的缩进子行（`name:` / `config:`…）留成"孤儿块"。YAML 会把这些行算成**上一个条目的续行**，于是报 `duplicated mapping key` —— 结果不是"少一个插件"，而是**整个 `cordis.patch.yml` 解析失败**，插件层全灭。

```
Error: failed to parse overlay .../cordis.patch.yml:
  YAMLException: duplicated mapping key (30:3)
```

本工具先做 YAML 语法校验，报错时直接指出**行号与重复的 key**。

### ② include 写成目录式 —— `ERR_UNSUPPORTED_DIR_IMPORT`

`insert` 里的本地插件必须写**文件式**路径：

```yaml
# ✗ 目录式：loader 报 ERR_UNSUPPORTED_DIR_IMPORT，插件树连锁重置
- insert:
    - id: foo
      name: ../plugins/foo

# ✓ 文件式
- insert:
    - id: foo
      name: ../plugins/foo/foo.mjs
```

### ③ 装机双份漂移 —— 改了 A，跑的却是 B

DSH 的 loader 实际解析 `profiles/plugins/`，而 `plugins/` 常被当作备份双份。两边 md5 不一致时，你改的那份可能**根本没生效**。本工具逐文件比对（运行态文件如 `*.state.json`、`*.log`、`.bak*` 自动跳过——两边各写各的，比了只会误报）。

## 用法

```
dsh-plugin-doctor [--dsh-home <目录>] [--profile <名>] [--json] [--strict]

--dsh-home   DSH_HOME（默认 $DSH_HOME 或 ~/.dsh）
--profile    profile 名（默认 desktop）
--json       输出 JSON
--strict     有任何问题（含提醒）→ exit 1
```

退出码：`0` 全绿；`1` 有不合格项。

## 依赖

零依赖。若环境里能解析到 [`yaml`](https://www.npmjs.com/package/yaml) 包，会做完整 YAML 语法校验；否则退化为"重复 key 检查"（覆盖上面那个最常见的坏法）。

## 许可

MIT
