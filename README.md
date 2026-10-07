# dsh-llm-auto

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.9.0-blue.svg)](package.json)
[![DSH Plugin](https://img.shields.io/badge/dsh-plugin-8A2BE2.svg)](https://github.com/topics/dsh-plugin)

给 DSH 加一个 **`auto` 模型**:模型选择器里多出一个 `Auto` 分组,组内一条 `auto`。
选它以后,请求依次尝试多条「provider + model」,某条失败会**先按官方同款策略在该路由内原地重试**
(瞬时错误,默认最多 5 次),重试耗尽才静默切下一条 —— 对上层(agent loop / 会话日志 /
压缩链路)它就是一个普通模型。用来把多个模型订阅"合并"成一个入口。

**0.8.0 起,顺序默认由插件按订阅额度自动决定**:有月度重置时刻的订阅按「越早重置越靠前」排,
查不到重置时刻的按你写的顺序,永不过期的按量兜底永远最后;某一跳因窗口额度耗尽被拒
(错误码 `QUOTA`)时,插件会补查该来源的额度接口,确认后把它**冷却**到对应档位的重置时刻
(面板上写明是哪一档,例如「月度已耗尽,10-24 00:00 恢复」),期间不再尝试,到点自动恢复。想回到「完全按你排的顺序、只失败时切换」的旧行为,
把 `ordering.mode` 设成 `manual`(面板上就有这个开关)。

还能把**自动压缩点**钉在你要的位置(`compactWindow`,默认 50 万 token):DSH 的压缩引擎按
"该请求声明的窗口"算阈值,而本插件的窗口是**按压缩点反算**出来的。

插件页那张卡片上还有一块 **`回退链`面板**:0.5.0 起只读,0.6.0 起**可编辑** ——
拖拽行首手柄改顺序、点行内模型名从 live 模型目录里换一条、按行开关 `keepThinking`/`breakToolLoop`,
点保存即写入 profile 的 `cordis.patch.yml` 并**免重启生效**;面板下半仍是最近若干次请求**实际**
怎么回退的(哪条失败、什么错误码、切给了谁、花了多久)。详情见 §2「回退链面板:可编辑(0.6.0 起)」。

0.7.0 起面板上多一段**只读**的「额度」摘要;0.8.0 起多一段「自动排序」——
一行模式开关(auto/manual,写 `ordering.mode`,免重启切换)+ 一行**实际尝试顺序**
(冷却中的条目也列在这里,带「冷却中」、**哪一档打满**与恢复时刻,例如「月度已耗尽,10-24 00:00 恢复」;
它们**不会被尝试**)。**0.9.0 起这一段与链编辑器合成一段、按模式显示**:开关挪到卡片**最上面**,
自动模式主视图是「生效顺序」、可编辑的链折进默认收起的「配置顺序」,手动模式反过来。这段是**行为**,
「额度」那段是**观测**,两者可能同时出现同一个来源 —— 不是故障,见 §2「排序与耗尽冷却(0.8.0 起)」。

```
                    ┌─ 用户选了 auto/auto ─┐
   请求 ──► AutoAdapter.stream()
                    │  (0.8.0 起先按额度排一次序、滤掉冷却期内的 provider;
                    │   `ordering.mode: manual` 时这一步跳过,完全按配置顺序)
                    │
                    ├─ 1) commandcode/deepseek/deepseek-v4.1-flash
                    │      ├─ 第 1 次失败(SERVER 502) ──► 白名单内 ⇒ 退避 500ms 后原地重试
                    │      ├─ 第 2 次失败 ──────────────► 退避 1s 后原地重试 ……(默认最多重试 5 次)
                    │      └─ 重试耗尽 ────────────────┐
                    ├─ 2) opencode-go/deepseek-v4.1-flash   ▼
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

在 DSH profile 目录(`~\.dsh\profiles\desktop\`)下:

```bash
# ① 装进 profile:dshpm 会顺带把包名写进 dsh.profile.bundles
node <工作区>\dsh\dsh-plugin-manager\dshpm.mjs add file:./plugins/dsh-llm-auto --profile desktop
#    公开环境:profile 的 package.json 里加 "dsh-llm-auto": "github:liuyun847/dsh-llm-auto"
#    再 pnpm install(或 npm install) —— 同样只要包名在 dsh.profile.bundles 里

# ② 按本机 provider 改 routes:改包内 cordis.patch.yml 那一行(profile 层也可按 id 覆写)

# ③ 重启一次 DSH(本机桌面端:关掉再打开 DeepSeek Harness 窗口,见 §4「生效条件」)
```

- **启停**:Web 侧栏「插件」页 →「已安装」区里本卡的总开关(写 `dsh.profile.bundles`);
  点开卡片后每一行还有行级开关(向 profile 的 `cordis.patch.yml` 写 `disabled` 覆盖 ——
  profile 层在包层之后应用,所以覆写优先)。
- **卸载**:`node dshpm.mjs remove dsh-llm-auto --profile desktop`。
  ⚠ 本 profile 的 pnpm 带供应链策略,`pnpm remove` 会报
  `ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED`;绕过办法是进 profile 目录直接跑
  `pnpm remove dsh-llm-auto --config.minimum-release-age=0`
  (dshpm 的 `--fast` 只对 `add` 有效 —— `pnpm remove` 不接受 `--minimum-release-age` 这类参数)。
- ⚠ **0.4.0 新增的浏览器半侧必须重启一次 dsh 才会被收录**:宿主 `dsh-client-modules` 把
  "本包不是客户端包"这一**否定结论按 specifier 缓存在 `pkgMeta` 里,只写不删**
  (其 `lib/index.js:510` / `:703`),HMR 不会重新扫描 ⇒ 半侧新增后先重启,插件页才会
  长出配置表单(见 §2)。

重启后:模型选择器出现 **`Auto`** 分组 → 选 `auto` → 发一条消息 → 打开
`http://127.0.0.1:19387/api/llm-auto/routes` 看它到底走了哪条(以及当前声明的上下文窗口)。
`compactWindow` 的图形入口在插件页:「已安装」→ 点开 `dsh-llm-auto` 那张卡片,表单就在
卡片描述与行列表之间(0.4.0 起,见 §2「插件页里的 compactWindow 表单」)。

---

## 2. 配置

配置有两个入口:

- **插件页里的表单**(0.4.0 起):「已安装」→ 点开 `dsh-llm-auto` 卡片 → 表单在描述与行之间。
  这里能改的是 `compactWindow`(0.4.0 起)、`routes`(0.6.0 起,「回退链」面板)与
  `ordering.mode`(0.8.0 起,「自动排序」那一行的开关);
- **包内 `cordis.patch.yml`** 的注册行(= 本包自带、随组合包加载的那一行):**结构性**配置
  (现在只剩 `retry`)只能在这里改;profile 层要覆盖就按 `id: llm-auto` 写覆写行
  (profile 层在包层之后应用)。`routes` 从 0.6.0 起、`ordering` 从 0.8.0 起都是 `.volatile()`
  ⇒ 面板里改完即时生效,不必重启,所以"改链/改模式"不必动文件。

标了「热改」的键同时是 schemastery 的 `.volatile()` 字段,经宿主的设置服务可改、改完即时生效
(效果边界见本节末尾)。

```yaml
- insert:
    - id: llm-auto
      name: 'dsh-llm-auto'
      config:
        routes:
          - { provider: commandcode, model: deepseek/deepseek-v4.1-flash }
          - { provider: opencode-go, model: deepseek-v4.1-flash }
          - { provider: deepseek-official, model: deepseek-flash, keepThinking: true, breakToolLoop: true }
        # 压缩点(默认就是 500000,写出来只是显式化)
        compactWindow: 500000
        # 额度感知的路由行为(0.8.0 起):**包内这份 patch 里没有这一行** —— 不写就是默认的 auto。
        # 要改成 manual(或想在文件里留痕)时才放开下面两行;
        # 面板上那个「自动排序」开关写的就是它,改完即时生效(volatile)。
        # ordering:
        #   mode: auto        # auto(默认)| manual;其余值只 warn 回落 auto
        # retry 不写 = 官方默认(每路由 5 次重试);要关掉或改参数再放开:
        # retry:
        #   maxRetries: 5
        #   retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]
        #   backoff: { initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 }
```

| 键 | 必填 | 默认 | 热改 | 说明 |
| --- | --- | --- | --- | --- |
| `routes` | ✅ | — | ✅ | 有序回退链,**第一项即首选**。每项 `{ provider, model, keepThinking?, breakToolLoop? }`;`model` 要写全(provider 声明的真实 id,如 `deepseek-v4.1-flash`、`deepseek/deepseek-v4.1-flash`,别省前缀)。0.6.0 起可在**插件页的「回退链」面板**里直接编辑(写入 profile 的 `cordis.patch.yml`,免重启);手写 YAML 照旧可用,profile 层按 `id: llm-auto` 覆写优先 |
| `compactWindow` | | `500000` | ✅ | **让自动压缩发生在这个 token 数附近**(正整数)。对外宣称的窗口由它反算(见下) |
| `name` | | `Auto` | ✅ | **模型**显示名(选择器里的分组名恒为 `Auto`) |
| `contextWindow` | | 见下 | ✅ | 【旧键】直接声明对外宣称的上下文窗口(正整数)。与 `compactWindow` 同时给出时**以 `compactWindow` 为准**并被忽略(warn 会点名两者) |
| `logLimit` | | `50` | ✅ | 路由日志环形缓冲条数(仅内存) |
| `ordering.mode` | | `auto` | ✅ | **额度感知的路由行为**(0.8.0 起):`auto` = 按订阅月度重置时刻自动排序 + 额度耗尽时冷却该来源;`manual` = 完全按 `routes` 顺序、只失败时切换(0.7.0 的行为)。两个值之外的坏值(**标量 / 数组 / 普通对象**形态)**只 warn 并回落 `auto`**;⚠ 但值里**不要写 `!!js`、函数或类实例**(`RegExp`/`Date`/`Map`,YAML 里未加引号的日期也会变成 `Date`)—— 这类"非普通值"在 schema 层就被拒,会让**整行插件加载失败**(见本节末尾的 ⚠) |
| `retry.maxRetries` | | `5` | ✗ | **每路由**重试上限(不含首次);`0` = 关闭重试,恢复"一次败就切" |
| `retry.retryableCodes` | | `EMPTY_RESPONSE`/`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT` | ✗ | 可重试的错误码**白名单**;永久错误(不在表里的)一次败就切,不白烧请求 |
| `retry.backoff.initialDelayMs` | | `500` | ✗ | 指数退避起步(毫秒) |
| `retry.backoff.maxDelayMs` | | `10000` | ✗ | 退避封顶;上游 `Retry-After` 超过它则不等了,直接切下一条 |
| `retry.backoff.jitterRatio` | | `0.1` | ✗ | ±10% 对称抖动 |

「热改」= 该键是 schemastery `.volatile()` 字段 ⇒ 由宿主设置服务写入后**原地更新**引用,
插件下次用到时就是新值(不需要重启、也不需要重新 apply);✗ 的键是结构性配置,
由 `apply()` 一次性消费,只能改 `cordis.patch.yml`(包内或 profile 覆写行)。

> `routes` 从 0.6.0 起也是 `.volatile()`,但类型写成 `z.union([z.array(条目), z.any()])` ——
> 这不是画蛇添足:写路径要求目标是 volatile 字段,而 schemastery **禁止 volatile 之下再套 voluntary**,
> 同时本插件"坏形状只 warn"的约定又要保住。union 两个成员各管一头:
> 第一个给出"数组 + 字段类型"的形状(编辑器写进来的值走这条),第二个兜底放行其它形状
> (继续交给 `normalizeRoutes()` 逐条判)。
>
> `ordering` 从 0.8.0 起**同样是 volatile**,形状照抄 0.6.0 的教训写成
> `z.union([z.object({ mode: z.string() }), z.any()]).volatile()`:
> **必须** volatile,因为面板上那个「自动排序」开关承诺"改完即时生效、不用重启";
> **必须** union 兜底,因为 schema 是**加载期**校验 —— 直接写 `z.object(...)` 会让
> `ordering: nope` 这种坏值把**整行插件**搞成加载失败,那正是 0.6.0 踩过的坑。
> 坏值只由 `normalizeOrdering()` warn 并回落 `auto`。
>
> ⚠ **这条不绝对**:schema 是**加载期**校验,值里含 `!!js` 标签、函数或类实例(`RegExp` / `Date` / `Map`)
> 时仍会被拒 ⇒ **整行插件加载失败**(实测:`ordering: [{ mode: auto }]` 这种"数组里套对象"过得了
> union,但 `{ d: new Date(0) }`、`{ f: () => {} }` 一律抛)。这条对 `routes` / `retry` / `quota` /
> `ordering` 一视同仁 —— **配置值只写标量、数组与普通对象**。

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
> ⚠ `compactWindow` 低于最小可用值 12484(见 `minimumUsableCompactWindow()`)会另打一条 warn:此时引擎的"保留尾部 < 阈值"校验过不去
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
- 写入经宿主 settings 服务。0.4.0–0.5.x 时这张表单只落 `compactWindow` 一个键;0.6.0 起
  `routes` **也能写**(见下节「回退链面板」),而且它现在就是 `.volatile()` 字段(union 兜底坏形状)
  ⇒ 改完不用重启、下一次请求就是新链;`retry` 仍是结构性配置,只能改包内 `cordis.patch.yml`;
- 命名空间就是 loader 行 id `llm-auto`(`dsh-settings` 按 `entry.options.id` 投影)——
  与启停开关、覆写行的寻址键一致;
- **前提**:这个半侧是 0.4.0 新增的,首次启用必须**重启一次 dsh** 才会被收录(依据见 §1);
  此后**改这个文件本身也要重启**(或至少刷新页面)才看得到新表单,见 §4 第 2 条;
- 备选改法不变:手编 profile 的 `cordis.patch.yml` 追加按 id 覆写的顶层行
  (`- id: llm-auto` + `name: 'dsh-llm-auto'` + `config: { routes: [...], compactWindow: N }`,
  profile 层在包层之后应用 ⇒ 遮蔽包内那行 insert),或直接改包内 `cordis.patch.yml`。
  `routes` 从 0.6.0 起**有**表单(就在这张卡片的「回退链」面板里),上面这两条只是等价的备选改法;
  `retry` 这类结构性配置仍然没有表单,只能走这两条。

### 回退链面板:可编辑 + 按模式显示(0.6.0 起可编辑;0.9.0 起与「排序」合段)

同一张卡片上、compactWindow 表单**下方**多出一块「回退链」面板。**0.9.0 起它按排序模式显示**,
模式开关画在卡片**最上面**(「回退链」标题之前):

`auto`(默认)—— 主视图是**生效顺序**,可编辑的配置链折进「配置顺序」(默认收起):

```
排序方式                                            [当前:自动排序。切到手动]
──────────────────────────────────────────────────────────────────────
回退链                                            [放弃改动] [刷新] [保存]
自动排序生效中:按订阅的重置时刻排序、额度耗尽的来源暂时跳过;下面是本次实际会尝试的顺序。…

生效顺序
冷却中  opencode-go/deepseek-v4.1-flash   月度已耗尽,10-24 08:00 恢复
commandcode/deepseek/deepseek-v4.1-flash
deepseek-official/deepseek-flash   额度查不到,按配置顺序
⌄ 配置顺序(3 条)          ← 点开就是下面「手动」那张里可拖拽的链(改动照旧要点「保存」)
每路由最多重试 5 次,退避 500ms→10000ms
额度 ...............................................(只读;鼠标悬停给一句口径说明)
Command Code   余额 $45.23 · 5h $2.09/$14.00 · 周 $24.77/$35.00   individual-goat
OpenCode Go    5h 0% · 周 0% · 月 已耗尽                          10-24 08:00 重置

最近请求 ............................................ 共 13 条记录,容量 50
● 10:05:28  1m4s  成功
    1. commandcode/deepseek/deepseek-v4.1-flash   ✓ 成功
```

`manual` —— 主视图就是那条可编辑的链,不画生效顺序(那种模式本来就不排序):

```
排序方式                                            [当前:手动。切回自动]
──────────────────────────────────────────────────────────────────────
回退链                                            [放弃改动] [刷新] [保存]
按下面的顺序依次尝试:第 1 项即首选。某条重试耗尽、或错误码不允许重试时,才静默切下一条。
拖动行首的手柄改顺序,改完点「保存」写入配置并即时生效(不用重启)。

⠿ commandcode / DeepSeek V4.1 Flash              ⌄   选项 ⌄   ✕
⠿ opencode-go / DeepSeek V4.1 Flash              ⌄   选项 ⌄   ✕
⠿ deepseek-official / DeepSeek-V41-Flash  keepThinking · breakToolLoop  ⌄   选项 ⌄   ✕
     └─「选项」展开(这一行开着两个开关时):
          保留思考块            [开]
          工具循环收尾          [开]
[+ 添加模型]   [恢复包内默认链]
每路由最多重试 5 次,退避 500ms→10000ms
额度 … / 最近请求 …(与上面那张相同)
```

- **配置链 0.6.0 起就地可编辑** —— 行首 `⠿` 拖拽排序、点行内模型名开选择器换一条、
  「选项」展开两个逐条开关、行尾 `✕` 删除(最后一条不允许删)。改动先落在本地草稿,
  只有点「保存」才写配置;「放弃改动」回到端点值。⚠ **0.9.0 起自动模式下这块默认收起**
  (折进「配置顺序」那一行,点开照旧可改)—— 链本身没变,只是不再跟「生效顺序」抢主视图。
- **选择器长得像主页的模型菜单**:顶部搜索(大小写不敏感的有序子序列,与官方 `rankByName` 同判据)、
  按 provider 分组、行高 34px、当前项打勾、材质直接用官方 `MenuSurface` + `MenuGroup`
  (滚动时分组标题吸附)。数据来自新增的 `GET /api/llm-auto/catalog`。
- **不在目录里的条目照样显示**:目录读不到该模型时那一行标一个「不在当前目录」的标记,
  但仍可拖、可删、可保存 —— 目录失败不该把链弄成不可编辑的。
- **保存写到哪里**:`configForms` → 宿主 `settings.mutate` → `dsh-config-editor`,落进 **profile 的
  `cordis.patch.yml`** 里那一行 `- id: llm-auto` 的 `config.routes`(yaml 文档式写入 ⇒
  该文件里那些注释与 `!!js` 标签原样保留)。profile 层在包层之后应用 ⇒ 这一行会遮蔽包内
  那段 `insert`;面板上的「恢复包内默认链」= `unset` 掉这个覆盖 —— 该按钮**只在 profile 层确实
  覆盖了 `routes` 时才出现**(判据是端点响应的 `user.routes`,见 §5),没有覆盖时它压根不画。
- **为什么不用重启**:`routes` 是 cosmokit 的 volatile **引用**,加载器重建配置时原地更新同一个引用,
  而适配器只在**每次请求开始时**现取一次链(不是构造时抄一份)⇒ 改完链的下一次请求就是新链,
  正在跑的那一次不受影响。
- **下半是运行时的真实回退**:端点的 `calls` 字段,按**一次 auto 请求**分组(adapter 给
  每条日志写上本次 `stream()` 的序号 `call`,宿主侧 `lib/calls.js` 的 `groupCalls()` 还原)。
  同一条路由的多次尝试合并成一行(`试了 N 次`),错误码取该路由的最终失败,
  `→ 切换至 …` 指向下一条候选。**最近结束**的请求排最上面。这一段始终只读。
- **刷新时机**:组件挂载(进这张卡片)时读一次链与目录,点「刷新」再读一次;不轮询。
  链在别处被改过(另一个标签页、手改 YAML)时,下一次刷新会重种草稿并说明一句;
  而你在草稿里的改动如果基于过期版本保存,宿主会**拒绝**并提示重新读取(乐观并发控制,带 revision)。
- **失败有提示而不是空白**:端点非 200 / 网络错误 ⇒ 面板尾部一行"读取失败:原因"
  (插件没加载、端点不可达时正是这个);某几个 provider 的目录读不到 ⇒ 选择器里列出它们的 id。
- 路由日志是**进程内内存**,重启即清空 ⇒ 面板读的就是它,重启后"最近请求"从空开始。
- **模式开关与链是两件事**:开关写的是 `ordering.mode`(0.9.0 起画在卡片**最上面**,见下节),
  链仍是你排的顺序(`chain` 一字不变);它只决定"这一次实际会按什么顺序试、跳过谁"
  (`ordering.effective`)—— 自动模式下后者就是主视图「生效顺序」。
- 备选仍是 curl:`curl http://127.0.0.1:19387/api/llm-auto/routes`(完整字段见 §5)。
- 面板样式只用主题 `--dsw-*` token(浅色/深色两套随外壳),状态用官方 `StateDot` / `Tag`;
  文案走本插件的字典命名空间 `llmAutoSettings`(中英双语,与 compactWindow 表单同一份)。

### 排序与耗尽冷却(0.8.0 起;0.9.0 起与链编辑器合段)

**行为**是 0.8.0 加的,**界面**在 0.9.0 收敛成一段:模式开关(「排序方式」+ 那个按钮)画在卡片
**最上面、「回退链」标题之前**;`auto` 时主视图是下面这块「生效顺序」、可编辑的链折进「配置顺序」,
`manual` 时只给可编辑的链、不画「生效顺序」(两段不再各画一次"当前是什么模式"):

```
排序方式                                          [当前:自动排序。切到手动]
生效顺序
冷却中  OpenCode Go/deepseek-v4.1-flash    月度已耗尽,10-24 00:00 恢复
Command Code/deepseek/deepseek-v4.1-flash
deepseek-official/deepseek-flash   额度查不到,按配置顺序
⌄ 配置顺序(3 条)
```

- **一行模式开关**:点它就在 `auto` / `manual` 之间切(写 `ordering.mode`,即时生效、不用重启);
  悬停给一句口径。提示语随模式换 —— `manual` 下"按下面的顺序依次尝试…"那句才成立,
  `auto` 下换成"自动排序生效中…"(旧那句在自动模式里是错的:它会排序、也会跳过)。
- **实际顺序,一行一个来源**(`auto` 时):这一次请求会依次尝试的路线,来自端点新增的只读字段
  `ordering.effective`。**冷却中的条目也列在这里**(排在前面,带「冷却中」标签、**哪一档打满**
  与解除时刻,如「月度已耗尽,10-24 00:00 恢复」),它们**不会被尝试** —— 真正会走的是去掉这些
  条目之后的顺序;查不到额度的标「额度查不到,按配置顺序」。
- **它和「额度」段是两件事**:这一段是**行为**(插件真的会跳过谁),「额度」那段是**观测**
  (上游现在怎么说)。同一个来源可能一段写「冷却中」、另一段写「已耗尽」—— 两者都对。

规则(与设计档 §3 逐条对应):

| 项 | 规则 |
| --- | --- |
| 排序键 | 订阅来源取**月度重置时刻升序**(Command Code = 套餐 `currentPeriodEnd`;OpenCode Go = 月度档 `resetsAt`)。**不用** 5h/周窗口的重置点 —— 那是速率闸门,按它排会每几小时抖一次 |
| 三桶 | ① 已知重置时刻的订阅(升序)→ ② 重置时刻未知的(按配置顺序)→ ③ 按量兜底(永不过期,按配置顺序,**永远最后**)。桶内保持配置顺序,且**不改 `routes` 配置本身** |
| 粒度 | 排序按**条目**;冷却是按 **provider**(额度是账号级的)⇒ 同一家所有条目一起冷 |
| 触发 | **反应式**:某条在会走回退的失败路径上返回 `QUOTA`(兜底:报文命中 `insufficient quota/balance/credits`、`(quota\|usage limit) exceeded/exhausted/reached`)。`AUTH` / `RATE_LIMIT` / 其它码**不触发** |
| 判定 | **补查该 provider 的额度接口**确认,不靠错误文本猜。**三档都看**:OpenCode Go 的 5 小时 / 周 / 月度,Command Code 的 5 小时窗 / 周窗 / **月度余额**(判据:`credits.belowThreshold` 为真,**或** `monthly` 与 `total` 两个键都在且都 ≤ 0 —— 字段缺失=不知道,绝不当成 0)。任一档耗尽 ⇒ 冷却到**被耗尽那几档里最晚**的重置时刻,面板写明是哪一档(「月度已耗尽」/「余额已耗尽」/「周已耗尽」…) |
| 恢复 | **不用定时器**:每次请求重算时 `now >= until` 即自动解除 |
| 兜底 | 过滤后一条都不剩(理论上到不了,按量不参与冷却)⇒ **忽略冷却**,避免假故障「链已用尽」 |
| 持久化 | **不落盘**(进程内 Map),重启重算 —— 最坏白撞一次,而 `QUOTA` 不在重试白名单里,代价只是一次失败往返 |
| 查询失败 | **fail-open**:断网 / 超时 / 形状不认 / 401 ⇒ **不冷却**,只记一条 warn(宁可下次白撞,也不误伤一条其实能用的订阅)。这一轮既然没查到,路由侧的额度缓存只记 **10 分钟**短闸门后重试(见下面的 §4 说明) |

> ⚠ **路由侧的额度缓存不与面板那份共用**(设计档 §4):面板的 `quota` 仍是 60 秒 TTL、
> 只在读端点时刷(只读观测,一行不动);路由侧另有一份低频缓存,有效期 = 该来源**已知重置时刻里
> 最早的那个**,另挂 6 小时上界兜底。**"查过"的判据是这一轮真的拿到 `status: ok`** ——
> 查失败(断网/超时/形状不认/401)只记 **10 分钟**短闸门后重试,而不是把失败也当成"查到了"占满
> 6 小时。两者复用同一套查询与解析(lib/quota.js),只换"什么时候查"的策略。
> ⚠ 路由侧**只在三个时机**去问:① 进程内第一次有请求需要排序 ② 发生 `QUOTA` 报错(只查这一家、
> **绕缓存**)③ 缓存过期。①③ 同挂在**每次请求的排序路径**上(适配器每请求判一次,过期才查)⇒
> **headless(没人读 `/routes`)也照样会补查**;读端点那一次只是幂等地顺带推一下。
> 三处都是 **fire-and-forget** —— 查询不阻塞任何一次请求或端点响应;而且只补查**真的过期**的那几家
> (链上查不到的来源永远"该查",不该把别的家的闸门顶穿)。**没人用 `auto` 时零外部流量**
> (与 0.7.0 的额度观测同一条纪律)。
> ⚠ `manual` 下冷却表照旧记着(切回 `auto` 立刻生效),但端点的 `ordering.cooldown` **恒为空数组** ——
> 那种模式不跳过任何一跳,把表画出来只会让人以为"它被跳过了"。
> ⚠ **profile 遮蔽**(0.6.0 的同一个坑):面板上保存过一次链之后,整块 `config` 被写进 profile 的
> `- id: llm-auto` 行 ⇒ 之后改包内 `cordis.patch.yml` 的 `ordering` 不再生效,要改就改 profile 那一行
> (或直接在面板上切)。

### 额度(只读,0.7.0 起)

同一张卡片上、「最近请求」上方还有一段**只读**的额度摘要:一家一行。它**不是路由策略的一部分** ——
插件不会因此跳过或重排任何一跳(顺序完全由链决定),查不到也只体现在这一段里。

- **Command Code**:`余额 $59.92 · 5h $0.62/$14.00 · 周 $10.08/$35.00`,右侧是套餐 id(如 `individual-goat`)。
  余额 = `monthly + purchased + free`(充值额度可结转),两档窗口的 `used`/`cap` 同单位(美元等值)。
- **OpenCode Go**:`5h 0% · 周 0% · 月 已耗尽`,右侧是该档的重置时间(**本地时区**,上游给的是 ISO/UTC 串)。
  ⚠ 它的接口给的是**百分比窗口**(没有金额口径);`status: "rate-limited"` 表示**该档已经耗尽**
  (服务端会把 percent 硬编码成 100)⇒ 界面写「已耗尽」,不写 100% 更不写 0%。
- **查不到就说查不到**:凭据没配 / 被 Cloudflare 按浏览器签名拦(403 + `error_code 1010`)/ 超时 /
  网络不通 ⇒ 那一行写「不可查:原因」,**一个数字都不给**。用 0 顶替会把"已耗尽"说成"没用量"。
- **按需刷新**:只在 `/api/llm-auto/routes` 被命中且缓存过期(默认 60s)时才查一次,不轮询;
  点面板的「刷新」即重读。第一次读到"查询中…"时面板会自动补拉一次(只补一次)。
- **配置**(可选,改**包内** `cordis.patch.yml`;它不是 volatile 字段,面板里没有表单):

```yaml
quota:
  enabled: true            # 只读观测,缺省开;false ⇒ 整段不显示
  ttlMs: 60000             # 缓存窗口(从"上次尝试"起算,成败都算)
  timeoutMs: 8000          # 单个 HTTP 请求上限(实测 CC 冷连接可达 2.3s,4s 会误报超时)
  # userAgent: '...'       # 查询用的 UA(默认浏览器 UA)
  commandcode: { apiKeyEnv: CMD_API_KEY }
  opencodeGo:  { apiKeyEnv: OPENCODE_API_KEY }
```

> ⚠ 凭据引用名默认 `CMD_API_KEY` / `OPENCODE_API_KEY`,走宿主凭据服务(与模型页写的是同一份);
> 拿不到凭据服务时才退环境变量。⚠ 面板上保存过一次链之后,`quota` 会被一并写进 **profile** 的
> 覆盖行(profile 层遮蔽包层)⇒ 之后要改 quota,改 profile 那一行。

### 导出 `Config`(= 成为可编辑配置条目),以及它的代价与**效果边界**

0.3.0 起本插件导出一个 schemastery `Config`(`lib/index.js`)。效果是**配置成为宿主的可编辑条目**:
`dsh-settings` 的 `SettingsForms.describe()` 会为带 schema 的活动条目生成描述符
(`lib/index.js:413-452`;schema 取 `entry.fiber.runtime.Config`,同文件 `:538-541`),
`settings.describe()` / `settings.mutate()` 这条远端通道因此能看到并写入它的字段。
`name` / `compactWindow` / `contextWindow` / `logLimit` 标了 `.volatile()`,插件不缓存这些值
(每次用到时重新读引用),所以值一改就生效、不需要重启;**0.6.0 起 `routes` 也是 `.volatile()`**
(适配器每次请求现取一次链,面板里改完即时生效);**0.8.0 起 `ordering` 同样是 `.volatile()`**
(面板那个「自动排序」开关写的就是它,每次排序现读一次模式)。仍是结构性配置的是 `retry` 与
0.7.0 的 `quota`(后者是只读观测,**刻意不标** volatile),这两者仍走**包内** `cordis.patch.yml`。

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
  范围与整数性仍由插件自己判并 warn 回落。会硬失败的是两类:**类型错误**(例如把字符串写进
  `compactWindow` 这种数字字段)与**非普通值**(`!!js` 标签、函数、类实例;YAML 里未加引号的日期
  会被解析成 `Date`)—— 所以配置值只写标量、数组与普通对象。
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
> 以文件为准(`curl http://127.0.0.1:19387/api/llm-auto/routes` 的 `chain` 字段永远反映**当前**生效值)。

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

### 跨路由历史思考摘除:跨路由的思考**摘掉**,而不是被上游摊成正文(2026-09-28 修复;0.5.2 修正 DeepSeek 原生路由例外)

**症状**:会话中途换过路由时,那批**跨路由**的历史助手消息里,模型自己的思考被当成普通正文
发给上游 —— 与上一节同款的现象,但成因不同,上一节的修法①对它无效(修法①只救得回**同路由**的历史)。

**成因**:上一节的修法①让历史走 pi-ai 的 `replayedAssistant`;而 `dsh-llm-pi-ai` 只会为
**同一条路由**的历史走这条路,跨路由的历史走另一条分支 —— pi-ai 的 `transform-messages.js:66-90`
对"历史消息的模型 ≠ 本次请求模型"的助手消息执行 `return { type:'text', text: block.thinking }`
(`:87-90`),思考块被**降级成正文**。判据是 `provider + api + model` **三者全等**
(`transform-messages.js:68-70`),而当前链上 3 条路由的 provider 互不相同 ⇒
**任何**中途切换都必然走降级分支(把某条路由移出链只是换个受害者)。

抓包实测(同一份历史两跑,`auto-route-capture/REPORT.md`):跨路由臂那条历史消息出站是
`keys=[role,content]`、`content` 长 145 = 思考 124 + 真答案 21(**零分隔符**)、没有任何独立思考字段;
同路由对照臂 `content` 只有真答案 17 字符、思考 124 字符在 `reasoning_content` 里。
后果不是"少一段上下文",而是**模型把内心独白学成正文格式**,整场会话此后思考全进正文且不可自愈。

**修法**:在换 provider 的那一刻(`adapter.js` 的 `#nestedOptions`)把跨路由历史助手消息的
`reasoning` 块从 **`content` 与 `replayState.blocks` 两侧同位同步摘掉**(`lib/replay.js` 的
`restoreMessageSource` / `stripReasoning`):

```
跨路由的历史助手消息
  content:            [reasoning, text, tool-call]   ─┐ 同位摘掉 reasoning
  replayState.blocks: [reasoning, text, tool-call]   ─┘ (两侧必须同步)
                     ↓
  content:            [text, tool-call]
  replayState.blocks: [text, tool-call]      ← dsh-llm-pi-ai 的等长校验仍然通过
```

**为什么必须两侧同步摘**:`dsh-llm-pi-ai` 的 `replayedAssistant` 有四条校验
(`lib/index.js:185`/`:186`/`:187`/`:192`),其中 `:187` 比的是 `replayState.blocks.length` 与
`message.content.length` **逐条等长**、`:192` 比逐条同型。只摘 `content` 一侧 ⇒ `:187` 抛
`INVALID_REPLAY_STATE` ⇒ `toPiAssistant`(`:240-252`)把**整条**降级成 `foreignAssistant`,
而那条路径会把残留的 `reasoning` 原样映射成 `thinking`(`:154-158`)、并把 `api` 打成
`"dsh-foreign"` ⇒ pi-ai 的 `isSameModel` 必为假 ⇒ 思考**照样**被摊成正文。
也就是说**只摘一侧 = 缺陷原样复发 + 多一条 degrade 日志**(日志文案见 §8);
同位摘 k 项 ⇒ 两侧各减 k ⇒ 等长与逐条同型都仍然成立。

**边界(哪些动、哪些不动)**:

| 情形 | 行为 |
| --- | --- |
| 跨路由的历史助手消息 | `content` 与 `replayState.blocks` 同位摘 `reasoning` |
| **同路由**的历史 | **一个字都不动** —— 那是唯一能让 pi-ai 带签名原样回放的路径(`transform-messages.js:80-81` 要求 `isSameModel && thinkingSignature`),摘了等于把 2026-09-24 的收益还回去 |
| 摘完全空的消息(这条消息本来只有思考) | **整条消息从请求里去掉** —— 不给上游一个空 `content` 的助手消息(`dsh-llm-deepseek` 的序列化只跳过空 user 消息,空助手消息会原样发出去;该条路由对空 `content` 助手消息的真实反应**未测**,见 `auto-route-capture/FIX-A-IMPL-20260928.md` 的"未验证项") |
| `replayState.blocks` 与 `content` 对不齐(缺 `blocks`、长度或类型已错位) | 摘 `content` 并**丢掉整个 `replayState`**(不交半截信封);与宿主自己的做法一致 —— `BlockAssembler` 在 blocks 对不上时就是 `replay: undefined`(`@deepseek-ai/dsh-llm/lib/index.js:1060-1063`) |
| 非助手消息、`source` 缺失、路由值不是非空字符串 | 原样放行,不抛错(交给下游适配器自己校验/降级) |
| 目标路由 keepThinking: true | 跨路由思考不摘除;用于 DeepSeek thinking 模式的工具循环。未设置/false 仍照常摘除 |
| 目标路由 breakToolLoop: true | 出站以**工具结果**结尾、且历史里存在"带工具调用却没有思考块"的助手消息时,末尾追加一条用户提示,把请求改成"以用户消息结尾" —— 绕开 DeepSeek thinking 模式的工具循环校验。未设置/false 不追加(见下一节) |
| DeepSeek Messages 信封缺 provider | 通知与摘除按 model 判同异;source 不伪造 provider,通知标签只显示 model |
| 调用 `restoreReplaySources(options)`(不传 route) | 退化为旧行为:只改 `source`,不摘思考 |

**代价(有意的取舍)**:跨路由的思考从此"看不见"了。现状是"看得见但被误导",改后是"看不见"。
跨路由时思考的签名已经无效(`thoughtSignature` 跨模型即删),保真价值接近零;
丢弃只损失一点上下文,而污染会改掉整场会话的格式。这一层与 pi-ai 自己的先例同向:
`transform-messages.js:72-77` 对跨模型的 `redacted` 思考就是直接丢弃。

**复发路径与兜底**:唯一现实的复发路径是上游把 `readReplayState` 加严、或把 `version` 升到 3
—— 那时**同路由**的消息也会走 `foreignAssistant`,而本插件"同路由 ⇒ 保留思考"的判断就成了帮凶。
兜底做法是在"保留"分支上加一个自证可用的前置检查(`version === 2 && blocks 与 content 同位同型`);
**本次有意不加**(它把上游校验复制进插件,且现有用例里没有对应失败场景)。
日后升级 DSH/pi-ai 时,先跑 `auto-route-capture/FIX-A-DESIGN.md` §4.2 的用例 1/2/11 再决定。

### 工具循环收尾:历史缺思考时,别让请求以工具结果结尾(0.5.3 新增)

**症状**:兜底到 DeepSeek 原生路由时,工具循环第二轮必失败,整条请求被拒:
`The content[].thinking in the thinking mode must be passed back to the API`(HTTP 400)。

**根因与"摘思考"不是一回事**:那一回的思考**不是被摘掉的、是从来没有** —— 会话前段由别的路由
(现场是 `opencode-go`)产出,那些回合的上游响应里本就没有 reasoning 分片,`keepThinking: true`
无从保留。DeepSeek 在 thinking 模式下对**工具循环**有硬校验:请求以 `tool` 结果结尾时,
历史里带工具调用的助手消息必须把思考一并回传。

**修法**:目标路由声明 `breakToolLoop: true` 后,满足下面两个附加条件时,在出站消息**末尾追加一条
用户角色的提示**(正文 `[tool loop notice: …]`),把请求形态从"以工具结果结尾"改成"以用户消息结尾"。

| 条件 | 为什么 |
| --- | --- |
| 目标路由 `breakToolLoop: true` | 显式开关,不猜 provider 语义 |
| 出站消息以 `tool` 结果结尾 | 不处在这个形态就没有校验点 |
| 历史里存在"带工具调用却没有思考块"的助手消息 | 否则纯属打扰 |

**与路由切换通知互斥**:两者都追加在末尾、都是用户角色。切换通知先落地时末尾已不是工具结果,
本提示自然不追加 —— 这正好解释了 2026-10-01 现场"第 113 步侥幸成功、第 114 步才炸"的现象
(那一步的切换通知替它挡了一次)。

**代价**:提示只存在于**出站副本**里(不落盘),所以每轮都会重新追加一条;模型会看到一句
"上面有些回合没有思考记录,请从工具结果接着做"。这是有意的取舍 —— 相比整条请求被 400 拒绝,
多一句话是更小的代价。

### 路由切换通知:静默切换也告诉模型"上面那些回合是别的模型生成的"(0.5.1 起;0.5.2 支持 DeepSeek 信封)

DSH 自带的那条 `[model changed: …]` 只在用户**手动换模型**时追加
(`@deepseek-ai/dsh-agent/lib/index.js:133-147` 的 `modelSwitchNotice`,由 `agent/pre-step`
瀑布注入,且会落进会话记录)。`auto` 的切换是**静默**的,模型在毫无提示的情况下看到一堆
"内心独白式正文",更容易把坏格式学下去 ⇒ 本插件在**本次请求真的发生了切换**时,
在出站消息序列**末尾**追加一条同款通知。

**措辞与标签规则**(逐字复刻自带通知,`routeLabel` = `dsh-agent/lib/index.js:130-132`):

```
[model changed: assistant turns above this point were generated by <来源>; the session continues with <目标>]
```

| 标签 | 规则 |
| --- | --- |
| `<来源>` / `<目标>` | provider 相同就只写 `model`,否则写 `provider/model` |
| 注意 | 两侧各按**对方**判一次(`routeLabel(旧, 新)` / `routeLabel(新, 旧)`),所以 provider 不同时两个标签**都会**带 provider 前缀 |

**追加在末尾而不是插在那批回合之后**:措辞是 "assistant turns above this point",放在末尾时
"上面"正好包含全部历史回合,措辞仍然准确;插进历史中间会让 `messages` 的下标与其它改写逻辑
(以及宿主自己"内容块与 replay 块逐条同位"的不变式)纠缠。

**触发条件(三条全中才追加)**:

1. 有历史助手消息,且它的 `replayState.response` 给出可用路由
   (取不到时**不发通知** —— 判不出"上面那些回合是哪个模型生成的"就不能声称发生了切换;
   宁可不发,也不发一条每回合都出现的假通知。这不是常态:会话里每条经 `auto` 产出的助手消息
   都带 replay 状态 —— `dsh-llm-pi-ai` 的 `toPiReplayState` 与 `dsh-llm-deepseek` 的
   `replayState()` 都是每次产出必写,而外层 `forAdapter` 对 `source.provider === 'auto'`
   的消息本来就原样保留 replay);
2. 本次候选路由与它**不同**(比 `provider` + 重建后的 `model`(信封无 provider 时仅比 model),与摘思考同一套口径
   —— 见上节;`api === 'anthropic-messages'` 时 pi-ai 用的是 `responseModel`,
   重建规则见 `dsh-llm-pi-ai/lib/index.js:218`);
3. 历史里**没有**已覆盖本次切换的通知(见下)。

候选路由在 `adapter.js` 的链循环里定,`#nestedOptions(options, route)` **每次尝试都重算**,
且每次尝试都从**原始** `options` 重新派生(不是从上一次尝试的结果接着改)⇒ 失败路由的尝试
不会把摘除结果或通知带进下一次尝试的负载;只有真正成功那条的负载会被上游看到,
所以"逐次尝试各自判定"与"链上第一个成功的路由 ≠ 上一条助手消息的路由"等价。

**只改出站负载**:通知只加在交给嵌套调用的**请求副本**里,**绝不写进会话记录**
(与上节"只改出站、不改落盘"同一口径);会话记录由 DSH 自己的机制管。
通知消息本身是用户角色、深冻结,`source` 带同款标记(`kind: 'model-selection'` /
`form: 'notice'`);**不带 `id`** —— 出站请求消息不需要稳定身份,省略也让出站负载可预测、可测
(自带那条由 `createUserMessage` 造,会带一个随机 uuid)。

**去重规则(`hasCoveringNotice`)**:历史里若已有一条"覆盖本次切换"的通知就不再追加。
两条判据**同时**成立才算覆盖:

| # | 判据 | 为什么 |
| --- | --- | --- |
| 1 | **位置**:它出现在**最后一条助手消息之后** | 自带通知里的 "assistant turns above this point" 是位置相关的 —— 只有紧跟在我们要标注的那批回合之后,它说的才是同一批回合;更早的那条说的是更早的回合,不能拿它顶账 |
| 2 | **来源**:它的措辞里 "generated by `<来源标签>`;" 这一段与本次要写的来源路由一致 | 即模型已经被明确告知"上面那些回合是 `<来源>` 生成的" |

只比这两条、**不比目标标签**:自带通知的目标写的是**选择**(`auto`),我们写的是**真实路由**,
两者天然不同字;而"上面那些回合是别的模型生成的"这层意思,来源标签就是它的全部信息量。
比**前缀**而不比整句,是为了对 `boundContextSummary` 的截断(自带那条的 `summary` 会被截到
120 字符)保持稳健 —— 正文本身不截断,但只依赖前缀更不容易被上游改坏。

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

1. **`file:` 依赖的落盘形态逐文件实测**:desktop profile 当前本包文件为硬链接;修改包内文件必须用 `[System.IO.File]::WriteAllText` 原地写入以保留 inode,并用 `fsutil hardlink list` 核实 plugins 与 node_modules 两侧同一 FileId。不要依赖旧文档关于 web profile 拷贝形态的结论。

   pnpm 把 `file:` 依赖装进 `~\.dsh\profiles\<profile>\node_modules\dsh-llm-auto\`,**真正被加载的是这一份**;
   原地改已有文件两侧同生效,**不需要** remove + add,但 `write` / `edit` 这类"写临时文件再改名"的换文件式
   写入会**当场打断硬链接**,改完必须核两侧 `fileId`。**只有新增文件**才要重跑 link(`remove` + `add`,
   或 `pnpm install`;只 `add` 可能报 `Already up to date` 而跳过同步):

   ```powershell
   node <工作区>\dsh\dsh-plugin-manager\dshpm.mjs remove dsh-llm-auto --profile <profile>
   node <工作区>\dsh\dsh-plugin-manager\dshpm.mjs add `
     file:$env:USERPROFILE\.dsh\profiles\<profile>\plugins\dsh-llm-auto --profile <profile>
   ```

   `dshpm` 是本机工作区里的插件装卸 CLI(`dsh-plugin-manager`,即上面那个脚本),公开环境没有它;
   可用官方 `dsh plugin add` / `dsh plugin remove` 代替,只是官方命令在部分版本会超时并丢
   `dsh.profile.bundles` 更新,所以本机一直用 `dshpm`。

   改完用 SHA256 比对两份 `lib/index.js` 一致;不想经历 `remove` 造成的空窗时也可以**直接改运行副本
   侧那份**(原地改写,别用会换文件的工具 —— 那会断链),再照上面核对 SHA256。

   最快的一条是**只给改动过的那个文件重建硬链接**:

   ```powershell
   $src="$env:USERPROFILE\.dsh\profiles\desktop\plugins\dsh-llm-auto\lib\client.js"
   $dst="$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-llm-auto\lib\client.js"
   Remove-Item $dst -Force
   New-Item -ItemType HardLink -Path $dst -Target $src | Out-Null
   (Get-FileHash $src).Hash -eq (Get-FileHash $dst).Hash   # 必须 True
   fsutil hardlink list $dst                               # 必须列出两条
   ```

2. **改插件代码要重启 dsh** —— loader 按 URL 缓存已 import 的模块实例。
   浏览器半侧理论上另有一条免重启路径:宿主 `dsh-client-hmr` 每 500ms stat 一遍各 client bundle,
   一有变化就 `clientModules.rebuilt(id)` 并经 `/plugins/events` SSE 让页面 `modules.reload` 换掉旧模块
   (`dsh-client-hmr/lib/index.js:79-92`、其 `lib/client.js:59`)。**但 2026-09-25 实测这条没生效**:
   改完 `lib/client.js`(同步两份后 stat 的 mtime/size 确实变了)后,线上 `plugins.row.config` 的占用者
   仍是旧注册 —— 用 `cordis_inspect_query`(client `Slots`,`plugins.bundle.config` / `plugins.row.config`)
   复核可重现。所以按老规矩办:改完**重启 dsh**(至少要刷新页面再看),别指望它自己换。
   改**包内 `cordis.patch.yml`**(包层 patch)不需要重启,但它**不会自己触发重组合**:dsh-hmr 只监视
   profile 的 `cordis.patch.yml`、home 层 `cordis.patch.yml` 与 profile 的 `package.json` 三个输入
   (`dsh-hmr/lib/index.js:353-376`),包内 patch 不在其中;重组合时会重读全部 bundle 层,所以改完要有
   一次触发才被读入 —— 在插件页点一下本卡(或任意行级)开关,或保存 profile 的 `cordis.patch.yml` 里任意一处。
   所以顺序是:先改代码(改完同步两份)→ 改配置(可选)→ 按上面触发一次重组合;代码改动本身仍要重启。

3. 本插件是**组合包(bundle)**:包里有 `dsh.bundle.patch`(指向包内 `cordis.patch.yml`),
   包名在 `dsh.profile.bundles` 里 ⇒ 由 profile 的 bundles 装载,**不需要**再往 profile 的
   `cordis.patch.yml` 里贴 insert 行(启停与卸载见 §1)。

---

## 5. 可观测

### HTTP 端点

> 以下端点都走**本机桌面端宿主**(`http://127.0.0.1:19387`);旧 web 宿主时代是 `3080`。端口以实际监听为准。

```
GET /api/llm-auto/routes?limit=N      # limit 省略/非法 = 不限(以容量为上限)
GET /api/llm-auto/catalog             # 0.6.0 新增:live 模型目录(provider 分组 + 模型名)
GET|POST /api/llm-auto/diag           # 0.6.0 新增:客户端半侧自诊断(GET 读最近 50 条 / POST 追加一条)
```

```json
{
  "provider": "auto", "model": "auto", "name": "Auto",
  "retry": { "mode": "normal", "maxRetries": 5, "retryableCodes": ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"], "initialDelayMs": 500, "maxDelayMs": 10000, "jitterRatio": 0.1 },
  "compactWindow": 500000, "declaredContextWindow": 625000,
  "chain": [
    { "label": "commandcode/deepseek/deepseek-v4.1-flash" },
    { "label": "opencode-go/deepseek-v4.1-flash" },
    { "label": "deepseek-official/deepseek-flash", "options": { "keepThinking": true, "breakToolLoop": true } }
  ],
  "writable": true,
  "user": { "routes": [{ "provider": "opencode-go", "model": "deepseek-v4.1-flash" }] },
  "ordering": {
    "mode": "auto",
    "effective": [
      { "label": "opencode-go/deepseek-v4.1-flash", "provider": "opencode-go", "model": "deepseek-v4.1-flash", "keepThinking": true, "reason": "monthly-reset-asc" },
      { "label": "commandcode/deepseek/deepseek-v4.1-flash", "provider": "commandcode", "model": "deepseek/deepseek-v4.1-flash", "reason": "monthly-reset-asc", "cooling": true, "until": "2026-11-04T14:00:31.000Z" },
      { "label": "deepseek-official/deepseek-flash", "provider": "deepseek-official", "model": "deepseek-flash", "reason": "never-expires" }
    ],
    "cooldown": [{ "provider": "commandcode", "until": 1793800831000 }],
    "ignoredCooldown": false
  },
  "quota": {
    "state": "fresh", "checkedAt": "2026-10-05T07:40:11.000Z", "ageMs": 8123, "ttlMs": 60000, "timeoutMs": 8000, "inFlight": false,
    "sources": [
      { "provider": "commandcode", "status": "ok", "reason": null, "message": null, "ref": "CMD_API_KEY", "credentialSource": "file", "fetchedAt": "2026-10-05T07:40:11.000Z",
        "credits": { "total": 59.9240242796, "monthly": 59.9240242796, "purchased": 0, "free": 0, "belowThreshold": false, "threshold": 0 },
        "windows": { "fiveHour": { "used": 0.622990592, "cap": 14, "exceeded": false, "resetAt": 1791202779495 },
                     "weekly": { "used": 10.0759757204, "cap": 35, "exceeded": false, "resetAt": 1791727383630 } },
        "plan": { "planId": "individual-goat", "status": "active", "currentPeriodEnd": "2026-11-04T14:00:31.000Z", "cancelAtPeriodEnd": false, "endedAt": null } },
      { "provider": "opencode-go", "status": "ok", "reason": null, "message": null, "ref": "OPENCODE_API_KEY", "credentialSource": "file", "fetchedAt": "2026-10-05T07:40:11.000Z",
        "windows": { "rolling": { "status": "ok", "percent": 0, "resetsAt": "2026-10-05T12:41:30.831Z" },
                     "weekly": { "status": "ok", "percent": 0, "resetsAt": "2026-10-12T00:00:00.000Z" },
                     "monthly": { "status": "rate-limited", "percent": 100, "resetsAt": "2026-10-24T00:00:44.000Z" } } }
    ]
  },
  "calls": [
    { "call": 12, "at": "2026-09-23T13:03:51.518Z", "elapsedMs": 3100, "outcome": "ok",
      "routes": [
        { "attempt": 1, "provider": "commandcode", "model": "deepseek/deepseek-v4.1-flash", "tries": 5, "ok": false, "code": "SERVER", "reason": "SERVER(502): 502 status code", "elapsedMs": 1200, "switched": true, "switchedTo": "stepfun/step-5-preview" },
        { "attempt": 2, "provider": "stepfun", "model": "step-5-preview", "tries": 1, "ok": true, "code": null, "reason": null, "elapsedMs": 1900, "switched": false, "switchedTo": null }
      ] }
  ],
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

顶层 `calls` 是 0.5.0 加的**分组视图**(插件页面板读的就是它):同一份记录按一次
`stream()` 调用(`call` 字段)归组,`outcome` 为 `ok` / `failed` / `aborted`,
`routes` 里同一条候选路由的多次尝试合并为一行(`tries` 次尝试、`code`/`reason` 取最终失败、
`elapsedMs` 为该路由内的耗时之和),`switchedTo` 指向同组下一条候选。`?limit=N` 只切
**记录条数** ⇒ 分组后最旧那一组可能被截断(同一次请求的前半段已被环形缓冲淘汰)。

顶层 `chain` 是当前生效的链(现场重算,不是挂载时那份):0.5.x 里每项是裸字符串
`provider/model`,0.6.0 起是 `{ label, options? }` —— `options` 只带**打开**的逐条开关
(`keepThinking` / `breakToolLoop`),面板据此画出"这一行开着什么"。顶层 `writable` 表示本部署
是否接受配置写入(`false` 时面板退回只读形态)。

顶层 `user` **只在 profile 层确实覆盖了 `routes` 时**出现(形状 `{ routes: [...] }`,取自设置服务
描述符里那一行的覆盖层)⇒ 面板据此显示「恢复包内默认链」;没有覆盖时整键缺席、面板也不画那个按钮。

顶层 `ordering` 是 0.8.0 新增的**只读**字段(形状见上面示例),三部分:

- `mode`:`auto` / `manual`,当前生效的模式(= `config.ordering.mode`);
- `effective`:这一次的**排序投影**,现场重算。每项就是**一条可用的路由**(带 `provider` / `model` /
  逐条开关)+ 三个只读字段:`label`(与 `chain[]` 同拼法)、`reason`
  (`monthly-reset-asc` / `unknown` / `never-expires`,即它落在哪个桶)、冷却中的额外带
  `cooling: true`、`until`(ISO 串)与 `windows`(被耗尽的档,见下)。**冷却中的条目也列在这里**
  (排在最前),但**不会被尝试**:**真正会走的顺序 = 去掉带 `cooling` 的那些**,与适配器拿到的
  那一份同源(适配器用的是不含冷却项的 `entries`,这层投影只影响显示、不影响路由)。
  ⚠ **`chain` 仍是配置顺序**(0.6.0 的编辑契约不动),
  两者不同不是 bug:一个是你排的,一个是这一次会走的;
- `cooldown`:当前冷却表 `[{ provider, until, windows }]`:`until` 是**毫秒时间戳**(与
  `effective[].until` 的 ISO 串**不同口径**,别混),`windows` 是**被耗尽档位的固定枚举 id** ——
  `rolling` / `fiveHour`(面板都显示成「5 小时」)、`weekly`(「周」)、`monthly`(「月度」)、
  `credits`(Command Code 的**月度余额**,「余额」)。一个都没认出来时是空数组(面板退回中性的
  「额度已耗尽」)。⚠ 这几个 id 是**插件自己的白名单**,不是上游原始键名 —— 上游字符串一个都不往外透传。
  `manual` 下**恒为空数组**(那种模式不跳过任何一跳),切回 `auto` 立刻复原;
- `ignoredCooldown`:为 `true` 时说明"全部路由都在冷却期内 ⇒ 本次忽略冷却"(兜底,避免假故障)。

顶层 `quota` 是 0.7.0 的**只读额度快照**(形状见上面的示例):`state` 为 `fresh` / `stale`(有数据
但过期)/ `pending`(还没查完)/ `disabled`(关掉了);`sources[]` 按当前 `chain` 里出现的 provider
排序,每项只有两种 `status`:`ok`(带数字)或 `unavailable`(**只带 `reason`/`message`,一个数字都
没有** —— 不是 0、不是 null)。`ref` / `credentialSource` 是**引用名与来源层**,不是凭据值。
handler 是**同步**的:它只读快照,真正的查询按 TTL 在后台去重触发 ⇒ 这个端点的响应时间与外部
HTTPS 完全解耦,额度查询失败也不会让它变成非 200。

`GET /api/llm-auto/catalog` 把 live LLM 注册表投影成 `{ groups: [{ id, name, models: [{ id, name, description? }] }], failures: [{ id, name, message }] }`:
口径照官方 `buildModelCatalog()`(逐 provider 隔离失败),但字段是**白名单** ——
provider 档案里的 `apiKeyEnv` / `baseURL` / 请求头一律不外传。注意 `listModels()` **不校验凭据**,
所以没配 key 的 provider 也会列出来(与本机模型选择器的表现一致)。

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
- 0.8.0 起:真的发生额度冷却时一条 `warn`(`auto: <provider> 额度耗尽,冷却到 <ISO>(补查已确认)`);
  补查失败或没确认到耗尽时也各一条 `warn`(明说"不冷却"、宁可下次白撞);
  全部路由都在冷却期内而走了兜底时一条 `warn`;
- 全部失败一条 `error`。

不刷屏:每次**重试/切换**才一条,正常请求零日志。

---

## 6. 边界与已知限制

- **默认按订阅到期自动排序;遇额度耗尽自动跳过**:顺序默认由插件决定 —— 有月度重置时刻的订阅按
  「越早重置越靠前」排,查不到重置时刻的按配置顺序,永不过期的按量兜底排最后。某一跳因窗口额度
  耗尽被拒(错误码 `QUOTA`)时,插件会补查该来源的额度接口,确认后把它冷却到对应档位的重置时刻
  (三档都看:Go 的 5 小时/周/月度,CC 的 5h 窗/周窗/**月度余额**;是哪一档会写在面板上),
  期间不再尝试。把 `ordering.mode` 设成 `manual` 即回到「完全按 `routes` 顺序、只失败时切换」的
  旧行为。无论哪种模式,插件都**不做额度记账**、不按价格/能力/内容挑路由。
  (失败时先在**该路由内**重试,重试耗尽或码不可重试才按顺序切下一条;见上节。)
- **重试的计费/时延上限(默认参数下)**:单次 `auto` 请求最坏 = 链长 × 6 次上游调用、约 15.5s×链长
  的退避(0.5+1+2+4+8+10s);想省就把 `retry.maxRetries` 调小或设 `0`。每次重试都是新的上游请求,
  与自带 `dsh-llm-retry` 一样可能重复计费 input token。连带效应:ring 缓冲(默认 50 条)消耗也快
  约 6 倍 —— 一条全瞬时失败的链一个请求就占 20+ 条,想多留历史就调大 `logLimit`。
- **只支持 `mode: 'normal'`**:`always`(无上限重试)在单请求内可能无上限计费,挂载时 warn 并回落默认。
- **插件卸载不 drain 在飞退避**:cordis 卸载本插件时,正在进行的退避(≤10s)会自然完成,不像官方
  `dsh-llm-retry` 有 lifetime abort + drain(它挂在 agent loop 上,拿得到 session 生命周期)。
- **不做视觉/长上下文分流**:上游同类插件按"含图 / 超长"分流,本插件按用户明确要求只做失败重试/回退。
- **声明 `inputModalities: ['text','image']`(2026-09-27 起;此前有意留空)**:留空等于对所有调用方
  宣称"不支持图片"——`read_image`(dsh-tool-fs)与 MCP 图像回传(dsh-mcp-client)的能力门禁都是
  "未声明即拒",于是 `auto` 路由下连截图都读不了。曾担心的投影副作用不成立:投影发生在每次
  `llm.stream()` 的适配器边界,嵌套调用会按**内层真实路由**再判一次 ⇒ 链路里若有纯文本模型,
  图片仍会在那一层被换成占位文本。前提是链路全部候选都收图。
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
  同样发生)。**跨模型**的历史(replay 路由 ≠ 本次路由)本来也会被 pi-ai 摊平(它的策略是"思考签名跨模型
  不可信",与直连时一致);本插件 2026-09-28 起改为**主动把跨路由的思考块摘掉**(见 §3「跨路由历史思考摘除」),
  不再让它以正文形态出现 —— 这是有意的取舍:跨路由的思考不再可见,换掉的是"整场会话的格式被污染"。
- **重启后的第一条消息可能白撞一次**:冷却表是进程内的(不落盘),刚重启时它是空的、额度也可能还没
  查过 ⇒ 第一条消息仍会先在已耗尽的来源上失败一次,之后才被冷却。这是**设计行为**:
  `QUOTA` 不在重试白名单里,代价只是一次失败往返(不会白等 5 次退避)。
- **路由日志是进程内内存**,重启即清空,不适合当审计账本。
- **回退链面板的数据来源就是这份内存缓冲**(0.5.0):进程内没有对应路由活动时"最近请求"为空;
  换一次浏览器/刷新页面不会丢(数据在宿主侧),但重启会。端点非 200 或插件未加载时面板显示
  "读取失败:原因",不是空列表。
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
  注册在 `plugins.bundle.config`,见 §2);⑤**额度感知排序 + 冷却**的离线覆盖齐全(三桶/冷却/兜底/
  fail-open 都有单测),但"真上游报 `QUOTA` ⇒ 补查确认 ⇒ 跳过后真的不再尝试"这条端到端只有
  注入式测试(见 §7),没有对真上游复现过;⑥「Command Code 的额度在 `currentPeriodEnd` 回满」
  是**假设**(免费接口看不出额度回满时刻):见底的判据是上游的 `credits.belowThreshold` /
  `monthly` 与 `total` 都 ≤ 0(字段缺失就当"不知道",不冷却),而**终点**只能取套餐周期末
  (月度余额那一档自己没有重置字段;连周期末也拿不到就不冷却)—— 11-04 之后可验证。
- **第三方同类插件**:`zhanghao3693/dsh-llm-router` 功能相近(按内容分流 + 回退链)。本插件是
  本机自建:0.8.0 起会按额度到期**排序**并跳过已耗尽的来源,但不做内容分流,不依赖也不需要它。

---

## 7. 测试

```bash
cd dsh-llm-auto                   # 本仓库根目录
node --test "test/*.test.mjs"     # 注意:Node 24 起 `node --test test/` 不再展开目录
```

| 文件 | 覆盖 |
| --- | --- |
| `test/ordering.test.mjs` | `lib/ordering.js`(0.8.0 新增的纯模块,**零真实网络**:额度快照 / 冷却表 / 时钟全部注入):`normalizeOrdering` 坏值只 warn 回落 auto;`timestampOf` 两种口径(毫秒数 + ISO 串)与坏值;`quotaSourceOf` 只认 own property(provider 名撞 `Object.prototype` 不算来源)、`monthlyResetOf`(CC 取 `currentPeriodEnd`、Go 取月度档 `resetsAt`,**刻意不看 5h/周窗口**)、`providerKind` 三态(订阅 / 按量兜底 / 未知,不可查的来源算"查不到"不算"按量")、`isExhausted`(`rate-limited` 与 CC 的布尔 `exceeded`;`percent: 100` 不算);`cooldownUntilOf`(没耗尽不冷却、多档打满取最晚、终点未知则不冷却);**三桶排序**(订阅按月度重置升序 → 未知按配置顺序 → 按量恒最后、桶内稳定、同 provider 多条各自独立、`entries` 原样带 `model` 与逐条开关、**不改入参**、坏输入不抛);**冷却**(provider 粒度、到点自动解除、时钟回退不冻死、全冷却兜底忽略、fail-open);**模式**(`manual` 严格配置顺序且不跳过、切回 auto 时冷却表立刻复活);`effectiveEntry` 坏终点不写成坏 ISO;`createOrderRefresh`(有效期跟着最早重置点走、6 小时上界、失败 10 分钟、去重与坏值);补丁轮新增:**CC 月度余额见底也算一档耗尽**(合成的 `credits` 档 ⇒ 冷却到套餐周期末;字段缺失 / 只给一个键都不算 ⇒ fail-open)、冷却表记下"是哪一档打满"(固定枚举、白名单外的 id 一律丢掉、更晚的终点连窗口一起换)、**坏时钟(`NaN`/±`Infinity`)下任一入口条都必须落在 `entries` 或 `skipped` 里**、`markFromQuota`(逐家判"真查到 `status: ok` 才算查过",查不到只占 10 分钟短闸门) |
| `test/routes.test.mjs` | `normalizeRoutes`(0.6.0 起**只保留打开的开关**:显式 `false` 与缺省同形、坏类型 warn 回落;空/非数组/自递归/重复/单条坏条目)、`describeChain`(`max` 与 `maxItems` 两个上限)、`createRing`(定长 + 取值函数容量);**链编辑器纯函数**(`toRouteDraft`/`toRouteConfig` 互逆与回环稳定、`sameRoutes`、`routeSignature` 指纹、`mutateRouteDraft` 的 append/update/remove/move/toggle 不改入参、最后一条不许删、越界与未知操作一律抛 `RouteConfigError`) |
| `test/compact.test.mjs` | **压缩点反算**:500000→625000、边界值表(12484 / 262143 / 262144 / 327680 / 884000 / 1000000…)、1~300 万抽样"阈值处处精确等于 T"(独立复刻一遍引擎的 `resolveCompactSpec` 来验算)、最小可用值 12484 的推导;`planDeclaredWindow` 的优先级/同时给出/非法回落/过小警告/null 与坏类型;`unwrapVolatile`;`describeWindowPlan` 四种文案;导出的 `Config`(**八键**中文 description、`compactWindow` 默认 500000 且 volatile、**`routes` 与 `ordering` 是 union + volatile 而 `retry`/`quota` 刻意不 volatile**、routes/retry/quota/ordering 坏值都不失败、ordering 的 `mode` 被收窄成字符串而缺省时是 undefined、真 schema 走一遍⇒解包后仍是 500000⇒625000) |
| `test/retry.test.mjs` | `normalizeRetry` 全部分支(缺省/布尔/对象/always/坏值回落)、`computeRetryDelay`(官方口径序列与 jitter 边界)、`describeRetryPolicy` |
| `test/adapter.test.mjs` | 0.5.2 新增 15 条 pi-ai 助手历史 + 工具结果结尾时,DeepSeek `keepThinking` 开/关的链级差异;首次成功、首条瞬时失败后先重试再回退、全部失败聚合(带尝试次数)、**已产出内容后失败不重试不回退**、暂存分片、空响应(可重试)、不可回退码、取消、退避中取消、上游抛异常、按路由取最高推理档位、窗口解析、`modelName` 取值函数;重试块另覆盖:第 N 次成功、白名单外不重试、`maxRetries: 0` 旧行为、`Retry-After` 界内优先/超界直切、退避序列 500/1000/2000/4000/8000;0.8.0 新增:按 `buildOrder` 给的实际顺序尝试(不是配置顺序)、冷却中的 provider 一次都不被尝试、`buildOrder` 缺席/坏返回/抛错一律退化成配置顺序、**每次"真的告吹"恰好回调一次 `onFailure`**(重试过程中不回调)、`QUOTA` 一次败就切并把 `{provider, failure}` 报给宿主、全部失败时逐条各回调一次、回调抛错不影响请求、已产出内容后失败与不可回退码都不算"告吹" |
| `test/replay.test.mjs` | `restoreReplaySources`:路由不同 ⇒ 改写且 `content` 逐字未变、路由相同/无 `replayState`/形状不对 ⇒ 原样放行不抛、非助手消息不动、多条各按自己的 replay 路由改写、冻结输入不被破坏;外加一条接线用例:经 `AutoAdapter.stream()` 的嵌套请求确实拿到了改写后的 source。2026-09-28 起同文件再覆盖**跨路由思考摘除**(两侧同步摘、只摘一侧 ⇒ 等长校验失败的反例、摘空 ⇒ 整条去掉、信封对不齐 ⇒ 丢 `replayState`、同路由零改动、anthropic 的 `responseModel` 重建规则)与**路由切换通知**(切换才追加、已有覆盖通知不重复、标签规则、只进嵌套请求),共 49 例;2026-10-01 起再覆盖**工具循环收尾**(三判据全中才追加、开关未开/末尾非工具结果/历史无断链消息各自不追加、坏形状不抛、与切换通知互斥、只在出站副本里);全套 **332 例**(0.9.0 面板合段实测:332 pass / 0 fail;0.8.0 补丁轮是 331;补丁轮之前是 321 例;基线 0.7.0 为 **259 例** —— 设计档里记的 253 是当时的数,0.7.0 收尾后又补了 6 例;0.5.3 时 194 例、0.6.0 时 220 例) |
| `test/runtime-integration.test.mjs` | 用**真实** `LlmRuntime` + **真实** `@deepseek-ai/dsh-llm/invariant` 跑端到端:目录校验、回退后的流语法零违规、**重试后成功的流语法零违规**、`maxRetries: 0` 旧行为、聚合错误的终止分片、注销后路由立刻消失 |
| `test/endpoint.test.mjs` | `apply()` 的注册/拒绝注册分支(0.6.0 起**三个** exact 端点、`configure({auto:false})`、settings 缺席时也照常)、`provider: auto` 跳过、HTTP 端点响应、`retry` 默认值/关闭/坏值回落;`compactWindow` 的映射/宿主形态/与 `contextWindow` 同时给出/非法回落/过小警告、**volatile 引用改值后不重启即生效**(name / compactWindow / logLimit)、端点复核字段;0.6.0 新增:`routes` 引用被原地改写 ⇒ 下一次请求走新链、`listModels()` 描述跟着变、改链后窗口缓存立刻失效、`chain` 携带 `options`、`/catalog` 的白名单字段与逐 provider 隔离失败;0.7.0 新增:`quota` 的四类形状(pending / 两源 ok / 不可查且**一个数字都不给** / 查询整体失败仍 200 且链与记录一字不变)、**响应里绝不出现凭据值**、请求带浏览器 UA、`user` 只在确有 profile 覆盖时出现(空覆盖 / 只覆盖 compactWindow / 坏形状三种"不出现"也都钉住);0.8.0 新增:`ordering` 的三部分形状与"`chain` 仍是配置顺序"、`effective` 是可用的路由形状(带 `model` 与逐条开关)、`ordering` 配置坏值只 warn 且端点仍 200、**volatile 引用原地改写 ⇒ 模式免重启生效**、断网时全落未知档且不冷却(cooldown 为空)、一次真的 `QUOTA` 告吹 ⇒ 冷却表出现该 provider(**带 `windows` 固定枚举**)、冷却中的条目仍出现在 `effective` 投影里(带 `cooling`,去掉它才是真正会走的)、`manual` 下 `cooldown` 恒空而切回 auto 立刻复原;补丁轮新增:补查的**触发点③(headless:一次 `/routes` 都不读)** 也按闸门走 —— 没过期零请求、过期恰好一轮,以及**闸门长度**(失败只占 10 分钟,查到 `ok` 才占 6 小时上界)、**CC 月度余额见底**那一档走完整条链(补查 ⇒ `cooldown[].windows = ['credits']` ⇒ 投影里带 `cooling`,终点 = 套餐 `currentPeriodEnd`) |
| `test/quota.test.mjs` | `lib/quota.js`(0.7.0 新增的纯模块,**零真实网络**:fetch / 凭据 / 时钟全注入):`normalizeQuota` 的坏值回落与两种键名写法、`sumCredits`、`classifyHttpError`(**403+1010 是 `blocked` 而不是 `auth`**)、`unavailableSource` 的键白名单;CC 成功形状(余额=三档之和、窗口原样、套餐来自次要接口、次要接口失败只让 plan 为 null)、UA 被拦 / 401 / 500 / 坏 JSON / 超时(AbortController)/ 网络错误各自的 reason;Go 三档原样透传(**`rate-limited` 不被折算**)、Go 401 与"月度已耗尽"区分、坏形状;TTL 命中不打上游、并发去重、**失败也占 TTL**、`touch()` 永不 reject、非法引用名 ⇒ `bad-ref`;0.8.0 新增 **`forceRefresh`**(绕过 TTL 只刷指定来源:连打只多一轮、别家快照原样保留、单飞去重、失败只把该家写成 unavailable 且 Promise 永不 reject、不认识的 provider / 空清单 / `enabled: false` 都是安全空操作) |
| `test/calls.test.mjs` | `groupCalls`:坏输入、按 `call` 分组、同 attempt 合并(`tries`/最终失败/耗时求和/`switchedTo`)、三种 `outcome`、`order` 与 `maxCalls`、desc 按**请求结束**排序、没有 `call` 的旧记录降级分组 |
| `test/client.test.mjs` | 浏览器半侧的纯函数(桩 `window.__ModuleLoader__` 后手动调 `factory(require)`):模块契约、`fill`/`tr`(对 t 的插值实现不敏感)、`retrySummary`、`formatClock`/`formatDuration`、结局→状态点/标签;0.6.0 新增:`splitLabel` 按**第一个**斜杠拆、端点两种 chain 形状都能还原、草稿→配置的收敛口径与服务端逐字一致、`sameChain` 的三种改动、搜索与分组过滤、**样式纪律**(类名必须 `la-` 前缀、颜色只走 `--dsw-*` token、不出现外部 URL)、**字典完整性不变量**(源码里用到的每个 `t("…")` 键中英两份都必须有);0.7.0 新增:`formatMoney` / `formatResetAt`(**同时吃毫秒数与 ISO 串**)/ `formatQuota`(CC 与 Go 各一行、`rate-limited` 显示"已耗尽"而不是 0%、不可查只给原因、旧宿主/关掉/无来源时整段不画)、`canResetChain`(只有 `user.routes` 是非空数组才成立)与 `resetChainOps` 的 op 形状;0.8.0 新增:`formatOrdering`(旧宿主没这个键 ⇒ 整段不画、`auto` 逐条渲染且冷却中带「冷却中」+ 恢复时刻、未知档标「额度查不到,按配置顺序」、`manual` 只给一行说明不渲染 effective、全冷却兜底给一句提示、坏形状不抛)与 `orderingModeOps` 的 op 形状;补丁轮新增:冷却行说清**是哪一档**(`monthly`→「月度已耗尽,10-24 00:00 恢复」等六种固定枚举 id,含 `credits`→「余额已耗尽」;认不出的 id 退回中性的「额度已耗尽」,老宿主没有这个键就只写解除时刻);0.9.0 新增:`chainSectionPlan`(auto ⇒ 主视图给生效顺序、配置链折叠、提示语换成自动那句;manual ⇒ 链就是主视图、不画生效顺序;拿不到 `ordering` ⇒ 退回手动形态)。**不覆盖渲染** —— 那部分靠真机(见 §7 末尾) |

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
| 选择器里没有 `Auto` 分组 | 插件没装进 `node_modules`(只改了 `plugins\`)、或宿主没重启、或包名不在 `dsh.profile.bundles` 里(用 `dshpm sync --check --profile desktop` 复查,`--dry-run` 可预演) |
| 有分组但选 `auto` 就报 `NO_ADAPTER` | 宿主还在跑旧代码,或包层那行被 profile 层的覆写行遮蔽/停用了 |
| 每次第一条必失败 | `routes[0]` 那条路由本机不可用(例如 `deepseek-official` 无凭据);`/api/llm-auto/routes` 会直接告诉你 code |
| 一条路由要试 6 次才切/切得慢 | 重试默认开启(每路由 5 次 + 退避累计约 15.5s);这是 v0.2.0 起的预期行为,想关:`retry.maxRetries: 0` |
| 期望"失败立即切"但它等了 | 失败码在瞬时白名单(RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/EMPTY_RESPONSE);不在白名单的码(NO_ADAPTER/UNKNOWN_MODEL/MISSING_CREDENTIAL…)本来就是一次败就切 |
| 改了源码没反应 | 忘了同步两份:本机 `plugins\` 与 `node_modules\` 对应文件为硬链接,必须原地写入并核 `fsutil hardlink list`(见 §4 第 1 条) |
| 压缩点不在 `compactWindow` 上 | 先看挂载日志那行"压缩点 X → 声明窗口 Y(假设 …)";X 对不上说明 `compactWindow` 非法/被回落(有 warn),Y 算得出而压缩仍不按 Y 走 ⇒ 多半是有人改了 `compaction-basic` 的 `thresholdRatio`/`headroomTokens`(见 §6);`/api/llm-auto/routes` 的 `compactWindow`/`declaredContextWindow` 用来复核 |
| 日志出现 `TargetPressureConfigError`(`retainTokens ... must be less than threshold tokens`) | `compactWindow` 太小(< 12484,挂载时已有 warn)或旧键 `contextWindow` ≤ 65536;把 `compactWindow` 调到 ≥ 12484 即可 |
| 设置了 `contextWindow` 但窗口没变 | 预设里 `compactWindow` 已有值(默认 500000)⇒ 按优先级以 `compactWindow` 为准,挂载日志有一条 warn 点名两者;要用旧键就先把 `compactWindow` 从配置里删掉 |
| 插件页看不到本插件的配置表单 | 本包 0.4.0 起自带浏览器半侧、注册进 `plugins.bundle.config`(键 = 包名 `dsh-llm-auto`,渲染在卡片描述与行之间)。没看到先分清两种原因:①宿主还在跑 0.4.0 之前的代码 —— 半侧新增后**必须重启一次 dsh**(见 §1),HMR 不会重新扫描(`dsh-client-modules` 把"本包不是客户端包"的否定结论按 specifier 缓存在 `pkgMeta`,其 `lib/index.js:510/703`);②只是刚改过 `lib/client.js` —— 这条 HMR 路径实测不生效,同样要重启(见 §4 第 2 条)。另:本插件**故意不再**注册 `plugins.row.config`,所以行 `llm-auto` 上没有「配置」控件是正常的;`routes`/`retry` 本来就没有表单,故意留在**包内** `cordis.patch.yml` 里 |
| 插件页看不到「回退链」面板 / 上面写着"读取失败" | 面板与 compactWindow 表单是同一个客户端半侧(0.5.0 新增、0.6.0 变成可编辑 ⇒ 改版后同样要重启一次 dsh 才被收录);若是"读取失败:…",先用 `curl http://127.0.0.1:19387/api/llm-auto/routes` 复核端点本身 —— 插件没加载、被停机或 bind 到非回环地址时就是这个文案 |
| 「最近请求」是空的 | 路由日志是进程内内存(重启清零,见 §6);也可能还没有请求走过 `auto`:模型选择器选一次 `Auto` 再发一条消息 |
| 「添加模型」打开的列表里没有某个 provider | 该 provider 的目录读取失败(选择器顶部会点名是哪几个)—— 用 `curl http://127.0.0.1:19387/api/llm-auto/catalog` 看 `failures`;也可能是它压根没在 profile 里配 |
| 链上某一行标着「不在当前目录」 | 该 `provider/model` 现在不在 live 目录里(改过 profile、provider 被摘、或目录读取失败)。照样可拖可删可保存;真跑到那一条会以 `NO_ADAPTER`/`UNKNOWN_MODEL` 一次败就切 |
| 点保存报"保存被拒:设置可能已被别处改动" | 乐观并发控制:你读到的 revision 与宿主当前的不一致(另一个标签页/手改 YAML 之后没刷新)。点「刷新」重新读取再改一次即可 |
| 保存成功但链没变 | 先看 `curl http://127.0.0.1:19387/api/llm-auto/routes` 的 `chain`(现场值)。若 `chain` 已变而请求仍走旧链 ⇒ 宿主还在跑 0.6.0 之前的代码(没有懒读 volatile 引用),重启 dsh |
| 改了包内 `cordis.patch.yml` 的 `ordering` 但模式没变 | **profile 遮蔽**(0.6.0 的同一个坑):面板上保存过一次链之后,整块 `config` 被写进 profile 的 `- id: llm-auto` 行 ⇒ 包内那份默认值不再生效。改 profile 那一行,或直接在面板上切。⚠ 包内 patch 也不在 dsh-hmr 的监视范围里(见 §4 第 2 条),改完要有一次触发才被读入 |
| 想让链回到包内 `cordis.patch.yml` 那一条 | 面板上点「恢复包内默认链」(= `unset` 掉 profile 里对 `routes` 的覆盖);也可以手编 profile 的 `cordis.patch.yml` 删掉那一行里的 `routes:`。⚠ 这个按钮**只在 profile 层确实覆盖了 `routes` 时才出现**(判据是 `/routes` 响应的 `user.routes`)—— 看不到它说明当前用的是包内那条链,不需要恢复 |
| 面板上「额度」那一段显示「不可查」 | `/api/llm-auto/routes` 的 `quota.sources[].reason` 直接给出原因:`no-credential`(凭据没配:在「模型」页填 `CMD_API_KEY` / `OPENCODE_API_KEY`,或设同名环境变量后重启)、`blocked`(Command Code 的 403 + `error_code 1010`:Cloudflare 按浏览器签名拦了,**不是 key 无效** —— 实测 node 默认 UA 反而能过,只有 `Python-urllib` 之类命中黑名单;可改 `quota.userAgent` 或稍后再试)、`auth`(401/403,凭据真被拒)、`timeout` / `network` / `parse`(本机网络或上游形状变了)。**额度查不到不影响发消息** —— 它只是观测 |
| 面板上「额度」整段不显示 | 三种都正常:宿主还是 0.7.0 之前的代码(`/routes` 里没有 `quota` 键)、配置里 `quota.enabled: false`、或当前链上没有任何本插件认识的 provider(只认 `commandcode` 与 `opencode-go`) |
| 「生效顺序」那一段写着「冷却中」 | 不是故障:该来源报过额度耗尽(`QUOTA`),插件补查额度接口确认有档位打满(行上会写明是哪一档:「月度已耗尽」/「余额已耗尽」/「周已耗尽」…),于是把它冷却到那一档的重置时刻,期间不再尝试。这与「额度」段的「已耗尽」是两件事(一个是行为、一个是观测),两者可能同时出现 |
| 顺序和我排的不一样 | 0.8.0 起默认就是**自动排序**:有月度重置时刻的订阅按「越早重置越靠前」排、按量兜底恒最后。想完全按你排的顺序:`ordering.mode: manual`,或点面板最上面「排序方式」那个开关。`chain` 字段(端点)永远是配置顺序,对不上的看 `ordering.effective` |
| 重启后第一条消息又撞了一次已耗尽的来源 | 设计行为:冷却表是进程内 Map、不落盘,重启即空,而额度可能还没查过 ⇒ 第一条消息白撞一次后才冷却。`QUOTA` 不在重试白名单里,所以代价只是一次失败往返;第二条消息起就不再撞 |
| 冷却了一整轮但其实那家能用 | 先看 `/api/llm-auto/routes` 的 `ordering.cooldown` 与 `quota.sources[]`:补查确认的是上游的窗口状态。**fail-open 已经挡住"查不到就冷却"**(断网/超时/形状不认 ⇒ 不冷却、只在日志里留一条 warn);若确实误判,把 `ordering.mode` 切 `manual` 即立刻恢复按配置顺序不跳过 |
| 面板最上面那个模式开关点了没反应 | 两种都正常:只读部署(`writable: false` 时按钮置灰),或写入被拒(revision 冲突,面板会给一行「切换没被接受,已保留原值」,点「刷新」再来一次) |
| OpenCode Go 那行写着「已耗尽」 | 不是故障:上游 `status: "rate-limited"` 表示该档窗口**已经用满**(服务端把 `percent` 硬编码成 100),右侧是这一档的重置时间。Go 侧看不到金额 —— 它的接口只有百分比窗口;想继续用可以在控制台启用 "Use balance" 或等重置 |
| 经 `auto` 的历史思考跑到正文里、思考通道是空的 | 插件是修复前的版本(宿主还在跑旧代码);修复见 §3「历史回放」与「跨路由历史思考摘除」,改完两份并重启后消失。若已确认代码是修好的、这个现象还在 ⇒ 多半是**宿主没重启**(loader 按 URL 缓存已 import 的模块) |
| 日志出现 `llm-pi-ai: unusable replay state on assistant history` | 那条历史消息的 replay 状态与本次路由不匹配(例如跨模型回放),pi-ai 主动降级成 provider-neutral 内容;这是上游既有行为,不是本插件的错误。**0.5.1 起还有一条专属成因**:只摘了 `content` 一侧的思考而没有同步摘 `replayState.blocks` ⇒ `replayedAssistant` 的等长校验不过 ⇒ 整条降级(§3「跨路由历史思考摘除」的"只摘一侧 = 缺陷原样复发") |
| 跨路由的历史思考"不见了" | 默认(`keepThinking` 缺省/false)是**有意**的:跨路由的思考块被同位摘掉,不再被 pi-ai 摊进正文(见 §3)。想复核是不是真发生了:抓一次出站请求,跨路由臂的历史助手消息应当**既没有** `reasoning_content`、`content` 里也**不再**混着思考文本(与 §3 那对实测数字同口径) |
| DeepSeek 目标路由报 `content[].thinking` 必须回传 | 检查目标 `routes[i]` 是否显式设 `keepThinking: true`;该选项只对该条目标路由生效,默认仍照摘 |
| 想知道静默切换有没有通知模型 | 通知只加在**出站**请求里、不落盘,所以会话记录里看不到它属正常。抓包复核:跨路由臂的 `messages` 末尾多一条 `role: "user"`、正文是 `[model changed: assistant turns above this point were generated by …]`;同路由臂**不该**有这条(§3「路由切换通知」) |
| 上下文窗口明显偏小 | `contextWindow` 没配且首选路由解析不到窗口,回落到了保守值 65536;显式配一个即可 |

## 许可

[MIT License](LICENSE) —— Copyright (c) 2026 liuyun847。可自由使用、修改、分发（含商用），
保留版权声明与许可全文即可；软件按"原样"提供，不附任何担保。
