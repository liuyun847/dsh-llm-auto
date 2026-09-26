// 浏览器半侧：在「插件」页把本插件的 compactWindow 变成一个可编辑表单。
//
// 位置沿革（两版都是 2026-09-25）：
//   v0.4.0 初版注册进 plugins.row.config（键 = "<包名>#<行 id>"）⇒ 表单藏在
//     插件页 →「已安装」→ dsh-llm-auto → 行 `llm-auto` →「配置」的二级页里，要钻四层。
//   现在改注册进 plugins.bundle.config（键 = **本包包名**）⇒ 插件页 →「已安装」→
//     dsh-llm-auto 一进去就能看到表单（渲染在描述与行之间）；行上那个「配置」控件
//     随之消失（本插件不再占用 plugins.row.config）。
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
//
// 只暴露 compactWindow 一个字段（与 registry 时代一致，官方表单也只投影
// 标了 .volatile() 的字段）。routes / retry 不是 volatile，写入不会原地生效 ⇒
// 仍改包内 cordis.patch.yml。
//
// ⚠ 本文件在插件目录与 profile 的 node_modules 各有一份，本包 12 个共享文件（含本文件）
//   两侧实测均为**硬链接**、同 inode ⇒ 原地改即两侧同生效，不需要重装；
//   但 write/edit 这类换文件式写入会**断链**（编辑器 rename 保存同理），改完核 fileId；
//   重建与核对做法见 README §4 第 1 条。
//
// 格式遵循 DSH 客户端插件契约：window.__ModuleLoader__.load + 具名导出 apply/inject。
window.__ModuleLoader__.load({
  id: "dsh-llm-auto",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var jsxRuntime = require("react/jsx-runtime");
    var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    // 本插件的行 id，同时也是设置命名空间（dsh-settings 按 entry.options.id 投影）
    var NAMESPACE = "llm-auto";
    // 本组件注册的 plugins.bundle.config 键：bundle 自己的配置按**包名**寻址
    var BUNDLE_CONFIG_KEY = "dsh-llm-auto";
    // 本插件自己的字典命名空间
    var NS = "llmAutoSettings";

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
      saveFailed: "部署没有接受这些值，已保留供你修改。"
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
      saveFailed: "The deployment did not accept these values; they were left for you to correct."
    };

    /** SettingsForm 框架自己渲染的文案（官方各配置页同款五条）。 */
    var FORM_LABEL_KEYS = ["unavailable", "readOnly", "saveFailed", "save", "saving"];

    function formLabels(t) {
      var labels = {};
      for (var i = 0; i < FORM_LABEL_KEYS.length; i++) labels[FORM_LABEL_KEYS[i]] = t(FORM_LABEL_KEYS[i]);
      return labels;
    }

    /**
     * 配置表单本体：本组件只服务 bundle 页，而该槽位只问 view="page"
     * （契约明写 "Bundle configuration renders only `page`"）⇒ 直接出表单，无 summary 分支。
     * @param props - 页面给的 view，加上本注册项 inject 出来的表单状态与动作。
     */
    function AutoRouteConfig(props) {
      var t = props.t;
      var state = props.useAutoRouteForm(function (snapshot) { return snapshot; });
      return jsxRuntime.jsx(primitives.SettingsForm, {
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
    }

    // 需要槽位、字典与设置表单三个服务；configForms 由 @deepseek-ai/dsh-client-ui-settings 提供
    // （见 package.json 的 dsh.client.inject，保证提供方先到场）。
    var inject = ["slots", "locale", "configForms"];

    /**
     * 挂载 bundle 页的配置表单。
     * @param ctx - 浏览器插件上下文。
     */
    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, "dsh-llm-auto: dictionaries");
      var t = ctx.locale.bind(NS);

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
    return module.exports;
  }
});
