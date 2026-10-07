/**
 * dsh-llm-auto v0.8.0
 *
 * 给 DSH 加一个"合并多个模型订阅"的 `auto` 模型:模型选择器里多出一个 `Auto` 分组,
 * 组内一条 `auto`。选它以后,请求按 config.routes 的**顺序**依次尝试多条
 * 「provider + model」,某条**先按官方同款策略原地重试**(瞬时错误),重试耗尽
 * 才静默切下一条 —— 对上层(agent loop / 会话日志 / 压缩链路)它就是一个普通模型。
 *
 * ── 它到底怎么工作(一段话) ────────────────────────────────────────────────
 * 本插件用官方扩展点 `ctx.llm.registerAdapter(['auto'], adapter)` 注册一条**新的 provider 路由**。
 * 之所以不能往已有 provider 里追加模型:模型目录由
 * `dsh-api-session-controller/lib/types/catalog.js` 的 `buildModelCatalog()` 遍历
 * `ctx.llm.listProviders()` × `listModels()` 生成,**provider 是唯一的挂载单位**。
 * 于是 adapter.stream() 里对候选路由发起**嵌套调用** `ctx.llm.stream({...options, provider, model})`,
 * 把分片原样转交出去。嵌套调用是官方支持的形态(`LlmRuntime.stream` 的注释里写明
 * middleware / nested-call 的异常语义与适配器异常不同)。
 * 路由内重试的策略形状/默认值/校验全部复用 `@deepseek-ai/dsh-llm` 的 `resolveRetryPolicy`
 * (见 lib/retry.js):官方 `dsh-llm-retry` 挂在 agent loop 瀑布上,管不到嵌套调用,
 * 所以"某条路由原地重试"只能在本插件内做,但没必要自造一套策略。
 *
 * ── 生效条件(踩过) ────────────────────────────────────────────────────────
 * `file:` 依赖的 desktop profile 源目录与运行目录当前使用硬链接,修改包内文件必须原地写入。
 * 硬链接关系应逐文件核实:`fsutil hardlink list <路径>`必须同时列出
 * `~\.dsh\profiles\desktop\plugins\dsh-llm-auto\` 与
 * `~\.dsh\profiles\desktop\node_modules\dsh-llm-auto\` 下的对应路径;
 * 改动后再用 `fsutil file queryfileid` 核对两侧 FileId。禁止换文件式写入,否则会断开链接。
 * 改插件代码要重启 dsh —— loader 按 URL 缓存已 import 的模块。
 * 改 profile 的 `cordis.patch.yml`(patch 层)则保存即热加载,不需要重启。
 * 所以顺序是:先改代码(改完同步两份) → 改配置(可选) → 重启。
 * 本插件**是**组合包(包带 `dsh.bundle.patch`,包名在 `dsh.profile.bundles` 里),
 * 由 profile 的 bundles 装载 —— **不需要**再往 profile 的 `cordis.patch.yml` 贴 insert 行。
 *
 * ── 导出 `Config`(schemastery):0.2.x **有意不导出**,0.3.0 起改为导出 ────────
 * **为什么改**:插件配置只有成为"带 schemastery `Config` 的活动条目"才会进入宿主的设置服务 ——
 * `dsh-settings` 的 `SettingsForms.describe()` 只投影这类条目(schema 取自
 * `entry.fiber.runtime.Config`,见 dsh-settings `lib/index.js:413-452` 与 `:538-541`),
 * 并且只投影标了 `.volatile()` 的字段(`volatileForm()`,同文件 `:122-131`)。
 * 不导出 ⇒ 本插件的配置在设置服务里连一条描述符都没有,`compactWindow` 这类"值型"配置
 * 就只能改 `cordis.patch.yml`。
 *
 * ⚠ **导出的效果边界(别高估)**:这一步换来的是"配置条目 + schema + 可写路径"
 *   (`settings.describe()` 能看到它,`settings.mutate/replace` 能写它)。
 *   随包发布的 Web 客户端**还没有**"按 schema 自动生成表单"的页面 —— `dsh-settings` 的
 *   README 自己写着 `no shipped client does so yet`;插件页(Plugins)只渲染经 slot 注册的
 *   表单页(`dsh-client-ui-plugin-manager` 的 `plugins.item` / `plugins.bundle.config` /
 *   `plugins.row.config`)。所以**光导出 `Config` 不会长出任何表单**:可点的表单来自本包
 *   0.4.0 新增的浏览器 half(`lib/client.js`),它注册进 `plugins.bundle.config`(键 = 包名),
 *   把 `compactWindow` 渲染成插件页里该 bundle 卡片上的官方 SettingsForm
 *   (2026-09-25 从 `plugins.row.config` 的行二级页提到卡片上,见 README §2);
 *   宿主侧 schema 的作用是让 `settings.describe()` / `settings.mutate()` 这条远端通道
 *   能看到并写入这些字段。
 *
 * **代价(必须知道)**:schema 是**加载期**校验,校验失败 = **整行插件加载失败** ——
 * 不再是本插件那条"打一条 error 但不注册"的软失败。所以 schema 按"能松就松"写:
 *  · `routes` / `retry` 用 `z.any()`:形状校验继续留给 `normalizeRoutes()` / `normalizeRetry()`,
 *    坏值依旧是"单条 warn 跳过 / 整体 error 不注册",不会让整行加载失败;
 *  · 数值字段(含 `compactWindow`)用 `z.number()`,但**刻意不加 `.min()` / `.step()`**:
 *    设置页据此渲染数字输入框,而范围与整数性仍由插件自己判 —— 非法值 warn 后回落默认,
 *    而不是让宿主那一行起不来(唯一会硬失败的是"把字符串写进数字字段"这种类型错误);
 *  · 结构性键(`routes` / `retry`)不标 `.volatile()`:它们由 `apply()` 一次性消费,
 *    标了等于向设置页承诺"改了即时生效"(实际要等重新 apply)。
 *    ⇒ 代价:设置页表单里**只出现标了 `.volatile()` 的字段**(`volatileForm()`,
 *      dsh-settings `lib/index.js:122-131`;一个 volatile 字段都没有时整个条目被跳过),
 *      即 `name` / `contextWindow` / `compactWindow` / `logLimit`;
 *      `routes` 与 `retry` 仍按老办法改 `cordis.patch.yml`(那条路本来就支持热加载)。
 * ⚠ `.volatile()` 字段在插件里拿到的是 cosmokit 的 **Volatile 引用**而不是值本身
 *   (schemastery `src/index.ts:521-530` 的 `createVolatile()`),读之前必须
 *   `unwrapVolatile()`(见 lib/compact.js)—— 忘了解包会拿一个对象去做算术。
 *
 * 其余配置的校验口径不变:结构问题打 error 并**拒绝注册**(不抛,遵循本机既有约定 ——
 * 插件配置错误不该让宿主起不来);`retry` 块的校验复用官方 `resolveRetryPolicy`。
 *
 * ── 对外声明的上下文窗口:默认由"压缩点"反算 ────────────────────────────────
 * `config.compactWindow`(默认 500000)是**压缩点**;插件按 compaction-basic 的阈值算式
 * (`threshold = floor(min(cw × 0.8, cw − 65536))`)反算出该对外声明的窗口(默认 625000)。
 * 优先级 `compactWindow > contextWindow > 逐跳解析 > 65536`、假设与边界见 lib/compact.js 与
 * `planDeclaredWindow()`;老键 `contextWindow` 保留(显式声明窗口的逃生门),两者同时给出时
 * 以 `compactWindow` 为准,并打一条 warn 说明用了哪个、忽略了哪个。
 *
 * ── 回退链可视化(0.5.0 起) ──────────────────────────────────────────────
 * 两条出口,同一份数据:
 *  · 宿主侧:`GET /api/llm-auto/routes` 的响应除原来的平铺 `routes`,新增 `calls` ——
 *    按一次 `stream()` 调用分组(序号 `call` 由 adapter 写进每条记录)还原出的
 *    「一次请求依次经过哪几条路由、怎么失败的」(纯函数见 lib/calls.js);
 *  · 浏览器侧:`lib/client.js` 在插件页 bundle 卡片上把它渲染成只读面板(打开页面拉一次,
 *    可手动刷新),顺带显示当前生效的有序配置链 `chain` 与重试策略 `retry`。
 *    `limit` 只切**记录条数** ⇒ 分组后最旧一组可能被截断,这是有意的:面板看"最近发生了什么"。
 *
 * ── 边界(详见 README) ─────────────────────────────────────────────────────
 *  · 只"失败时切换":不记账、不按价格/能力挑路由,顺序完全由 config.routes 决定;
 *  · 瞬时错误先在**该路由内**重试(默认 5 次,官方同款退避),重试耗尽或错误码不在
 *    瞬时白名单才切下一条;
 *  · 已经向调用方交出内容之后的上游失败**不重试不回退**(避免半截回答 + 重新回答);
 *  · 历史回放:嵌套调用前把每条历史助手消息的 `source.provider/model` 改回它
 *    `replayState` 记录的真实路由(纯函数见 lib/replay.js)。不改写的话,`LlmRuntime.forAdapter`
 *    会因为"历史 provider 是 auto、本次适配器是 pi-ai"而剥掉 replay 状态,pi-ai 就把思考块
 *    摊平进正文、把 `reasoning_content` 填成空串(2026-09-24 字节级实测);
 *  · **跨路由的历史思考摘掉而不是摊成正文**(0.5.1 起):会话中途换过路由时 pi-ai 必然把历史
 *    思考降级成正文(判据是 provider+api+model 三者全等),模型会把内心独白学成正文格式;
 *    插件改为跨路由时把 `reasoning` 从 `content` 与 `replayState.blocks` **同步**摘掉
 *    (只摘一侧会命中上游等长校验 ⇒ 整条降级 ⇒ 缺陷原样复发)。代价是跨路由的思考不再可见 ——
 *    有意的取舍,详见 lib/replay.js 的模块注释与 README §3;
 *  · **路由切换通知**(0.5.1 起):真的发生静默切换时,在**出站**消息序列末尾追加一条与 DSH
 *    自带 `[model changed: …]` 逐字同款的用户角色通知,让模型知道"上面那些回合是别的模型
 *    生成的";只改出站负载、不写会话记录,历史里已有覆盖本次切换的通知时不再追加;
 *  · `routes` 里的 provider 不能写 `auto` 自己(自递归):挂载时 warn 并跳过该条;
 *  · 不改默认模型:用户不主动选 `auto` 时一切照旧(本插件不碰 settings 与默认模型行)。
 *
 * ── 回退链可视化 + 可编辑(0.5.0 只读 → 0.6.0 可写) ──────────────────────────
 * 两条出口,同一份数据:
 *  · 宿主侧:`GET /api/llm-auto/routes` 的响应除原来的平铺 `routes`,还有 `calls` ——
 *    按一次 `stream()` 调用分组(序号 `call` 由 adapter 写进每条记录)还原出的
 *    「一次请求依次经过哪几条路由、怎么失败的」(纯函数见 lib/calls.js);
 *  · 浏览器侧:`lib/client.js` 在插件页 bundle 卡片上把它渲染成面板(打开页面拉一次,
 *    可手动刷新),顺带显示当前生效的有序配置链 `chain` 与重试策略 `retry`。
 *    `limit` 只切**记录条数** ⇒ 分组后最旧一组可能被截断,这是有意的:面板看"最近发生了什么"。
 *
 * 0.6.0 起 `routes` 变成 schemastery 的 `.volatile()` 字段,于是链可以在插件页里改:
 *  · **写路径**是官方的设置服务(`configForms` → `settings.mutate` → `dsh-config-editor`),
 *    落在 profile 的 `cordis.patch.yml` 里那一行 `id: llm-auto` 的 `config.routes` 上;
 *    编辑器用 yaml 文档式写入,只替换该行的 config 节点,其余注释与 `!!js` 标签原样保留;
 *  · **免重启生效**靠"懒读引用":`config.routes` 是 cosmokit 的 volatile 引用,加载器重建配置时
 *    用 `updateVolatile()` **原地更新同一个引用** ⇒ 本文件与 adapter 都只持有引用、每次要用时
 *    现取 (`readRoutes()`),下一次请求就是新链;正在跑的那一次不受影响(adapter 在 `stream()`
 *    入口取一次快照);
 *  · **写什么形状**:客户端提交的链经 `normalizeRoutes()` 再收敛一次(逐条开关"打开才写",
 *    关掉即省略该键),与手写 YAML 逐字同形 —— 见 lib/routes.js 的 `toRouteConfig()`;
 *  · **目录从哪来**:`GET /api/llm-auto/catalog`(0.6.0 新增)把 `ctx.llm.listProviders()` ×
 *    `listModels()` 投影成"分组 + 模型名",字段是**白名单**(provider id/name、model id/name、
 *    可选 description),凭据引用(`apiKeyEnv` 之类)一律不外传 —— 官方 `buildModelCatalog()`
 *    的口径,但不引入 typert 依赖、也不回传 `reasoning` 等本面板用不到的字段。
 *  · `retry` 仍不是 volatile:它是 `apply()` 一次性消费的结构性配置,改它还是改文件。
 *
 * ── 订阅额度可见(0.7.0 起,只读) ─────────────────────────────────────────
 * `/routes` 的响应多一个顶层 `quota`:按当前链上出现的 provider,给出两家的额度快照 ——
 * Command Code 的美元余额 + 5 小时/周两档窗口,OpenCode Go 的 5 小时/周/月三档百分比。
 * 三条纪律:① **只读观测** —— 不改链、不跳过、不记账,查询失败只体现在 `quota` 字段里,
 * 端点状态码恒 200;② **查不到就说查不到** —— unavailable 的来源一个数字都不给(0 在两家
 * 都是合法真值,拿它顶替会把 Go 的"已耗尽"显示成"0%");③ 不外传凭据值,只回引用名与来源层。
 * 实现见 lib/quota.js(纯模块,注入 fetch / 凭据 / 时钟,便于单测)。
 *
 * ── profile 覆盖链可见(0.7.0 起) ──────────────────────────────────────────
 * `/routes` 的响应在**确有 profile 覆盖**时多一个 `user: { routes }` —— 插件页的
 * 「恢复包内默认链」按钮据此显示(见 {@link computeUserRoutes})。只有这一个键:
 * 端点在回环上,但"不外传整份配置"是同一套纪律。
 */
