/**
 * @dsh-external/dsh-blender-plugin —— dsh-TUI 宿主半边（v2.6.1，host 侧 / Node 进程内）。
 *
 * Web 的客户端半边（lib/client.js，`dsh.client.platform = "web"`）在 dsh-TUI 里不加载，
 * 所以 v2.3 的「Blender 原生选中 → 草稿」和 `@` 提及在 TUI 里一直是断的（契约 v2.3 增补 §S5.2）。
 * 这里用 dsh-TUI 的**宿主接缝**补上同一套体验（契约 v2.3 增补 §S6）：
 *   ① Blender 原生选中 → 输入框上下文 chip（`ctx.tuiContextChips`）+ toast（`ctx.tuiToast`）
 *   ② 页脚状态字段（`ctx.tuiStatus.setField`）：通道 / AI 暂停 / 渲染 / 租约 / 作业
 *   ③ `@` 提及 Blender 对象 / 材质 / 集合（`ctx.tuiMentions`）
 *   ④ `/blender status|doctor|jobs` 命令（`ctx.commands` 是 DSH 核心接缝，Web 也有）+ 子命令补全（`ctx.tuiCommandTrees`）
 *
 * 纪律：
 *   - 每块都按服务是否存在启用（`ctx.inject` 懒等）：Web / headless / 没有这些接缝的旧版 dsh-TUI 上什么都不做；
 *   - 只读后端（`/host/state` `/host/selection/*` `/host/jobs` 零 Blender 往返；`@` 提及与 `/blender doctor` 才碰 Blender）；
 *   - 任何失败都静默降级，绝不影响 15 个模型工具；
 *   - 选中**不自动发送**：chip 只在用户自己发下一条消息时随消息走，用户可以删掉。
 */
export interface TuiHostOptions {
    port: number;
    /** 本插件的写租约 holder（页脚区分「本会话持有 / 别的会话持有」） */
    holder: string;
}
/** v2.4 子元素选中（网格点/边/面、骨骼、曲线/晶格控制点）→ 文本。逐字对齐 lib/client.js 的 subSelectionText。 */
export declare function subSelectionText(sel: any): string | null;
/** selection payload → 给模型的文本（空选中回 null）。逐字对齐 lib/client.js 的 selectionMessageText。 */
export declare function selectionMessageText(payload: any): string | null;
/** chip 标题（一行，≤ 80 cell）：同一个 key 重发会**替换**上一条，所以标题只说「是什么、多少」 */
export declare function selectionChipTitle(sel: any): string;
/**
 * 一次轮询（导出给自检）：取未消费的选中 → 挂 chip → consume。
 * 与 Web 桥同一套 CAS 语义（§S3.2）：成功才 consume(ok:true)；挂不上不消费、下一 tick 重试，第 3 次失败
 * consume(ok:false, reason)；空选中直接 consume(ok:false)（没有可重试的东西）。
 */
export declare function selectionTick(deps: {
    port: number;
    chips: any;
    notify?: (text: string, color: string) => void;
    state: any;
}): Promise<void>;
/** `/host/state` 响应 → 页脚一格（文本 / tone / 悬停说明）。纯函数，导出给自检。 */
export declare function footerField(state: any, holder: string, port: number): {
    text: string;
    tone: string;
    detail: string;
};
/** `/host/scene-items` 响应 → 提及条目。插进草稿的是与 Web codec 同一份模型文本（`<blender-object>名字</blender-object>`）。 */
export declare function mentionItems(body: any, limit?: number): any[];
/** 本地过滤：label 含 query（不分大小写）；空 query 给前 50 条。宿主会再按自己的模糊打分排序。 */
export declare function filterMentionItems(items: any[], query: string): any[];
/**
 * `@` 提及的数据源：第一次查询拉一份全量（≤ 1000 条）缓存起来，之后在本地过滤、立即返回；
 * 缓存超过 5 s 就在后台刷新一次（不等它）。冷启动那一次可能超过宿主的单次时限、被丢弃，
 * 但缓存会填上，下一次按键就有结果。只在用户真的打 `@` 时才碰 Blender，不轮询。
 */
export declare function createSceneMentionSource(port: number): (query: string, signal: AbortSignal) => Promise<any[]>;
/** `/blender <sub>` → 文本。导出给自检。 */
export declare function blenderCommand(rawInput: string, opts: TuiHostOptions, signal?: AbortSignal): Promise<{
    kind: string;
    text: string;
}>;
/** apply() 调这个；宿主没有对应服务的块永远不会启用。 */
export declare function registerTuiHost(ctx: any, opts: TuiHostOptions): void;
/** doctor 的一行：TUI 宿主半边接上了哪些接缝（非 dsh-TUI 宿主时说明为什么是空的） */
export declare function tuiHostSummary(): string;
export declare const __tuiHostInternals: {
    wired: {
        chips: boolean;
        toast: boolean;
        status: boolean;
        mentions: boolean;
        commands: boolean;
        commandTree: boolean;
    };
    bridge: {
        lastSeq: number;
        lastOk: null | boolean;
        lastReason: null | string;
        lastAt: null | number;
    };
    SUBCOMMANDS: {
        name: string;
        description: string;
    }[];
};
