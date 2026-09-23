# dsh-llm-auto

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](package.json)
[![DSH Plugin](https://img.shields.io/badge/dsh-plugin-8A2BE2.svg)](https://github.com/topics/dsh-plugin)

给 DSH 加一个 **`auto` 模型**:模型选择器里多出一个 `Auto` 分组,组内一条 `auto`。
选它以后,请求按你给的**顺序**依次尝试多条「provider + model」,某条失败就静默切下一条 ——
对上层(agent loop / 会话日志 / 压缩链路)它就是一个普通模型。用来把多个模型订阅"合并"成一个入口。

```
                    ┌─ 用户选了 auto/auto ─┐
   请求 ──► AutoAdapter.stream()
                    │
                    ├─ 1) commandcode/deepseek/deepseek-v4.1-flash   ──► 失败(限流/鉴权/5xx/超时/空响应…)
                    ├─ 2) stepfun/step-5-preview                     ──► 成功 ⇒ 分片原样透传给上层
                    └─ 3) deepseek-official/deepseek-flash           ──► (没轮到)
                    │
                    └─ 全部失败 ⇒ 抛 AUTO_ROUTES_EXHAUSTED,消息里逐条列出「哪条路由、怎么失败的」
```

---

## 1. 快速开始

在 DSH profile 目录(例如 `~/.dsh/profiles/web/`)下:

```bash
# ① 装进 profile:profile 的 package.json 里加依赖,然后 pnpm install(或 npm install)
#      "dsh-llm-auto": "github:liuyun847/dsh-llm-auto"
#    (也在开发这个插件?本地 file: 依赖见 §4 —— pnpm 下不保证是拷贝还是硬链接)

# ② 把本插件自带的 cordis.patch.yml 里那个 - insert: 块复制到
#    ~/.dsh/profiles/<profile>/cordis.patch.yml 末尾,按本机 provider 改 routes

# ③ 重启一次 dsh web(见 §4「生效条件」)
```

重启后:模型选择器出现 **`Auto`** 分组 → 选 `auto` → 发一条消息 → 打开
`http://127.0.0.1:3080/api/llm-auto/routes` 看它到底走了哪条。

---

## 2. 配置

配置写在 profile 的 `cordis.patch.yml` 里(整块范本见本插件自带的 `cordis.patch.yml`):

```yaml
- insert:
    - id: llm-auto
      name: 'dsh-llm-auto'
      config:
        routes:
          - { provider: commandcode, model: deepseek/deepseek-v4.1-flash }
          - { provider: stepfun, model: step-5-preview }
          - { provider: deepseek-official, model: deepseek-flash }
```

| 键 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `routes` | ✅ | — | 有序回退链,**第一项即首选**。每项 `{ provider, model }`;`model` 要写全(settings.yaml 里的真实 id,如 `deepseek/deepseek-v4.1-flash`、`step-5-preview`,别省前缀) |
| `name` | | `Auto` | **模型**显示名(选择器里的分组名恒为 `Auto`) |
| `contextWindow` | | 见下 | 覆盖对外宣称的上下文窗口(正整数)|
| `logLimit` | | `50` | 路由日志环形缓冲条数(仅内存) |

`contextWindow` 不写时:**逐个试路由**,取第一条能给出正整数窗口的那条的窗口;
全都拿不到就用保守值 `65536`(宁可让压缩早触发,也不要谎报一个大窗口导致请求必撞上游上限)。
解析结果缓存 30 秒,目录被反复重建时不会反复去问上游适配器。

> ⚠ `provider` 不要写 `auto`(自递归):挂载时会 warn 并跳过该条。
> ⚠ `routes` 为空/缺失/解析后一条不剩:打一条 `error` 并**拒绝注册**(不抛错,宿主照常启动)。
> ⚠ 写成 `auto` 的**整条**目的链要避开两个坑:① `provider: auto` 是自递归(挂载时 warn 并跳过该条);
> ② 别写本机不可解析的通道或模型 id,否则那一跳每次都以 `NO_ADAPTER` / `UNKNOWN_MODEL` /
> `MISSING_CREDENTIAL` 白撞一次(点开 `/api/llm-auto/routes` 能看到真实 code)。
> ⚠ **本文档里的链是"当时的实例",权威定义在 profile 的 `cordis.patch.yml`**:那份改了而本文没同步时,
> 以文件为准(`curl http://127.0.0.1:3080/api/llm-auto/routes` 的 `chain` 字段永远反映**当前**生效值)。

---

## 3. 路由行为细则

### 回退判定

DSH 的适配器失败**不是抛异常**,而是终止分片
`finish{ kind:'error'|'aborted', failure:{ code, message, status? } }`(由 `LlmRuntime.adapterStream`
把适配器的一切异常归一而成)。本插件据此判定,口径是「**黑名单 + 默认回退**」:

- **绝不回退**:`ABORTED`(调用方取消)、`CONTEXT_WINDOW_EXCEEDED`(请求本身超窗)、
  `IMAGE_OFFLOAD_REQUIRED`(官方约定:按 `offloadImages` 卸图后重试**同一条**);
- **其余一律回退**,包括未知码/没有码。

之所以不做白名单:真机实测的上游错误码空间是开放的 —— 不存在的 provider 是 `NO_ADAPTER`、
错误 model id 是 `UNKNOWN_MODEL`、缺凭据是 `MISSING_CREDENTIAL`、上游 502 是 **`SERVER`**
(而 `SERVER` 并不在 `@deepseek-ai/dsh-llm` 的错误码常量里,是 pi-ai 自己带的)。
白名单会把真实错误漏成"不回退"。

### 硬要求:已经吐给调用方内容之后**不回退**

一旦向调用方交出了**内容**分片(`text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end`),
后续失败原样上报,绝不换路由 —— 否则用户会看到"半截回答 + 重新回答"的拼接。

实现上还有一条来自源码的硬约束:**回退只能发生在"一个分片都没交出去"的时候**。
`@deepseek-ai/dsh-llm/lib/invariant.js` 给每一次 `llm/stream` 套了流语法校验器,它会拒绝
「同一个流里 `block-start` 重复 index」和「`usage` 出现两次」。所以 `block-start` 与 `usage`
会被**暂存**,直到第一条内容分片到达才一起放行。这不是洁癖:真机观测到
`ww/gpt-6-astra` **先发一个全零 usage 再报 502**(2026-09-23 探针实测,该条已在同日改链时移出),
暂存 usage 正好让这种情形仍能安全回退。

### 空响应也算失败

上游"正常结束但一条内容都没有"(`finish{kind:'stop'}` 且零内容)被当作 `EMPTY_RESPONSE` 处理:
能换路由就换;全都这样则报聚合错误,而不是静默交出一个空回合。

### 全部失败

抛 `LlmError`(code `AUTO_ROUTES_EXHAUSTED`,`cause` 是逐条失败的 `AggregateError`),
消息形如:

```
auto: 全部 2 条路由均失败
  1) probe-no-such-provider/whatever → NO_ADAPTER: no adapter registered for provider "probe-no-such-provider"（1 ms）
  2) commandcode/xiaomi/definitely-not-a-model → UNKNOWN_MODEL: pi-ai provider "commandcode" has no configured model "xiaomi/definitely-not-a-model"（0 ms）
```

用 `LlmError` 而不是裸 `AggregateError`:后者的码会被归一成 `UNKNOWN`,丢掉可路由性。

### 不改默认模型

本插件**不碰** `settings.yaml` 与 `agent-default-model`:用户不主动选 `auto` 时一切照旧。

---

## 4. 生效条件(踩过)

1. **`file:` 依赖在 pnpm 下不保证是拷贝还是硬链接**(本机实测两者混存:同名文件可能共 inode,也可能
   是独立副本)。真正被加载的是 `~\.dsh\profiles\<profile>\node_modules\dsh-llm-auto\`,改完 `plugins\` 下的
   源码**别假设副本会自动更新** —— 用 SHA256 比对两处确认;编辑器"另存/原子替换"会**断开硬链接**,两处分叉。
   改完必须重新同步,而且要用 **remove + add**(只 `add` 可能报 "Already up to date" 而跳过拷贝):

   ```bash
   node <工作区>\dsh-plugin-manager\dshpm.mjs remove dsh-llm-auto --profile web
   node <工作区>\dsh-plugin-manager\dshpm.mjs add `
     file:%USERPROFILE%\.dsh\profiles\<profile>\plugins\dsh-llm-auto --profile <profile>
   ```

   `dshpm` 是本机工作区里的插件装卸 CLI(`dsh-plugin-manager`,即上面那个脚本),公开环境没有它;
   可用官方 `dsh plugin add` / `dsh plugin remove` 代替,只是官方命令在部分版本会超时并丢
   `dsh.profile.bundles` 更新,所以本机一直用 `dshpm`。

   同步后用 SHA256 比对两份 `lib/index.js` 一致。

2. **改插件代码要重启 dsh** —— loader 按 URL 缓存已 import 的模块实例。
   改 profile 的 `cordis.patch.yml`(patch 层)则保存即热加载,不需要重启。
   所以顺序是:先改代码 → 同步 → 改配置(可选)→ 重启。

3. 本插件**不进** `dsh.profile.bundles`(包内没有 `dsh.bundle` 字段),装载只能靠
   `cordis.patch.yml` 的 insert。

---

## 5. 可观测

### HTTP 端点

```
GET /api/llm-auto/routes?limit=N      # limit 省略/非法 = 不限(以容量为上限)
```

```json
{
  "provider": "auto", "model": "auto", "name": "Auto",
  "chain": ["commandcode/deepseek/deepseek-v4.1-flash", "stepfun/step-5-preview", "deepseek-official/deepseek-flash"],
  "capacity": 50, "total": 2,
  "routes": [
    { "at": "2026-09-23T13:03:49.516Z", "attempt": 1, "provider": "probe-no-such-provider",
      "model": "whatever", "ok": false, "switched": true, "elapsedMs": 1,
      "code": "NO_ADAPTER", "reason": "NO_ADAPTER: no adapter registered for provider \"probe-no-such-provider\"" },
    { "at": "2026-09-23T13:03:51.518Z", "attempt": 3, "provider": "commandcode",
      "model": "deepseek/deepseek-v4.1-flash", "ok": true, "switched": false, "elapsedMs": 1900 }
  ]
}
```

字段:`at`(时间)、`attempt`(第几次尝试,1 起)、`provider`/`model`(命中的路由)、
`ok`(是否成功)、`switched`(这次失败是否触发了切换)、`elapsedMs`(耗时)、`code`/`reason`(失败原因摘要)。

> ⚠ **该端点不经过浏览器鉴权**:它是 exact 路由,优先于 `dsh-client-connection` 注册的
> `/api` 前缀(前缀表只在 exact 未命中时才查),因此不检查鉴权 cookie。
> 仅因为 webServer 绑在回环地址才可接受;**不要**把 webServer 改成 `0.0.0.0` 后继续留用它。

### 日志

用插件 logger(`llm-auto` 子系统):
- 挂载时一条 `info`:`auto: 已注册路由 auto/auto（Auto）→ commandcode/… → ww/…`;
- 每次切换一条 `warn`:`auto: 第 1 条路由 x/y 失败(SERVER(502): …),静默切换 → a/b`;
- 已经产出内容后失败、以及错误码不允许回退时各一条 `warn`;
- 全部失败一条 `error`。

不刷屏:每次**切换**才一条,正常请求零日志。

---

## 6. 边界与已知限制

- **只"失败时切换"**:不做额度记账、不按价格/能力/内容挑路由。顺序完全由 `routes` 决定。
- **不做视觉/长上下文分流**:上游同类插件按"含图 / 超长"分流,本插件按用户明确要求只做失败回退。
- **不声明 `inputModalities`**:目录里不宣称"支持图片"。"能不能收图"交给真正被选中的那条路由决定;
  声明了反而会让运行时按声明去投影请求(把图片换成占位文本)。
- **`reasoningEffort` 一律用该路由可用的最高强度**(2026-09-23 用户指定):每跳前问一次该路由
  `resolveModelInfo` 的 `reasoning.efforts`,取**最后一项**(DSH 的档位强度序固定为
  `off→minimal→low→medium→high→xhigh→max`,适配器只保留该模型支持的档位 ⇒ "最后一项"就是它
  能给的最高强度),**忽略调用方带来的档位**;该路由完全不声明档位(不思考的模型)时才原样透传,
  让分发给出准确错误。这样既不因为"档位不匹配"让兜底路由白失败一次,也不需要调用方为每跳手动调档。
  本插件自己**不声明** reasoning 能力,所以模型选择器不会给 `auto` 提供档位选项。
- **跨路由的 replay 元数据**:DSH 只在"历史 provider 与目标 provider 属于同一个适配器实例"时保留
  replay 状态。`auto` 自己产出的消息(source.provider = `auto`)在嵌套调用里会被自动剥掉 replay;
  而历史消息若本来就来自 `commandcode`,回退到同属 pi-ai 的 `ww` 时 replay 会被保留 ——
  这是上游既有行为(手动切模型时同样发生),不是本插件引入的,但**路由切换确实会让它更容易出现**。
- **路由日志是进程内内存**,重启即清空,不适合当审计账本。
- **失败原因摘要可能含上游返回的文本**(如报文片段),但不含凭据:各适配器按设计不把 key 写进消息。
- **未实测覆盖**:①"已产出内容后失败"只有单测(含真实 `LlmRuntime` + 真实流语法不变式)覆盖,
  没有对真上游稳定复现过(需要一条"吐一半再断"的路由);②非回环绑定下的鉴权影响未评估(见 §5)。
- **第三方同类插件**:`zhanghao3693/dsh-llm-router` 功能相近(按内容分流 + 回退链)。本插件是
  本机自建、只做失败回退,不依赖也不需要它。

---

## 7. 测试

```bash
cd dsh-llm-auto                   # 本仓库根目录
node --test "test/*.test.mjs"     # 注意:Node 24 起 `node --test test/` 不再展开目录
```

| 文件 | 覆盖 |
| --- | --- |
| `test/routes.test.mjs` | `normalizeRoutes`(空/非数组/自递归/重复/单条坏条目)、`describeChain`、`createRing` |
| `test/adapter.test.mjs` | 首次成功、首条失败后回退、全部失败聚合、**已产出内容后失败不回退**、暂存分片、空响应、不可回退码、取消、上游抛异常、按路由取最高推理档位、窗口解析 |
| `test/runtime-integration.test.mjs` | 用**真实** `LlmRuntime` + **真实** `@deepseek-ai/dsh-llm/invariant` 跑端到端:目录校验、回退后的流语法零违规、聚合错误的终止分片、注销后路由立刻消失 |
| `test/endpoint.test.mjs` | `apply()` 的注册/拒绝注册分支、`provider: auto` 跳过、HTTP 端点响应 |

`runtime-integration` 是这套测试里最值钱的一个:它把"我的输出能不能被宿主接受"也钉住了 ——
尤其是"回退时不能出现重复 `block-start` / 重复 `usage`"这条,只有跑真实校验器才测得出来。

真机端到端(探针 profile,任务内容"只回复两个字:收到"):

| 场景 | 观察到的路由序列 | 结果 |
| --- | --- | --- |
| 首选可用 | `auto` → `commandcode/deepseek/deepseek-v4.1-flash` | 成功,exit 0 |
| 两条真实失败后回退 | `auto` → `probe-no-such-provider/whatever`(NO_ADAPTER) → `commandcode/xiaomi/definitely-not-a-model`(UNKNOWN_MODEL) → `commandcode/deepseek/deepseek-v4.1-flash` | 成功,exit 0 |
| 全部失败 | 同上但砍掉第三条 | exit 1,消息含 `AUTO_ROUTES_EXHAUSTED` 与逐条原因 |

---

## 8. 故障排查

| 现象 | 多半是 |
| --- | --- |
| 选择器里没有 `Auto` 分组 | 插件没装进 `node_modules`(只改了 `plugins\`)、或宿主没重启、或用 `--dump-config` 看 insert 块没进去 |
| 有分组但选 `auto` 就报 `NO_ADAPTER` | 宿主还在跑旧代码,或 insert 块被别处覆盖了 |
| 每次第一条必失败 | `routes[0]` 那条路由本机不可用(例如 `deepseek-official` 无凭据);`/api/llm-auto/routes` 会直接告诉你 code |
| 改了源码没反应 | `file:` 是实体拷贝:必须 remove + add 同步 + 重启(见 §4) |
| 上下文窗口明显偏小 | `contextWindow` 没配且首选路由解析不到窗口,回落到了保守值 65536;显式配一个即可 |

## License

MIT