import z from '@deepseek-ai/schemastery'
import { AutoAdapter, createContextWindowResolver } from './adapter.js'
import { AUTO_MODEL, AUTO_PROVIDER, DEFAULT_CONTEXT_WINDOW, DEFAULT_LOG_LIMIT, DEFAULT_MODEL_NAME, RouteConfigError, describeChain, normalizeRoutes } from './routes.js'
import { groupCalls } from './calls.js'
import { DEFAULT_COMPACT_WINDOW, describeWindowPlan, planDeclaredWindow, unwrapVolatile } from './compact.js'
import { describeRetryPolicy, normalizeRetry } from './retry.js'
import { createQuotaTracker, normalizeQuota } from './quota.js'
import { ORDERING_MODE, buildOrder, cooldownUntilOf, createCooldown, createOrderRefresh, exhaustedWindowIds, normalizeOrdering, quotaSourceOf } from './ordering.js'

/** Cordis 插件名,供加载器诊断与 cordis.patch.yml insert 使用。 */
export const name = 'llm-auto'
/** 只需要 llm 服务;webServer(HTTP 端点)走可选注入,headless 等 profile 下也能挂载。 */
export const inject = ['llm']

/**
 * 配置 schema(0.3.0 起导出,见文件头注释里的取舍说明)。
 *
 * 三条纪律:
 *  1. **能松就松** —— `routes` / `retry` 是 `z.any()`:形状校验留给 `normalizeRoutes()` /
 *     `normalizeRetry()`,坏值只 warn/error,绝不让整行插件加载失败;
 *  2. 数值字段是 `z.number()`(设置页要据此渲染数字输入框)但**不加 min/step**:
 *     范围与整数性仍由插件自己判并 warn 回落;
 *  3. 只有"插件会**重新读**的字段"才标 `.volatile()`(`name` / `contextWindow` /
 *     `compactWindow` / `logLimit` / `routes` / `ordering`)—— 设置页的表单只显示这些字段,
 *     标错等于承诺了做不到的"即时生效"。结构性键(`retry`)仍走 `cordis.patch.yml`。
 *
 * `ordering`(0.8.0 新增)与 `quota`(0.7.0)的**分工**:`ordering` 管"路由行为"
 * (怎么排序、跳过谁),所以必须 volatile —— 面板上那个「自动排序」开关要免重启生效;
 * `quota` 管"面板上看得见的只读观测",刻意**不** volatile。
 *
 * `description` 是设置页上唯一的中文说明来源,所以每个键都要写。
 */
