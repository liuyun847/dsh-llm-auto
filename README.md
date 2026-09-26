# dsh-llm-auto

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.4.0-blue.svg)](package.json)
[![DSH Plugin](https://img.shields.io/badge/dsh-plugin-8A2BE2.svg)](https://github.com/topics/dsh-plugin)

给 DSH 加一个 **`auto` 模型**:模型选择器里多出一个 `Auto` 分组,组内一条 `auto`。
选它以后,请求按你给的**顺序**依次尝试多条「provider + model」,某条失败会**先按官方同款策略
在该路由内原地重试**(瞬时错误,默认最多 5 次),重试耗尽才静默切下一条 ——
对上层(agent loop / 会话日志 / 压缩链路)它就是一个普通模型。用来把多个模型订阅"合并"成一个入口。

还能把**自动压缩点**钉在你要的位置(`compactWindow`,默认 50 万 token):DSH 的压缩引擎按
"该请求声明的窗口"算阈值,而本插件的窗口是**按压缩点反算**出来的。

```
                    ┌─ 用户选了 auto/auto ─┐
   请求 ──► AutoAdapter.stream()
                    │
                    ├─ 1) opencode-go/deepseek-v4.1-flash
                    │      ├─ 第 1 次失败(SERVER 502) ──► 白名单内 ⇒ 退避 500ms 后原地重试
                    │      ├─ 第 2 次失败 ──────────────► 退避 1s 后原地重试 ……(默认最多重试 5 次)
                    │      └─ 重试耗尽 ────────────────┐
                    ├─ 2) commandcode/deepseek/deepseek-v4.1-flash   ▼
                    │      └─ 成功 ⇒ 分片原样透传给上层(前面各次的 usage 等协议分片已被丢弃)
                    └─ 3) deepseek-official/deepseek-flash   ──► (没轮到)
                    │
                    └─ 全部失败 ⇒ 抛 AUTO_ROUTES_EXHAUSTED,消息里逐条列出「哪条路由、试了几次、怎么失败的」
```

---

## 1. 快速开始

本包是**组合包(bundle)**:注册行(`id: llm-auto`)随包发布在包内 `cordis.patch.yml` 里,
宿主按 profile `package.json` 的 `dsh.profile.bundles` 加载 —— **不需要**再往 profile 的
`cordis.patch.yml` 里贴任何 `- insert:` 行。

在 DSH profile 目录(`~\.dsh\profiles\web\`)下:

```bash
# ① 装进 profile:dshpm 会顺带把包名写进 dsh.profile.bundles
node C:\Users\MLTZ\Desktop\code\working\dsh-plugin-manager\dshpm.mjs add file:./plugins/dsh-llm-auto --profile web
#    公开环境:profile 的 package.json 里加 "dsh-llm-auto": "github:liuyun847/dsh-llm-auto"
#    再 pnpm install(或 npm install) —— 同样只要包名在 dsh.profile.bundles 里

# ② 按本机 provider 改 routes:改包内 cordis.patch.yml 那一行(profile 层也可按 id 覆写)

# ③ 重启一次 dsh web(见 §4「生效条件」)
```

- **启停**:Web 侧栏「插件」页 →「已安装」区里本卡的总开关(写 `dsh.profile.bundles`);
  点开卡片后每一行还有行级开关(向 profile 的 `cordis.patch.yml` 写 `disabled` 覆盖 ——
  profile 层在包层之后应用,所以覆写优先)。
- **卸载**:`node dshpm.mjs remove dsh-llm-auto --profile web`。
  ⚠ 本 profile 的 pnpm 带供应链策略,`pnpm remove` 会报
  `ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED`;绕过办法是进 profile 目录直接跑
  `pnpm remove dsh-llm-auto --config.minimum-release-age=0`
  (dshpm 的 `--fast` 只对 `add` 有效 —— `pnpm remove` 不接受 `--minimum-release-age` 这类参数)。
- ⚠ **0.4.0 新增的浏览器半侧必须重启一次 dsh 才会被收录**:宿主 `dsh-client-modules` 把
  "本包不是客户端包"这一**否定结论按 specifier 缓存在 `pkgMeta` 里,只写不删**
  (其 `lib/index.js:510` / `:703`),HMR 不会重新扫描 ⇒ 半侧新增后先重启,插件页才会
  长出配置表单(见 §2)。

重启后:模型选择器出现 **`Auto`** 分组 → 选 `auto` → 发一条消息 → 打开
`http://127.0.0.1:3080/api/llm-auto/routes` 看它到底走了哪条(以及当前声明的上下文窗口)。
`compactWindow` 的图形入口在插件页:「已安装」→ 点开 `dsh-llm-auto` 那张卡片,表单就在
卡片描述与行列表之间(0.4.0 起,见 §2「插件页里的 compactWindow 表单」)。

---

## 2. 配置

配置有两个入口:

- **插件页里的表单**(0.4.0 起):「已安装」→ 点开 `dsh-llm-auto` 卡片 → 表单在描述与行之间,
  只暴露 `compactWindow` 一个字段,保存才写入(见下节「插件页里的 compactWindow 表单」);
- **包内 `cordis.patch.yml`** 的注册行(= 本包自带、随组合包加载的那一行):结构性配置
  `routes` / `retry` 只能在这里改;profile 层要覆盖就按 `id: llm-auto` 写覆写行(profile 层在包层之后应用)。

标了「热改」的键同时是 schemastery 的 `.volatile()` 字段,经宿主的设置服务可改、改完即时生效
(效果边界见本节末尾)。

```yaml
- insert:
    - id: llm-auto
      name: 'dsh-llm-auto'
      config:
        routes:
          - { provider: opencode-go, model: deepseek-v4.1-flash }
          - { provider: commandcode, model: deepseek/deepseek-v4.1-flash }
          - { provider: deepseek-official, model: deepseek-flash }
        # 压缩点(默认就是 500000,写出来只是显式化)
        compactWindow: 500000
        # retry 不写 = 官方默认(每路由 5 次重试);要关掉或改参数再放开:
        # retry:
        #   maxRetries: 5
        #   retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]
        #   backoff: { initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 }
```

| 键 | 必填 | 默认 | 热改 | 说明 |
| --- | --- | --- | --- | --- |
| `routes` | ✅ | — | ✗ | 有序回退链,**第一项即首选**。每项 `{ provider, model }`;`model` 要写全(settings.yaml 里的真实 id,如 `deepseek-v4.1-flash`、`deepseek/deepseek-v4.1-flash`,别省前缀)。改它要改**包内** `cordis.patch.yml`(包层 patch:不需要重启,但改完要有一次触发才被读入 —— 见 §4 第 2 条;插件会重新 apply) |
| `compactWindow` | | `500000` | ✅ | **让自动压缩发生在这个 token 数附近**(正整数)。对外宣称的窗口由它反算(见下) |
| `name` | | `Auto` | ✅ | **模型**显示名(选择器里的分组名恒为 `Auto`) |
| `contextWindow` | | 见下 | ✅ | 【旧键】直接声明对外宣称的上下文窗口(正整数)。与 `compactWindow` 同时给出时**以 `compactWindow` 为准**并被忽略(warn 会点名两者) |
| `logLimit` | | `50` | ✅ | 路由日志环形缓冲条数(仅内存) |
| `retry.maxRetries` | | `5` | ✗ | **每路由**重试上限(不含首次);`0` = 关闭重试,恢复"一次败就切" |
| `retry.retryableCodes` | | `EMPTY_RESPONSE`/`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT` | ✗ | 可重试的错误码**白名单**;永久错误(不在表里的)一次败就切,不白烧请求 |
| `retry.backoff.initialDelayMs` | | `500` | ✗ | 指数退避起步(毫秒) |
| `retry.backoff.maxDelayMs` | | `10000` | ✗ | 退避封顶;上游 `Retry-After` 超过它则不等了,直接切下一条 |
| `retry.backoff.jitterRatio` | | `0.1` | ✗ | ±10% 对称抖动 |

「热改」= 该键是 schemastery `.volatile()` 字段 ⇒ 由宿主设置服务写入后**原地更新**引用,
插件下次用到时就是新值(不需要重启、也不需要重新 apply);✗ 的键是结构性配置,
由 `apply()` 一次性消费,只能改**包内** `cordis.patch.yml`。

`retry` 块的**形状与默认值全部复用官方** `resolveRetryPolicy`(`@deepseek-ai/dsh-llm`,
即自带 `dsh-llm-retry` 用的那个):选 `auto` 与选普通模型的重试语义一致。只支持 `mode: 'normal'`
(`always` = 无上限重试,单请求可能无上限计费,挂载时 warn 并回落默认);坏值只 warn 不阻止注册。

### `compactWindow`:压缩点 → 对外宣称的窗口

DSH 的自动压缩引擎 `@deepseek-ai/dsh-compaction-basic` **不看真实上游窗口**,只用"该请求声明的
窗口"算阈值(该包 `lib/index.js:124-147`):

```
threshold = floor(min( cw × 0.8, cw − reserved − 65536 ))      # 0.8 / 65536 是引擎默认值
reserved  = 请求头 maxTokens ?? 适配器声明的 defaultMaxTokens ?? 0
```

本插件既不声明 `defaultMaxTokens`、调用方也不给 `maxTokens` ⇒ `reserved = 0`,
于是 `threshold = floor(min(cw × 0.8, cw − 65536))`。**反过来解**就能让压缩点落在你要的位置:

```
cw = max(ceil(T × 1.25), T + 65536)      # T = compactWindow;T = 500000 ⇒ cw = 625000
```

验算(`T = 500000`):`0.8 × 625000 = 500000`;`625000 − 65536 = 559464 > 500000`(min 取前者);
保留尾部 `floor(625000 × 0.16) = 100000 < 500000` ✅。挂载日志会把这一步连同假设打出来:

```
auto: 压缩点 500000 → 声明窗口 625000(假设 compaction-basic thresholdRatio 0.8 / headroomTokens 65536)
```

**行为变化(升级到 0.3.0 就会看到)**:本机 auto 链的窗口从"第一条可解析路由的 884000"
变成"按默认压缩点反算的 **625000**",压缩触发点相应从 `707200` 提前到 **`500000`** ——
后者正好等于本机全链最紧那一跳的可用输入预算(`opencode-go` 884000 − 384000 = 500000)。
这是**有意**的:声明窗口在这里只是"给压缩引擎定位用的刻度",不是对上游窗口的承诺。

优先级(纯函数 `planDeclaredWindow()`,实现在 `lib/compact.js`):

```
compactWindow(正整数)  →  反算声明窗口        默认 500000 ⇒ 625000
contextWindow(正整数)  →  直接声明(旧键)     不写 compactWindow 时才轮到它
逐跳解析               →  第一条可解析路由的窗口
兜底 65536
```

> ⚠ 宿主里 schema 总会给 `compactWindow` 补上默认值 500000 ⇒ **默认口径就是反算**;
> `contextWindow` 只在"`compactWindow` 完全没出现"时才生效(直接调 `apply()` 的集成方)。
> 两者同时给出时会打一条 warn 说明用了哪个、忽略了哪个。
> ⚠ `compactWindow < 12484` 会另打一条 warn:此时引擎的"保留尾部 < 阈值"校验过不去
> (`floor(0.16 × (T + 65536)) ≥ T`),`@deepseek-ai/dsh-compaction-basic` 每轮抛
> `TargetPressureConfigError`;该错误被引擎捕获(`agent/pre-step` 那层):第一次 warn、之后对同一目标
> 静默跳过压缩、回合照常继续 —— 净效果是**压缩从不发生**(不会报错,但上下文会一直涨)。
> 这个下界是算出来的,不是拍脑袋的常量(见 `minimumUsableCompactWindow()`)。
> ⚠ `compactWindow`/`contextWindow` 非法(非正整数)只 warn 并回落默认值,**不会**让宿主起不来。
> ⚠ `contextWindow ≤ 65536` 时引擎的 pressure budget ≤ 0,连阈值都算不出来(同样每轮抛错)——
> 这也是引入 `compactWindow` 的原因之一;反算路径下 `T ≥ 12484` 一定是安全的。
> ⚠ 该反算依赖上面三个**引擎默认常量**。引擎换版本、或你把 `compaction-basic` 的
> `thresholdRatio`/`headroomTokens` 改成别的值,映射就不再精确 —— 挂载日志里那行假设就是为
> 这种时候留的证据(可用 `/api/llm-auto/routes` 的 `compactWindow`/`declaredContextWindow` 复核)。

### 插件页里的 `compactWindow` 表单(0.4.0 起)

0.4.0 起本包自带**浏览器半侧**(`lib/client.js`),注册进插件页为组合包预留的 `plugins.bundle.config`
slot(键 = **本包包名** `dsh-llm-auto`)⇒ 插件页 →「已安装」→ 点开 `dsh-llm-auto` 卡片,
官方 `SettingsForm` 的表单就渲染在卡片描述与行列表之间,不必再点进任何二级页。

> 位置沿革(两版同为 2026-09-25):初版注册的是 `plugins.row.config`(键 `<包名>#<行 id>`),
> 表单只能从「行 `llm-auto` →「配置」」的二级页进入 —— 要钻四层。现按用户要求提到卡片上,
> 行上的「配置」控件随之消失(本插件不再占用 `plugins.row.config`)。
> 两个槽位的契约都在 `dsh-client-ui-plugin-manager` 的 `lib/types/client/slot-contract.d.ts`;
> 该页只在 ledger 收录了这个键时才渲染这一段(其 `client.js:2879` 的 `ledger.bundles.has(pkg.name)`),
> 而 ledger 直接读槽位注册的 key(其 `client.js:48` 的 `keysOf`)⇒ 键必须**恰好**是包名。

- **只有一个字段**「用于压缩的上下文窗口」(= `compactWindow`),与官方四个配置页
  (`ui-settings-shell` / `agent-loop` / `subagent` / `web-search`)同构:用 `SettingsFormModel` /
  `SettingsForm` / `SettingsValueField` 暂存草稿,**点保存才写入**,自带「已覆盖」标记与「恢复默认」;
- 写入经宿主 settings 服务,**只落 `compactWindow` 这一个键**,`routes` 原样不动
  (`routes` / `retry` 不是 `.volatile()` 字段,写了也不会原地生效 ⇒ 仍改包内 `cordis.patch.yml`);
- 命名空间就是 loader 行 id `llm-auto`(`dsh-settings` 按 `entry.options.id` 投影)——
  与启停开关、覆写行的寻址键一致;
- **前提**:这个半侧是 0.4.0 新增的,首次启用必须**重启一次 dsh** 才会被收录(依据见 §1);
  此后**改这个文件本身也要重启**(或至少刷新页面)才看得到新表单,见 §4 第 2 条;
- 备选改法不变:手编 profile 的 `cordis.patch.yml` 追加按 id 覆写的顶层行
  (`- id: llm-auto` + `name: 'dsh-llm-auto'` + `config: { routes: [...], compactWindow: N }`,
  profile 层在包层之后应用 ⇒ 遮蔽包内那行 insert),或直接改包内 `cordis.patch.yml`。
  `routes` 这类结构性配置没有表单,只能走这两条。

### 导出 `Config`(= 成为可编辑配置条目),以及它的代价与**效果边界**

0.3.0 起本插件导出一个 schemastery `Config`(`lib/index.js`)。效果是**配置成为宿主的可编辑条目**:
`dsh-settings` 的 `SettingsForms.describe()` 会为带 schema 的活动条目生成描述符
(`lib/index.js:413-452`;schema 取 `entry.fiber.runtime.Config`,同文件 `:538-541`),
`settings.describe()` / `settings.mutate()` 这条远端通道因此能看到并写入它的字段。
`name` / `compactWindow` / `contextWindow` / `logLimit` 标了 `.volatile()`,插件不缓存这些值
(每次用到时重新读引用),所以值一改就生效、不需要重启;`routes` / `retry` 是结构性配置,
仍走**包内** `cordis.patch.yml`。

> ⚠ **效果边界(如实说明)**:导出 `Config` 这一步本身**不生成任何表单** —— 随包发布的 Web 客户端
> 没有"按 schema 自动生成表单"的页面(`@deepseek-ai/dsh-settings` 的 README 自己写着
> `Each form reports autoGenerate … for clients that build pages from the schema; no shipped client
> does so yet`),插件页(Plugins)只渲染**经 slot 注册**的表单页(`dsh-client-ui-plugin-manager` 的
> `plugins.item` / `plugins.bundle.config` / `plugins.row.config`)。0.4.0 起本包自带**浏览器半侧**
> (`lib/client.js`)注册进 `plugins.bundle.config`,才把 `compactWindow` 那一个字段变成插件页里可点的
> 表单(见上一节);宿主侧 schema 的作用是让 `settings.describe()` / `settings.mutate()` 这条远端
> 通道能看到并写入这些字段。
> 本节的结论来自源码阅读 + 单测(`test/compact.test.mjs` 里"真 schema 校验 ⇒ 解包 ⇒ 反算 625000")。

代价与取舍(原作者当初"有意不导出 Config"的理由依然成立,只是被权衡掉了):

- schema 是**加载期**校验,校验失败 = **整行插件加载失败**(不再是本插件那条"打 error 但不注册"
  的软失败)。所以 `routes` / `retry` 用 `z.any()`:形状校验继续留在 `normalizeRoutes()` /
  `normalizeRetry()` 里,坏值依旧只 warn/error;数值字段用 `z.number()` 但**不加 `.min()`/`.step()`**,
  范围与整数性仍由插件自己判并 warn 回落。**唯一会硬失败的是类型错误**(例如把字符串写进
  `compactWindow` 这种数字字段)。
- 表单只覆盖标了 `.volatile()` 的字段(`volatileForm()`,dsh-settings `lib/index.js:122-131`;
  一个 volatile 字段都没有时整条目被跳过),所以 `routes` / `retry` 不在可写字段里 —— 这是有意的:
  它们由 `apply()` 一次性消费,标成 volatile 等于承诺一个做不到的"改了即时生效"。
- `.volatile()` 字段在插件里拿到的是 cosmokit 的 **Volatile 引用**(不是值本身),
  读之前必须 `unwrapVolatile()`(`lib/compact.js`)。

> ⚠ 宿主侧这条能力("配置成为可编辑条目")的依据是上面引用的源码位置 + 单测里
> "真 schema 校验 → 解包 → 反算 625000"这条用例(见 §7);插件页里的表单入口见上面那节
> (它走的是同一套 schema:`ctx.configForms` 只投影标了 `.volatile()` 的字段)。
> 重启后请先看 `/api/llm-auto/routes` 的 `compactWindow`/`declaredContextWindow` 是否符合预期。

`contextWindow` 不写且 `compactWindow` 也没给时:**逐个试路由**,取第一条能给出正整数窗口的那条的窗口;
全都拿不到就用保守值 `65536`(宁可让压缩早触发,也不要谎报一个大窗口导致请求必撞上游上限)。
解析结果缓存 30 秒,目录被反复重建时不会反复去问上游适配器。

> ⚠ `provider` 不要写 `auto`(自递归):挂载时会 warn 并跳过该条。
> ⚠ `routes` 为空/缺失/解析后一条不剩:打一条 `error` 并**拒绝注册**(不抛错,宿主照常启动)。
> ⚠ 写成 `auto` 的**整条**目的链要避开两个坑:① `provider: auto` 是自递归(挂载时 warn 并跳过该条);
> ② 别写本机不可解析的通道或模型 id,否则那一跳每次都以 `NO_ADAPTER` / `UNKNOWN_MODEL` /
> `MISSING_CREDENTIAL` 白撞一次(点开 `/api/llm-auto/routes` 能看到真实 code)。
> ⚠ **本文档里的链是"当时的实例",权威定义在包内 `cordis.patch.yml`**(profile 层按 `id: llm-auto` 的覆写行优先):那份改了而本文没同步时,
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

> 注意这是**换路由**的口径。**原地重试**是另一套、相反的口径(白名单,见下节):
> 重试比切换贵(同一路由重复计费),永久错误不值得白撞 N 次。

### 硬要求:已经吐给调用方内容之后**不重试也不回退**

一旦向调用方交出了**内容**分片(`text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end`),
后续失败原样上报,绝不换路由、绝不在该路由内重试 —— 否则用户会看到"半截回答 + 重新回答"的拼接。

实现上还有一条来自源码的硬约束:**重试/回退只能发生在"一个分片都没交出去"的时候**。
`@deepseek-ai/dsh-llm/lib/invariant.js` 给每一次 `llm/stream` 套了流语法校验器,它会拒绝
「同一个流里 `block-start` 重复 index」和「`usage` 出现两次」。所以 `block-start` 与 `usage`
会被**暂存**,直到第一条内容分片到达才一起放行。这不是洁癖:真机观测到
`ww/gpt-6-astra` **先发一个全零 usage 再报 502**(2026-09-23 探针实测,该条已在同日改链时移出),
暂存 usage 正好让这种情形仍能安全重试/回退。

### 路由内重试(v0.2.0 起,默认开启)

某条路由失败时,若错误码在**瞬时白名单**(`EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` /
`TIMEOUT` / `TRANSPORT`)且该路由还有尝试预算,就带退避**原地重试**,重试耗尽才切下一条。
策略形状/默认值/校验复用官方 `resolveRetryPolicy`(`@deepseek-ai/dsh-llm`),
与不选 `auto` 时的普通模型完全一致:

- 默认每路由最多**重试 5 次**(共 6 次尝试),`retry.maxRetries: 0` 关闭;
- 退避 500ms 起步、10s 封顶的指数退避,±10% jitter(第 1/2/3… 次重试前约等
  0.5s / 1s / 2s / 4s / 8s);
- 上游 `Retry-After` 在 10s 界内优先;超过上限则**不等了直接切**(与官方 normal 模式一致 ——
  一条"等 120s"的指令等满了大概率还是限流,不如换一条健康的路);
- 白名单外的错误码(永久错误)**不重试**,一次败就切;
- 调用方取消(含退避等待中被取消)立即收尾,不再打上游;
- 与自带 `@deepseek-ai/dsh-llm-retry` **不叠加**:那个挂在 agent loop 瀑布上管"整步重跑",
  管不到本插件的嵌套调用;本插件的最终错误码 `AUTO_ROUTES_EXHAUSTED` 也不在它的默认可重试
  集合里。同一次上游失败只会被一层消费,不会双重计费。

### 历史回放:嵌套调用前把 `source` 改回真实路由(2026-09-24 修复)

**症状**:经 `auto` 的会话回放历史时,模型自己每一轮的**思考被当成普通正文**发给上游,
思考通道被填成空串;直连同一路由(`opencode-go`)则两个通道严格分离。
会话持久化记录本身是完整的(思考块、正文块、`replayState` 都在),坏的只是**出站负载**。

**成因**(五环,每一环都读过源码):

```
会话里的历史助手消息:source.provider = "auto"(外层请求的 provider)
                      source.replayState.response.provider = "opencode-go"(嵌套路由真正用的)
   ↓ ① dsh-agent-loop 把"当次请求的 provider"写进 source.provider ⇒ 经 auto 的每一轮都写着 auto
   ↓ ② LlmRuntime.forAdapter 只保留「历史 provider 的适配器 === 本次适配器」的 replay 状态
        嵌套调用里本次适配器是 pi-ai、历史 provider 是 auto(归本插件)⇒ replay 被剥掉
   ↓ ③ dsh-llm-pi-ai 的 toPiAssistant 见不到 replay ⇒ 退到 foreignAssistant
        (打上 provider=auto / api="dsh-foreign" / model=auto)
   ↓ ④ pi-ai 的 transformMessages 算 isSameModel(provider+api+model 全等)⇒ 假
        ⇒ 思考块被降级成普通文本块
   ↓ ⑤ pi-ai 的 OpenAI 序列化把文本块拼成一个字符串当 content;
        思考通道没人写,又因 requiresReasoningContentOnAssistantMessages 补成 ""
```

**修法**:在换 provider 的那一刻(`adapter.js` 的 `#nestedOptions`,即发起嵌套调用之前),
把每条历史助手消息的 `source.provider` / `source.model` 换成它 `replayState.response` 里记着的
真实路由值(纯函数 `restoreReplaySources`,见 `lib/replay.js`)。于是环 ② 的判定成立 ⇒
replay 状态保留 ⇒ pi-ai 走 `replayedAssistant`(它正好校验 `response.provider === source.provider`
且 `response.model === source.model`,改写后逐字通过)⇒ 思考回 `reasoning_content`、正文回 `content`。

为什么**不能**改成包一层 `LlmRuntime.forAdapter`:外层请求的适配器是本插件的 `AutoAdapter`,
外层那次 `forAdapter` 对 `source.provider === 'auto'` 的消息本来就是原样保留 replay 的
(实测:`AutoAdapter.stream()` 收到的历史助手消息 `source` 键为 `['kind','provider','model','replayState']`);
剥掉 replay 的是**嵌套调用**那一次。若在 `forAdapter` 外面统一改写,外层那次会变成
「历史 provider 是 `opencode-go`、适配器却是 `AutoAdapter`」⇒ 反而把 replay 剥掉,修法失效。

纪律:`restoreReplaySources` 是**纯函数** —— 只读入参、返回新对象、绝不改 `content`、
逐条按各自的 replay 路由取值(会话中途切过路由时不能统一成"当前路由")、
`replayState` 缺失或形状不对就**原样放行**(不抛错,交给下游适配器自己校验/降级)。

字节级验收(无头 profile + 抓包代理,同一份历史两跑):

| | 修复前 | 修复后 |
| --- | --- | --- |
| 出站 `content` | 62 字符 = 思考 57 + 正文 5(拼接,无分隔符) | **5 字符,与会话正文块 SHA256 一致** |
| 出站 `reasoning_content` | **空串(长度 0)** | **57 字符,与会话思考块 SHA256 一致** |

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

重试到耗尽的路由会多带一个次数后缀(每条路由在聚合错误里只有一行,次数 = 该路由的总尝试数):

```
  2) commandcode/deepseek-v4.1-flash → SERVER(HTTP 502): 502 status code（8231 ms，共 6 次尝试）
```

行里的 `elapsedMs` 是该路由**最后一次**尝试的耗时(不是 6 次的累计);逐次耗时看
`/api/llm-auto/routes` 的 ring 记录(每条 attempt 一条)。

用 `LlmError` 而不是裸 `AggregateError`:后者的码会被归一成 `UNKNOWN`,丢掉可路由性。

### 不改默认模型

本插件**不碰** `settings.yaml` 与 `agent-default-model`:用户不主动选 `auto` 时一切照旧。

---

## 4. 生效条件(踩过)

1. **`file:` 依赖在 pnpm 下默认建硬链接,但形态要**逐文件实测**(本包 12/12 共享文件实测同 inode)。
   真正被加载的是 `~\.dsh\profiles\<profile>\node_modules\dsh-llm-auto\` ⇒ 原地改已有文件两侧同生效,**不需要**
   remove + add;但 `write` / `edit` 这类"写临时文件再改名"的换文件式写入会**当场打断硬链接**,改完必须核
   两侧 `fileId`。**只有新增文件**才要重跑 link(`remove` + `add`,或 `pnpm install`;只 `add` 可能报

   ```bash
   node <工作区>\dsh-plugin-manager\dshpm.mjs remove dsh-llm-auto --profile web
   node <工作区>\dsh-plugin-manager\dshpm.mjs add `
     file:%USERPROFILE%\.dsh\profiles\<profile>\plugins\dsh-llm-auto --profile <profile>
   ```

   `dshpm` 是本机工作区里的插件装卸 CLI(`dsh-plugin-manager`,即上面那个脚本),公开环境没有它;
   可用官方 `dsh plugin add` / `dsh plugin remove` 代替,只是官方命令在部分版本会超时并丢
   `dsh.profile.bundles` 更新,所以本机一直用 `dshpm`。

   改完用 SHA256 比对两份 `lib/index.js` 一致。不想经历 `remove` 造成的空窗时也可以**直接改运行副本
   侧那份**(原地改写,别用会换文件的工具 —— 那会断链),再照上面核对 SHA256。

   最快的一条是**只给改动过的那个文件重建硬链接**(2026-09-25 搬 `compactWindow` 表单时用的就是这条,
   之后 8 个 `lib/*.js` 两侧全部共 inode):

   ```powershell
   $src="$env:USERPROFILE\.dsh\profiles\web\plugins\dsh-llm-auto\lib\client.js"
   $dst="$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-llm-auto\lib\client.js"
   Remove-Item $dst -Force
   New-Item -ItemType HardLink -Path $dst -Target $src | Out-Null
   (Get-FileHash $src).Hash -eq (Get-FileHash $dst).Hash   # 必须 True
   fsutil hardlink list $dst                               # 必须列出两条
   ```

2. **改插件代码要重启 dsh** —— loader 按 URL 缓存已 import 的模块实例。
   浏览器半侧理论上另有一条免重启路径:宿主 `dsh-client-hmr` 每 500ms stat 一遍各 client bundle,
   一有变化就 `clientModules.rebuilt(id)` 并经 `/plugins/events` SSE 让页面 `modules.reload` 换掉旧模块
   (`dsh-client-hmr/lib/index.js:79-92`、其 `lib/client.js:59`)。**但 2026-09-25 实测这条没生效**:
   改完 `lib/client.js`(原地改即两侧同变;stat 的 mtime/size 确实变了)后,线上 `plugins.row.config` 的占用者
   仍是旧注册 —— 用 `cordis_inspect_query`(client `Slots`,`plugins.bundle.config` / `plugins.row.config`)
   复核可重现。所以按老规矩办:改完**重启 dsh**(至少要刷新页面再看),别指望它自己换。
   改**包内 `cordis.patch.yml`**(包层 patch)不需要重启,但它**不会自己触发重组合**:dsh-hmr 只监视
   profile 的 `cordis.patch.yml`、home 层 `cordis.patch.yml` 与 profile 的 `package.json` 三个输入
   (`dsh-hmr/lib/index.js:353-376`),包内 patch 不在其中;重组合时会重读全部 bundle 层,所以改完要有
   一次触发才被读入 —— 在插件页点一下本卡(或任意行级)开关,或保存 profile 的 `cordis.patch.yml` 里任意一处。
   所以顺序是:先改代码(原地改即两侧生效)→ 改配置(可选)→ 按上面触发一次重组合;代码改动本身仍要重启。

3. 本插件是**组合包(bundle)**:包里有 `dsh.bundle.patch`(指向包内 `cordis.patch.yml`),
   包名在 `dsh.profile.bundles` 里 ⇒ 由 profile 的 bundles 装载,**不需要**再往 profile 的
   `cordis.patch.yml` 里贴 insert 行(启停与卸载见 §1)。

---

## 5. 可观测

### HTTP 端点

```
GET /api/llm-auto/routes?limit=N      # limit 省略/非法 = 不限(以容量为上限)
```

```json
{
  "provider": "auto", "model": "auto", "name": "Auto",
  "retry": { "mode": "normal", "maxRetries": 5, "retryableCodes": ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"], "initialDelayMs": 500, "maxDelayMs": 10000, "jitterRatio": 0.1 },
  "compactWindow": 500000, "declaredContextWindow": 625000,
  "chain": ["commandcode/deepseek/deepseek-v4.1-flash", "stepfun/step-5-preview", "deepseek-official/deepseek-flash"],
  "capacity": 50, "total": 2,
  "routes": [
    { "at": "2026-09-23T13:03:49.516Z", "attempt": 1, "try": 1, "provider": "probe-no-such-provider",
      "model": "whatever", "ok": false, "switched": true, "elapsedMs": 1,
      "code": "NO_ADAPTER", "reason": "NO_ADAPTER: no adapter registered for provider \"probe-no-such-provider\"" },
    { "at": "2026-09-23T13:03:50.516Z", "attempt": 1, "try": 2, "willRetry": true, "provider": "commandcode",
      "model": "deepseek/deepseek-v4.1-flash", "ok": false, "switched": false, "elapsedMs": 1200,
      "code": "SERVER", "reason": "SERVER(502): 502 status code" },
    { "at": "2026-09-23T13:03:51.518Z", "attempt": 3, "provider": "commandcode",
      "model": "deepseek/deepseek-v4.1-flash", "ok": true, "switched": false, "elapsedMs": 1900 }
  ]
}
```

字段:`at`(时间)、`attempt`(第几条路由,1 起)、`try`(该路由第几次尝试,1 起)、
`willRetry`(存在且为 true 表示这条失败后还会重试,不是终态)、`provider`/`model`(命中的路由)、
`ok`(是否成功)、`switched`(这次失败是否触发了切换)、`elapsedMs`(耗时)、`code`/`reason`(失败原因摘要)。
顶层 `retry` 是当前生效的重试策略(排查"它为什么重试/为什么不重试"先看这个)。

顶层 `compactWindow` / `declaredContextWindow` 是**窗口口径的事后复核字段**:前者是生效的压缩点
(没启用映射时为 `null`),后者是当前对外声明的窗口(逐跳解析口径下,要等第一次目录解析才有值,
否则为 `null`)。两个值都是**现场重算**的,设置页刚改完就能在这里看到。

> ⚠ **该端点不经过浏览器鉴权**:它是 exact 路由,优先于 `dsh-client-connection` 注册的
> `/api` 前缀(前缀表只在 exact 未命中时才查),因此不检查鉴权 cookie。
> 仅因为 webServer 绑在回环地址才可接受;**不要**把 webServer 改成 `0.0.0.0` 后继续留用它。

### 日志

用插件 logger(`llm-auto` 子系统):
- 挂载时一条 `info`:`auto: 已注册路由 auto/auto（Auto）→ commandcode/… → ww/…；重试: 每路由最多 5 次(瞬时码 …),退避 500→10000ms jitter 0.1`;
- 挂载时再一条 `info`(窗口口径):`auto: 压缩点 500000 → 声明窗口 625000(假设 compaction-basic thresholdRatio 0.8 / headroomTokens 65536)`
  (contextWindow 口径下会写明"未启用压缩点映射"并报出实际压缩点;逐跳解析口径下写明兜底值);
- 配置有问题时各一条 `warn`:`compactWindow` 非法(回落默认)、与 `contextWindow` 同时给出(说明用哪个忽略哪个)、
  压缩点过小(点名 `TargetPressureConfigError`);
- 每次重试一条 `warn`:`auto: 第 1 条路由 x/y 第 2 次尝试失败(SERVER(502): …),500 ms 后重试(剩余重试 3 次)`;
- 每次切换一条 `warn`:`auto: 第 1 条路由 x/y 失败(SERVER(502): …,共尝试 6 次),静默切换 → a/b`;
- 已经产出内容后失败、以及错误码不允许回退时各一条 `warn`;
- 全部失败一条 `error`。

不刷屏:每次**重试/切换**才一条,正常请求零日志。

---

## 6. 边界与已知限制

- **只"失败时切换",不挑路由**:不做额度记账、不按价格/能力/内容挑路由。顺序完全由 `routes` 决定;
  失败时先在**该路由内**重试(见上节),重试耗尽或码不可重试才按顺序切下一条。
- **重试的计费/时延上限(默认参数下)**:单次 `auto` 请求最坏 = 链长 × 6 次上游调用、约 15.5s×链长
  的退避(0.5+1+2+4+8+10s);想省就把 `retry.maxRetries` 调小或设 `0`。每次重试都是新的上游请求,
  与自带 `dsh-llm-retry` 一样可能重复计费 input token。连带效应:ring 缓冲(默认 50 条)消耗也快
  约 6 倍 —— 一条全瞬时失败的链一个请求就占 20+ 条,想多留历史就调大 `logLimit`。
- **只支持 `mode: 'normal'`**:`always`(无上限重试)在单请求内可能无上限计费,挂载时 warn 并回落默认。
- **插件卸载不 drain 在飞退避**:cordis 卸载本插件时,正在进行的退避(≤10s)会自然完成,不像官方
  `dsh-llm-retry` 有 lifetime abort + drain(它挂在 agent loop 上,拿得到 session 生命周期)。
- **不做视觉/长上下文分流**:上游同类插件按"含图 / 超长"分流,本插件按用户明确要求只做失败重试/回退。
- **不声明 `inputModalities`**:目录里不宣称"支持图片"。"能不能收图"交给真正被选中的那条路由决定;
  声明了反而会让运行时按声明去投影请求(把图片换成占位文本)。
- **`reasoningEffort` 一律用该路由可用的最高强度**(2026-09-23 用户指定):每跳前问一次该路由
  `resolveModelInfo` 的 `reasoning.efforts`,取**最后一项**(DSH 的档位强度序固定为
  `off→minimal→low→medium→high→xhigh→max`,适配器只保留该模型支持的档位 ⇒ "最后一项"就是它
  能给的最高强度),**忽略调用方带来的档位**;该路由完全不声明档位(不思考的模型)时才原样透传,
  让分发给出准确错误。这样既不因为"档位不匹配"让兜底路由白失败一次,也不需要调用方为每跳手动调档。
  本插件自己**不声明** reasoning 能力,所以模型选择器不会给 `auto` 提供档位选项。
- **跨路由的 replay 元数据**:DSH 只在"历史 provider 与目标 provider 属于同一个适配器实例"时保留
  replay 状态。`auto` 自己产出的消息(source.provider = `auto`)在嵌套调用里会被自动剥掉 replay ——
  这正是上面「历史回放」一节修的缺陷:剥掉后 pi-ai 会把思考摊平进正文、把 `reasoning_content`
  填成空串。本插件在嵌套调用前把 source 改回 replay 记录的真实路由来保住它;历史消息若本来就来自
  `commandcode`,回退到同属 pi-ai 的 `ww` 时 replay 会被保留 —— 那是上游既有行为(手动切模型时
  同样发生)。**跨模型**的历史(replay 路由 ≠ 本次路由)仍然会被 pi-ai 摊平,这是 pi-ai 自己的策略
  (思考签名跨模型不可信),与直连时的行为一致。
- **路由日志是进程内内存**,重启即清空,不适合当审计账本。
- **压缩点靠"声明窗口"间接控制,依赖引擎默认常量**:`compactWindow` 的反算写死了
  `thresholdRatio = 0.8` / `headroomTokens = 65536`,并按 `reserved = 0` 推算。若把
  `@deepseek-ai/dsh-compaction-basic` 的 `thresholdRatio`/`headroomTokens` 改成别的值、
  或给本插件补上 `defaultMaxTokens` 声明,压缩点就会偏离 `compactWindow` ——
  挂载日志那行假设与 `/api/llm-auto/routes` 的两个复核字段是排查这类偏离的入口。
- **声明窗口是"压缩刻度"而不是上游承诺**:默认 625000 大于本机某些跳的真实窗口(如 `stepfun`
  的可用输入 958464 没问题,但换成更小的通道就会超)—— 请求真正撞上游窗口时由那一条路由
  如实报 `CONTEXT_WINDOW_EXCEEDED`(该码不回退)。要"声明真实窗口"就把 `compactWindow`
  调成你想要的压缩点,或用旧键 `contextWindow` 直接声明。
- **失败原因摘要可能含上游返回的文本**(如报文片段),但不含凭据:各适配器按设计不把 key 写进消息。
- **未实测覆盖**:①"已产出内容后失败"只有单测(含真实 `LlmRuntime` + 真实流语法不变式)覆盖,
  没有对真上游稳定复现过(需要一条"吐一半再断"的路由);②**路由内重试**同样只有单测/真实
  `LlmRuntime` 覆盖,没有对真上游的瞬时抖动复现过(需要一条"抖几下再好"的路由);③非回环绑定下的
  鉴权影响未评估(见 §5);④**导出 `Config` 之后的设置描述符**只有源码依据 + 单测(见 §2「效果边界」),
  没有在重启后的真机上查过 `settings.describe()`(0.4.0 的插件页表单走的是同一套 schema,
  注册在 `plugins.bundle.config`,见 §2)。
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
| `test/routes.test.mjs` | `normalizeRoutes`(空/非数组/自递归/重复/单条坏条目)、`describeChain`、`createRing`(定长 + 取值函数容量) |
| `test/compact.test.mjs` | **压缩点反算**:500000→625000、边界值表(12484 / 262143 / 262144 / 327680 / 884000 / 1000000…)、1~300 万抽样"阈值处处精确等于 T"(独立复刻一遍引擎的 `resolveCompactSpec` 来验算)、最小可用值 12484 的推导;`planDeclaredWindow` 的优先级/同时给出/非法回落/过小警告/null 与坏类型;`unwrapVolatile`;`describeWindowPlan` 四种文案;导出的 `Config`(六键中文 description、`compactWindow` 默认 500000 且 volatile、routes/retry 坏值不失败、真 schema 走一遍⇒解包后仍是 500000⇒625000) |
| `test/retry.test.mjs` | `normalizeRetry` 全部分支(缺省/布尔/对象/always/坏值回落)、`computeRetryDelay`(官方口径序列与 jitter 边界)、`describeRetryPolicy` |
| `test/adapter.test.mjs` | 首次成功、首条瞬时失败后先重试再回退、全部失败聚合(带尝试次数)、**已产出内容后失败不重试不回退**、暂存分片、空响应(可重试)、不可回退码、取消、退避中取消、上游抛异常、按路由取最高推理档位、窗口解析、`modelName` 取值函数;重试块另覆盖:第 N 次成功、白名单外不重试、`maxRetries: 0` 旧行为、`Retry-After` 界内优先/超界直切、退避序列 500/1000/2000/4000/8000 |
| `test/replay.test.mjs` | `restoreReplaySources`:路由不同 ⇒ 改写且 `content` 逐字未变、路由相同/无 `replayState`/形状不对 ⇒ 原样放行不抛、非助手消息不动、多条各按自己的 replay 路由改写、冻结输入不被破坏;外加一条接线用例:经 `AutoAdapter.stream()` 的嵌套请求确实拿到了改写后的 source |
| `test/runtime-integration.test.mjs` | 用**真实** `LlmRuntime` + **真实** `@deepseek-ai/dsh-llm/invariant` 跑端到端:目录校验、回退后的流语法零违规、**重试后成功的流语法零违规**、`maxRetries: 0` 旧行为、聚合错误的终止分片、注销后路由立刻消失 |
| `test/endpoint.test.mjs` | `apply()` 的注册/拒绝注册分支、`provider: auto` 跳过、HTTP 端点响应、`retry` 默认值/关闭/坏值回落;`compactWindow` 的映射/宿主形态/与 `contextWindow` 同时给出/非法回落/过小警告、**volatile 引用改值后不重启即生效**(name / compactWindow / logLimit)、端点复核字段 |

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
| 选择器里没有 `Auto` 分组 | 插件没装进 `node_modules`(只改了 `plugins\`)、或宿主没重启、或包名不在 `dsh.profile.bundles` 里(用 `dshpm sync --check --profile web` 复查,`--dry-run` 可预演) |
| 有分组但选 `auto` 就报 `NO_ADAPTER` | 宿主还在跑旧代码,或包层那行被 profile 层的覆写行遮蔽/停用了 |
| 每次第一条必失败 | `routes[0]` 那条路由本机不可用(例如 `deepseek-official` 无凭据);`/api/llm-auto/routes` 会直接告诉你 code |
| 一条路由要试 6 次才切/切得慢 | 重试默认开启(每路由 5 次 + 退避累计约 15.5s);这是 v0.2.0 起的预期行为,想关:`retry.maxRetries: 0` |
| 期望"失败立即切"但它等了 | 失败码在瞬时白名单(RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/EMPTY_RESPONSE);不在白名单的码(NO_ADAPTER/UNKNOWN_MODEL/MISSING_CREDENTIAL…)本来就是一次败就切 |
| 改了源码没反应 | 形态逐文件实测(本包 12/12 同 inode)⇒ 硬链接文件原地改即生效,断链或新增文件才需重装 + 重启;改完核 fileId/SHA256(见 §4) |
| 压缩点不在 `compactWindow` 上 | 先看挂载日志那行"压缩点 X → 声明窗口 Y(假设 …)";X 对不上说明 `compactWindow` 非法/被回落(有 warn),Y 算得出而压缩仍不按 Y 走 ⇒ 多半是有人改了 `compaction-basic` 的 `thresholdRatio`/`headroomTokens`(见 §6);`/api/llm-auto/routes` 的 `compactWindow`/`declaredContextWindow` 用来复核 |
| 日志出现 `TargetPressureConfigError`(`retainTokens ... must be less than threshold tokens`) | `compactWindow` 太小(< 12484,挂载时已有 warn)或旧键 `contextWindow` ≤ 65536;把 `compactWindow` 调到 ≥ 12484 即可 |
| 设置了 `contextWindow` 但窗口没变 | 预设里 `compactWindow` 已有值(默认 500000)⇒ 按优先级以 `compactWindow` 为准,挂载日志有一条 warn 点名两者;要用旧键就先把 `compactWindow` 从配置里删掉 |
| 插件页看不到本插件的配置表单 | 本包 0.4.0 起自带浏览器半侧、注册进 `plugins.bundle.config`(键 = 包名 `dsh-llm-auto`,渲染在卡片描述与行之间)。没看到先分清两种原因:①宿主还在跑 0.4.0 之前的代码 —— 半侧新增后**必须重启一次 dsh**(见 §1),HMR 不会重新扫描(`dsh-client-modules` 把"本包不是客户端包"的否定结论按 specifier 缓存在 `pkgMeta`,其 `lib/index.js:510/703`);②只是刚改过 `lib/client.js` —— 这条 HMR 路径实测不生效,同样要重启(见 §4 第 2 条)。另:本插件**故意不再**注册 `plugins.row.config`,所以行 `llm-auto` 上没有「配置」控件是正常的;`routes`/`retry` 本来就没有表单,故意留在**包内** `cordis.patch.yml` 里 |
| 经 `auto` 的历史思考跑到正文里、思考通道是空的 | 插件是修复前的版本(宿主还在跑旧代码);修复见 §3「历史回放」,改完两份并重启后消失 |
| 日志出现 `llm-pi-ai: unusable replay state on assistant history` | 那条历史消息的 replay 状态与本次路由不匹配(例如跨模型回放),pi-ai 主动降级成 provider-neutral 内容;这是上游既有行为,不是本插件的错误 |
| 上下文窗口明显偏小 | `contextWindow` 没配且首选路由解析不到窗口,回落到了保守值 65536;显式配一个即可 |

## License

MIT
