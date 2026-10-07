// 浏览器半侧:在「插件」页把本插件的配置做成可编辑界面 ——
//   · compactWindow:官方 SettingsForm 一个数字字段(0.4.0 起);
//   · 「回退链」面板:0.5.0 起只读,0.6.0 起**可编辑**(拖拽排序、从模型目录里选模型、
//     按行开关 keepThinking / breakToolLoop),写入走官方设置服务,保存即免重启生效;
//     0.9.0 起与「自动排序」**合成一段、按模式显示**(自动 ⇒ 主视图是「生效顺序」,可编辑的
//     配置链折进默认收起的「配置顺序」;手动 ⇒ 主视图就是那条可编辑的链);
//   · 「最近请求」:只读的回退过程视图(端点的 `calls`)。
//
// 位置沿革(三版):
//   v0.4.0 初版注册进 plugins.row.config(键 = "<包名>#<行 id>")⇒ 表单藏在
//     插件页 →「已安装」→ dsh-llm-auto → 行 `llm-auto` →「配置」的二级页里,要钻四层。
//   随后改注册进 plugins.bundle.config(键 = **本包包名**)⇒ 插件页 →「已安装」→
//     dsh-llm-auto 一进去就能看到表单(渲染在描述与行之间);行上那个「配置」控件
//     随之消失(本插件不再占用 plugins.row.config)。
//   v0.5.0 在同一位置加只读「回退链」面板;v0.6.0 把它升级成可编辑的链编辑器。
//
// 依据(全部为实测源码,非推测):
//   · slot 契约:dsh-client-ui-plugin-manager 的 lib/types/client/slot-contract.d.ts
//     —— plugins.bundle.config 是 keyed slot,键为 bundle 包名,只问 view="page",
//     渲染位置是 bundle 页「描述与行之间」;plugins.row.config 的键才是
//     `${bundle}#${rowId}`(其 client.js:27 的 rowConfigKey)。
//   · 键必须**恰好**是包名:该页只在 ledger 收录了这个键时才渲染这一段
//     (其 client.js:2879 的 `ledger.bundles.has(pkg.name)`),而 ledger 直接读
//     槽位注册的 key(其 client.js:48 的 keysOf)。
//   · 同槽位的官方实例:@deepseek-ai/dsh-experimental-client-ui-voice-input 的
//     VoicePreparation 也注册在这里(键为 voice-input-bundle 的包名),自身不带标题。
//   · 设置命名空间 = loader 行 id:本插件的行 id 是 `llm-auto`,dsh-settings 按
//     entry.options.id 投影命名空间 ⇒ ctx.configForms.get('llm-auto')。
//   · 表单原语:@deepseek-ai/dsh-client-ui-primitives 属**平台种子模块**
//     (前端 bundle 的 staticModules 明确列出它,连同 react / slots / store / cordis),
//     任何客户端半侧可直接 require,无需它出现在 node_modules 依赖里。
//     SettingsFormModel + SettingsForm + SettingsValueField 负责暂存草稿、保存/丢弃、
//     「已覆盖」标记与「恢复默认」;本插件不自己实现任何写入逻辑。
//   · 写链走 `ctx.configForms.get(ns).mutate(ops, revision)`(官方 ConfigFormController,
//     见 dsh-client-ui-settings 的 lib/client.js):它排队、按 revision 做乐观并发控制、
//     失败自动重拉;宿主侧由 dsh-config-editor 用 yaml 文档式写入落进 profile 的
//     cordis.patch.yml(**只替换那一行的 config 节点,注释与 !!js 标签都保留**)。
//   · inject 里的 hooks 以 use<Name> 形式注入组件(官方写法 hooks:{shellCard} → props.useShellCard)。
//   · ⚠ **本插件不用 configForms.whileServed 门控**(2026-10-05 实测后改的):官方四个配置页用它,
//     条件是"宿主服务的命名空间表里有本命名空间";桌面端实测该条件从未成立(槽位 occupant 长期
//     active: false),于是 0.4.0–0.5.x 这段配置**静默地什么都不长** —— 用户看不到任何东西、
//     也没有任何提示。现在无条件注册进槽位,由组件自己报状态:设置服务缺席或设置文档读不到时,
//     表单与链面板都退回只读并写明原因(见 AutoRouteConfig 的 available 与 apply() 里的 inertScope)。
//     代价:插件没被服务时也会多出一段;换来的"看得见的解释"比静默空白划算。
//   · 主题样式只用 --dsw-* token(Theme 令牌表),不写死颜色;light/dark 两套由外壳提供。
//     面板的 class 名统一加 `la-` 前缀,随本模块的 effect 注入 <style>,卸载时移除。
//   · 模型菜单的度量与配色逐条照抄主页模型选择器(dsh-client-ui-model-selection 的
//     lib/client.js 内联 CSS):34px 行高、4px 卡片内边距、透明背景的搜索行、
//     hover 用 --dsw-alias-interactive-bg-hover、勾选色 --dsw-alias-label-primary。
//
// 可写字段两个:compactWindow(数字)与 routes(链,形状与校验见宿主 lib/routes.js)。
// 两者同属 `llm-auto` 命名空间但路径不同,各带自己的 revision 基线 ⇒ 一次保存里谁改了写谁。
// retry 不是 volatile,仍改包内 cordis.patch.yml(面板只展示)。
//
// 额度(0.7.0 起):面板上多一段**只读**的摘要 —— 一家一行(Command Code 的余额/窗口、
// OpenCode Go 的三档百分比),数据来自 `/routes` 的 `quota` 字段。宿主侧只读查询、按 TTL 缓存、
// 永不因此改变端点状态码;**查不到就显示「不可查」,绝不显示成 0**(见宿主 lib/quota.js)。
//
// ⚠ 本文件在插件目录、desktop 与 headless 的 node_modules 里各有一份,且是**同一 inode 的
//   硬链接**(2026-10-05 用 `fsutil hardlink list` 实测三向)。所以改它必须**原地写入**:
//   write/edit 这类"换文件式"写入会当场断链、让运行副本停在旧版本。做法与核对见 README §4。
//
// 格式遵循 DSH 客户端插件契约:window.__ModuleLoader__.load + 具名导出 apply/inject。
window.__ModuleLoader__.load({
  id: "dsh-llm-auto",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var jsxRuntime = require("react/jsx-runtime");
    var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    // 0.8.0 起再往上一段「自动排序」:一行模式开关(写 `ordering.mode`,volatile ⇒ 免重启切换)
    // + 一行实际尝试顺序(端点新增的只读 `ordering` 字段)。`manual` 下只显示一句"按你排的顺序",
    // 不渲染 effective —— 那种模式本来就不排序。冷却标记与「额度」段的「已耗尽」可能同时出现:
    // 一个是**行为**、一个是**观测**,两者都对。
    // 0.9.0 起把「自动排序」与链编辑器**合并成一段、按模式显示**(见 {@link chainSectionPlan}):
    // 模式开关挪到卡片**最上面**(在「回退链」标题之前);`auto` 主视图是「生效顺序」、配置链折叠,
    // `manual` 反过来。两段不再各画一次"当前是什么模式"。
    // 本插件的行 id,同时也是设置命名空间(dsh-settings 按 entry.options.id 投影)
    var NAMESPACE = "llm-auto";
    // 本组件注册的 plugins.bundle.config 键:bundle 自己的配置按**包名**寻址
    var BUNDLE_CONFIG_KEY = "dsh-llm-auto";
    // 本插件自己的字典命名空间
    var NS = "llmAutoSettings";
    /**
     * 宿主侧的只读端点(必须与 lib/index.js 的 ROUTES_PATH / CATALOG_PATH 一致)。
     * exact 路由、不经过浏览器鉴权 cookie,同源相对路径即可(见 README §5)。
     */
    var ROUTES_PATH = "/api/llm-auto/routes";
    /** 模型目录端点:链编辑器的选择器读它(0.6.0 新增)。 */
    var CATALOG_PATH = "/api/llm-auto/catalog";
    /** 自诊断端点(0.6.0 新增):页面侧把报错原文发到这里,宿主收进内存环形缓冲。 */
    var DIAG_PATH = "/api/llm-auto/diag";
    /** 上报正文的长度上限(与宿主的 16 KB 上限对齐,留余量)。 */
    var DIAG_TEXT_LIMIT = 4000;
    /**
     * 当前字典的翻译函数(在 applyInner 里绑定)。
     * 边界组件是**类组件**、拿不到 props.t,所以走这个模块级绑定 —— 比把 t 一路传进每层组件便宜,
     * 且字典在挂载时就注册好了。
     */
    var activeT = function (key) { return String(key); };
    /** 面板最多显示几次请求(回退过程一屏能看完;更多记录看端点 raw `routes`)。 */
    var MAX_CALLS = 8;
    /** 逐条开关的 UI 表(键名与配置里的键名一致,顺序即面板上的顺序)。 */
    var OPTION_KEYS = ["keepThinking", "breakToolLoop"];
    /** 拖拽起手阈值(px):小于它只当点击,免得手一抖就把行挪了。 */
    var DRAG_THRESHOLD_PX = 4;

    var zh = {
      compactWindow: "用于压缩的上下文窗口",
      compactWindowHint: "让自动压缩发生在这个 token 数附近;只写这一个字段,改完即时生效、无需重启。",
      overridden: "已覆盖",
      reset: "恢复默认",
      invalidNumber: "请填数字,留空表示用默认值。",
      readOnly: "本次部署以只读方式保存设置。",
      unavailable: "该插件没有加载,暂时无法配置。",
      save: "保存",
      saving: "保存中…",
      saveFailed: "部署没有接受这些值,已保留供你修改。",
      chainTitle: "回退链",
      chainHint: "按下面的顺序依次尝试:第 1 项即首选。某条重试耗尽、或错误码不允许重试时,才静默切下一条。拖动行首的手柄改顺序,改完点「保存」写入配置并即时生效(不用重启)。",
      chainFooter: "「最近请求」是只读的回退过程记录,打开本页时读一次,点「刷新」看最新。",
      retryLine: "每路由最多重试 {max} 次,退避 {initial}ms→{maxDelay}ms",
      retryOff: "路由内重试已关闭:每路由只尝试一次,失败即切下一条。",
      chainUnavailable: "该部署不允许写配置,链只能看不能改。",
      settingsNoProvider: "页面侧没有设置服务(configForms 缺席),所以这个面板只能看不能改。",
      settingsNoDocument: "读不到设置文档,所以这个面板只能看不能改:页面侧的 settings.describe() 没成功(插件页的官方设置页同样会受影响)。",
      settingsUnavailableHint: "设置服务缺席时,这个面板只显示当前生效的链。",
      noSettingsService: "未接入设置服务",
      noChainInjection: "槽位没有把写配置的句柄注进来,所以这个面板只读(详情见 /api/llm-auto/diag)。",
      renderFailed: "这段界面渲染失败(原因已上报到 /api/llm-auto/diag)。",
      chainEmpty: "配置链是空的(插件未加载,或链路里一条路由都不可用)。",
      chainLoading: "读取中…",
      chainLoadFailed: "读取失败:{reason}",
      recentCalls: "最近请求",
      recordCount: "共 {total} 条记录,容量 {capacity}",
      noCalls: "还没有请求经过 auto 路由。选一次 Auto 模型再回来看。",
      refresh: "刷新",
      saveChain: "保存",
      discardChain: "放弃改动",
      addModel: "添加模型",
      addModelTitle: "添加一条路由(加在链尾)",
      pickModelTitle: "换成另一个模型",
      dragHandle: "拖动排序(也可用 Alt+↑ / Alt+↓)",
      moveUp: "上移一条",
      moveDown: "下移一条",
      removeRoute: "从链上删除这一条",
      optionsToggle: "选项",
      keepThinking: "保留思考块",
      keepThinkingHint: "工具循环里的思考块是否逐条回传。DeepSeek 原生 thinking 路由要开,别的路由开了可能被拒。",
      breakToolLoop: "工具循环收尾",
      breakToolLoopHint: "历史里带工具调用却没有思考块、且出站以工具结果结尾时,补一条用户提示把请求收尾。",
      off: "关",
      on: "开",
      pickerSearch: "搜索模型…",
      pickerClear: "清除搜索",
      pickerEmpty: "这个目录里没有模型(provider 未配置或目录读取失败)。",
      pickerNoMatch: "没有匹配「{query}」的模型。",
      pickerFailedGroups: "这些 provider 的目录读不到:{list}",
      notInCatalog: "不在当前目录",
      alreadyOnChain: "已在链上",
      dirty: "链有未保存的改动",
      emptyChain: "回退链至少要保留一条路由(空链会让插件整行不注册,最后一条不能删)。",
      saved: "已写入 profile 的 cordis.patch.yml,已即时生效。",
      conflict: "保存被拒:设置可能已被别处改动。请点「刷新」重新读取后再改一次。",
      resync: "配置在别处改过,显示的是最新值(未保存的改动已放弃)。",
      routeNotes: "配置里有这些条目被回落:{list}",
      loading: "读取中…",
      loadFailed: "读取失败:{reason}(插件未加载、端点不可达时也会这样)",
      resetChain: "恢复包内默认链",
      resetChainHint: "删掉 profile 里对 routes 的覆盖,回到包内 cordis.patch.yml 那条链。",
      quotaTitle: "额度",
      quotaHint: "只读观测:链上两家订阅的余额/窗口用量(数据来自上游接口)。它不参与路由选择;查不到就显示「不可查」,绝不用 0 顶替。",
      quotaMeta: "{at} 更新",
      quotaPending: "额度查询中…",
      quotaCmdCode: "Command Code",
      quotaGo: "OpenCode Go",
      quotaBalance: "余额 {amount}",
      quotaWindow5h: "5h",
      quotaWindowWeek: "周",
      quotaWindowMonth: "月",
      quotaExhausted: "已耗尽",
      quotaUnavailable: "不可查",
      quotaUnavailableReason: "不可查:{reason}",
      quotaReset: "{at} 重置",
      quotaNoAmount: "无金额口径",
      orderingTitle: "自动排序",
      orderingToManual: "当前:自动排序。切到手动",
      orderingToAuto: "当前:手动。切回自动",
      orderingManualNote: "手动:按你排的顺序,不排序也不跳过。",
      orderingUnknown: "额度查不到,按配置顺序",
      orderingCooling: "{at} 恢复",
      orderingCoolingTag: "冷却中",
      orderingWindow5h: "5 小时",
      orderingWindowWeek: "周",
      orderingWindowMonth: "月度",
      orderingWindowCredits: "余额",
      orderingExhaustedWindow: "{window}已耗尽",
      orderingExhausted: "额度已耗尽",
      orderingIgnoredCooling: "全部路由都在冷却期内 —— 本次忽略冷却、仍按排序顺序尝试。",
      orderingSaveFailed: "切换没被接受,已保留原值。",
      orderingModeHint: "自动:按订阅月度重置时刻排序,并跳过额度耗尽的来源(冷却到它重置)。手动:完全按上面这条链的顺序,只失败时切换。它不改变链本身,改完即时生效。",
      orderingModeLabel: "排序方式",
      orderingEffectiveTitle: "生效顺序",
      chainHintAuto: "自动排序生效中:按订阅的重置时刻排序、额度耗尽的来源暂时跳过;下面是本次实际会尝试的顺序。点开下面的「配置顺序」仍可改链,保存后即时生效(不用重启)。",
      chainConfigToggle: "配置顺序({n} 条)",
      chainConfigToggleHint: "点开可拖动排序、换模型、增删条目",
      outcomeOk: "成功",
      outcomeFailed: "全部失败",
      outcomeAborted: "已取消",
      okTag: "成功",
      failedTag: "失败",
      retried: "试了 {n} 次",
      switchedTo: "→ 切换至 {route}",
      durationNone: "—"
    };

    var en = {
      compactWindow: "Context window used for compaction",
      compactWindowHint: "Lets automatic compaction happen near this token count; writes this one field and takes effect without a restart.",
      overridden: "Overridden",
      reset: "Reset to default",
      invalidNumber: "Enter a number, or leave blank to use the default.",
      readOnly: "This deployment stores settings read-only.",
      unavailable: "This plugin is not loaded, so it cannot be configured right now.",
      save: "Save",
      saving: "Saving…",
      saveFailed: "The deployment did not accept these values; they were left for you to correct.",
      chainTitle: "Fallback chain",
      chainHint: "Routes are tried in order; the first is preferred. One is replaced silently only after its retries are exhausted or its error code is not retryable. Drag the handle at the start of a row to reorder, then Save to write the configuration — it applies without a restart.",
      chainFooter: "\"Recent requests\" is a read-only record of how fallback actually went; it is fetched once when the page opens, and Refresh reloads it.",
      retryLine: "Up to {max} retries per route, backoff {initial}ms→{maxDelay}ms",
      retryOff: "In-route retries are off: one attempt per route, then switch.",
      chainUnavailable: "This deployment does not accept configuration writes, so the chain is read-only.",
      settingsNoProvider: "The client has no settings service (configForms is absent), so this panel is read-only.",
      settingsNoDocument: "The settings document could not be read, so this panel is read-only: settings.describe() did not succeed on this page (the shipped settings pages are affected the same way).",
      settingsUnavailableHint: "Without the settings service this panel only shows the effective chain.",
      noSettingsService: "no settings service",
      noChainInjection: "The slot did not inject the write handle, so this panel is read-only (see /api/llm-auto/diag).",
      renderFailed: "This panel failed to render (the reason was reported to /api/llm-auto/diag).",
      chainEmpty: "The configured chain is empty (plugin not loaded, or every route unusable).",
      chainLoading: "Loading…",
      chainLoadFailed: "Load failed: {reason}",
      recentCalls: "Recent requests",
      recordCount: "{total} records, capacity {capacity}",
      noCalls: "No request has gone through the auto route yet. Pick Auto once and come back.",
      refresh: "Refresh",
      saveChain: "Save",
      discardChain: "Discard changes",
      addModel: "Add model",
      addModelTitle: "Append a route to the end of the chain",
      pickModelTitle: "Replace with another model",
      dragHandle: "Drag to reorder (Alt+Up / Alt+Down also work)",
      moveUp: "Move up one",
      moveDown: "Move down one",
      removeRoute: "Remove this route from the chain",
      optionsToggle: "Options",
      keepThinking: "Keep thinking blocks",
      keepThinkingHint: "Whether thinking blocks are replayed inside a tool loop. Required by DeepSeek's native thinking routes; other routes may reject it.",
      breakToolLoop: "Close the tool loop",
      breakToolLoopHint: "When history holds a tool-calling assistant message with no thinking block and the request ends on a tool result, append a user prompt that closes the loop.",
      off: "off",
      on: "on",
      pickerSearch: "Search models…",
      pickerClear: "Clear search",
      pickerEmpty: "No models in this directory (provider unconfigured, or its catalog failed).",
      pickerNoMatch: "No model matches \"{query}\".",
      pickerFailedGroups: "These providers could not be listed: {list}",
      notInCatalog: "not in the current catalog",
      alreadyOnChain: "already on the chain",
      dirty: "The chain has unsaved changes",
      emptyChain: "A fallback chain keeps at least one route (an empty chain stops the plugin from registering, so the last one cannot be removed).",
      saved: "Written to the profile's cordis.patch.yml and applied live.",
      conflict: "The save was refused: the settings may have been changed elsewhere. Refresh to re-read, then try again.",
      resync: "The configuration changed elsewhere; the latest values are shown and unsaved edits were dropped.",
      routeNotes: "These entries were coerced in the configuration: {list}",
      loading: "Loading…",
      loadFailed: "Load failed: {reason} (also happens when the plugin is not loaded or the endpoint is unreachable)",
      resetChain: "Reset to the bundled chain",
      resetChainHint: "Removes the profile's routes override, returning to the chain in the package's own cordis.patch.yml.",
      quotaTitle: "Quota",
      quotaHint: "Read-only: subscription balances and window usage for the routes above. It never affects routing, and an unreachable upstream is reported as unavailable instead of as a number.",
      quotaMeta: "updated {at}",
      quotaPending: "Checking quota…",
      quotaCmdCode: "Command Code",
      quotaGo: "OpenCode Go",
      quotaBalance: "balance {amount}",
      quotaWindow5h: "5h",
      quotaWindowWeek: "week",
      quotaWindowMonth: "month",
      quotaExhausted: "exhausted",
      quotaUnavailable: "unavailable",
      quotaUnavailableReason: "unavailable: {reason}",
      quotaReset: "resets {at}",
      quotaNoAmount: "no amount reported",
      orderingTitle: "Automatic ordering",
      orderingToManual: "Automatic ordering is on. Switch to manual",
      orderingToAuto: "Automatic ordering is off. Switch back to auto",
      orderingManualNote: "Manual: your order, no sorting and no skipping.",
      orderingUnknown: "quota unknown, kept in configured order",
      orderingCooling: "back at {at}",
      orderingCoolingTag: "cooling down",
      orderingWindow5h: "5-hour",
      orderingWindowWeek: "week",
      orderingWindowMonth: "monthly",
      orderingWindowCredits: "balance",
      orderingExhaustedWindow: "{window} exhausted",
      orderingExhausted: "quota exhausted",
      orderingIgnoredCooling: "Every route is cooling down, so this request ignores cooldowns and still follows the sorted order.",
      orderingSaveFailed: "The switch was not accepted; the previous value is kept.",
      orderingModeHint: "Auto sorts by the subscription's monthly reset and skips providers whose quota is used up (until it resets). Manual follows the chain above exactly and only switches on failure. It never rewrites the chain, and applies without a restart.",
      orderingModeLabel: "Ordering mode",
      orderingEffectiveTitle: "Effective order",
      chainHintAuto: "Automatic ordering is on: routes are sorted by subscription reset time, and providers whose quota is used up are skipped for now; the order actually attempted is listed below. Open \"Configured order\" below to keep editing the chain — saving applies without a restart.",
      chainConfigToggle: "Configured order ({n})",
      chainConfigToggleHint: "Open to reorder, replace, add, or remove routes",
      outcomeOk: "ok",
      outcomeFailed: "failed",
      outcomeAborted: "aborted",
      okTag: "ok",
      failedTag: "failed",
      retried: "{n} attempts",
      switchedTo: "→ switched to {route}",
      durationNone: "—"
    };

    /** SettingsForm 框架自己渲染的文案(官方各配置页同款五条)。 */
    var FORM_LABEL_KEYS = ["unavailable", "readOnly", "saveFailed", "save", "saving"];

    function formLabels(t) {
      var labels = {};
      for (var i = 0; i < FORM_LABEL_KEYS.length; i++) labels[FORM_LABEL_KEYS[i]] = t(FORM_LABEL_KEYS[i]);
      return labels;
    }

    /**
     * 把 `{name}` 模板填上值。
     *
     * dsh 的 `t(key, params)` 官方支持 `{name}` 插值(dsh-client-ui-slots 的
     * Translate 类型注明),但本模块不赌版本:`tr()` 先按 params 调一次,返回值里
     * 还留着 `{xxx}` 时就地自己替换一遍 —— 两种实现下结果一致。
     * @param template - 模板串(含 `{key}` 占位)。
     * @param values - 占位值表。
     * @returns 填好的字符串;未提供的占位原样保留。
     */
    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/gu, function (matched, key) {
        return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : matched;
      });
    }

    /**
     * 取文案并填参数(对 t 的插值实现不敏感,见 {@link fill})。
     * @param t - 绑定本命名空间的翻译函数。
     * @param key - 字典键。
     * @param params - 可选的 `{name}` 值表。
     * @returns 最终展示文本。
     */
    function tr(t, key, params) {
      var text = String(t(key, params));
      return params && text.indexOf("{") !== -1 ? fill(text, params) : text;
    }

    /**
     * ISO 时间 → 本地 `HH:mm:ss`(面板只要时分秒,日期只会碍事)。
     * @param at - ISO 8601 字符串;解析不了时给占位。
     * @returns `HH:mm:ss`。
     */
    function formatClock(at) {
      var date = at instanceof Date ? at : new Date(at);
      if (isNaN(date.getTime())) return "--:--:--";
      function pad(value) { return value < 10 ? "0" + value : "" + value }
      return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
    }

    /**
     * 毫秒 → 人读时长(一次请求的总耗时只含上游尝试,不含路由内退避等待)。
     * @param ms - 毫秒数。
     * @returns `120ms` / `1.9s` / `4m30s` 这样的短串。
     */
    function formatDuration(ms) {
      if (!Number.isFinite(ms) || ms < 0) return "—";
      if (ms < 1000) return Math.round(ms) + "ms";
      if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + "s";
      return Math.floor(ms / 60000) + "m" + Math.round((ms % 60000) / 1000) + "s";
    }

    /**
     * 重试策略一行摘要(来自端点的扁平 `retry`)。
     * @param t - 翻译函数。
     * @param retry - 端点响应里的 `retry`(可缺省)。
     * @returns 一行中文/英文摘要。
     */
    function retrySummary(t, retry) {
      if (!retry || typeof retry !== "object") return "";
      if (!(retry.maxRetries > 0)) return String(t("retryOff"));
      return tr(t, "retryLine", {
        max: retry.maxRetries,
        initial: retry.initialDelayMs,
        maxDelay: retry.maxDelayMs
      });
    }

    /**
     * 金额 → 面板上的短串(两位小数;拿不到数字时给 `?`,**绝不用 0 顶替**)。
     * @param value - 数字或 null。
     * @returns 形如 `$59.92` / `?`。
     */
    function formatMoney(value) {
      return Number.isFinite(value) ? "$" + value.toFixed(2) : "?";
    }

    /**
     * 重置时间 → `MM-DD HH:mm`(本地时区)。
     *
     * ⚠ 两种口径都要吃:Command Code 的 `resetAt` 是**毫秒时间戳**(数字),
     * OpenCode Go 的 `resetsAt` 是 **ISO 串** —— 写死一种就会让一家在界面上变成空。
     * @param value - 毫秒数或 ISO 串。
     * @returns 短串;解析不了给空串(调用方据此不显示这一段)。
     */
    function formatResetAt(value) {
      var date = new Date(value);
      if (isNaN(date.getTime())) return "";
      function pad(item) { return item < 10 ? "0" + item : "" + item }
      return pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
    }

    /**
     * 一档窗口 → `5h $0.62/$14`(Command Code:used/cap 同单位,都是美元等值)。
     * @param t - 翻译函数。
     * @param labelKey - 窗口名的字典键。
     * @param used - 已用。
     * @param cap - 上限。
     * @returns 一段短串。
     */
    function windowPart(t, labelKey, used, cap) {
      return String(t(labelKey)) + " " + formatMoney(used) + "/" + formatMoney(cap);
    }

    /**
     * 一家来源 → 面板上的一行。
     *
     * 两家口径不同,分开写:Command Code 是**美元池**(余额 + 两档窗口),OpenCode Go 是
     * **百分比窗口**(三档,且 `status === 'rate-limited'` 表示该档**已耗尽** —— 服务端会把
     * percent 硬编码成 100,所以这里显示"已耗尽"而不是"100%",更不能显示成 0%)。
     * @param source - 端点 `quota.sources[]` 的一项。
     * @param t - 翻译函数。
     * @returns `{ key, label, tone, main, detail }`;不可查时 main 为空串、detail 给原因。
     */
    function quotaRow(source, t) {
      var provider = source && source.provider ? String(source.provider) : "";
      var label = provider === "commandcode" ? String(t("quotaCmdCode")) : provider === "opencode-go" ? String(t("quotaGo")) : provider;
      if (!source || source.status !== "ok") {
        // 没有 message 时给一句光秃秃的"不可查",不要拼成"不可查:不可查"。
        var message = source && typeof source.message === "string" ? source.message : "";
        return { key: provider, label: label, tone: "quiet", main: "", detail: message.length > 0 ? tr(t, "quotaUnavailableReason", { reason: message }) : String(t("quotaUnavailable")) };
      }
      if (provider === "commandcode") {
        var credits = source.credits || {};
        var windows = source.windows || {};
        // 算不出总额就不画"余额"那一段(宿主在这种情况下**不带** total 键,不是给 0)。
        var parts = [];
        if (Number.isFinite(credits.total)) parts.push(tr(t, "quotaBalance", { amount: formatMoney(credits.total) }));
        if (windows.fiveHour) parts.push(windowPart(t, "quotaWindow5h", windows.fiveHour.used, windows.fiveHour.cap));
        if (windows.weekly) parts.push(windowPart(t, "quotaWindowWeek", windows.weekly.used, windows.weekly.cap));
        var plan = source.plan && typeof source.plan.planId === "string" ? source.plan.planId : "";
        return { key: provider, label: label, tone: credits.belowThreshold === true ? "danger" : "quiet", main: parts.join(" · "), detail: plan };
      }
      var go = source.windows || {};
      var order = [["rolling", "quotaWindow5h"], ["weekly", "quotaWindowWeek"], ["monthly", "quotaWindowMonth"]];
      var goParts = [];
      var exhaustedAt = "";
      var limited = false;
      for (var i = 0; i < order.length; i++) {
        var win = go[order[i][0]];
        if (!win) continue;
        if (win.status === "rate-limited") {
          limited = true;
          goParts.push(String(t(order[i][1])) + " " + String(t("quotaExhausted")));
          if (exhaustedAt.length === 0) exhaustedAt = formatResetAt(win.resetsAt);
        } else {
          goParts.push(String(t(order[i][1])) + " " + (win.percent === null || win.percent === undefined ? "?" : String(win.percent) + "%"));
        }
      }
      var detail = exhaustedAt.length > 0 ? tr(t, "quotaReset", { at: exhaustedAt }) : String(t("quotaNoAmount"));
      return { key: provider, label: label, tone: limited ? "danger" : "quiet", main: goParts.join(" · "), detail: detail };
    }

    /**
     * 额度段 → 渲染模型(纯函数,不碰 DOM;单测直接调它)。
     *
     * 返回 null 表示**这一段整个不画**:端点没有 `quota`(旧宿主)、额度被关掉(state disabled)、
     * 或链上没有任何本模块认识的来源。面板因此天然兼容新旧宿主。
     * @param quota - 端点响应的 `quota`。
     * @param t - 翻译函数。
     * @returns `{ pending, meta, rows }` 或 null。
     */
    function formatQuota(quota, t) {
      if (!quota || typeof quota !== "object") return null;
      if (quota.state === "disabled") return null;
      var sources = Array.isArray(quota.sources) ? quota.sources : [];
      // "查询中"只认 `inFlight`:链上没有任何本模块认识的 provider 时宿主永远不会落定
      // checkedAt(它压根没得查)⇒ 只看 state 会画出一个**永久**的"额度查询中…"。
      var pending = quota.state === "pending" && quota.inFlight === true;
      if (sources.length === 0 && !pending) return null;
      var rows = [];
      for (var i = 0; i < sources.length; i++) rows.push(quotaRow(sources[i], t));
      var meta = rows.length === 0
        ? String(t("quotaPending"))
        : (typeof quota.checkedAt === "string" && quota.checkedAt.length > 0 ? tr(t, "quotaMeta", { at: formatClock(quota.checkedAt) }) : "");
      return { pending: pending, meta: meta, rows: rows };
    }

    /**
     * 被耗尽窗口的**固定枚举 id** → 面板上的名字。
     *
     * ⚠ 只认这几个 id(与宿主侧同一个白名单,见 lib/ordering.js 的 `WINDOW_IDS`),**绝不**把上游
     * 给的窗口名透传上来 —— 那是自由文本,上游换个形状就会在界面上显示一串英文键名。
     * `credits` 是宿主给 Command Code 月度余额那一档合成的 id(它不是上游的窗口键)。
     * @param id - 宿主给的窗口 id。
     * @param t - 翻译函数。
     * @returns 窗口名;认不出的 id 给空串(调用方据此退回中性说法)。
     */
    function coolingWindowName(id, t) {
      if (id === "rolling" || id === "fiveHour") return String(t("orderingWindow5h"));
      if (id === "weekly") return String(t("orderingWindowWeek"));
      if (id === "monthly") return String(t("orderingWindowMonth"));
      if (id === "credits") return String(t("orderingWindowCredits"));
      return "";
    }

    /**
     * 端点条目里的被耗尽窗口 → 「月度」这样的短串(多个用 ` / ` 连;去重,保持宿主给的顺序)。
     * @param windows - 端点条目的 `windows`(id 数组;可省)。
     * @param t - 翻译函数。
     * @returns 短串;一个都认不出时给空串。
     */
    function coolingWindowNames(windows, t) {
      var names = [];
      var list = Array.isArray(windows) ? windows : [];
      for (var i = 0; i < list.length; i++) {
        var name = coolingWindowName(list[i], t);
        if (name.length > 0 && names.indexOf(name) === -1) names.push(name);
      }
      return names.join(" / ");
    }

    /**
     * 一条实际顺序的条目 → 面板上的一行。
     *
     * 三种状态各自有明确说法(设计档 §7),免得用户把"行为"当成"故障":
     *  · 冷却中 ⇒ `cooling` + 「冷却中」标签 + "哪一档打满"(固定枚举的 `windows`)+ 解除时刻;
     *  · 未知档 ⇒ 「额度查不到,按配置顺序」;
     *  · 其余 ⇒ 只画标签(越早重置越靠前这件事由整段的提示语说明,不必每行重复)。
     * @param entry - 端点 `ordering.effective[]` 的一项(`{ label, provider, reason, cooling?, until?, windows? }`)。
     * @param t - 翻译函数。
     * @returns `{ key, label, tone, tag, detail, cooling }`。
     */
    function orderingRow(entry, t) {
      var item = entry && typeof entry === "object" ? entry : {};
      var known = typeof item.label === "string" && item.label.length > 0 ? item.label : String(item.provider || "");
      var at = item.until === undefined || item.until === null ? "" : formatResetAt(item.until);
      if (item.cooling === true) {
        // 「哪一档打满」优先:宿主给了固定枚举 id 就写"月度已耗尽";认不出来(或老宿主没有这个键)
        // 就退回中性的"额度已耗尽"、再不然只写解除时刻 —— 绝不显示裸键名,也绝不编一档出来。
        var names = coolingWindowNames(item.windows, t);
        var reason = names.length > 0
          ? tr(t, "orderingExhaustedWindow", { window: names })
          : (Array.isArray(item.windows) ? String(t("orderingExhausted")) : "");
        var reset = at.length > 0 ? tr(t, "orderingCooling", { at: at }) : "";
        return {
          key: "ordering-" + known,
          label: known,
          tone: "danger",
          tag: String(t("orderingCoolingTag")),
          detail: reason.length === 0 ? reset : (reset.length === 0 ? reason : reason + "," + reset),
          cooling: true
        };
      }
      return {
        key: "ordering-" + known,
        label: known,
        tone: "quiet",
        tag: "",
        detail: item.reason === "unknown" ? String(t("orderingUnknown")) : "",
        cooling: false
      };
    }

    /**
     * 端点 `ordering` 字段 → 渲染模型(纯函数,不碰 DOM;单测直接调它)。
     *
     * 返回 null 表示**这一段整个不画**(旧宿主没有 `ordering` 键)⇒ 面板天然兼容新旧宿主。
     * ⚠ `manual` 模式下**只**给一行说明,不渲染 `effective`(设计档 §7:手动时那个顺序没有意义)。
     * ⚠ 冷却标记与额度段的「已耗尽」可能同时出现 —— 一个是**行为**、一个是**观测**,两者都对。
     * @param ordering - 端点响应的 `ordering`。
     * @param t - 翻译函数。
     * @returns `{ mode, manual, hint, rows, note }` 或 null。
     */
    function formatOrdering(ordering, t) {
      if (!ordering || typeof ordering !== "object") return null;
      var manual = ordering.mode === "manual";
      var note = "";
      if (manual) {
        return { mode: "manual", manual: true, hint: String(t("orderingManualNote")), rows: [], note: note };
      }
      var effective = Array.isArray(ordering.effective) ? ordering.effective : [];
      var rows = [];
      for (var i = 0; i < effective.length; i++) rows.push(orderingRow(effective[i], t));
      if (ordering.ignoredCooldown === true) note = String(t("orderingIgnoredCooling"));
      return { mode: "auto", manual: false, hint: "", rows: rows, note: note };
    }

    /**
     * 「回退链」卡片的分区计划(0.9.0:合并 0.8.0 的「自动排序」段与链编辑器,**按模式显示**)。
     *
     * 模式决定主视图:
     *  · `auto`   ⇒ 主视图是**生效顺序**(插件排出来的实际尝试顺序,含冷却/未知档说明),
     *              可编辑的配置链折进一个默认收起的「配置顺序」折叠项(点开照旧可拖可改);
     *  · `manual` ⇒ 主视图就是可编辑的配置链,不画生效顺序(那种模式本来就不排序);
     *  · 拿不到 `ordering`(旧宿主没这个键、或端点还没读回来)⇒ 退回 `manual` 形态,
     *              与 0.8.0 之前的界面一致(面板天然兼容新旧宿主)。
     * 提示语随模式换:`chainHint` 那句"按下面的顺序…"只在手动模式下成立(auto 会排序、会跳过),
     * 所以自动模式换成 `chainHintAuto`。
     * @param ordering - 端点响应的 `ordering`(可缺省)。
     * @param t - 翻译函数。
     * @returns `{ view, manual, hint, collapsible, rows, note }`。
     */
    function chainSectionPlan(ordering, t) {
      var view = formatOrdering(ordering, t);
      var manual = view === null || view.manual === true;
      return {
        view: view,
        manual: manual,
        hint: String(manual ? t("chainHint") : t("chainHintAuto")),
        // 只有自动模式把配置链折起来 —— 手动模式下它本来就是主视图,折了等于没内容
        collapsible: !manual,
        rows: manual ? [] : view.rows,
        note: manual ? "" : view.note
      };
    }

    /**
     * 切换排序模式要发的写操作(与 {@link resetChainOps} 同口径:路径限定,只写这一个键)。
     * @param mode - 目标模式(`auto` / `manual`)。
     * @returns 一个新的 ops 数组。
     */
    function orderingModeOps(mode) {
      return [{ op: "set", path: ["ordering"], value: { mode: mode === "manual" ? "manual" : "auto" } }];
    }

    /**
     * profile 层是否覆盖了 `routes`(宿主 `/routes` 响应的 `user.routes`)。
     *
     * 判据必须是"**确有一份覆盖**",不能放宽成"链上有东西就显示":那个按钮发的是
     * `unset routes`,没有覆盖时点它等于空写一次,徒增一次 revision 冲突的机会。
     * 宿主的 `user` 只在确有覆盖时出现(见宿主 `computeUserRoutes()`);这里再要求它是
     * **非空数组** —— 形状不对就不画按钮,宁可少一个控件也不误报。
     * @param data - `/routes` 的响应体。
     * @returns 该显示「恢复包内默认链」时为 true。
     */
    function canResetChain(data) {
      var user = data && data.user;
      return !!(user && typeof user === "object" && Array.isArray(user.routes) && user.routes.length > 0);
    }

    /**
     * 「恢复包内默认链」要发的写操作。
     *
     * 路径**限定在 `routes`**:同一次保存里 compactWindow 有自己的 op,别的键一个都不碰。
     * 单列成函数是为了让测试能钉住 op 的形状(见 test/client.test.mjs)。
     * @returns 一个新的 ops 数组。
     */
    function resetChainOps() {
      return [{ op: "unset", path: ["routes"] }];
    }

    /**
     * 拉一次端点(只读)。
     *
     * 不 catch 掉响应体解析错误之外的情况:非 200、JSON 解析失败、网络错误都会变成
     * `status: 'error'`,面板据原样显示(插件没加载时正是排查入口)。
     * @param path - 端点路径。
     * @param onDone - `(next) => void`,收到 `{ status, data, error }` 之一。
     */
    function loadJson(path, onDone) {
      fetch(path, { headers: { accept: "application/json" } }).then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      }).then(function (json) {
        onDone({ status: "ready", data: json, error: null });
      }).catch(function (error) {
        onDone({ status: "error", data: null, error: String(error && error.message || error) });
      });
    }

    /** 一次请求的结局 → 状态点语义(失败与取消都要和"成功"一眼区分)。 */
    function outcomeState(outcome) {
      if (outcome === "ok") return "done";
      if (outcome === "aborted") return "idle";
      return "error";
    }

    /** 一次请求的结局 → 标签色调。 */
    function outcomeTone(outcome) {
      if (outcome === "ok") return "success";
      if (outcome === "aborted") return "quiet";
      return "danger";
    }

    /**
     * `provider/model` 字符串拆成两段。
     *
     * ⚠ **按第一个斜杠拆**,不是最后一个:本机的 model id 里带斜杠(commandcode 那两条是
     * `deepseek/deepseek-v4.1-flash`),按最后一个拆会把 provider 认成 `commandcode/deepseek`。
     * 端点给的是对象形状(0.6.0 起带 options),这里只兜老端点/裸字符串。
     * @param label - `provider/model`。
     * @returns `{ provider, model }`;没有斜杠时 provider 为空串。
     */
    function splitLabel(label) {
      var text = String(label);
      var at = text.indexOf("/");
      return at < 0 ? { provider: "", model: text } : { provider: text.slice(0, at), model: text.slice(at + 1) };
    }

    /**
     * 草稿条目的配置形状(逐条开关**打开才写**,与宿主 lib/routes.js 的 toRouteConfig 同口径)。
     * @param draft - 一条草稿条目。
     * @returns `{ provider, model, keepThinking?, breakToolLoop? }`。
     */
    function draftToConfig(draft) {
      var route = { provider: draft.provider, model: draft.model };
      for (var i = 0; i < OPTION_KEYS.length; i++) {
        if (draft[OPTION_KEYS[i]] === true) route[OPTION_KEYS[i]] = true;
      }
      return route;
    }

    /** 整条草稿链 → 配置形状(保存前用)。 */
    function draftToChain(drafts) {
      return drafts.map(draftToConfig);
    }

    /** 两条链是否逐项等价(JSON 逐字比:两边字段序一致,见 lib/routes.js 的同款理由)。 */
    function sameChain(left, right) {
      return JSON.stringify(left) === JSON.stringify(right);
    }

    /**
     * 端点 `chain` 的每一项 → 草稿条目。
     * @param item - `{ label, options? }`(0.6.0)或裸字符串 `provider/model`(0.5.x 兜底)。
     * @param key - 稳定身份(React 列表与拖拽用)。
     * @returns 一条草稿条目。
     */
    function routeFromEndpoint(item, key) {
      if (typeof item === "string") {
        var split = splitLabel(item);
        return { key: key, provider: split.provider, model: split.model, keepThinking: false, breakToolLoop: false };
      }
      var parsed = splitLabel(item && item.label !== undefined ? item.label : "");
      var options = (item && item.options) || {};
      return {
        key: key,
        provider: parsed.provider,
        model: parsed.model,
        keepThinking: options.keepThinking === true,
        breakToolLoop: options.breakToolLoop === true
      };
    }

    /** 已打开的逐条开关 → 面板上的一行小结(没开的返回空串)。 */
    function optionSummary(draft) {
      var on = [];
      for (var i = 0; i < OPTION_KEYS.length; i++) {
        if (draft[OPTION_KEYS[i]] === true) on.push(OPTION_KEYS[i]);
      }
      return on.join(" · ");
    }

    /**
     * 大小写不敏感的有序子序列匹配(与官方 \`rankByName\` 同一判据),用来过滤模型列表。
     * @param text - 候选文本。
     * @param query - 已 trim 的查询串(空串表示不过滤)。
     * @returns 命中为 true。
     */
    function matchesQuery(text, query) {
      if (query.length === 0) return true;
      var haystack = String(text).toLowerCase();
      var needle = query.toLowerCase();
      var at = 0;
      for (var i = 0; i < needle.length; i++) {
        var found = haystack.indexOf(needle.charAt(i), at);
        if (found < 0) return false;
        at = found + 1;
      }
      return true;
    }

    /**
     * 目录分组 → 过滤后的分组(空组丢掉;查询命中 provider 名时整组保留,方便"先选 provider")。
     * @param groups - 端点 `catalog.groups`。
     * @param query - 原始查询串。
     * @returns 过滤后的分组数组。
     */
    function filterGroups(groups, query) {
      var needle = String(query || "").trim();
      if (needle.length === 0) return groups;
      var kept = [];
      for (var i = 0; i < groups.length; i++) {
        var group = groups[i];
        if (matchesQuery(group.name || group.id, needle) || matchesQuery(group.id, needle)) {
          kept.push(group);
          continue;
        }
        var models = (group.models || []).filter(function (model) { return matchesQuery(model.name || model.id, needle) });
        if (models.length > 0) kept.push({ id: group.id, name: group.name, models: models });
      }
      return kept;
    }

    /**
     * 一个小图标(只画在 16px 视框里,颜色继承 \`currentColor\`)。
     * 面板自带的几个形状都很简单,不值得为它们引官方图标包(那也要多记几个导出名)。
     * @param props - `{ d, size, className }`。
     * @returns svg 元素。
     */
    function Glyph(props) {
      return jsxRuntime.jsx("svg", {
        width: props.size || 14,
        height: props.size || 14,
        viewBox: "0 0 16 16",
        "aria-hidden": "true",
        focusable: "false",
        className: props.className,
        children: jsxRuntime.jsx("path", { d: props.d, fill: "currentColor" })
      });
    }
    /** 勾选(菜单里标"当前项")。 */
    var PATH_CHECK = "M13.3 4.3a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.4 0l-3-3a1 1 0 1 1 1.4-1.4L6.6 9.6l5.3-5.3a1 1 0 0 1 1.4 0Z";
    /** 拖拽手柄(六点)。 */
    var PATH_GRIP = "M6 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 3.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 3.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm6-7a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 3.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 3.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z";
    /** 小三角(展开/收起)。 */
    var PATH_CHEVRON = "M4.3 6.3a1 1 0 0 1 1.4 0L8 8.6l2.3-2.3a1 1 0 1 1 1.4 1.4l-3 3a1 1 0 0 1-1.4 0l-3-3a1 1 0 0 1 0-1.4Z";
    /** 叉(删除 / 清空搜索)。 */
    var PATH_CLOSE = "M4.3 4.3a1 1 0 0 1 1.4 0L8 6.6l2.3-2.3a1 1 0 1 1 1.4 1.4L9.4 8l2.3 2.3a1 1 0 1 1-1.4 1.4L8 9.4l-2.3 2.3a1 1 0 1 1-1.4-1.4L6.6 8 4.3 5.7a1 1 0 0 1 0-1.4Z";
    /** 上移 / 下移(键盘可达的排序入口)。 */
    var PATH_UP = "M8 3.3 12 7.3a1 1 0 0 1-1.4 1.4L8 6.1 5.4 8.7A1 1 0 1 1 4 7.3l4-4Z";
    var PATH_DOWN = "M8 12.7 4 8.7a1 1 0 0 1 1.4-1.4L8 9.9l2.6-2.6A1 1 0 1 1 12 8.7l-4 4Z";
    /** 加号。 */
    var PATH_PLUS = "M8 3a1 1 0 0 1 1 1v3h3a1 1 0 1 1 0 2H9v3a1 1 0 1 1-2 0V9H4a1 1 0 1 1 0-2h3V4a1 1 0 0 1 1-1Z";

    /**
     * 把一个页面侧的错误原文报给宿主的诊断端点(fire-and-forget)。
     *
     * 这是本半侧唯一的"写"请求,但它写的只是宿主内存里的诊断缓冲:不碰配置、不碰凭据。
     * 自己抛错就违背了这条通道的用途 ⇒ 所有异常都在这里吞掉。
     * @param where - 出错位置标签(例如 apply / render:ChainPanel)。
     * @param detail - 错误对象、字符串或任意值。
     * @param extra - 附加上下文(键值对,一并存档)。
     */
    function reportDiag(where, detail, extra) {
      try {
        var message = "";
        var stack = "";
        if (detail instanceof Error) {
          message = String(detail.message || detail);
          stack = String(detail.stack || "");
        } else {
          message = String(detail);
        }
        var payload = {
          where: String(where),
          message: message.slice(0, DIAG_TEXT_LIMIT),
          stack: stack.slice(0, DIAG_TEXT_LIMIT)
        };
        if (extra !== undefined && extra !== null) {
          try {
            payload.extra = JSON.parse(JSON.stringify(extra).slice(0, DIAG_TEXT_LIMIT));
          } catch (ignored) {
            payload.extra = { unserializable: true };
          }
        }
        if (typeof fetch !== "function") return;
        fetch(DIAG_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        }).catch(function () { /* 通道自己失败就算了,不能影响页面 */ });
      } catch (ignored) { /* 同上 */ }
    }

    /** 装上全局错误钩子(只装一次;模块重载会重复调用,用哨兵位挡掉)。 */
    function installGlobalDiag() {
      if (typeof window === "undefined" || window.__llmAutoDiagInstalled === true) return;
      window.__llmAutoDiagInstalled = true;
      window.addEventListener("error", function (event) {
        reportDiag("window.onerror", (event && event.error) || String((event && event.message) || "unknown"), {
          source: event && event.filename,
          line: event && event.lineno,
          column: event && event.colno
        });
      });
      window.addEventListener("unhandledrejection", function (event) {
        reportDiag("unhandledrejection", (event && event.reason) || "unknown");
      });
    }

    /**
     * 给一个组件套错误边界:渲染期抛错时**上报**并在原位显示一小段文字。
     *
     * 没有它的话,React 渲染抛错只在控制台留一行、界面上什么都没有 —— 桌面端看不到控制台,
     * 这正是"配置段整段不出现"最难查的地方。
     * @param name - 组件名(上报与显示都用它)。
     * @param Component - 被包裹的组件。
     * @returns 带边界的组件。
     */
    function withDiag(name, Component) {
      var Guarded = class extends react.Component {
        constructor(props) {
          super(props);
          this.state = { failed: null };
        }
        static getDerivedStateFromError(error) {
          return { failed: error };
        }
        componentDidCatch(error, info) {
          reportDiag("render:" + name, error, { componentStack: info && info.componentStack });
        }
        render() {
          if (this.state.failed === null) return jsxRuntime.jsx(Component, this.props);
          return jsxRuntime.jsxs("div", { className: "la-chain-error", children: [
            activeT("renderFailed"),
            jsxRuntime.jsx("div", { className: "la-chain-empty", children: String((this.state.failed && this.state.failed.message) || this.state.failed) })
          ] });
        }
      };
      Guarded.displayName = "Diag(" + name + ")";
      return Guarded;
    }

    /**
     * 供应商档案(链编辑器的模型选择器读它)。
     *
     * 打开面板时拉一次并缓存;失败时给出可读原因(面板上还有「刷新」重试)。
     * @returns `{ status, groups, failures, error, reload }`。
     */
    function useCatalog() {
      var pair = react.useState({ status: "loading", groups: [], failures: [], error: null });
      var state = pair[0];
      var setState = pair[1];
      var reload = react.useCallback(function () {
        setState(function (prev) { return { status: "loading", groups: prev.groups, failures: prev.failures, error: null } });
        loadJson(CATALOG_PATH, function (next) {
          if (next.status === "error") setState({ status: "error", groups: [], failures: [], error: next.error });
          else {
            var data = next.data || {};
            setState({
              status: "ready",
              groups: Array.isArray(data.groups) ? data.groups : [],
              failures: Array.isArray(data.failures) ? data.failures : [],
              error: null
            });
          }
        });
      }, []);
      react.useEffect(function () { reload(); }, [reload]);
      return { status: state.status, groups: state.groups, failures: state.failures, error: state.error, reload: reload };
    }

    /**
     * 模型选择器:与主页模型菜单同构(搜索行 + 按 provider 分组 + 当前项打勾)。
     *
     * 用官方 MenuSurface 拿材质(半透明填充 + 背景模糊 + 圆角),分组标题用 MenuGroup
     * (滚动时自动吸附,但要求分组是"无内边距滚动容器"的直接子节点 ⇒ 这里让
     * \`.la-picker-groups\` 自己不设 padding,行自带内边距)。
     * @param props - `{ t, groups, failures, current, taken, onPick, onClose }`;
     *   `taken` 是"整条链上已经有的 provider\u0000model"集合 —— 同一组合再加一遍会被宿主
     *   静默去重(只留第一条),所以这里直接把它标成不可选,不让用户白加。
     * @returns 菜单元素。
     */
    function ModelPicker(props) {
      var t = props.t;
      var queryPair = react.useState("");
      var query = queryPair[0];
      var setQuery = queryPair[1];
      if (typeof document !== "undefined") {
        // 打开时聚焦搜索框(与官方的"drilling 聚焦搜索"一致)
        react.useEffect(function () {
          var input = document.querySelector(".la-picker-search input");
          if (input) input.focus();
        }, []);
      }
      var filtered = filterGroups(props.groups || [], query);
      var visible = false;
      for (var i = 0; i < filtered.length; i++) if ((filtered[i].models || []).length > 0) visible = true;

      var head = jsxRuntime.jsx("div", { className: "la-picker-head", children: tr(t, "addModelTitle") });
      var searchRow = jsxRuntime.jsxs("div", { className: "la-picker-rowextra la-picker-searchrow", children: [
        jsxRuntime.jsx("span", { className: "la-picker-search", children: jsxRuntime.jsx("input", {
          type: "text",
          value: query,
          placeholder: t("pickerSearch"),
          "aria-label": t("pickerSearch"),
          onChange: function (event) { setQuery(event.target.value); },
          onKeyDown: function (event) { if (event.key === "Escape") { event.stopPropagation(); props.onClose(); } }
        }) }),
        query.length > 0
          ? jsxRuntime.jsx("button", {
              type: "button",
              className: "la-picker-clear",
              title: t("pickerClear"),
              "aria-label": t("pickerClear"),
              onClick: function () { setQuery(""); },
              children: jsxRuntime.jsx(Glyph, { d: PATH_CLOSE, size: 12 })
            })
          : null
      ] });

      var sections = filtered.map(function (group) {
        var models = group.models || [];
        if (models.length === 0) return null;
        return jsxRuntime.jsxs(primitives.MenuGroup, { label: group.name || group.id, children: models.map(function (model) {
          var picked = props.current && props.current.provider === group.id && props.current.model === model.id;
          var taken = picked !== true && props.taken !== undefined && props.taken[group.id + "\u0000" + model.id] === true;
          return jsxRuntime.jsxs("button", {
            type: "button",
            role: "menuitem",
            className: "la-picker-option" + (picked ? " la-picker-option-on" : "") + (taken ? " la-picker-option-taken" : ""),
            disabled: taken,
            title: taken ? t("alreadyOnChain") : undefined,
            onClick: function () { props.onPick(group.id, model.id); },
            children: [
              jsxRuntime.jsxs("span", { className: "la-picker-copy", children: [
                jsxRuntime.jsx("span", { className: "la-picker-name", children: model.name || model.id }),
                model.description ? jsxRuntime.jsx("span", { className: "la-picker-desc", children: model.description }) : null
              ] }),
              jsxRuntime.jsx("span", { className: "la-picker-check", children: picked ? jsxRuntime.jsx(Glyph, { d: PATH_CHECK, size: 14 }) : null }),
              taken ? jsxRuntime.jsx("span", { className: "la-picker-taken", children: t("alreadyOnChain") }) : null
            ]
          }, group.id + "/" + model.id);
        }) }, group.id);
      });

      var body = [];
      if (props.failures && props.failures.length > 0) {
        body.push(jsxRuntime.jsx("div", { className: "la-picker-note", key: "failed", children: tr(t, "pickerFailedGroups", {
          list: props.failures.map(function (failure) { return failure.id; }).join(", ")
        }) }));
      }
      if (!visible) {
        body.push(jsxRuntime.jsx("div", { className: "la-picker-empty", key: "empty", children: query.length > 0 ? tr(t, "pickerNoMatch", { query: query }) : t("pickerEmpty") }));
      }
      body.push(jsxRuntime.jsx("div", { className: "la-picker-groups", key: "groups", "data-la-picker": "groups", children: sections }));

      return jsxRuntime.jsxs(primitives.MenuSurface, {
        className: "la-picker",
        "data-la-picker": "panel",
        role: "menu",
        children: [head, searchRow].concat(body)
      });
    }

    /**
     * 链上的一行。
     *
     * 拖拽用 pointer events 自己实现(官方原语里没有可排序列表,而 HTML5 DnD 在
     * 桌面 WebView 里对"行内按钮"的命中判定很脆)。手柄负责拖,行内其他控件照常点击;
     * 键盘用 Alt+↑/↓ 与手柄按钮(见 lib/client.js 的 \`onKeyDown\`)。
     * @param props - `{ t, draft, index, total, label, known, onMove, onPick, onToggle, onRemove, dragging, onDragState }`。
     * @returns 一行。
     */
    function RouteRow(props) {
      var t = props.t;
      var draft = props.draft;
      var index = props.index;
      var openPair = react.useState(false);
      var optionsOpen = openPair[0];
      var setOptionsOpen = openPair[1];
      var label = props.label || (draft.provider + "/" + draft.model);

      function startDrag(event) {
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault();
        var drag = { index: index, y0: event.clientY, x0: event.clientX, active: false };
        function onMove(moveEvent) {
          if (!drag.active) {
            if (Math.abs(moveEvent.clientY - drag.y0) < DRAG_THRESHOLD_PX && Math.abs(moveEvent.clientX - drag.x0) < DRAG_THRESHOLD_PX) return;
            drag.active = true;
            props.onDragState(true);
          }
          var row = document.querySelector('[data-la-row="' + index + '"]');
          if (!row) return;
          var step = row.getBoundingClientRect().height + 4;
          var offset = Math.round((moveEvent.clientY - drag.y0) / step);
          var to = Math.max(0, Math.min(props.total - 1, drag.index + offset));
          if (to !== drag.index) {
            props.onMove(drag.index, to);
            drag.index = to;
            drag.y0 = moveEvent.clientY;
          }
        }
        function onUp() {
          document.removeEventListener("pointermove", onMove);
          document.removeEventListener("pointerup", onUp);
          props.onDragState(false);
        }
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
      }

      var handle = jsxRuntime.jsx("span", {
        className: "la-grip",
        role: "button",
        tabIndex: 0,
        title: t("dragHandle"),
        "aria-label": t("dragHandle"),
        onPointerDown: startDrag,
        onKeyDown: function (event) {
          if (event.altKey && event.key === "ArrowUp") { event.preventDefault(); props.onMove(index, index - 1); }
          if (event.altKey && event.key === "ArrowDown") { event.preventDefault(); props.onMove(index, index + 1); }
        },
        children: jsxRuntime.jsx(Glyph, { d: PATH_GRIP })
      });

      var moveButtons = jsxRuntime.jsxs("span", { className: "la-nudge", children: [
        jsxRuntime.jsx("button", {
          type: "button", className: "la-nudge-btn", disabled: index === 0,
          title: t("moveUp"), "aria-label": t("moveUp"),
          onClick: function () { props.onMove(index, index - 1); },
          children: jsxRuntime.jsx(Glyph, { d: PATH_UP, size: 12 })
        }),
        jsxRuntime.jsx("button", {
          type: "button", className: "la-nudge-btn", disabled: index === props.total - 1,
          title: t("moveDown"), "aria-label": t("moveDown"),
          onClick: function () { props.onMove(index, index + 1); },
          children: jsxRuntime.jsx(Glyph, { d: PATH_DOWN, size: 12 })
        })
      ] });

      var summary = optionSummary(draft);
      var modelButton = jsxRuntime.jsxs("button", {
        type: "button",
        className: "la-row-model",
        title: t("pickModelTitle"),
        "aria-label": t("pickModelTitle"),
        "data-la-anchor": "row-" + index,
        onClick: function () { props.onPick(index, "row-" + index); },
        children: [
          jsxRuntime.jsx("span", { className: "la-row-name", children: label }),
          props.known === false ? jsxRuntime.jsx(primitives.Tag, { tone: "warning", children: t("notInCatalog") }) : null,
          summary.length > 0 ? jsxRuntime.jsx("span", { className: "la-row-on", children: summary }) : null,
          jsxRuntime.jsx(Glyph, { d: PATH_CHEVRON, size: 12, className: "la-row-chevron" })
        ]
      });

      var optionsToggle = jsxRuntime.jsxs("button", {
        type: "button",
        className: "la-row-options",
        "aria-expanded": optionsOpen,
        onClick: function () { setOptionsOpen(!optionsOpen); },
        children: [t("optionsToggle"), jsxRuntime.jsx(Glyph, { d: PATH_CHEVRON, size: 12, className: optionsOpen ? "la-row-chevron la-row-chevron-open" : "la-row-chevron" })]
      });

      var removeButton = jsxRuntime.jsx("button", {
        type: "button",
        className: "la-row-remove",
        title: t("removeRoute"),
        "aria-label": t("removeRoute"),
        disabled: props.total <= 1,
        onClick: function () { props.onRemove(index); },
        children: jsxRuntime.jsx(Glyph, { d: PATH_CLOSE, size: 12 })
      });

      var optionPanel = optionsOpen
        ? jsxRuntime.jsx("div", { className: "la-row-optpanel", children: OPTION_KEYS.map(function (key) {
            return jsxRuntime.jsxs("div", { className: "la-opt", children: [
              jsxRuntime.jsxs("span", { className: "la-opt-text", children: [
                jsxRuntime.jsx("span", { className: "la-opt-name", children: t(key) }),
                jsxRuntime.jsx("span", { className: "la-opt-hint", children: t(key + "Hint") })
              ] }),
              jsxRuntime.jsx(primitives.Switch, {
                checked: draft[key] === true,
                label: t(key),
                onChange: function () { props.onToggle(index, key); }
              })
            ] }, key);
          }) })
        : null;

      return jsxRuntime.jsxs("div", {
        className: "la-row" + (props.dragging ? " la-row-dragging" : ""),
        "data-la-row": index,
        children: [
          jsxRuntime.jsxs("div", { className: "la-row-main", children: [handle, modelButton, moveButtons, optionsToggle, removeButton] }),
          optionPanel
        ]
      });
    }

    /**
     * 「回退链」面板(0.6.0:可编辑)。
     *
     * 状态自己做主:链与最近请求来自端点(打开拉一次、可手动刷新),草稿就是本地 state,
     * 保存/放弃按钮只在"草稿与端点不一致"时出现。写配置走官方设置服务
     * (\`props.chain.mutate\`),本组件不直接碰 HTTP 写路径。
     * @param props - `{ t, form, settings }`;`form.mutate(ops)` 提交一次原子写、
     *   `form.onSaved()` 让上层清掉 compactWindow 的暂存;`settings` 是上层拿到的设置表单快照
     *   状态(`{ available, writable, reason, mode }`)—— 面板据此决定能不能改,并在不能改时
     *   **显示原因**(而不是静默什么都不长:0.4.0–0.5.x 就是这么静默的,实测排查花了几轮)。
     * @returns 面板。
     */
    function ChainPanel(props) {
      var t = props.t;
      // form 由槽位的 inject 结果给(`chain`)。它缺失时**不要**整段炸掉:给一个本地降级替身,
      // 面板照常显示链与最近请求,只是不能保存(并把这件事写在面板上)。
      var form = props.form === undefined || props.form === null ? {
        isDirty: function () { return false; },
        takeOps: function () { return []; },
        mutate: function () { return Promise.resolve(false); },
        onSaved: function () {},
        discardEdits: function () {}
      } : props.form;
      var formMissing = props.form === undefined || props.form === null;
      var catalog = useCatalog();
      var pair = react.useState({ status: "loading", data: null, error: null });
      var state = pair[0];
      var setState = pair[1];
      // 草稿:null = 还没种;lastSynced = 上一次与端点一致的那份配置形状(用来判"改没改")
      var draftPair = react.useState(null);
      var drafts = draftPair[0];
      var setDrafts = draftPair[1];
      var syncedPair = react.useState(null);
      var lastSynced = syncedPair[0];
      var setLastSynced = syncedPair[1];
      var notePair = react.useState("");
      var note = notePair[0];
      var setNote = notePair[1];
      var errPair = react.useState("");
      var errorText = errPair[0];
      var setErrorText = errPair[1];
      var savingPair = react.useState(false);
      var saving = savingPair[0];
      var setSaving = savingPair[1];
      var dragPair = react.useState(false);
      var dragging = dragPair[0];
      var setDragging = dragPair[1];
      var pickerPair = react.useState(null);
      var picker = pickerPair[0];
      var setPicker = pickerPair[1];
      var seqRef = react.useRef(0);
      // 0.9.0:自动模式下可编辑的配置链折进折叠项(默认收起;手动模式下这个状态不参与渲染)
      var configPair = react.useState(false);
      var configOpen = configPair[0];
      var setConfigOpen = configPair[1];

      var refresh = react.useCallback(function () {
        setState(function (prev) { return { status: "loading", data: prev.data, error: null }; });
        loadJson(ROUTES_PATH, function (next) { setState(next); });
      }, []);
      react.useEffect(function () { refresh(); }, [refresh]);

      // 额度首次读到 pending(宿主刚重启、或快照过期后第一次读)时补拉一次 —— **只补一次**,
      // 不做轮询:面板的「刷新」按钮随时可以再来一次。
      var quotaState = state.data && state.data.quota && typeof state.data.quota === "object" ? state.data.quota.state : undefined;
      var quotaRetryRef = react.useRef(false);
      react.useEffect(function () {
        if (quotaState !== "pending" || quotaRetryRef.current) return undefined;
        quotaRetryRef.current = true;
        var timer = setTimeout(function () { refresh(); }, 2000);
        return function () { clearTimeout(timer); };
      }, [quotaState, refresh]);

      var endpointChain = state.data && Array.isArray(state.data.chain) ? state.data.chain : null;
      // 种草稿:端点链每次"内容变化"都重种一次(多标签页/手改 YAML 之后打开本页就是新链)
      var endpointKey = endpointChain === null ? "" : JSON.stringify(endpointChain);
      react.useEffect(function () {
        if (endpointChain === null) return;
        if (saving) return;
        var seeded = endpointChain.map(function (item) { return routeFromEndpoint(item, "r" + (++seqRef.current)); });
        var config = draftToChain(seeded);
        if (lastSynced !== null && !sameChain(config, lastSynced) && drafts !== null) {
          setNote(t("resync"));
        }
        setDrafts(seeded);
        setLastSynced(config);
      }, [endpointKey]);

      var calls = state.data && Array.isArray(state.data.calls) ? state.data.calls.slice(0, MAX_CALLS) : [];
      var loading = state.status === "loading";
      // 写配置要两道门同时开:宿主说这个部署接受写入(endpoint 的 writable),
      // **而且**页面侧真的拿到了设置文档(settings.available)——后者缺席时 configForms
      // 的写队列会直接把 ops 丢掉(持久化模式不是 host),按钮点了也没用。
      var settings = props.settings || { available: false, writable: false, reason: "" };
      var writable = !formMissing && !(state.data && state.data.writable === false) && settings.available === true && settings.writable !== false;
      var readOnlyReason = formMissing
        ? t("noChainInjection")
        : (state.data && state.data.writable === false)
        ? t("chainUnavailable")
        : (settings.reason === undefined || settings.reason === null || settings.reason === "" ? t("chainUnavailable") : settings.reason);
      var draftChain = drafts === null ? null : draftToChain(drafts);
      var chainDirty = draftChain !== null && lastSynced !== null && !sameChain(draftChain, lastSynced);
      var dirty = chainDirty || form.isDirty();

      /** 目录查询表:provider → model id 集合(判"这条还在不在目录里")。 */
      var known = {};
      for (var gi = 0; gi < catalog.groups.length; gi++) {
        var group = catalog.groups[gi];
        known[group.id] = {};
        for (var mi = 0; mi < (group.models || []).length; mi++) known[group.id][group.models[mi].id] = true;
      }
      /** 显示名:优先用目录里的模型名,取不到就退回原始 id(不让用户看到空白)。 */
      function labelFor(draft) {
        var models = null;
        for (var i = 0; i < catalog.groups.length; i++) if (catalog.groups[i].id === draft.provider) models = catalog.groups[i].models || [];
        if (models) {
          for (var j = 0; j < models.length; j++) if (models[j].id === draft.model) return draft.provider + " / " + (models[j].name || models[j].id);
        }
        return draft.provider + " / " + draft.model;
      }
      function isKnown(draft) {
        if (catalog.status !== "ready") return null;
        var table = known[draft.provider];
        return table === undefined ? false : table[draft.model] === true;
      }

      /** 一次成功的草稿改动(失败就只报错,不动草稿)。 */
      function edit(action) {
        try {
          setDrafts(function (prev) {
            var next = prev === null ? prev : applyDraft(prev, action);
            return next;
          });
          setErrorText("");
          setNote("");
        } catch (error) {
          setErrorText(String(error && error.message || error));
        }
      }
      function applyDraft(prev, action) {
        if (action.kind === "append") return prev.concat([action.entry]);
        if (action.kind === "remove") {
          if (prev.length <= 1) throw new Error(t("emptyChain"));
          return prev.filter(function (_item, index) { return index !== action.index; });
        }
        if (action.kind === "replace") {
          return prev.map(function (item, index) {
            return index === action.index
              ? { key: item.key, provider: action.provider, model: action.model, keepThinking: item.keepThinking, breakToolLoop: item.breakToolLoop }
              : item;
          });
        }
        if (action.kind === "toggle") {
          return prev.map(function (item, index) {
            if (index !== action.index) return item;
            var next = { key: item.key, provider: item.provider, model: item.model, keepThinking: item.keepThinking, breakToolLoop: item.breakToolLoop };
            next[action.key] = item[action.key] !== true;
            return next;
          });
        }
        if (action.kind === "move") {
          if (action.from === action.to) return prev;
          var next = prev.slice();
          var moved = next.splice(action.from, 1)[0];
          next.splice(action.to, 0, moved);
          return next;
        }
        throw new Error("unknown draft action");
      }

      function save() {
        if (saving || !writable || !dirty) return;
        var ops = form.takeOps();
        if (chainDirty && draftChain !== null) ops.push({ op: "set", path: ["routes"], value: draftChain });
        if (ops.length === 0) return;
        setSaving(true);
        setErrorText("");
        setNote("");
        Promise.resolve(form.mutate(ops)).then(function (landed) {
          setSaving(false);
          if (landed) {
            if (chainDirty && draftChain !== null) setLastSynced(draftChain);
            form.onSaved();
            setNote(t("saved"));
            refresh();
          } else {
            setErrorText(t("conflict"));
          }
        }).catch(function (error) {
          setSaving(false);
          setErrorText(String(error && error.message || error));
        });
      }

      function discard() {
        form.discardEdits();
        if (endpointChain !== null) {
          var seeded = endpointChain.map(function (item) { return routeFromEndpoint(item, "r" + (++seqRef.current)); });
          setDrafts(seeded);
          setLastSynced(draftToChain(seeded));
        }
        setErrorText("");
        setNote("");
      }

      /**
       * 切换自动排序模式(写 `ordering.mode`)。
       *
       * 不走"暂存 + 保存"那条路:这是个**开关**,按下去就该生效(宿主侧是 volatile,改完
       * 即时生效)。写失败(只读部署 / revision 冲突)时给一行提示并保留端点上的原值 ——
       * 下一次刷新自然会把它改回来。
       * @param mode - 目标模式。
       */
      function switchOrdering(mode) {
        if (saving || !writable) return;
        setSaving(true);
        setErrorText("");
        Promise.resolve(form.mutate(orderingModeOps(mode))).then(function (landed) {
          setSaving(false);
          if (landed) { setNote(t("saved")); refresh(); } else setErrorText(t("orderingSaveFailed"));
        }).catch(function (error) {
          setSaving(false);
          setErrorText(String(error && error.message || error));
        });
      }

      function resetToBundled() {
        if (saving || !writable) return;
        setSaving(true);
        setErrorText("");
        Promise.resolve(form.mutate(resetChainOps())).then(function (landed) {
          setSaving(false);
          if (landed) { setNote(t("saved")); refresh(); } else setErrorText(t("conflict"));
        }).catch(function (error) {
          setSaving(false);
          setErrorText(String(error && error.message || error));
        });
      }

      // 菜单外部点击关闭
      react.useEffect(function () {
        if (picker === null) return undefined;
        function onPointerDown(event) {
          var target = event.target;
          if (target && target.closest && target.closest('[data-la-picker="panel"]')) return;
          if (target && target.closest && target.closest('[data-la-anchor="' + picker.anchor + '"]')) return;
          setPicker(null);
        }
        document.addEventListener("pointerdown", onPointerDown, true);
        return function () { document.removeEventListener("pointerdown", onPointerDown, true); };
      }, [picker]);

      var head = jsxRuntime.jsxs("div", { className: "la-chain-head", children: [
        jsxRuntime.jsxs("span", { className: "la-chain-titlewrap", children: [
          jsxRuntime.jsx("span", { className: "la-chain-title", children: t("chainTitle") }),
          settings.available === true
            ? null
            : jsxRuntime.jsx(primitives.Tag, { tone: "quiet", children: t("noSettingsService") })
        ] }),
        jsxRuntime.jsxs("span", { className: "la-chain-actions", children: [
          dirty ? jsxRuntime.jsx(primitives.Button, { variant: "toolbar", size: "sm", onClick: discard, disabled: saving, children: t("discardChain") }) : null,
          jsxRuntime.jsx(primitives.Button, { variant: "toolbar", size: "sm", onClick: refresh, disabled: loading || saving, children: t("refresh") }),
          jsxRuntime.jsx(primitives.Button, {
            variant: dirty ? "primary" : "toolbar",
            size: "sm",
            onClick: save,
            disabled: !dirty || saving || !writable,
            children: saving ? t("saving") : t("saveChain")
          })
        ] })
      ] });

      // 0.9.0:模式决定这一段怎么长(见 {@link chainSectionPlan});端点还没读回来时按手动形态画。
      var plan = chainSectionPlan(state.data === null || state.data === undefined ? undefined : state.data.ordering, t);
      // 自动模式把配置链折进「配置顺序」(默认收起);手动模式下它本来就是主视图,直接铺开。
      var showConfig = !plan.collapsible || configOpen;

      // 模式开关(0.9.0 挪到卡片**最上面**、在「回退链」标题之前):写 `ordering.mode`(volatile)
      // ⇒ 即时生效;拿不到 `ordering`(旧宿主 / 还没读回来)时整行不画,退回 0.8.0 之前的形态。
      var modeRow = plan.view === null ? null : jsxRuntime.jsxs("div", { className: "la-mode-row", children: [
        jsxRuntime.jsx("span", { className: "la-mode-label", title: t("orderingModeHint"), children: t("orderingModeLabel") }),
        jsxRuntime.jsx("button", {
          type: "button",
          className: "la-ordering-toggle",
          disabled: !writable || saving,
          title: t("orderingModeHint"),
          onClick: function () { switchOrdering(plan.manual ? "auto" : "manual"); },
          children: plan.manual ? String(t("orderingToAuto")) : String(t("orderingToManual"))
        })
      ] });

      var hint = jsxRuntime.jsx("div", { className: "la-chain-hint", children: plan.hint });

      var rows = drafts === null ? [] : drafts.map(function (draft, index) {
        return jsxRuntime.jsx(RouteRow, {
          t: t,
          draft: draft,
          index: index,
          total: drafts.length,
          label: labelFor(draft),
          known: isKnown(draft),
          dragging: dragging,
          onMove: function (from, to) { if (to >= 0 && to < drafts.length) edit({ kind: "move", from: from, to: to }); },
          onPick: function (rowIndex, anchor) {
            setPicker(picker !== null && picker.index === rowIndex ? null : { index: rowIndex, anchor: anchor });
          },
          onToggle: function (rowIndex, key) { edit({ kind: "toggle", index: rowIndex, key: key }); },
          onRemove: function (rowIndex) { edit({ kind: "remove", index: rowIndex }); },
          onDragState: setDragging
        }, draft.key);
      });

      var addButton = jsxRuntime.jsxs("div", { className: "la-chain-addrow", children: [
        jsxRuntime.jsxs("button", {
          type: "button",
          className: "la-add",
          disabled: !writable || drafts === null,
          "data-la-anchor": "add",
          onClick: function () { setPicker(picker !== null && picker.index === -1 ? null : { index: -1, anchor: "add" }); },
          children: [jsxRuntime.jsx(Glyph, { d: PATH_PLUS, size: 12 }), t("addModel")]
        }),
        canResetChain(state.data)
          ? jsxRuntime.jsx("button", {
              type: "button",
              className: "la-add la-add-quiet",
              disabled: !writable || saving,
              title: t("resetChainHint"),
              onClick: resetToBundled,
              children: t("resetChain")
            })
          : null
      ] });

      var retryLine = retrySummary(t, state.data && state.data.retry);
      var meta = retryLine ? jsxRuntime.jsx("div", { className: "la-chain-meta", children: retryLine }) : null;

      // 「生效顺序」(0.8.0 的行为;0.9.0 起是**自动模式的主视图**,手动模式下整块不画 ——
      // 那种模式本来就不排序)。它是行为,「额度」段是观测:同一来源两段可能都写着,两者都对。
      var effectiveTitle = plan.manual ? null : jsxRuntime.jsx("div", { className: "la-chain-section", children: [
        jsxRuntime.jsx("span", { className: "la-ordering-title", title: t("orderingModeHint"), children: t("orderingEffectiveTitle") })
      ] });
      var orderingRows = plan.manual ? null : jsxRuntime.jsxs("div", { className: "la-ordering-list", children: [
        // 一行一个来源(2026-10-07 用户要求):原先所有来源挤在**同一个** flex 行里,长了就折成
        // "第一条末尾接第二条",读不出边界。现在每条自己占一行,行内再长由这一行自己 wrap。
        plan.rows.length === 0
          ? null
          : plan.rows.map(function (row) {
              return jsxRuntime.jsxs("div", { className: "la-ordering-row", children: [
                row.cooling ? jsxRuntime.jsx(primitives.Tag, { tone: row.tone, children: row.tag }) : null,
                jsxRuntime.jsx("span", { className: "la-ordering-name", children: row.label }),
                row.detail.length > 0 ? jsxRuntime.jsx("span", { className: "la-ordering-detail", children: row.detail }) : null
              ] }, row.key);
            }),
        plan.note.length > 0
          ? jsxRuntime.jsx("div", { className: "la-ordering-row", children: jsxRuntime.jsx("span", { className: "la-ordering-detail", children: plan.note }) })
          : null
      ] });

      // 自动模式下,可编辑的配置链折进这一行(默认收起;手动模式下压根不画这一行)。
      // 折叠时点开会先关掉模型选择器 —— 否则选择器会挂在一个已经收起来的行上。
      var configToggle = plan.collapsible ? jsxRuntime.jsxs("div", { className: "la-config-row", children: [
        jsxRuntime.jsxs("button", {
          type: "button",
          className: "la-config-toggle",
          "aria-expanded": configOpen,
          title: t("chainConfigToggleHint"),
          onClick: function () {
            setPicker(null);
            setConfigOpen(!configOpen);
          },
          children: [
            jsxRuntime.jsx(Glyph, { d: PATH_CHEVRON, size: 12, className: configOpen ? "la-row-chevron la-row-chevron-open" : "la-row-chevron" }),
            tr(t, "chainConfigToggle", { n: drafts === null ? 0 : drafts.length })
          ]
        }),
        dirty ? jsxRuntime.jsx("span", { className: "la-chain-count", children: t("dirty") }) : null
      ] }) : null;

      // 额度:紧凑版 —— 一个小节标题行 + 每来源一行摘要(细节放在同一行的次行文字里,
      // 不占额外高度、也不跟顶部的链编辑器抢位置)。
      var quotaView = state.data === null ? null : formatQuota(state.data.quota, t);
      var quotaSection = quotaView === null ? null : jsxRuntime.jsxs("div", { className: "la-chain-section la-chain-section-quota", children: [
        jsxRuntime.jsx("span", { className: "la-quota-title", title: t("quotaHint"), children: t("quotaTitle") }),
        jsxRuntime.jsx("span", { className: "la-chain-count", children: quotaView.meta })
      ] });
      var quotaRows = quotaView === null || quotaView.rows.length === 0 ? null : jsxRuntime.jsx("div", { className: "la-quota-list", children: quotaView.rows.map(function (row) {
        return jsxRuntime.jsxs("div", { className: "la-quota-row", key: "quota-" + row.key, children: [
          jsxRuntime.jsx("span", { className: "la-quota-label", children: row.label }),
          row.main.length > 0 ? jsxRuntime.jsx(primitives.Tag, { tone: row.tone, children: row.main }) : null,
          row.detail.length > 0 ? jsxRuntime.jsx("span", { className: "la-quota-detail", children: row.detail }) : null
        ] });
      }) });
      var counter = state.data
        ? jsxRuntime.jsx("span", { className: "la-chain-count", children: tr(t, "recordCount", { total: state.data.total, capacity: state.data.capacity }) })
        : null;

      var callList = jsxRuntime.jsx("div", { className: "la-call-list", children: calls.map(function (call, index) {
        var headRow = jsxRuntime.jsxs("div", { className: "la-call-head", children: [
          jsxRuntime.jsx(primitives.StateDot, { state: outcomeState(call.outcome), size: 10 }),
          jsxRuntime.jsx("span", { className: "la-call-time", children: formatClock(call.at) }),
          jsxRuntime.jsx("span", { className: "la-call-duration", children: formatDuration(call.elapsedMs) }),
          jsxRuntime.jsx(primitives.Tag, { tone: outcomeTone(call.outcome), children: t(call.outcome === "ok" ? "outcomeOk" : call.outcome === "aborted" ? "outcomeAborted" : "outcomeFailed") })
        ] });
        var routeRows = (call.routes || []).map(function (route) {
          return jsxRuntime.jsxs("div", { className: "la-call-route", key: "attempt-" + route.attempt, children: [
            jsxRuntime.jsxs("span", { className: "la-call-index", children: [String(route.attempt), "."] }),
            jsxRuntime.jsx("span", { className: "la-chain-route", children: route.provider + "/" + route.model }),
            route.ok
              ? jsxRuntime.jsx(primitives.Tag, { tone: "success", children: t("okTag") })
              : jsxRuntime.jsx(primitives.Tag, { tone: "danger", children: route.code || t("failedTag") }),
            route.tries > 1
              ? jsxRuntime.jsx("span", { className: "la-chain-meta", children: tr(t, "retried", { n: route.tries }) })
              : null,
            route.switchedTo
              ? jsxRuntime.jsx("span", { className: "la-chain-switch", children: tr(t, "switchedTo", { route: route.switchedTo }) })
              : null
          ] });
        });
        return jsxRuntime.jsxs("div", { className: "la-call", key: "call-" + index, children: [headRow, routeRows] });
      }) });

      var tail = [];
      if (loading) tail.push(jsxRuntime.jsx("div", { className: "la-chain-empty", key: "loading", children: t("loading") }));

      if (!writable) tail.push(jsxRuntime.jsx("div", { className: "la-chain-empty", key: "ro", children: readOnlyReason }));
      if (note.length > 0) tail.push(jsxRuntime.jsx("div", { className: "la-chain-note", key: "note", children: note }));
      if (errorText.length > 0) tail.push(jsxRuntime.jsx("div", { className: "la-chain-error", key: "error", children: errorText }));
      if (state.status === "error" && state.error) {
        tail.push(jsxRuntime.jsx("div", { className: "la-chain-error", key: "loadfail", children: tr(t, "loadFailed", { reason: state.error }) }));
      }

      var recentSection = jsxRuntime.jsxs("div", { className: "la-chain-section la-chain-section-calls", children: [t("recentCalls"), counter] });

      var pickerEl = null;
      if (picker !== null) {
        var current = picker.index >= 0 && drafts !== null ? drafts[picker.index] : null;
        // 整条链上已有的组合(宿主会静默去重,所以选择器里直接标成不可选)
        var takenSet = {};
        for (var ti = 0; ti < (drafts === null ? 0 : drafts.length); ti++) takenSet[drafts[ti].provider + "\u0000" + drafts[ti].model] = true;
        pickerEl = jsxRuntime.jsxs("div", { className: "la-picker-wrap", "data-la-anchor": picker.anchor, children: jsxRuntime.jsx(ModelPicker, {
          t: t,
          groups: catalog.groups,
          failures: catalog.failures,
          current: current,
          taken: takenSet,
          onClose: function () { setPicker(null); },
          onPick: function (provider, model) {
            if (picker.index < 0) {
              edit({ kind: "append", entry: { key: "r" + (++seqRef.current), provider: provider, model: model, keepThinking: false, breakToolLoop: false } });
            } else {
              edit({ kind: "replace", index: picker.index, provider: provider, model: model });
            }
            setPicker(null);
          }
        }) });
      }

      // 折叠态下不渲染链编辑器(rows / 添加模型行);展开态与手动模式完全相同。
      var rowsBlock = showConfig && rows.length > 0 ? jsxRuntime.jsx("div", { className: "la-rows", children: rows }) : null;
      var addBlock = showConfig && drafts !== null ? addButton : null;

      return jsxRuntime.jsxs("div", { className: "la-chain", children: [modeRow, head, hint, effectiveTitle, orderingRows, configToggle, rowsBlock, addBlock, meta, quotaSection, quotaRows, recentSection, callList, tail, pickerEl] });
    }

    /**
     * 配置表单本体:本组件只服务 bundle 页,而该槽位只问 view="page"
     * (契约明写 "Bundle configuration renders only `page`")⇒ 直接出表单,无 summary 分支。
     * 表单之下是「回退链」面板(0.6.0 起可编辑,见 {@link ChainPanel})。
     * @param props - 页面给的 view,加上本注册项 inject 出来的表单状态与动作。
     */
    function AutoRouteConfig(props) {
      var t = props.t;
      var state = props.useAutoRouteForm(function (snapshot) { return snapshot; });
      // 取证(2026-10-05):症状是"注册时明明返回了 chain,渲染时 props.chain 却是 undefined"。
      // 挂载后报一次实际 props 名单 —— 用 useEffect(不在渲染期 setState,也不动 hooks 顺序)。
      react.useEffect(function () {
        var shape = {};
        for (var name in props) {
          if (!Object.prototype.hasOwnProperty.call(props, name)) continue;
          var value = props[name];
          shape[name] = value === undefined ? "undefined" : (value === null ? "null" : typeof value);
        }
        reportDiag("props:AutoRouteConfig", "inject result shape", {
          keys: Object.keys(shape).sort().join(","),
          types: JSON.stringify(shape).slice(0, 1500)
        });
      }, []);
      var shell = props.chainShell === undefined ? null : props.chainShell();
      var available = shell !== null && shell.available !== false;
      // 设置文档读不到时快照里根本没有 compactWindow 这一格(settings.describe 没成功),
      // 直接取 state.compactWindow.text 会当场抛错、把整个配置段带下去 ⇒ 兜一套空状态。
      var FIELD_FALLBACK = { text: "", overridden: false, invalid: false };
      var field = available && state.compactWindow !== undefined ? state.compactWindow : FIELD_FALLBACK;
      var form = jsxRuntime.jsx(primitives.SettingsForm, {
        labels: formLabels(t),
        state: state,
        onSave: props.save,
        onDiscard: props.discard,
        children: jsxRuntime.jsx(primitives.SettingsValueField, {
          id: "plugin-config-llm-auto-compact-window",
          label: t("compactWindow"),
          hint: t("compactWindowHint"),
          overriddenLabel: t("overridden"),
          resetLabel: t("reset"),
          invalidLabel: t("invalidNumber"),
          numeric: true,
          disabled: !available || !state.writable,
          text: field.text,
          overridden: field.overridden,
          invalid: field.invalid,
          onEdit: function (text) { props.edit("compactWindow", text); },
          onReset: function () { props.resetField("compactWindow"); }
        })
      });
      return jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
        form,
        jsxRuntime.jsx(ChainPanel, {
          t: t,
          form: props.chain,
          // 设置文档的状态(能不能写、拿不到时的原因)一并交给面板,好在界面上说清楚
          settings: {
            available: available,
            writable: shell === null ? false : shell.writable !== false,
            reason: shell === null || shell.available === false
              ? (props.chainSettings !== undefined && props.chainSettings.provider === false
                  ? t("settingsNoProvider")
                  : t("settingsNoDocument"))
              : ""
          }
        })
      ] });
    }

    /** 面板样式:只引用主题 token,不写死颜色;卸载时随 effect 一起移除。 */
    var PANEL_STYLE = [
      ".la-chain{display:flex;flex-direction:column;gap:8px;margin:12px 0 0;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}",
      ".la-chain-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}",
      ".la-chain-titlewrap{display:inline-flex;align-items:center;gap:6px}",
      ".la-chain-title{font:var(--dsw-font-xs-strong-13);color:var(--dsw-alias-label-primary)}",
      ".la-chain-actions{display:flex;align-items:center;gap:6px}",
      ".la-chain-hint{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-caption);line-height:1.5}",
      ".la-chain-section{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}",
      ".la-chain-section-calls{margin-top:4px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}",
      ".la-chain-count{color:var(--dsw-alias-label-caption)}",
      ".la-chain-section-quota{margin-top:4px}",
      ".la-mode-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".la-mode-label{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}",
      ".la-config-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".la-config-toggle{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);cursor:pointer}",
      ".la-config-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".la-ordering-title{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}",
      ".la-ordering-toggle{display:inline-flex;align-items:center;height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);cursor:pointer}",
      ".la-ordering-toggle:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".la-ordering-toggle:disabled{opacity:.5;cursor:default}",
      ".la-ordering-list{display:flex;flex-direction:column;gap:4px}",
      ".la-ordering-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-primary)}",
      ".la-ordering-name{overflow-wrap:anywhere;word-break:break-all}",
      ".la-ordering-detail{color:var(--dsw-alias-label-caption)}",
      ".la-quota-title{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}",
      ".la-quota-list{display:flex;flex-direction:column;gap:4px}",
      ".la-quota-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-primary)}",
      ".la-quota-label{flex:none;color:var(--dsw-alias-label-secondary)}",
      ".la-quota-detail{color:var(--dsw-alias-label-caption)}",
      ".la-rows{display:flex;flex-direction:column;gap:4px}",
      ".la-row{display:flex;flex-direction:column;gap:4px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2)}",
      ".la-row-main{display:flex;align-items:center;gap:6px;padding:3px 6px;min-height:34px}",
      ".la-row-dragging{cursor:grabbing}",
      ".la-row-dragging .la-row-main{box-shadow:var(--dsw-elevation-prominent)}",
      ".la-grip{display:inline-flex;align-items:center;justify-content:center;width:18px;height:24px;flex:none;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-caption);cursor:grab;touch-action:none}",
      ".la-grip:hover,.la-grip:focus-visible{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);outline:none}",
      ".la-row-model{display:flex;align-items:center;gap:6px;flex:1;min-width:0;height:28px;padding:0 6px;border:1px solid transparent;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);cursor:pointer;text-align:left}",
      ".la-row-model:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".la-row-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
      ".la-row-on{flex:none;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}",
      ".la-row-chevron{flex:none;color:var(--dsw-alias-menu-icon);transition:transform .12s}",
      ".la-row-chevron-open{transform:rotate(180deg)}",
      ".la-nudge{display:inline-flex;align-items:center;gap:2px;flex:none}",
      ".la-nudge-btn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-caption);cursor:pointer}",
      ".la-nudge-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
      ".la-nudge-btn:disabled{opacity:.4;cursor:default}",
      ".la-row-options{display:inline-flex;align-items:center;gap:4px;flex:none;height:24px;padding:0 6px;border:0;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);cursor:pointer}",
      ".la-row-options:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".la-row-remove{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;flex:none;padding:0;border:0;border-radius:50%;background:0 0;color:var(--dsw-alias-label-caption);cursor:pointer}",
      ".la-row-remove:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}",
      ".la-row-remove:disabled{opacity:.35;cursor:default}",
      ".la-row-optpanel{display:flex;flex-direction:column;gap:8px;margin:0 6px 6px 30px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}",
      ".la-opt{display:flex;align-items:center;justify-content:space-between;gap:12px}",
      ".la-opt-text{display:flex;flex-direction:column;gap:2px;min-width:0}",
      ".la-opt-name{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-primary)}",
      ".la-opt-hint{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-caption);line-height:1.45}",
      ".la-chain-addrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".la-add{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:0 0;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);cursor:pointer}",
      ".la-add:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".la-add:disabled{opacity:.5;cursor:default}",
      ".la-add-quiet{color:var(--dsw-alias-label-secondary);border-color:transparent}",
      ".la-chain-meta{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-caption)}",
      ".la-chain-switch{color:var(--dsw-alias-label-secondary)}",
      ".la-chain-empty,.la-chain-error,.la-chain-note{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-caption);line-height:1.5}",
      ".la-chain-error{color:var(--dsw-alias-state-error-primary)}",
      ".la-chain-note{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}",
      ".la-chain-route{overflow-wrap:anywhere;word-break:break-all}",
      ".la-call-list{display:flex;flex-direction:column;gap:8px}",
      ".la-call{display:flex;flex-direction:column;gap:4px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}",
      ".la-call-head{display:flex;align-items:center;gap:8px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}",
      ".la-call-time,.la-call-duration{font-variant-numeric:tabular-nums}",
      ".la-chain-row,.la-call-route{display:flex;align-items:center;gap:6px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-primary)}",
      ".la-chain-index,.la-call-index{flex:none;min-width:16px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}",
      ".la-picker-wrap{position:relative;display:block}",
      ".la-picker{position:absolute;z-index:1100;left:0;top:100%;margin-top:4px;width:max-content;min-width:min(320px,100%);max-width:min(460px,90vw);max-height:min(360px,60vh);flex-direction:column;padding:4px;display:flex;overflow:hidden;box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);border:0}",
      ".la-picker-head{flex:none;padding:4px 8px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-caption)}",
      ".la-picker-searchrow{position:relative;flex:none;margin:2px 0 3px}",
      ".la-picker-search{display:block;border-radius:var(--dsw-radius-md);background:0 0;border:0;padding:5px 7px}",
      ".la-picker-search input{width:100%;padding:0;border:0;background:0 0;outline:none;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);font-size:12px}",
      ".la-picker-search input::placeholder{color:var(--dsw-alias-label-caption)}",
      ".la-picker-clear{position:absolute;top:50%;right:4px;transform:translateY(-50%);display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:50%;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer}",
      ".la-picker-clear:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".la-picker-groups{min-height:0;overflow-y:auto;padding:0}",
      ".la-picker-option{display:flex;align-items:center;gap:6px;width:auto;min-width:100%;min-height:34px;padding:5px 7px;border:0;border-radius:var(--dsw-radius-md);background:0 0;color:inherit;text-align:left;cursor:pointer}",
      ".la-picker-option:hover:not(:disabled),.la-picker-option:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:none}",
      ".la-picker-option-taken{color:var(--dsw-alias-label-dimmed);cursor:default}",
      ".la-picker-taken{flex:none;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-caption)}",
      ".la-picker-copy{display:flex;flex-direction:column;flex:1;min-width:0}",
      ".la-picker-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xxs-12);font-size:13px;line-height:18px;color:inherit}",
      ".la-picker-desc{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-caption)}",
      ".la-picker-check{display:grid;place-items:center;flex:0 0 14px;color:var(--dsw-alias-label-primary)}",
      ".la-picker-empty,.la-picker-note{padding:8px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);line-height:1.5}",
      ".la-picker-note{color:var(--dsw-alias-state-warn-label)}"
    ].join("\n");

    // 需要槽位、字典与设置表单三个服务;configForms 由 @deepseek-ai/dsh-client-ui-settings 提供
    // (见 package.json 的 dsh.client.inject,保证提供方先到场)。
    var inject = ["slots", "locale", "configForms"];

    /**
     * 设置服务缺席时给 SettingsFormModel 的替身作用域。
     *
     * 只实现它真正会调的四件事:`subscribe`(订阅)、`getSnapshot`(读)、`mutate`(写)、
     * `dispose` 相关。不可写 + 值为空 ⇒ 表单渲染成禁用且空白,不会抛错也不会假装能存。
     * @returns 一个永远"未就绪且不可写"的设置作用域。
     */
    function inertScope() {
      var snapshot = { status: "unavailable", value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: "memory" };
      return {
        subscribe: function () { return function () {}; },
        getSnapshot: function () { return snapshot; },
        mutate: function () { return Promise.resolve(false); }
      };
    }

    /**
     * 挂载 bundle 页的配置表单、「回退链」编辑器(0.6.0)与最近请求面板。
     * @param ctx - 浏览器插件上下文。
     */
    function apply(ctx) {
      installGlobalDiag();
      try {
        applyInner(ctx);
      } catch (error) {
        // 注册只要抛一次,配置段就整段不出现、且没有任何提示 ⇒ 把原文报给宿主再原样抛出。
        reportDiag("apply", error, { stage: "applyInner" });
        throw error;
      }
    }

    /**
     * 真正干活的那一半(由 {@link apply} 包了错误上报)。
     * @param ctx - 浏览器插件上下文。
     */
    function applyInner(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, "dsh-llm-auto: dictionaries");
      var t = ctx.locale.bind(NS);
      activeT = t;

      // 面板样式随模块生命周期注入/移除
      ctx.effect(function () {
        var style = document.createElement("style");
        style.setAttribute("data-llm-auto", "chain-panel");
        style.textContent = PANEL_STYLE;
        document.head.appendChild(style);
        return function () { style.remove(); };
      }, "dsh-llm-auto: chain panel styles");

      // 页面侧到底有没有设置服务(configForms 由 @deepseek-ai/dsh-client-ui-settings 提供)。
      // 它缺席时不能硬取 `ctx.configForms.get(...)`:那样 apply() 会抛错、整个半侧悄悄失效。
      var configForms = ctx.get("configForms");
      var hasConfigForms = configForms !== undefined && configForms !== null && typeof configForms.get === "function";

      // 暂存表单:只声明 compactWindow 一个字段(链的草稿由 ChainPanel 自己管)。
      // 两者共用同一个设置命名空间,但路径不同 ⇒ 谁改了写谁,互不覆盖。
      // 设置服务缺席时给一个"什么都不做"的替身:表单显示空值且禁用,面板显示原因。
      var form = new primitives.SettingsFormModel(
        hasConfigForms ? configForms.get(NAMESPACE) : inertScope(),
        [primitives.settingsNumberField("compactWindow")]
      );
      var store = form.bind(function () {
        var shell = form.shell();
        shell.compactWindow = form.field("compactWindow");
        return shell;
      });
      ctx.effect(function () {
        return function () { form.dispose(); };
      }, "dsh-llm-auto: form subscription");

      // 链编辑器的写入口:直接用同一个 ConfigForm(官方 ConfigFormController)。
      // 标记位只在"设置了但还没写"期间有效,保存成功/放弃时清掉。
      var editing = false;
      var scope = ctx.configForms.get(NAMESPACE);
      var chain = {
        isDirty: function () { return editing || form.shell().dirty; },
        takeOps: function () {
          var plan = form.plan();
          var ops = [];
          for (var i = 0; i < plan.length; i++) if (plan[i].op) ops.push(plan[i].op);
          return ops;
        },
        mutate: function (ops) { return scope.mutate(ops); },
        onSaved: function () { editing = false; form.actions().discard(); },
        discardEdits: function () { editing = false; form.actions().discard(); }
      };

      /**
       * 页面侧设置文档的状态:能不能写、拿不到时的原因。
       *
       * 面板与表单共用这一份描述。两件事分开看:
       *  · 有没有 configForms 服务 —— 没有就根本没有设置文档(页面侧没装 ui-settings);
       *  · 有服务但快照 `available === false` —— 服务在、文档没读到(remote.settings.describe 失败)。
       * ⚠ 局部变量名**不能**叫 `reason`:与函数形参 `reason` 重名会让它被静默遮蔽。
       */
      function describeSettings() {
        if (!hasConfigForms) return { available: false, writable: false, provider: false, mode: "absent" };
        var snapshot;
        try {
          snapshot = store.getSnapshot();
        } catch (error) {
          return { available: false, writable: false, provider: true, mode: "error", reason: String(error && error.message || error) };
        }
        return {
          available: snapshot.available !== false,
          writable: snapshot.writable !== false,
          provider: true,
          mode: snapshot.mode
        };
      }

      // 配置段的注册**不再用 whileServed 门控**:那条路要求"宿主服务的命名空间表里有
      // llm-auto",而桌面端实测从未满足 ⇒ 整段配置静默地什么都不长(用户看不到任何东西、
      // 也拿不到任何提示)。现在无条件注册,由组件自己显示状态:设置文档拿不到时,表单与
      // 链面板都退回只读并写明原因。代价是插件没被服务时也会多出一段 —— 但"看得见的解释"
      // 比"静默空白"划算。
      ctx.effect(function () {
        return ctx.slots.inject("plugins.bundle.config", function () {
          return ctx.slots.register({
            name: "plugins.bundle.config",
            key: BUNDLE_CONFIG_KEY,
            locale: NS,
            inject: function () {
              var actions = form.actions();
              return {
                hooks: { autoRouteForm: store },
                edit: actions.edit,
                resetField: actions.resetField,
                save: actions.save,
                discard: actions.discard,
                chain: chain,
                // 挂载时先探一次:让面板知道"有没有设置服务、文档读到没有"
                chainSettings: describeSettings(),
                chainShell: function () { return describeSettings(); }
              };
            }
          }, withDiag("AutoRouteConfig", AutoRouteConfig));
        });
      }, "dsh-llm-auto: bundle config section");
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    exports.ROUTES_PATH = ROUTES_PATH;
    exports.CATALOG_PATH = CATALOG_PATH;
    // 纯函数供测试直接调(不依赖 window / document / react)
    exports.__internals = {
      fill: fill,
      tr: tr,
      formatClock: formatClock,
      formatDuration: formatDuration,
      retrySummary: retrySummary,
      outcomeState: outcomeState,
      outcomeTone: outcomeTone,
      splitLabel: splitLabel,
      draftToConfig: draftToConfig,
      draftToChain: draftToChain,
      sameChain: sameChain,
      routeFromEndpoint: routeFromEndpoint,
      optionSummary: optionSummary,
      matchesQuery: matchesQuery,
      formatMoney: formatMoney,
      formatResetAt: formatResetAt,
      formatQuota: formatQuota,
      formatOrdering: formatOrdering,
      chainSectionPlan: chainSectionPlan,
      orderingModeOps: orderingModeOps,
      canResetChain: canResetChain,
      resetChainOps: resetChainOps,
      filterGroups: filterGroups,
      OPTION_KEYS: OPTION_KEYS
    };
    return module.exports;
  }
});