export const Config = z.object({
  routes: z.union([z.array(z.object({
    provider: z.string().description('provider 路由名(真实 id,例如 commandcode / opencode-go / deepseek-official;不能写 auto 自己)'),
    model: z.string().description('模型 id,**要写全**:provider 声明的那个 id,例如 deepseek-v4.1-flash 或 deepseek/deepseek-v4.1-flash(别省前缀)'),
    keepThinking: z.boolean().description('可选:该路由是否保留工具循环里的思考块(缺省 false = 摘掉;对 DeepSeek 原生 thinking 路由要开)'),
    breakToolLoop: z.boolean().description('可选:该路由在"历史里带工具调用却没有思考块、且出站以工具结果结尾"时,补一条用户提示把请求收尾(缺省 false)'),
  })), z.any()])
    .description('有序回退链,**第一项即首选**。0.6.0 起可在插件页的「回退链」面板里直接编辑(拖拽排序、从模型目录里选),写入 profile 的 cordis.patch.yml 并免重启生效;手写 YAML 的路子照旧可用,profile 层按 id 覆写的优先级更高。坏条目的处理口径不变:由 normalizeRoutes() 逐条 warn 后跳过,整条链不可用时才拒绝注册')
    // ⚠ 这里**必须**是 union,不能直接写成 `z.array(...).volatile()`:
    //   · 写路径(设置服务)要求目标是 .volatile() 字段,而且 schemastery 的
    //     `validateVolatileSchema` **禁止 volatile 之下再套 voluntary**(union 的成员会被逐个遍历);
    //   · 而本插件的一条硬约定是"routes 坏形状只 warn,不让整行加载失败"(schema 是加载期校验,
    //     类型不符 = 整行插件不注册)。z.array() 单独用会把 `routes: 'not-an-array'` 变成加载失败。
    //   两个成员各管一头:第一个给出"数组 + 正确字段类型"的形状(编辑器写进来的值走这条),
    //   第二个是兜底(任何其它形状原样放行,继续交给 normalizeRoutes() 逐条判)。
    //   顺序有意义:union 从头试,形状对就收窄、对不上才落到 z.any()。
    .volatile(),
  name: z.string().description('模型显示名(模型选择器里的分组名恒为 Auto)。改完即时生效,不需要重启').volatile(),
  contextWindow: z.number().description('[旧键] 直接声明对外宣称的上下文窗口(正整数)。与 compactWindow 同时给出时以 compactWindow 为准并被忽略;≤ 65536 时压缩引擎的 pressure budget 会 ≤ 0').volatile(),
  compactWindow: z.number().default(DEFAULT_COMPACT_WINDOW).description(`让自动压缩发生在这个 token 数附近(正整数,默认 ${DEFAULT_COMPACT_WINDOW})。插件据此反算出对外宣称的上下文窗口(默认 500000 ⇒ 625000)`).volatile(),
  logLimit: z.number().description(`路由日志环形缓冲条数(仅内存,重启即清空;默认 ${DEFAULT_LOG_LIMIT})`).volatile(),
  retry: z.any().description('路由内重试策略(与官方 retryPolicy 同形状:maxRetries / retryableCodes / backoff)。刻意用宽松类型:坏值由插件自己 warn 后回落官方默认'),
  // ⚠ 额度查询**刻意不标** `.volatile()`:它是"只读观测",不该出现在设置表单里,也不该被任何
  //   写入路径改到(标了等于给设置页一个可写路径,还可能被链编辑器的整块 config 重写牵着走)。
  //   形状校验留给 normalizeQuota(),坏值只 warn 不拒绝加载。
  quota: z.any().description('订阅额度查询(只读观测,不参与路由选择)。形状:{ enabled, ttlMs, timeoutMs, userAgent, commandcode:{ apiKeyEnv }, opencodeGo:{ apiKeyEnv } };全部可省,坏值只 warn 并回落默认。刻意用宽松类型:坏值不该让整行插件加载失败'),
  // ⚠ `ordering` **必须** volatile:插件页那个「自动排序 / 手动」开关写的就是它,而面板的
  //   承诺是"改完即时生效、不用重启"。照 0.6.0 的教训,形状用 union 兜底:第一个成员给出
  //   "对象 + mode 是字符串"的形状(编辑器写进来的值走这条),第二个 `z.any()` 放行其它形状
  //   ⇒ 坏值只由 normalizeOrdering() warn 并回落 auto,**绝不让整行插件加载失败**
  //   (schema 是加载期校验,类型不符 = 整行不注册)。
  ordering: z.union([z.object({
    mode: z.string().description('auto(默认)= 按订阅月度重置时刻自动排序,并把额度耗尽的 provider 冷却到重置时刻;manual = 完全按 routes 顺序、只失败时切换(0.7.0 的行为)。其余值只 warn 并回落 auto'),
  }), z.any()])
    .description('额度感知的路由行为(0.8.0 起)。mode: auto(默认)| manual。auto 下:① 实际尝试顺序按"有月度重置时刻的订阅(越早重置越靠前) → 重置时刻未知的(按配置顺序) → 按量兜底(永远最后)"三桶排;② 某跳因窗口额度耗尽被拒(错误码 QUOTA)时,补查该来源的额度接口,确认后把该 provider 冷却到对应窗口的重置时刻。改完即时生效(volatile),面板上那个开关写的就是这个键')
    .volatile(),
})

