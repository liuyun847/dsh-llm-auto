// 浏览器半侧：在「插件」页把本插件的 compactWindow 变成一个可编辑表单，并在同一处
// 渲染一块只读的「回退链」面板（0.5.0 起）。
//
// 位置沿革（三版）：
//   v0.4.0 初版注册进 plugins.row.config（键 = "<包名>#<行 id>"）⇒ 表单藏在
//     插件页 →「已安装」→ dsh-llm-auto → 行 `llm-auto` →「配置」的二级页里，要钻四层。
//   随后改注册进 plugins.bundle.config（键 = **本包包名**）⇒ 插件页 →「已安装」→
//     dsh-llm-auto 一进去就能看到表单（渲染在描述与行之间）；行上那个「配置」控件
//     随之消失（本插件不再占用 plugins.row.config）。
//   v0.5.0 在同一位置加「回退链」面板：上半是当前生效的有序配置链（来自端点的
//     `chain` 与 `retry`），下半是最近若干次请求的真实回退过程（端点的 `calls`，
//     由宿主侧 lib/calls.js 分组）。只读，不写任何配置。
//
// 依据（全部为实测源码，非推测）：
//   · slot 契约：dsh-client-ui-plugin-manager 的 lib/types/client/slot-contract.d.ts
//     —— plugins.bundle.config 是 keyed slot，键为 bundle 包名，只问 view="page"，
//     渲染位置是 bundle 页「描述与行之间」；plugins.row.config 的键才是
//     `${bundle}#${rowId}`（其 client.js:27 的 rowConfigKey）。
//   · 键必须**恰好**是包名：该页只在 ledger 收录了这个键时才渲染这一段
//     （其 client.js:2879 的 `ledger.bundles.has(pkg.name)`），而 ledger 直接读
//     槽位注册的 key（其 client.js:48 的 keysOf）。
//   · 同槽位的官方实例：@deepseek-ai/dsh-experimental-client-ui-voice-input 的
//     VoicePreparation 也注册在这里（键为 voice-input-bundle 的包名），自身不带标题。
//   · 设置命名空间 = loader 行 id：本插件的行 id 是 `llm-auto`，dsh-settings 按
//     entry.options.id 投影命名空间 ⇒ ctx.configForms.get('llm-auto')。
//   · 表单原语：@deepseek-ai/dsh-client-ui-primitives 属**平台种子模块**
//     （前端 bundle 的 staticModules 明确列出它，连同 react / slots / store / cordis），
//     任何客户端半侧可直接 require，无需它出现在 node_modules 依赖里。
//     SettingsFormModel + SettingsForm + SettingsValueField 负责暂存草稿、保存/丢弃、
//     「已覆盖」标记与「恢复默认」；本插件不自己实现任何写入逻辑。
//   · 与官方四个配置页（ui-settings-shell / agent-loop / subagent / web-search）同构：
//     用 ctx.configForms.whileServed 保证命名空间未被服务时不注册；inject 里的 hooks
//     以 use<Name> 形式注入组件（官方写法 hooks:{shellCard} → props.useShellCard）。
//   · 主题样式只用 --dsw-* token（Theme 令牌表），不写死颜色；light/dark 两套由外壳提供。
//     面板的 class 名统一加 `la-` 前缀，随本模块的 effect 注入 <style>，卸载时移除。
//
// 只暴露 compactWindow 一个**可写**字段（与 registry 时代一致，官方表单也只投影
// 标了 .volatile() 的字段）。routes / retry 不是 volatile，写入不会原地生效 ⇒
// 仍改包内 cordis.patch.yml；面板只展示它们，不改写。
//
// ⚠ 本文件在插件目录与 profile 的 node_modules 各有一份 —— 2026-09-27 实测这两份是**独立拷贝**
//   （`fsutil hardlink list` 两侧各只有一条 link），不是硬链接；宿主加载的是 node_modules 那份。
//   所以改完必须把内容**同步过去**并核两侧 SHA256（`(Get-Item).FileId` 在本机返回空值，
//   比较会恒真，别用它判断）。同步与核对做法见 README §4 第 1 条。
//
// 格式遵循 DSH 客户端插件契约：window.__ModuleLoader__.load + 具名导出 apply/inject。
window.__ModuleLoader__.load({
  id: "dsh-llm-auto",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var jsxRuntime = require("react/jsx-runtime");
    var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    // 本插件的行 id，同时也是设置命名空间（dsh-settings 按 entry.options.id 投影）
    var NAMESPACE = "llm-auto";
    // 本组件注册的 plugins.bundle.config 键：bundle 自己的配置按**包名**寻址
    var BUNDLE_CONFIG_KEY = "dsh-llm-auto";
    // 本插件自己的字典命名空间
    var NS = "llmAutoSettings";
    /**
     * 宿主侧的只读端点（必须与 lib/index.js 的 ROUTES_PATH 一致）。
     * exact 路由、不经过浏览器鉴权 cookie，同源相对路径即可（见 README §5）。
     */
    var ROUTES_PATH = "/api/llm-auto/routes";
    /** 面板最多显示几次请求（回退过程一屏能看完；更多记录看端点 raw `routes`）。 */
    var MAX_CALLS = 8;

    var zh = {
      compactWindow: "用于压缩的上下文窗口",
      compactWindowHint: "让自动压缩发生在这个 token 数附近；只写这一个字段，改完即时生效、无需重启。",
      overridden: "已覆盖",
      reset: "恢复默认",
      invalidNumber: "请填数字，留空表示用默认值。",
      readOnly: "本次部署以只读方式保存设置。",
      unavailable: "该插件没有加载，暂时无法配置。",
      save: "保存",
      saving: "保存中…",
      saveFailed: "部署没有接受这些值，已保留供你修改。",
      chainTitle: "回退链",
      chainHint: "按上面的顺序依次尝试；某条重试耗尽、或错误码不允许重试时，才静默切下一条。这里是只读视图，打开本页时读一次，点「刷新」看最新。",
      configChain: "当前链（第一项即首选）",
      chainEmpty: "还没读到配置链（插件未加载，或链路里一条路由都不可用）。",
      retryLine: "每路由最多重试 {max} 次，退避 {initial}ms→{maxDelay}ms",
      retryOff: "路由内重试已关闭：每路由只尝试一次，失败即切下一条。",
      recentCalls: "最近请求",
      recordCount: "共 {total} 条记录，容量 {capacity}",
      noCalls: "还没有请求经过 auto 路由。选一次 Auto 模型再回来看。",
      loading: "读取中…",
      loadFailed: "读取失败：{reason}（插件未加载、端点不可达时也会这样）",
      refresh: "刷新",
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
      chainHint: "Routes are tried in order; one is replaced silently only after its retries are exhausted or its error code is not retryable. This view is read-only: it is fetched once when the page opens, and Refresh reloads it.",
      configChain: "Current chain (first is preferred)",
      chainEmpty: "No configured chain yet (plugin not loaded, or every route unusable).",
      retryLine: "Up to {max} retries per route, backoff {initial}ms→{maxDelay}ms",
      retryOff: "In-route retries are off: one attempt per route, then switch.",
      recentCalls: "Recent requests",
      recordCount: "{total} records, capacity {capacity}",
      noCalls: "No request has gone through the auto route yet. Pick Auto once and come back.",
      loading: "Loading…",
      loadFailed: "Load failed: {reason} (also happens when the plugin is not loaded or the endpoint is unreachable)",
      refresh: "Refresh",
      outcomeOk: "ok",
      outcomeFailed: "failed",
      outcomeAborted: "aborted",
      okTag: "ok",
      failedTag: "failed",
      retried: "{n} attempts",
      switchedTo: "→ switched to {route}",
      durationNone: "—"
    };

    /** SettingsForm 框架自己渲染的文案（官方各配置页同款五条）。 */
    var FORM_LABEL_KEYS = ["unavailable", "readOnly", "saveFailed", "save", "saving"];

    function formLabels(t) {
      var labels = {};
      for (var i = 0; i < FORM_LABEL_KEYS.length; i++) labels[FORM_LABEL_KEYS[i]] = t(FORM_LABEL_KEYS[i]);
      return labels;
    }

    /**
     * 把 `{name}` 模板填上值。
     *
     * dsh 的 `t(key, params)` 官方支持 `{name}` 插值（dsh-client-ui-slots 的
     * Translate 类型注明），但本模块不赌版本：`tr()` 先按 params 调一次，返回值里
     * 还留着 `{xxx}` 时就地自己替换一遍 —— 两种实现下结果一致。
     * @param template - 模板串（含 `{key}` 占位）。
     * @param values - 占位值表。
     * @returns 填好的字符串；未提供的占位原样保留。
     */
    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/gu, function (matched, key) {
        return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : matched;
      });
    }

    /**
     * 取文案并填参数（对 t 的插值实现不敏感，见 {@link fill}）。
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
     * ISO 时间 → 本地 `HH:mm:ss`（面板只要时分秒，日期只会碍事）。
     * @param at - ISO 8601 字符串；解析不了时给占位。
     * @returns `HH:mm:ss`。
     */
    function formatClock(at) {
      var date = at instanceof Date ? at : new Date(at);
      if (isNaN(date.getTime())) return "--:--:--";
      function pad(value) { return value < 10 ? "0" + value : "" + value }
      return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
    }

    /**
     * 毫秒 → 人读时长（一次请求的总耗时只含上游尝试，不含路由内退避等待）。
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
     * 重试策略一行摘要（来自端点的扁平 `retry`）。
     * @param t - 翻译函数。
     * @param retry - 端点响应里的 `retry`（可缺省）。
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
     * 拉一次端点（只读）。
     *
     * 不 catch 掉响应体解析错误之外的情况：非 200、JSON 解析失败、网络错误都会变成
     * `status: 'error'`，面板据原样显示（插件没加载时正是排查入口）。
     * @param onDone - `(next) => void`，收到 `{ status, data, error }` 之一。
     */
    function loadRoutes(onDone) {
      fetch(ROUTES_PATH, { headers: { accept: "application/json" } }).then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      }).then(function (json) {
        onDone({ status: "ready", data: json, error: null });
      }).catch(function (error) {
        onDone({ status: "error", data: null, error: String(error && error.message || error) });
      });
    }

    /** 一次请求的结局 → 状态点语义（失败与取消都要和"成功"一眼区分）。 */
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
     * 「回退链」面板：配置链 + 最近请求的真实回退过程。
     *
     * 状态自己做主:打开页面拉一次(via useEffect),刷新按钮再拉一次;失败时保留上一次
     * 数据并在末尾给出错误行,不把面板整个掀掉。
     * @param props - `props.t` 翻译函数(state 与动作都在组件内)。
     */
    function ChainPanel(props) {
      var t = props.t;
      var pair = react.useState({ status: "loading", data: null, error: null });
      var state = pair[0];
      var setState = pair[1];

      var refresh = react.useCallback(function () {
        setState(function (prev) { return { status: "loading", data: prev.data, error: null } });
        loadRoutes(function (next) { setState(next); });
      }, []);

      react.useEffect(function () {
        refresh();
      }, [refresh]);

      var data = state.data;
      var chain = data && Array.isArray(data.chain) ? data.chain : [];
      var calls = data && Array.isArray(data.calls) ? data.calls.slice(0, MAX_CALLS) : [];
      var loading = state.status === "loading";

      var head = jsxRuntime.jsxs("div", { className: "la-chain-head", children: [
        jsxRuntime.jsx("span", { className: "la-chain-title", children: t("chainTitle") }),
        jsxRuntime.jsx(primitives.Button, {
          variant: "toolbar",
          size: "sm",
          onClick: refresh,
          disabled: loading,
          children: t("refresh")
        })
      ] });

      var hint = jsxRuntime.jsx("div", { className: "la-chain-hint", children: t("chainHint") });

      var configSection = jsxRuntime.jsxs("div", { className: "la-chain-section", children: [
        jsxRuntime.jsx("span", { children: t("configChain") })
      ] });

      var chainList = jsxRuntime.jsx("ol", { className: "la-chain-list", children: chain.map(function (route, index) {
        return jsxRuntime.jsxs("li", { className: "la-chain-row", key: "route-" + index, children: [
          jsxRuntime.jsxs("span", { className: "la-chain-index", children: [String(index + 1), "."] }),
          jsxRuntime.jsx("span", { className: "la-chain-route", children: String(route) })
        ] });
      }) });

      var chainEmpty = jsxRuntime.jsx("div", { className: "la-chain-empty", children: t("chainEmpty") });

      var meta = jsxRuntime.jsx("div", { className: "la-chain-meta", children: retrySummary(t, data && data.retry) });

      // 「最近请求」小节标题 + 记录数（端点 raw 字段，重启后清零）
      var recentSection = jsxRuntime.jsxs("div", { className: "la-chain-section la-chain-section-calls", children: [t("recentCalls"), counter] });

      var counter = data
        ? jsxRuntime.jsx("span", { className: "la-chain-count", children: tr(t, "recordCount", { total: data.total, capacity: data.capacity }) })
        : null;

      var callList = jsxRuntime.jsxs("div", { className: "la-call-list", children: calls.map(function (call, index) {
        var headRow = jsxRuntime.jsxs("div", { className: "la-call-head", children: [
          jsxRuntime.jsx(primitives.StateDot, { state: outcomeState(call.outcome), size: 10 }),
          jsxRuntime.jsx("span", { className: "la-call-time", children: formatClock(call.at) }),
          jsxRuntime.jsx("span", { className: "la-call-duration", children: formatDuration(call.elapsedMs) }),
          jsxRuntime.jsx(primitives.Tag, { tone: outcomeTone(call.outcome), children: t(call.outcome === "ok" ? "outcomeOk" : call.outcome === "aborted" ? "outcomeAborted" : "outcomeFailed") })
        ] });
        var routeRows = call.routes.map(function (route) {
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
      if (!loading && calls.length === 0 && state.status !== "error") {
        tail.push(jsxRuntime.jsx("div", { className: "la-chain-empty", key: "no-calls", children: t("noCalls") }));
      }
      if (state.status === "error" && state.error) {
        tail.push(jsxRuntime.jsx("div", { className: "la-chain-error", key: "error", children: tr(t, "loadFailed", { reason: state.error }) }));
      }

      return jsxRuntime.jsxs("div", { className: "la-chain", children: [head, hint, configSection, chainEmpty, chainList, meta, recentSection, callList, tail] });
    }

    /**
     * 配置表单本体：本组件只服务 bundle 页，而该槽位只问 view="page"
     * （契约明写 "Bundle configuration renders only `page`"）⇒ 直接出表单，无 summary 分支。
     * 表单之下是 0.5.0 新增的「回退链」面板（只读视图，见 {@link ChainPanel}）。
     * @param props - 页面给的 view，加上本注册项 inject 出来的表单状态与动作。
     */
    function AutoRouteConfig(props) {
      var t = props.t;
      var state = props.useAutoRouteForm(function (snapshot) { return snapshot; });
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
          disabled: !state.writable,
          text: state.compactWindow.text,
          overridden: state.compactWindow.overridden,
          invalid: state.compactWindow.invalid,
          onEdit: function (text) { props.edit("compactWindow", text); },
          onReset: function () { props.resetField("compactWindow"); }
        })
      });
      return jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [form, jsxRuntime.jsx(ChainPanel, { t: t })] });
    }

    /** 面板样式：只引用主题 token，不写死颜色；卸载时随 effect 一起移除。 */
    var PANEL_STYLE = [
      ".la-chain{display:flex;flex-direction:column;gap:8px;margin:12px 0 0;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}",
      ".la-chain-head{display:flex;align-items:center;justify-content:space-between;gap:8px}",
      ".la-chain-title{font:var(--dsw-font-xs-strong-13);color:var(--dsw-alias-label-primary)}",
      ".la-chain-hint{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-caption);line-height:1.5}",
      ".la-chain-section{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}",
      ".la-chain-count{color:var(--dsw-alias-label-caption)}",
      ".la-chain-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}",
      ".la-chain-row,.la-call-route{display:flex;align-items:center;gap:6px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-primary)}",
      ".la-chain-index,.la-call-index{flex:none;min-width:16px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}",
      ".la-chain-route{overflow-wrap:anywhere;word-break:break-all}",
      ".la-chain-meta{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-caption)}",
      ".la-chain-switch{color:var(--dsw-alias-label-secondary)}",
      ".la-chain-empty,.la-chain-error{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-caption);line-height:1.5}",
      ".la-chain-error{color:var(--dsw-alias-state-error-primary)}",
      ".la-call-list{display:flex;flex-direction:column;gap:8px}",
      ".la-call{display:flex;flex-direction:column;gap:4px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}",
      ".la-call-head{display:flex;align-items:center;gap:8px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}",
      ".la-call-time,.la-call-duration{font-variant-numeric:tabular-nums}"
    ].join("\n");

    // 需要槽位、字典与设置表单三个服务；configForms 由 @deepseek-ai/dsh-client-ui-settings 提供
    // （见 package.json 的 dsh.client.inject，保证提供方先到场）。
    var inject = ["slots", "locale", "configForms"];

    /**
     * 挂载 bundle 页的配置表单与「回退链」面板。
     * @param ctx - 浏览器插件上下文。
     */
    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, "dsh-llm-auto: dictionaries");
      var t = ctx.locale.bind(NS);

      // 面板样式随模块生命周期注入/移除
      ctx.effect(function () {
        var style = document.createElement("style");
        style.setAttribute("data-llm-auto", "chain-panel");
        style.textContent = PANEL_STYLE;
        document.head.appendChild(style);
        return function () { style.remove(); };
      }, "dsh-llm-auto: chain panel styles");

      // 暂存表单：只声明 compactWindow 一个字段，保存时也只写这一个键
      // （其它键如 routes 原样不动 —— 这是 SettingsFormModel 的既定语义）。
      var form = new primitives.SettingsFormModel(ctx.configForms.get(NAMESPACE), [
        primitives.settingsNumberField("compactWindow")
      ]);
      var store = form.bind(function () {
        var shell = form.shell();
        shell.compactWindow = form.field("compactWindow");
        return shell;
      });
      ctx.effect(function () {
        return function () { form.dispose(); };
      }, "dsh-llm-auto: form subscription");

      // 命名空间被宿主服务期间才注册：没被服务时 bundle 页不显示这一段配置。
      ctx.effect(function () {
        return ctx.configForms.whileServed([NAMESPACE], function () {
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
                  discard: actions.discard
                };
              }
            }, AutoRouteConfig);
          });
        });
      }, "dsh-llm-auto: bundle config section");
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    exports.ROUTES_PATH = ROUTES_PATH;
    // 纯函数供测试直接调（不依赖 window / document / react）
    exports.__internals = {
      fill: fill,
      tr: tr,
      formatClock: formatClock,
      formatDuration: formatDuration,
      retrySummary: retrySummary,
      outcomeState: outcomeState,
      outcomeTone: outcomeTone
    };
    return module.exports;
  }
});