/** `GET /api/llm-auto/routes` 的路径(与 `dsh-client-connection` 的 `/api` 前缀路由同级)。 */
export const ROUTES_PATH = '/api/llm-auto/routes'
/** `GET /api/llm-auto/catalog` 的路径:模型选择器(链编辑器)用的"有哪些 provider / 模型"。 */
export const CATALOG_PATH = '/api/llm-auto/catalog'
/**
 * `/api/llm-auto/diag` 的路径:客户端半侧的自诊断通道(`GET` 读、`POST` 报一条)。
 *
 * 桌面端看不到页面控制台,页面侧一抛错就只剩"什么都不显示"。这条通道把错误原文收进宿主内存,
 * 好让排查有个确切起点(用法见 README §5)。
 */
export const DIAG_PATH = '/api/llm-auto/diag'
/** 诊断缓冲容量(条):只留最近的,免得页面反复报错把内存撑起来。 */
export const DIAG_LIMIT = 50
/** 单条诊断报告的字节上限(超出即截断):这是写端点,不能让页面塞任意大的东西进来。 */
export const DIAG_MAX_BYTES = 16384

/**
 * 内存环形缓冲:只留最近 N 条路由决策,不落盘(重启即清空,不适合当审计账本)。
 * @param capacity - 容量(条);也可以传 `() => number`(宿主里 `config.logLimit` 是 volatile
 *   引用,传取值函数才能让设置页改完即时生效)。
 * @returns `{ push, list, size, capacity }`;`capacity` 是读时求值的 getter。
 */
export function createRing(capacity) {
  const items = []
  const capacityOf = () => (typeof capacity === 'function' ? capacity() : capacity)
  return {
    get capacity() {
      return capacityOf()
    },
    push(entry) {
      items.push(entry)
      const cap = capacityOf()
      if (items.length > cap) items.splice(0, items.length - cap)
    },
    /**
     * @param limit - 最多返回多少条(取最近的);非正整数表示不限(以容量为上限)。
     * @returns 最近的若干条,时间正序。
     */
    list(limit) {
      const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, items.length) : items.length
      return items.slice(items.length - n)
    },
    get size() {
      return items.length
    },
  }
}

/**
 * 诊断报告的内存环形缓冲(容量 {@link DIAG_LIMIT},不落盘)。
 * @param limit - 容量(条)。
 * @returns `{ push, list }`。
 */
export function createDiagLog(limit = DIAG_LIMIT) {
  const items = []
  return {
    push(entry) {
      items.push(entry)
      if (items.length > limit) items.splice(0, items.length - limit)
    },
    list() {
      return items.slice()
    },
  }
}

/**
 * 读一个 HTTP 请求体(带上限):诊断端点唯一的写入口。
 *
 * 只做"限长 + 解码",不解析 —— 页面侧报的就是一段 JSON 文本,解析失败也要留下原文。
 * @param req - node 请求对象。
 * @param maxBytes - 上限(字节);超出即停止累积并标记截断。
 * @returns Promise<{ text, truncated }>。
 */
export function readRequestBody(req, maxBytes = DIAG_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let truncated = false
    req.on('data', (chunk) => {
      if (truncated) return
      size += chunk.length
      if (size > maxBytes) {
        truncated = true
        chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (size - maxBytes))))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), truncated }))
    req.on('error', reject)
  })
}

/** 只读 JSON 响应(自己拥有整个响应生命周期)。 */
function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * 本部署是否接受配置写入(插件页面板据此决定"能改"还是"退回只读")。
 *
 * 依据是宿主设置服务的**各表单可写性**:`configForms` 底下每张官方表单都带 `writable`
 * (非回环页面会被置为 false —— "Non-loopback pages get no durable settings",见
 * dsh-client-ui-settings 的 README)。这里只读一次快照,不做任何写入尝试。
 *
 * 拿不到设置服务时返回 false:那种情况下链确实只能看不能改,如实报比假装可写更安全。
 * @param ctx - 宿主上下文。
 * @returns 可写为 true。
 */
/**
 * 读一次设置描述符表(失败/拿不到都给 undefined)。
 *
 * `ctx.get` 是 cordis Context 的可选查询口(1.x 起是可选方法)—— 老版本/替身 ctx 可能没有,
 * 所以先确认它存在再问;`describe()` 抛错也只是"拿不到",不往上抛。
 * @param ctx - 宿主上下文。
 * @returns 描述符数组,或 undefined。
 */
function readSettingsForms(ctx) {
  if (typeof ctx.get !== 'function') return undefined
  const settings = ctx.get('settings')
  if (settings === undefined || settings === null || typeof settings.describe !== 'function') return undefined
  try {
    const forms = settings.describe()
    return Array.isArray(forms) ? forms : undefined
  } catch {
    return undefined
  }
}

/**
 * 描述符表 → 本部署是否接受配置写入(插件页面板据此决定"能改"还是"退回只读")。
 *
 * 依据是宿主设置服务的**各表单可写性**:`configForms` 底下每张官方表单都带 `writable`
 * (非回环页面会被置为 false —— "Non-loopback pages get no durable settings",见
 * dsh-client-ui-settings 的 README)。拿不到描述符时返回 false:那种情况下链确实只能看不能改,
 * 如实报比假装可写更安全。
 * @param forms - {@link readSettingsForms} 的结果。
 * @returns 可写为 true。
 */
function writableOfForms(forms) {
  if (forms === undefined || forms.length === 0) return false
  return forms.every((row) => row.writable !== false)
}

/**
 * 描述符表 → profile 覆盖层里那一行 `id: llm-auto` 的 `config.routes`(没有覆盖时 undefined)。
 * @param forms - {@link readSettingsForms} 的结果。
 * @returns 配置形状的覆盖链,或 undefined。
 */
function userRoutesOfForms(forms) {
  if (forms === undefined) return undefined
  const row = forms.find((item) => item !== null && typeof item === 'object' && item.ns === name)
  const user = row === undefined ? undefined : row.user
  if (user === null || typeof user !== 'object' || !Object.prototype.hasOwnProperty.call(user, 'routes')) return undefined
  try {
    return normalizeRoutes(user.routes).routes
  } catch {
    return undefined
  }
}

/**
 * 一次读取,同时给出"能不能写"与"profile 覆盖链"。
 *
 * 两者都从同一份设置描述符来:`/routes` 的 handler 用这个口子,免得一次请求读两遍
 * `settings.describe()`(也就不会看到两个互相矛盾的快照)。
 * @param ctx - 宿主上下文。
 * @returns `{ writable, userRoutes }`。
 */
export function readSettingsView(ctx) {
  const forms = readSettingsForms(ctx)
  return { writable: writableOfForms(forms), userRoutes: userRoutesOfForms(forms) }
}

/**
 * 本部署是否接受配置写入(单读口;handler 走 {@link readSettingsView} 以免重复 describe)。
 * @param ctx - 宿主上下文。
 * @returns 可写为 true。
 */
export function computeWritable(ctx) {
  return writableOfForms(readSettingsForms(ctx))
}

/**
 * profile 覆盖层里那一行 `id: llm-auto` 的 `config.routes`(没有覆盖时 undefined)。
 *
 * 为什么需要它:插件页的「恢复包内默认链」按钮要 `unset` 掉 profile 层对 routes 的覆盖,
 * 而"有没有这份覆盖"只有宿主分得清 —— 面板拿到的 `chain` 是**合并后**的生效链,
 * 光看它推不出"这条链来自包内默认还是 profile 覆盖"。数据来源是设置服务的描述符:
 * `settings.describe()` 的每一行都带 `user`(profile 覆盖层经 volatile 表单投影后的值,
 * 见 dsh-settings 的 describe()),这里只挑自己那一行(`ns === 本插件行 id`)。
 *
 * 三处收窄(别放宽):只认 `ns === name` 那一行(拿不到就当"没有覆盖",宁可少画一个按钮);
 * 只回 `routes` 一个键(端点在回环上,但"不外传配置"是同一套纪律);`routes` 必须能过
 * `normalizeRoutes()`(坏形状当作没有覆盖,不误报)。
 * @param ctx - 宿主上下文。
 * @returns 配置形状的覆盖链,或 undefined。
 */
export function computeUserRoutes(ctx) {
  return userRoutesOfForms(readSettingsForms(ctx))
}

/**
 * 把 live LLM 注册表投影成"分组 + 模型名",给插件页的模型选择器用。
 *
 * 口径照 `@deepseek-ai/dsh-api-session-controller` 的 `buildModelCatalog()`(官方 Web 端
 * `/api/session/modelCatalog` 就是它):**逐 provider 隔离失败** —— 某个 provider 的目录
 * 抛错只让它自己变成一条 `failures` 记录,不拖垮整次读取。
 *
 * 三处有意的收窄:
 *  · 字段**白名单**:只回传 `{ provider, name, models:[{id,name,description?}] }`。provider 档案里
 *    还有 `apiKeyEnv` / `baseURL` / 请求头这类东西,一律不外传(端点虽然只绑回环,
 *    "不外传凭据引用"是硬纪律);
 *  · 不解析 `reasoning` 档位:本面板不提供档位编辑(档位由 adapter 自动取该路由的最高档);
 *  · `listModels()` **不校验凭据** ⇒ 没配 key 的 provider 也会列出来(与本机模型选择器的表现一致),
 *    选它进链不报错,但真跑到那一条会以 MISSING_CREDENTIAL 一次败就切。
 * @param ctx - 宿主上下文(用 `ctx.llm`)。
 * @returns 端点响应的数据体。
 */
export async function buildModelCatalog(ctx) {
  const providers = ctx.llm.listProviders()
  const groups = []
  const failures = []
  for (const provider of providers) {
    try {
      const models = await ctx.llm.listModels(provider.id)
      groups.push({
        id: provider.id,
        name: provider.name,
        models: models.map((model) => ({
          id: model.id,
          name: model.name,
          ...(typeof model.description === 'string' ? { description: model.description } : {}),
        })),
      })
    } catch (error) {
      failures.push({ id: provider.id, name: provider.name, message: String(error?.message ?? error) })
    }
  }
  return { groups, failures }
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger('llm-auto')

  // config.routes 现在是 schemastery 的 volatile 引用(见 Config 的注释):必须解包才能读值,
  // 且**不能**把这一份抄成局部常量 —— 设置服务写入后会原地更新引用,下面所有用链的地方都走
  // readRoutes() 现取。解包前先兜一层:老 profile 里可能残留数组形态(或手写配置直接给数组)。
  const routesRef = config.routes
  const readRoutes = () => normalizeRoutes(unwrapVolatile(routesRef)).routes
  let routes
  let skipped
  try {
    ({ routes, skipped } = normalizeRoutes(unwrapVolatile(routesRef)))
  } catch (error) {
    if (error instanceof RouteConfigError) {
      logger.error(error.message)
      return
    }
    throw error
  }
  for (const item of skipped) logger.warn(item.reason.startsWith('keepThinking ') ? `auto: 第 ${item.index} 条路由 ${item.label} —— ${item.reason}` : `auto: 跳过第 ${item.index} 条路由 ${item.label} —— ${item.reason}`)

  // 重试策略:缺省 = 官方默认(每路由 5 次重试,瞬时码白名单)。坏值只 warn 不拒绝注册。
  const { policy: retryPolicy, warnings: retryWarnings } = normalizeRetry(config.retry)
  for (const warning of retryWarnings) logger.warn(warning)

  // 下面四个取值器都**每次重读** config(而不是把值抄下来):宿主里这些键是 schemastery 的
  // `.volatile()` 字段,设置页/web 端写进来的新值会原地更新那个引用 ⇒ 取值器一读就是新值,
  // 不需要重新 apply。`unwrapVolatile()` 负责把引用解成真实值(见 lib/compact.js)。
  const readName = () => {
    const raw = unwrapVolatile(config.name)
    return typeof raw === 'string' && raw.length > 0 ? raw : DEFAULT_MODEL_NAME
  }
  const readLogLimit = () => {
    const raw = unwrapVolatile(config.logLimit)
    return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_LOG_LIMIT
  }

  const ring = createRing(readLogLimit)
  /** 客户端半侧报上来的诊断(仅内存;见 {@link createDiagLog})。 */
  const diagLog = createDiagLog()
  // ── 额度查询(只读观测) ────────────────────────────────────────────────────
  // 配置坏值只 warn 并回落默认;查询器本身**不发请求** —— 只有 /routes 端点被命中才会按 TTL 刷一次,
  // 所以 headless(没有 webServer)与"没人看面板"时对外零流量。
  const { config: quotaConfig, warnings: quotaWarnings } = normalizeQuota(config.quota)
  for (const warning of quotaWarnings) logger.warn(warning)
  const quotaTracker = createQuotaTracker({
    config: quotaConfig,
    // 每次刷新现问一次凭据服务(服务可能后到;换了 key 也不必重启);拿不到就退环境变量兜底。
    credentials: () => (typeof ctx.get === 'function' ? ctx.get('credentials') : undefined),
    logger,
  })

  // ── 额度感知的自动排序 + 耗尽冷却(0.8.0 起) ────────────────────────────────
  // 三件事分开:`ordering` 决定**怎么排/跳谁**(纯函数在 lib/ordering.js),`cooldown` 记
  // "某家冷到什么时候"(进程内,不落盘),`orderRefresh` 只管"路由侧该不该去补查一次额度"。
  // 面板那份 quota 快照是**只读观测**(60s TTL,只在读端点时刷),这里另有一份低频缓存 ——
  // 两者的 TTL 语义**不共用**(见设计档 §4)。
  const orderingRef = config.ordering
  const readOrdering = () => normalizeOrdering(unwrapVolatile(orderingRef)).config
  for (const warning of normalizeOrdering(unwrapVolatile(orderingRef)).warnings) logger.warn(warning)
  const readOrderMode = () => readOrdering().mode
  const cooldown = createCooldown()
  const orderRefresh = createOrderRefresh()
  /**
   * 最近一次成功读到的额度快照(排序与冷却判定都读它)。
   *
   * `undefined` = 还没查过 ⇒ 所有条目都落"未知档",排序退化成配置顺序(**不猜**)。
   * 有值时与 /routes 的 `quota` 字段同源(同一个 tracker),所以面板看到的和路由用的是同一份事实。
   */
  let orderQuota

  /** 链上的 provider(去重、保序)。链是 volatile 引用 ⇒ 现场取。 */
  const chainProviders = () => [...new Set(readRoutes().map((route) => route.provider))]

  function rememberQuota() {
    try {
      orderQuota = quotaTracker.snapshot(chainProviders())
    } catch (error) {
      logger.warn(`auto: 排序用额度快照读取失败 —— ${String(error?.message ?? error)}`)
    }
  }

  /**
   * 按路由侧的节流表补查额度(fire-and-forget)。
   *
   * 触发点(设计档 §4):① 进程内第一次需要排序 ② `QUOTA` 报错时(见 {@link onRouteFailure}:只查
   * 这一家、绕缓存)③ 缓存过期。①③ 都挂在**适配器每次请求的排序路径**上(见下面 `buildOrder` 的
   * 接线):没过期就什么都不做,过期才补一轮 —— headless(一次 `/routes` 都不读)同样会走到。
   * 查询与解析全部复用 lib/quota.js(只换"什么时候查"的策略),所以失败依旧是 **fail-open**:
   * 查不到 ⇒ 该家落"未知档"、不冷却(绝不因为一次查不到就误伤一条能用的订阅)。
   * @param only - 只补查这一家(可省;缺省 = 链上全部 provider)。
   */
  function bumpOrderQuota(only) {
    if (quotaConfig.enabled === false) return
    const wanted = only === undefined ? chainProviders() : [only]
    // ⚠ 只补查**真的过期**的那几家:整条链丢给 forceRefresh 会让"链上有一家永远查不到"
    //   (不认识的 provider 落不进长闸门)变成"每次请求都把另外几家重查一遍" —— 闸门形同虚设。
    const due = orderRefresh.plan(wanted).due
    if (due.length === 0) return
    // 先 mark 再查:① 同一次请求里并发触发的补查只打一轮上游 ② 万一这次刷新没有落定,闸门也只占
    // **短** TTL(默认 10 分钟)—— 绝不把"还没查到"当成"查到了"占满 6 小时。
    // 查完用**新的**快照逐家重判:查到 `status === 'ok'` 的换成有效期(可能提前到某个重置时刻)。
    orderRefresh.markChecked(due, orderQuota, false)
    void quotaTracker.forceRefresh(due)
      .then(() => {
        rememberQuota()
        orderRefresh.markFromQuota(due, orderQuota)
      })
      .catch((error) => {
        // `forceRefresh` 的契约是 Promise 永不 reject(失败已经变成 unavailable 记录 ⇒ 上面那次
        // markFromQuota 按"没查到"记短 TTL)。这一支只是兜底,别让任何意外把 warn 吞掉。
        logger.warn(`auto: 额度补查失败 —— ${String(error?.message ?? error)}`)
      })
  }

  /**
   * 一条路由**真的告吹**时的动作(adapter → 这里;adapter 不认识额度,只报事实)。
   *
   * 只在 `code === 'QUOTA'` 时动作(§3.2 决策 7/8:反应式、且**补查确认**而不是靠错误文本猜);
   * `AUTH` / `RATE_LIMIT` / 其它码一律不触发冷却 —— Go 的"余额不足"落 `AUTH`,不该被当成
   * 额度耗尽(它要用户去充值,等窗口重置没用)。补查是 fire-and-forget:本次照样切下一条。
   *
   * 兜底判据(在 `QUOTA` 之外多一层)故意写得很窄:上游适配器改判据时(把 quota 文本归到别的码)
   * 仍能识别,而"rate limit"一类**瞬时**限流不在其中(那有重试兜着,不该冷却)。
   * @param event - `{ provider, failure }`。
   */
  function onRouteFailure(event) {
    const failure = event?.failure
    const code = typeof failure?.code === 'string' ? failure.code : ''
    const message = typeof failure?.message === 'string' ? failure.message : ''
    const quotaish = code === 'QUOTA' || /insufficient (quota|balance|credits)|(quota|usage[-_ ]limit) (exceeded|exhausted|reached)/iu.test(message)
    if (!quotaish) return
    const provider = event?.provider
    if (typeof provider !== 'string' || provider.length === 0) return
    void quotaTracker.forceRefresh([provider])
      .then(() => {
        rememberQuota()
        // ⚠ "查过了"**不是**"Promise 有没有 reject"(它永不 reject):只有本轮真的拿到该家的
        //   `status === 'ok'` 才算查到,否则只占 10 分钟短闸门后重试(设计档 §4)。
        orderRefresh.markFromQuota([provider], orderQuota)
        const until = cooldownUntilOf(provider, orderQuota, Date.now())
        if (until === null) {
          // 补查没确认有档位耗尽(fail-open)或拿不到重置时刻 ⇒ **不冷却**,只留一条日志。
          logger.warn(`auto: ${provider} 报了额度错误,但补查未确认有窗口耗尽 —— 不冷却(下次仍会白撞一次)`)
          return
        }
        // 冷却行要说清"是哪一档打满"(§7):窗口 id 只从**固定枚举**里取(见 lib/ordering.js 的
        // `exhaustedWindowIds`,含 CC 那档合成的 `credits`),上游的原始字符串一个都不往外透传。
        cooldown.mark(provider, until, exhaustedWindowIds(quotaSourceOf(orderQuota, provider)))
        logger.warn(`auto: ${provider} 额度耗尽,冷却到 ${new Date(until).toISOString()}(补查已确认)`)
      })
      .catch((error) => {
        // 断网 / 超时 / 形状不认 ⇒ 不冷却(§3.2 的 fail-open)。
        orderRefresh.markChecked([provider], orderQuota, false)
        logger.warn(`auto: ${provider} 额度补查失败(不冷却,宁可下次白撞)—— ${String(error?.message ?? error)}`)
      })
  }

  /**
   * 同步读额度快照(永不抛):任何意外都退成 disabled 形态 —— 观测能力不该影响端点状态码。
   * @param providers - 当前链上的 provider 名(按链顺序)。
   * @returns `quota` 字段的值。
   */
  const readQuota = (providers) => {
    try {
      return quotaTracker.snapshot(providers)
    } catch (error) {
      logger.warn(`auto: 额度快照读取失败 —— ${String(error?.message ?? error)}`)
      return { state: 'disabled', checkedAt: null, ageMs: null, ttlMs: quotaConfig.ttlMs, timeoutMs: quotaConfig.timeoutMs, inFlight: false, sources: [] }
    }
  }
  const resolveRouteWindow = createContextWindowResolver(ctx.llm, readRoutes)

  // ── 对外声明的上下文窗口 ────────────────────────────────────────────────────
  // 口径决策全部在纯函数里(见 lib/compact.js 的 `planDeclaredWindow`):
  // compactWindow(默认 500000)反算 > contextWindow 直取 > 逐跳解析 > 65536。
  const initialPlan = planDeclaredWindow(config)
  for (const warning of initialPlan.warnings) logger.warn(warning)
  /** 逐跳解析出来的最近一次窗口,只给 HTTP 端点事后复核用。 */
  let lastResolvedWindow
  const resolveContextWindow = async (signal) => {
    const plan = planDeclaredWindow(config)
    const value = plan.declaredContextWindow ?? await resolveRouteWindow(signal)
    lastResolvedWindow = value
    return value
  }

  const adapter = new AutoAdapter({
    llm: ctx.llm,
    // ⚠ 传**取值函数**而不是上面那份 `routes` 快照:快照是挂载那一刻的链,传它就等于把
    // "插件页改完链即时生效"这条路径掐断(首次实测就是这么错的 —— 改完链仍走旧首选,
    // 而 `listModels()` 的描述也跟着停在旧链上)。这里的函数每次调用现解包 volatile 引用。
    routes: readRoutes,
    modelName: readName,
    retryPolicy,
    ring,
    logger,
    resolveContextWindow,
    // 0.8.0:每次请求现算"实际尝试顺序"(三桶排序 + 冷却过滤)。传函数而不是快照 ——
    // 链、模式、冷却表、额度快照都可能在两次请求之间变化,而适配器本来就要求"每次请求开始时取一次"。
    buildOrder: (routes) => {
      // ⚠ 触发点 ①(§4 的"进程内第一次需要排序")与 ③(缓存过期)**都挂在这条路上**:每次请求
      // 排序前按节流表判一次,该查才发一次后台查询 —— **fire-and-forget**,本次请求立刻按现有
      // (可能是"未知档")的顺序往下走,不阻塞。这样 headless(没人读 /routes)也照样会补查。
      // 节流表 + 单飞保证节奏最多是"重置时刻 / 6 小时上界(查到 ok)/ 失败后 10 分钟"一轮;
      // 而没人用 auto(没有请求)时它一次都不会执行 —— 零外部流量。
      bumpOrderQuota()
      return buildOrder(routes, {
        quota: orderQuota,
        cooldown,
        mode: readOrderMode(),
        now: Date.now(),
      })
    },
    onFailure: onRouteFailure,
  })

  // ⚠ 必须用自己的 effect 包一层:`ctx.llm.registerAdapter()` 内部的 effect 挂在 **llm 服务自己的
  // fiber** 上(见 cordis Service 的 this.ctx),不会随本插件的卸载自动释放。返回的 handle 才是
  // 本插件的释放口 —— 热重载/卸载时必须由本 fiber 调用它,否则会留下一条指向死实例的路由。
  ctx.effect(() => ctx.llm.registerAdapter([AUTO_PROVIDER], adapter), 'llm-auto: register provider route')
  logger.info(`auto: 已注册路由 ${AUTO_PROVIDER}/${AUTO_MODEL}（${readName()}）→ ${describeChain(routes)}；${describeRetryPolicy(retryPolicy)}`)
  // 窗口口径单独一行:映射那一支会把所依赖的假设一并打出来,便于事后倒推(见 lib/compact.js)。
  logger.info(describeWindowPlan(initialPlan, DEFAULT_CONTEXT_WINDOW))

  // 本插件自带浏览器半侧(链编辑器 + compactWindow 表单)⇒ 关掉设置页的"按 schema 自动生成表单",
  // 免得同一个命名空间被两套界面同时编辑(官方 `configure({ auto: false })` 语义,见 dsh-settings)。
  // settings 服务可能缺席(headless / 精简组合)⇒ 走可选注入,没有它也不影响插件本体。
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }), 'llm-auto: own settings page')
  })

  // HTTP 端点属于 web 外壳;headless 等 profile 没有 webServer,走可选注入。
  // 该路径是 exact 路由,优先于 dsh-client-connection 注册的 `/api` 前缀(前缀表只在 exact 未命中时
  // 才查)⇒ 它**不经过**浏览器鉴权 cookie 那一关。仅因 webServer 绑在回环地址才可接受,详见 README。
  ctx.inject(['webServer'], (webCtx) => {
    /**
     * 诊断端点:GET 读回最近若干条报告,POST 追加一条。
     * 页面侧只发文本(可能不是合法 JSON)—— 原样收下更利于排查,所以解析失败也存原文。
     */
    const diagHandler = (req, res) => {
      if (req.method === 'GET' || req.method === 'HEAD') {
        sendJson(res, 200, { reports: diagLog.list(), limit: DIAG_LIMIT })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'diagnostic endpoint takes GET or POST' })
        return
      }
      readRequestBody(req).then(({ text, truncated }) => {
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = { raw: text }
        }
        const record = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value: parsed }
        diagLog.push({
          at: new Date().toISOString(),
          ...(truncated ? { truncated: true } : {}),
          ...record,
        })
        sendJson(res, 200, { ok: true, stored: diagLog.list().length })
      }).catch((error) => sendJson(res, 500, { error: String(error?.message ?? error) }))
    }

    /** 模型目录端点的处理器(形状见 {@link buildModelCatalog})。 */
    const catalogHandler = (req, res) => {
      buildModelCatalog(ctx)
        .then((body) => sendJson(res, 200, body))
        .catch((error) => sendJson(res, 500, { error: String(error?.message ?? error) }))
    }
    const handler = (req, res) => {
      try {
        const url = new URL(req.url ?? ROUTES_PATH, 'http://127.0.0.1')
        const rawLimit = url.searchParams.get('limit')
        // 现场重算(而不是用挂载时那份):设置页里的 volatile 改动即时反映在响应里,便于事后复核。
        const plan = planDeclaredWindow(config)
        // limit 只切**记录条数**:分组后最旧那一组可能被截断(同一次请求的前半段已被淘汰),
        // 插件页面板就是这么显示的(见 README §5)。
        const entries = ring.list(rawLimit === null ? undefined : Number.parseInt(rawLimit, 10))
        // 现场取链(不是挂载时那份):插件页改完链,这里下一次请求就是新顺序。
        const live = readRoutes()
        // 现场取链之后:① 同步读一次额度快照(可能是 pending);② fire-and-forget 触发一次按 TTL
        // 去重的刷新。handler 因此保持**同步** —— 响应时间与外部 HTTPS 完全解耦,查询失败只体现在
        // quota 字段的内容里(状态码恒 200)。
        const providers = live.map((route) => route.provider)
        const quota = readQuota(providers)
        void quotaTracker.touch(providers).catch(() => {})
        // 排序判定用的那份快照与这里**同源同值**(都是同一个 tracker 的现场快照):面板看到的
        // "已耗尽"与路由真的会跳过的,是同一份事实 —— 不然用户会看到"显示已耗尽但没跳过"。
        orderQuota = quota
        // 路由侧的低频节流也在这里顺带推进一次(幂等:没过期什么都不做)。主路径是适配器每次请求的
        // 排序路径(见上面 buildOrder 的接线),它 headless 也走 —— 这里只是"面板打开时顺便也推一下"。
        bumpOrderQuota()
        // 实际尝试顺序:每次请求现算(quota / cooldown / mode 都可能是新的)。
        const ordering = buildOrder(live, {
          quota: orderQuota,
          cooldown,
          mode: readOrderMode(),
          now: Date.now(),
        })
        // 设置服务**只读一次**:可写性与 profile 覆盖链都从同一份描述符来 —— 拆成两次调用会让
        // 一次 /routes 读两遍 describe(),还可能看到两个互相矛盾的快照。
        const settingsView = readSettingsView(ctx)
        sendJson(res, 200, {
          provider: AUTO_PROVIDER,
          model: AUTO_MODEL,
          name: readName(),
          // 当前生效的重试策略(扁平结构,与官方 resolveRetryPolicy 的返回一致)
          retry: {
            mode: retryPolicy.mode,
            maxRetries: retryPolicy.maxRetries,
            retryableCodes: [...retryPolicy.retryableCodes],
            initialDelayMs: retryPolicy.initialDelayMs,
            maxDelayMs: retryPolicy.maxDelayMs,
            jitterRatio: retryPolicy.jitterRatio,
          },
          // 压缩点(未启用映射时为 null)与最终对外声明的窗口;后者在"逐跳解析"口径下要等
          // 第一次目录解析才有值,故回落到最近一次解析结果(null = 还没解析过)。
          compactWindow: plan.compactPoint,
          declaredContextWindow: plan.declaredContextWindow ?? lastResolvedWindow ?? null,
          // 链的每一项:0.5.x 是裸字符串 `provider/model`;0.6.0 起是对象 `{ label, options? }`,
          // 好让面板把逐条开关(keepThinking / breakToolLoop)画成"开着"的状态 —— 只回传**打开**的开关。
          // 本次部署是否接受配置写入:插件页的链编辑器据此决定"显示保存按钮"还是"退回只读"。
          // 每次请求现算(设置服务/客户端形态可能在会话中途变化),不做缓存。
          writable: settingsView.writable,
          // profile 覆盖层里的 routes(仅确有覆盖时出现):面板据此显示「恢复包内默认链」。
          ...(settingsView.userRoutes === undefined ? {} : { user: { routes: settingsView.userRoutes } }),
          // 订阅额度快照(只读观测;详见 lib/quota.js 与 README §2「额度」)。
          quota,
          // 额度感知的排序与冷却(0.8.0):`mode` 是当前模式,`effective` 是**实际尝试顺序**
          // (带每条的桶归属),`cooldown` 是当前冷却表。三者都是**只读**字段 ——
          // `chain` 仍是配置顺序(0.6.0 的编辑契约不动),面板的投影逻辑据此渲染。
          ordering: {
            mode: ordering.mode,
            // ⚠ 冷却中的条目**也列在这里**(带 `cooling` / `until` / `windows`):面板要能画出
            //   "这条现在被跳过、因为月度那一档(或 CC 的月度余额)打满了"(设计档 §7 的那个例子)。
            //   真正会被尝试的顺序 = 去掉带 `cooling` 的那些 —— 适配器拿的是 buildOrder 的
            //   `entries`,本身就不含冷却项,所以这层投影只影响显示,不影响路由。
            //   全冷却兜底(ignoredCooldown)时跳过列表就是被放行的那一批,不能再拼一次(会重复)。
            effective: ordering.ignoredCooldown ? ordering.entries : [...ordering.skipped, ...ordering.entries],
            // ⚠ `manual` 下**恒为空数组**(设计档 §7):那种模式不跳过任何一跳,把冷却表画出来
            // 会让人以为"它被跳过了"。表本身照旧记着(切回 auto 立刻生效),只是不往外报。
            cooldown: ordering.mode === ORDERING_MODE.MANUAL ? [] : cooldown.snapshot(Date.now()),
            ignoredCooldown: ordering.ignoredCooldown,
          },
          chain: live.map((route) => ({
            label: `${route.provider}/${route.model}`,
            ...(route.keepThinking === true || route.breakToolLoop === true
              ? {
                  options: {
                    ...(route.keepThinking === true ? { keepThinking: true } : {}),
                    ...(route.breakToolLoop === true ? { breakToolLoop: true } : {}),
                  },
                }
              : {}),
          })),
          capacity: ring.capacity,
          total: ring.size,
          routes: entries,
          // 按一次请求分组后的回退路径(最近一次在前):插件页面板渲染的就是它,与上面平铺的 routes 同源,只是整形角度不同。
          calls: groupCalls(entries),
        })
      } catch (error) {
        sendJson(res, 500, { error: String(error?.message ?? error) })
      }
    }
    // 两个都注册成 exact 路由。沿革:0.5.0 只登记函数不登记路径 ⇒ 「刷新/检查插件」重组合后
    // 端点会静默消失(重组合重建了服务、旧登记随之释放,而 loader 认为模块没变、不会重新执行
    // 模块体 ⇒ 函数据以重建的那次注册再也不会发生)。0.6.0 顺带补上路径登记,并把两个端点
    // 收进同一个循环:再加重组合时两个一起回来,不会再出现"一个在、一个没了"。
    const handlers = {
      [ROUTES_PATH]: handler,
      [CATALOG_PATH]: catalogHandler,
      [DIAG_PATH]: diagHandler,
    }
    for (const path of [ROUTES_PATH, CATALOG_PATH, DIAG_PATH]) {
      const routeHandler = handlers[path]
      webCtx.effect(
        () => webCtx.webServer.register({ kind: 'exact', path, handler: routeHandler }),
        `llm-auto: ${path}`,
      )
    }
  })
}

// 导出内部件供测试直接调用(不需要跑起 harness)
export { AutoAdapter, createContextWindowResolver } from './adapter.js'
export { describeChain, normalizeRoutes, RouteConfigError, AUTO_MODEL, AUTO_PROVIDER, DEFAULT_CONTEXT_WINDOW, DEFAULT_LOG_LIMIT, DEFAULT_MODEL_NAME } from './routes.js'
export { COMPACT_HEADROOM_TOKENS, COMPACT_RETAIN_RATIO, COMPACT_THRESHOLD_RATIO, DEFAULT_COMPACT_WINDOW, WINDOW_SOURCE, compactRetainFor, compactThresholdFor, declaredWindowForCompactPoint, describeWindowPlan, minimumUsableCompactWindow, planDeclaredWindow, unwrapVolatile } from './compact.js'
export { computeRetryDelay, describeRetryPolicy, normalizeRetry, DEFAULT_RETRY_POLICY, NO_RETRY_POLICY } from './retry.js'
export { buildExhaustedError, isFallbackCode, summarizeFailure, EXHAUSTED_CODE, NEVER_FALLBACK_CODES } from './errors.js'
export { appendRouteSwitchNotice, appendToolLoopBreak, restoreReplaySources } from './replay.js'
export { CALL_OUTCOME, groupCalls } from './calls.js'
export { DEFAULT_QUOTA_CONFIG, QUOTA_PROVIDERS, QUOTA_REASON, createQuotaTracker, normalizeQuota, sumCredits } from './quota.js'
export {
  CREDITS_WINDOW_ID, DEFAULT_ORDERING_CONFIG, DEFAULT_ORDERING_RETRY_MS, DEFAULT_ORDERING_TTL_MS, ORDERING_MODE, ORDER_BUCKETS, WINDOW_IDS,
  buildOrder, cooldownUntilOf, createCooldown, createOrderRefresh, earliestResetOf, effectiveEntry, exhaustedUntil,
  exhaustedWindowIds, exhaustedWindows, isCreditsExhausted, isExhausted, isExhaustedWindow, isSourceOk, isoOf as orderingIsoOf,
  monthlyResetOf, normalizeMode, normalizeOrdering, providerKind, quotaSourceOf, reasonOf, timestampOf,
} from './ordering.js'
