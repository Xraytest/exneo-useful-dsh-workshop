/**
 * 消息分支（dsh-message-branches）— 浏览器半边（v4）。
 *
 * ── v4 语义：分支＝我的消息的多个版本，**不建会话** ─────────────────────────
 * 入口只有一处：**我自己的消息**（`conversation.chat.node` 的 user / steering
 * 两个键——普通消息与回合中途插的话都是我发的）。出厂把这两格的最终渲染权交给
 * 该槽位，本插件按出厂同构布局重建气泡（几何/类名/style 自负），在动作行末尾
 * 保留一支笔，并在消息**下面**加一条分支导航条：
 *
 *     ‹ 上一个分支   2/3   下一个分支 ›
 *
 * 口径：
 *   · 第 1 个分支永远是日志原文（会话日志 append-only，谁也改不了）；
 *   · 点笔 → 编辑框 → 「创建分支」＝把改写版存进 host 账本并切到它；
 *   · 导航条只在**有 ≥2 个分支**时出现（1/1 没有导航价值，不给每条消息添噪）；
 *   · 切换是**粘性**的：host 记账、刷新不丢，且绝不「自动切回最新」；
 *   · 分支只长在**我的消息**上（助手消息、工具行一律不碰）。
 *
 * 顶格纪律：出厂 ui-chat 用 **priority 0** 注册了同键渲染器，而 SlotCore 的
 * 判重是「同 key 同 priority 即抛」——抛错会一路穿过 slots.inject → apply 让
 * 整条 client fiber 失败。所以这两格必须用**负 priority**（SHADOW_PRIORITY）
 * 成为 winner；出厂条目留在账本里当兜底，插件卸载后自动回位。
 *
 * 与 v3 的区别（v3＝真会话分叉）：不再有会话头部面板、不再有「任意历史会话」
 * 选择器、不再有文件回退——不建会话就没有「被丢弃的后文」，那一整套
 * （journal / 隔离区 / 回执）随之删除。改写后的消息**不会**重新生成助手回复：
 * 不建新会话就没有第二条日志，而日志 append-only，改写版进不了模型上下文
 * （硬做只会答非所问）。分支在这里的定位是「同一句话的多个说法」。
 *
 * ── 仍然坚守的两条 v1 教训 ──────────────────────────────────────────────
 * ① 编辑框宿主注册在 `shell.overlay`（root 作用域、常驻、在一切滚动容器之外），
 *    不寄居在任何会话条目里——v1 把它挂在头部条目内，那个条目一崩，编辑框跟着消失。
 * ② 不重新发明出厂视觉：控件用出厂 primitives（Modal / Button / Tooltip），
 *    自写样式只用 `--dsw-alias-*` 主题变量，文案全部走出厂 locale 服务；
 *    组件里一律经 ctxRef 取服务，**绝不**引用自由变量 ctx。
 */
window.__ModuleLoader__.load({
  id: 'dsh-message-branches',
  factory: (require) => {
    const React = require('react');
    // 平台种子模块（staticModules 里常驻），与出厂的客户端包同一份实例。
    const ui = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;

    /** locale 命名空间 = 插件 id；同时用作 registrant 标识。 */
    const NS = 'dsh-message-branches';
    const ROUTE = '/dsh-branches';
    const POLL_MS = 30000;
    const STYLE_ID = `${NS}/client.css`;

    /* ─────────────────────────── 文案（zh / en 成对，键集必然一致） ─────────────────────────── */

    const STRINGS = {
      pencil: ['改写这条消息并创建分支', 'Rewrite this message to create a branch'],
      copy: ['复制', 'Copy'],
      copied: ['已复制', 'Copied'],
      extraBlock: ['附加数据块', 'Extra block'],
      truncated: ['已截断（共 {total} 字符）', 'Truncated ({total} characters)'],
      referenceSummary: ['引用：{labels}', 'References: {labels}'],
      // 引用摘要的分隔符：与出厂 chat 词典的 message.referenceSeparator 同口径（zh「、」/ en「, 」）。
      referenceSeparator: ['、', ', '],
      // 时钟分档：与出厂 formatMessageClock 的模板逐语言一致（zh「M月D日」/ en「M/D」）。
      clockMd: ['{m}月{d}日', '{m}/{d}'],
      clockYmd: ['{y}年{m}月{d}日', '{y}-{m}-{d}'],
      navPrev: ['上一个分支', 'Previous branch'],
      navNext: ['下一个分支', 'Next branch'],
      navLabel: ['第 {current} 个分支，共 {total} 个', 'Branch {current} of {total}'],
      title: ['改写并创建分支', 'Rewrite and create a branch'],
      metaSeq: ['seq {seq}', 'seq {seq}'],
      metaBranches: ['当前 {current}/{total} 分支', 'branch {current}/{total}'],
      charCount: ['{count} 字', '{count} characters'],
      safeClose: [' · 关闭不会改动任何东西，确认后才创建分支', ' · closing changes nothing; the branch appears only on confirm'],
      confirm: ['创建分支', 'Create branch'],
      confirming: ['创建中…', 'Creating…'],
      cancel: ['取消', 'Cancel'],
      close: ['关闭', 'Close'],
      ok: ['好', 'OK'],
      done: ['已创建分支，当前 {current}/{total}。', 'Branch created; now on {current}/{total}.'],
      doneNote: [' · 分支已存进本地账本，刷新页面后仍在', ' · the branch is stored locally and survives a refresh'],
      sameText: ['与当前版本一字不差——改几个字再建分支。', 'Identical to the current version — change a few words first.'],
      errorEmpty: ['消息不能为空', 'The message cannot be empty'],
      errorFailed: ['创建分支失败：{message}', 'Creating the branch failed: {message}'],
      switchFailed: ['切换分支失败：{message}', 'Switching the branch failed: {message}'],
      stateFailed: ['分支状态读取失败：{message}', 'Reading the branch state failed: {message}'],
      copyEdited: ['复制当前分支文本', 'Copy the current branch text'],
    };

    const dictFor = (at) => {
      const out = {};
      for (const [key, pair] of Object.entries(STRINGS)) out[`branch.${key}`] = pair[at];
      return out;
    };
    const ZH_DICT = dictFor(0);
    const EN_DICT = dictFor(1);

    /* ─────────────────────────── 通用小工具 ─────────────────────────── */

    const errorText = (error) => (error instanceof Error ? error.message : String(error));

    async function api(path, options) {
      const response = await fetch(path, options);
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload !== null && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`);
      if (payload === null) throw new Error('响应不是 JSON / the response was not JSON');
      return payload;
    }

    const postJson = (path, body) => api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    /**
     * 与出厂 formatMessageClock 同口径的紧凑时钟：今天 `HH:mm`，今年 `M月D日 HH:mm`
     * （en `M/D HH:mm`），更早 `Y年M月D日 HH:mm`（en `Y-M-D HH:mm`）。
     * 日期模板走出厂词典同款措辞，不自己发明格式。
     */
    function clockText(time, t) {
      if (typeof time !== 'number' || !(time > 0)) return null;
      const date = new Date(time);
      const now = new Date();
      const pad2 = (value) => String(value).padStart(2, '0');
      const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
      const sameYear = date.getFullYear() === now.getFullYear();
      if (sameYear && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) return clock;
      const template = sameYear ? t('branch.clockMd', { m: date.getMonth() + 1, d: date.getDate() })
        : t('branch.clockYmd', { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() });
      return `${template} ${clock}`;
    }

    /** 出厂 contentParts：文本 / 附件 / 其余块分开（出处 ui-chat MessageItem.js）。 */
    function contentParts(content) {
      const texts = [];
      const attachments = [];
      const rest = [];
      const blocks = Array.isArray(content) ? content : [];
      for (const block of blocks) {
        if (block === null || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
        else if (block.type === 'image' && block.attachment !== undefined) attachments.push({ type: 'image', image: { attachment: block.attachment } });
        else if (block.type === 'file' && block.attachment !== undefined) attachments.push({ type: 'file', file: block.attachment });
        else rest.push(block);
      }
      return { text: texts.join(''), attachments, rest };
    }

    /**
     * 条目体内的翻译席 `t` 由出厂 renderer 按注册时声明的 `locale` 命名空间注入。
     * 这里再兜一层 `locale.bind(NS)`：万一某个席位的注入路径出问题，编辑框也照常
     * 渲染（宁可显示原始 key），**绝不**因为一个翻译函数缺失就让整条入口静默失效
     * ——v1 的「点了没反应」正是"某个依赖缺失 → 整棵树什么都不渲染"这一类故障。
     */
    function translatorOf(props) {
      if (typeof props?.t === 'function') return props.t;
      const bound = ctxRef?.get?.('locale')?.bind?.(NS);
      return typeof bound === 'function' ? bound : (key) => key;
    }

    /* ──────────────────── 会话 → 分支账本记录（host 是唯一权威） ──────────────────── */

    /** 没有 sessionId 时的恒定空状态（不订阅、不轮询、不发请求）。 */
    const EMPTY_RECORD = Object.freeze({ loading: false, group: null, error: '', version: 0 });

    /** 会话 → 分支组；30s 兜底轮询，动作后立刻刷新（host 是唯一权威）。 */
    const records = new Map();

    function recordOf(sessionId) {
      let record = records.get(sessionId);
      if (record === undefined) {
        record = { state: { loading: true, group: null, error: '', everLoaded: false, version: 0 }, listeners: new Set(), at: 0, ticket: 0, inflight: null, timer: null, subscribers: 0 };
        records.set(sessionId, record);
      }
      return record;
    }

    function emitRecord(record, patch) {
      record.state = { ...record.state, ...patch, version: record.state.version + 1 };
      for (const listener of [...record.listeners]) listener(record.state);
    }

    /** 分支账本的等价判断（30s 轮询返回同一份账时不该惊动整棵会话树）。 */
    function sameGroup(left, right) {
      if (left === null || right === null || left === undefined || right === undefined) return left === right;
      try {
        return JSON.stringify(left) === JSON.stringify(right);
      } catch {
        return false;
      }
    }

    async function refreshRecord(sessionId, force = false) {
      const record = recordOf(sessionId);
      if (force !== true) {
        // 同一会话的多个条目（每条用户消息一个）同帧挂载时复用**同一次在途请求**，
        // 不搞请求惊群；已 settled 的账本 1.5s 内也不重复拉。
        if (record.inflight !== null) return record.inflight;
        if (record.state.loading !== true && Date.now() - record.at < 1500) return record.state;
      }
      record.at = Date.now();
      // 单调票号：点击后的乐观更新会让在途的旧响应作废，绝不拿旧真值覆盖新意图。
      const ticket = (record.ticket += 1);
      const run = (async () => {
        try {
          const body = await api(`${ROUTE}/state?sessionId=${encodeURIComponent(sessionId)}`);
          if (ticket !== record.ticket) return record.state; // 过期响应：丢弃
          const group = body.group ?? null;
          const unchanged = record.state.loading !== true && record.state.error === '' && sameGroup(record.state.group, group);
          if (!unchanged) emitRecord(record, { loading: false, group, error: '', everLoaded: true });
        } catch (failure) {
          if (ticket !== record.ticket) return record.state;
          const message = errorText(failure);
          // 失败分支也要防抖：host 持续挂着时不该每 30s 把整棵会话树重渲染一遍。
          if (record.state.loading === true || record.state.error !== message) {
            emitRecord(record, { loading: false, error: message });
          }
        }
        return record.state;
      })();
      record.inflight = run;
      try {
        return await run;
      } finally {
        if (record.inflight === run) record.inflight = null;
      }
    }

    function patchRecord(sessionId, patch) {
      const record = recordOf(sessionId);
      record.ticket += 1; // 让在途的 /state 响应全部作废（它们此刻都是旧真值）
      emitRecord(record, patch);
    }

    /**
     * 订阅某个会话的分支账本。**hook 顺序必须稳定**：sessionId 为空时走同一条
     * hook 路径，只是不订阅、不轮询、不发请求（返回恒定的空状态）。
     * 最后一个订阅者退订时把记录整条删掉：host 是唯一权威，下次挂载重拉即可
     * （也顺带不把陈旧的 error 留在内存里）。
     */
    function useRecord(sessionId) {
      const key = typeof sessionId === 'string' && sessionId !== '' ? sessionId : '';
      const [state, setState] = React.useState(() => (key === '' ? EMPTY_RECORD : recordOf(key).state));
      React.useEffect(() => {
        // 换会话（同实例不重挂的 rare 路径）：立刻换成新会话的当前状态，
        // 绝不拿上一个会话的分支组配这一个会话的 seq。
        setState(key === '' ? EMPTY_RECORD : recordOf(key).state);
        if (key === '') return undefined;
        const record = recordOf(key);
        record.listeners.add(setState);
        record.subscribers += 1;
        if (record.timer === null) record.timer = window.setInterval(() => { refreshRecord(key, true); }, POLL_MS);
        refreshRecord(key);
        return () => {
          record.listeners.delete(setState);
          record.subscribers -= 1;
          if (record.subscribers <= 0) {
            if (record.timer !== null) {
              window.clearInterval(record.timer);
              record.timer = null;
            }
            if (records.get(key) === record) records.delete(key);
          }
        };
      }, [key]);
      return state;
    }

    /** 某条消息的分支集（没有分支 → null：导航条不渲染，笔照常）。 */
    function branchEntryOf(group, seq) {
      if (group === null || group === undefined || typeof seq !== 'number') return null;
      const messages = group.messages ?? {};
      const entry = messages[String(seq)];
      if (entry === null || entry === undefined) return null;
      if (!Number.isInteger(entry.total) || entry.total < 2) return null;
      if (!Array.isArray(entry.variants)) return null; // 脏数据：不渲染导航，也不抛
      return entry;
    }

    /** 只改 selected 的不可变副本（乐观切换用；失败后再 refresh 回真值）。 */
    function groupWithSelected(group, seq, index) {
      if (group === null || group === undefined) return group;
      const key = String(seq);
      const entry = group.messages?.[key];
      if (entry === undefined) return group;
      return {
        ...group,
        messages: { ...group.messages, [key]: { ...entry, selected: index } },
      };
    }

    /* ───────────────────────── 编辑框（唯一入口） ───────────────────────── */

    /**
     * 全局单例编辑框：笔只是 `open()`，**不碰任何数据**；
     * 真正的分支只发生在「创建分支」那一下。
     */
    const editor = {
      state: null,
      listeners: new Set(),
      open(payload) {
        this.state = payload;
        this.publish();
      },
      close() {
        this.state = null;
        this.publish();
      },
      publish() {
        for (const listener of [...this.listeners]) listener(this.state);
      },
      subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
    };

    function useEditorState() {
      const [state, setState] = React.useState(editor.state);
      React.useEffect(() => editor.subscribe(setState), []);
      return state;
    }

    /* ─────────────────── 我自己的消息：气泡 + 一支笔 + 分支导航条 ─────────────────── */

    /**
     * 动作行里的图标按钮：类名与出厂 MessageIconActions 的 `.action` 同几何
     * （28px 方、悬停底色、15px 图标），颜色走主题变量。
     */
    function IconAction({ label, onClick, children, time }) {
      const button = h('button', {
        type: 'button',
        className: 'mb-action',
        'aria-label': label,
        onClick,
      }, children);
      return time === null || time === undefined
        ? h(ui.Tooltip, { label, side: 'bottom' }, button)
        : h(React.Fragment, null, h('span', { className: 'mb-time' }, time), h(ui.Tooltip, { label, side: 'bottom' }, button));
    }

    /**
     * 分支导航条：`‹ 上一个分支 | 2/3 | 下一个分支 ›`。
     * 只有 ≥2 个分支时才由调用方渲染；两端各自禁用。切换先乐观改本地记录，
     * POST 成功即真、失败就拉一次 host 真值回滚（绝不留下「界面说变了其实没变」）。
     */
    function BranchNav({ entry, t, onStep }) {
      const total = entry.total;
      const current = entry.selected + 1;
      const navButton = (side, label, disabled, step) => h('button', {
        type: 'button',
        className: 'mb-branchBtn',
        disabled,
        'aria-label': label,
        title: label,
        onClick: () => onStep(step),
      },
      h(side === 'prev' ? ui.IconChevronLeftOutlineRegular : ui.IconChevronRightOutlineRegular, { size: 13 }),
      h('span', { className: 'mb-branchBtnText' }, label));
      return h('div', { className: 'mb-branchNav', 'data-message-branches': 'yes' },
        navButton('prev', t('branch.navPrev'), current <= 1, -1),
        h('span', {
          className: 'mb-branchCount',
          'aria-label': t('branch.navLabel', { current, total }),
          title: t('branch.navLabel', { current, total }),
        }, `${current}/${total}`),
        navButton('next', t('branch.navNext'), current >= total, 1));
    }

    /**
     * user 键的接管者：按出厂同构布局重建气泡（自有类名 + 主题变量），
     * 动作行末尾一支笔，消息下面一条分支导航条。
     * 当前分支不是原文时，气泡显示改写版文本（附件/引用照旧）。
     */
    function UserNodeEntry(props) {
      const { node, renderMessageImages, openFile, openSkill, sessionId } = props;
      const t = translatorOf(props);
      const data = (node !== null && node !== undefined ? node.data : null) ?? {};
      const [copied, setCopied] = React.useState(false);
      const [switchError, setSwitchError] = React.useState('');
      const copyTimer = React.useRef(null);
      const copyPending = React.useRef(false);
      const record = useRecord(sessionId);
      const entry = branchEntryOf(record.group, data.seq);
      const active = entry !== null && entry.selected > 0 ? (entry.variants[entry.selected - 1] ?? null) : null;
      const parts = contentParts(data.content);
      const displayText = active !== null && typeof active.text === 'string' ? active.text : parts.text;
      const referenceLabels = Array.isArray(data.referenceLabels) ? data.referenceLabels : [];
      const skillNames = Array.isArray(data.skillNames) ? data.skillNames : [];
      const compactImages = parts.attachments.length > 1;
      const showBubble = displayText !== '' || parts.rest.length > 0;
      const copyText = t('branch.copy');
      const copiedText = t('branch.copied');

      React.useEffect(() => () => { if (copyTimer.current !== null) window.clearTimeout(copyTimer.current); }, []);

      const onCopy = () => {
        if (copied || copyPending.current) return;
        copyPending.current = true;
        Promise.resolve(ui.writeClipboard(displayText)).then((ok) => {
          copyPending.current = false;
          if (ok === false) return;
          setCopied(true);
          copyTimer.current = window.setTimeout(() => { copyTimer.current = null; setCopied(false); }, 1000);
        }).catch(() => { copyPending.current = false; });
      };

      const onStep = async (step) => {
        if (entry === null || typeof sessionId !== 'string' || sessionId === '') return;
        const next = entry.selected + step;
        if (next < 0 || next > entry.total - 1) return;
        setSwitchError('');
        patchRecord(sessionId, { group: groupWithSelected(record.group, data.seq, next), error: '' });
        try {
          await postJson(`${ROUTE}/select`, { sessionId, seq: data.seq, index: next });
          setSwitchError('');
          refreshRecord(sessionId, true);
        } catch (failure) {
          setSwitchError(errorText(failure));
          refreshRecord(sessionId, true); // 回滚到 host 真值
        }
      };

      const attachmentRow = parts.attachments.length === 0 ? null : h('div', { className: 'mb-attachmentRow', 'data-message-attachments': true },
        parts.attachments.map((attachment, index) => {
          if (attachment.type === 'image') {
            if (typeof renderMessageImages !== 'function') return null;
            return h(React.Fragment, { key: `image:${index}` },
              renderMessageImages({ images: [attachment.image], align: 'end', compact: compactImages }));
          }
          const name = attachment.file?.name ?? '';
          const meta = [
            ui.fileExtension(name).toUpperCase().slice(0, 8),
            ui.fileSizeText(attachment.file?.bytes ?? 0),
          ].filter(Boolean).join(' ');
          return h('span', { key: `file:${index}`, className: 'mb-fileCard', title: name },
            h(ui.FileTypeIcon, { path: name, className: 'mb-fileIcon' }),
            h('span', { className: 'mb-fileContent' },
              h('span', { className: 'mb-fileName' }, name),
              h('span', { className: 'mb-fileMeta' }, meta)));
        }));

      const bubble = showBubble ? h('div', { className: 'mb-bubble', 'data-message-branch': active === null ? 'original' : 'edited' },
        ui.projectUserText(displayText, referenceLabels, skillNames, 'skill', { openFile, openSkill }),
        parts.rest.map((block, index) => h(ui.JsonBlock, {
          key: index,
          label: t('branch.extraBlock'),
          payload: block,
          truncatedLabel: (total) => t('branch.truncated', { total }),
        }))) : null;

      const referenceSummary = referenceLabels.length === 0 ? null
        : h('div', { className: 'mb-referenceSummary' },
          t('branch.referenceSummary', { labels: referenceLabels.join(t('branch.referenceSeparator')) }));

      const pencilLabel = t('branch.pencil');
      const pencil = h(IconAction, {
        label: pencilLabel,
        onClick: () => {
          if (typeof data.seq !== 'number' || typeof sessionId !== 'string' || sessionId === '') return;
          editor.open({
            sessionId,
            seq: data.seq,
            text: displayText,
            current: entry === null ? 1 : entry.selected + 1,
            total: entry === null ? 1 : entry.total,
          });
        },
      }, h(ui.IconEditOutlineRegular, { size: 15 }));

      const nav = entry === null ? null : h(BranchNav, { entry, t, onStep });
      // 只在「分支功能本该在场却读不到」时提示，两种情况分开：
      //   · 本来有分支、只是这次刷新失败 → 导航条下方（entry !== null）；
      //   · 这个会话从来没读成功过 → 动作行下方（否则「没有分支」和「host 挂了」
      //     在用户眼里一模一样，正是最难排查的那类静默失效）。
      const stateError = record.error === '' ? null
        : (entry !== null || record.everLoaded !== true)
          ? h('div', { className: 'mb-branchError' }, t('branch.stateFailed', { message: record.error }))
          : null;

      return h('div', { className: 'mb-userRow' },
        h('div', { className: 'mb-userStack' }, attachmentRow, bubble, referenceSummary),
        h('div', { className: 'mb-actions' },
          h(IconAction, {
            label: active !== null ? t('branch.copyEdited') : (copied ? copiedText : copyText),
            onClick: onCopy,
            time: clockText(data.time, t),
          }, copied ? h(ui.IconCheckOutlineRegular, { size: 15 }) : h(ui.IconCopyOutlineRegular, { size: 15 })),
          pencil),
        nav,
        stateError,
        switchError !== '' ? h('div', { className: 'mb-branchError' }, t('branch.switchFailed', { message: switchError })) : null);
    }

    /* ───────────────────────── 编辑框本体 ───────────────────────── */

    function EditBranchModal({ payload, t }) {
      const [text, setText] = React.useState(payload.text ?? '');
      const [phase, setPhase] = React.useState('edit'); // edit | busy | done
      const [error, setError] = React.useState('');
      const [result, setResult] = React.useState(null);

      const confirm = async () => {
        const trimmed = text.trim();
        if (trimmed === '') { setError(t('branch.errorEmpty')); return; }
        setError('');
        setPhase('busy');
        try {
          const body = await postJson(`${ROUTE}/branch`, { sessionId: payload.sessionId, seq: payload.seq, text: trimmed });
          setResult(body.message ?? null);
          setPhase('done');
          refreshRecord(payload.sessionId, true);
        } catch (failure) {
          setError(t('branch.errorFailed', { message: errorText(failure) }));
          setPhase('edit');
        }
      };

      let body = null;
      if (phase === 'done') {
        const message = result ?? { total: payload.total ?? 2, selected: payload.total ?? 2 };
        body = h('div', null,
          h('div', { className: 'mb-ok' }, t('branch.done', { current: message.selected + 1, total: message.total })),
          h('div', { className: 'mb-note' }, t('branch.doneNote')));
      } else {
        // 与打开时的文本一字不差 → 建不出新分支（只会得到一条重复项）：直接禁掉确认。
        const unchanged = text.trim() === (payload.text ?? '').trim() && text.trim() !== '';
        body = h('div', null,
          h('div', { className: 'mb-meta' },
            t('branch.metaSeq', { seq: payload.seq ?? '?' }),
            ' · ',
            t('branch.metaBranches', { current: payload.current ?? 1, total: payload.total ?? 1 })),
          h('textarea', {
            className: 'mb-input',
            value: text,
            rows: Math.min(16, Math.max(4, text.split('\n').length + 1)),
            onChange: (event) => setText(event.target.value),
            disabled: phase === 'busy',
          }),
          h('div', { className: 'mb-meta' }, `${t('branch.charCount', { count: text.length })}${t('branch.safeClose')}`),
          unchanged ? h('div', { className: 'mb-note' }, t('branch.sameText')) : null);
      }

      const footer = phase === 'done'
        ? [h(ui.Button, { key: 'ok', variant: 'primary', onClick: () => editor.close() }, t('branch.ok'))]
        : [
          h(ui.Button, {
            key: 'confirm', variant: 'primary', disabled: phase === 'busy' || text.trim() === '' || text.trim() === (payload.text ?? '').trim(),
            onClick: confirm,
          }, phase === 'busy' ? t('branch.confirming') : t('branch.confirm')),
          h(ui.Button, { key: 'cancel', variant: 'outline', disabled: phase === 'busy', onClick: () => editor.close() }, t('branch.cancel')),
        ];

      return h(ui.Modal, {
        open: true,
        onClose: () => editor.close(),
        title: t('branch.title'),
        closeLabel: t('branch.close'),
        footer: h(React.Fragment, null, footer),
      },
      error !== '' ? h('div', { className: 'mb-error' }, error) : null,
      body);
    }

    /**
     * 单例宿主：注册在 `shell.overlay`（root 作用域、常驻、与任何会话条目解耦）。
     * **不要**把它挂回某个会话条目内部——那条路径一旦崩掉，入口就一起失效（v1 的教训）。
     */
    function EditorHost(props) {
      const state = useEditorState();
      if (state === null) return null;
      const t = translatorOf(props);
      return h(EditBranchModal, { payload: state, t });
    }

    /* ─────────────────────────── 样式 ─────────────────────────── */

    // 只有三条硬约束：① 只用 --dsw-alias-* / --dsw-specific-* 主题变量（不写死颜色）；
    // ② 用户气泡的几何与出厂 UserStyleBubble 一致（改用自有类名，不再依赖别包的哈希类名）；
    // ③ 弹窗的"外壳"交给出厂 primitives，这里只给内容排版。
    const CSS = `
.mb-userRow{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.mb-userStack{display:flex;flex-direction:column;align-items:flex-end;gap:8px;min-width:0;max-width:min(calc(var(--dsh-chat-content-width,748px) * .702),82%)}
.mb-attachmentRow{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;max-width:100%}
.mb-fileCard{display:inline-flex;align-items:center;gap:10px;box-sizing:border-box;flex:0 0 240px;width:240px;min-height:64px;padding:8px 12px;border:.5px solid var(--dsw-alias-border-l2,#0000001f);border-radius:var(--dsw-radius-xl,12px);background:var(--dsw-specific-input-major,transparent)}
.mb-fileIcon{flex:none;width:28px;height:28px}
.mb-fileContent{display:flex;flex-direction:column;flex:1;min-width:0}
.mb-fileName{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.mb-fileMeta{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary,#00000073);font-size:12px;line-height:15px}
.mb-bubble{max-width:100%;padding:10px 16px;border-radius:var(--dsw-radius-xl,12px);background:var(--dsw-specific-bubble,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));white-space:pre-wrap;word-break:break-word}
.mb-referenceSummary{color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px))}
.mb-actions{display:flex;align-items:center;gap:8px;height:calc(28px + var(--dsh-content-font-delta,0px))}
.mb-time{color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));white-space:nowrap;padding-right:12px}
.mb-action{display:inline-flex;align-items:center;justify-content:center;width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));padding:6px;border:0;border-radius:var(--dsw-radius-sm,6px);background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.mb-action:hover{background:var(--dsw-alias-interactive-bg-hover,transparent);color:var(--dsw-alias-label-secondary)}
.mb-action svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}
@media (hover:hover){
:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering]):has(~:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering])) .mb-actions{opacity:0;transition:opacity 80ms}
:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering]):has(~:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering])):hover .mb-actions,
:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering]):has(~:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering])):focus-within .mb-actions{opacity:1}
}
.mb-branchNav{display:inline-flex;align-items:center;gap:2px;height:22px;padding:0 2px;border-radius:11px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1;user-select:none}
.mb-branchBtn{display:inline-flex;align-items:center;gap:1px;height:20px;padding:0 5px;border:0;border-radius:11px;background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;cursor:pointer}
.mb-branchBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,transparent);color:var(--dsw-alias-label-secondary)}
.mb-branchBtn:disabled{opacity:.38;cursor:default}
.mb-branchBtn svg{width:13px;height:13px}
.mb-branchBtnText{white-space:nowrap}
.mb-branchCount{min-width:26px;padding:0 3px;color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums;text-align:center;white-space:nowrap}
.mb-branchError{margin-top:2px;color:var(--dsw-alias-state-error-primary,#d33);font-size:11px;word-break:break-all}
.mb-note{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.55}
.mb-meta{color:var(--dsw-alias-label-secondary);font-size:11px;margin:2px 0 6px}
.mb-error{margin:4px 0;padding:8px 10px;border:1px solid var(--dsw-alias-state-error-primary,#d33);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary,#d33);font-size:12px;word-break:break-word}
.mb-ok{margin:4px 0;padding:8px 10px;border:1px solid var(--dsw-alias-state-success-primary,#2a2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-success-primary,#2a2);font-size:12px}
.mb-input{box-sizing:border-box;width:100%;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.6;resize:vertical}
.mb-input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}
`;

    function installStyles() {
      if (typeof document === 'undefined') return () => {};
      // 同 id 的旧节点（客户端热换期间可能还在）先摘掉：留着它，这一份新样式会被
      // "已存在"挡掉，而旧实例随后的清理又会把它删掉——页面上会一条样式都不剩。
      for (const stale of document.querySelectorAll(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`)) stale.remove();
      const tag = document.createElement('style');
      tag.dataset.plugin = NS;
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => { tag.remove(); };
    }

    /* ─────────────────────────── 装配 ─────────────────────────── */

    /** 插件 ctx：组件里一律经它取服务，**绝不**引用自由变量 `ctx`。 */
    let ctxRef = null;

    const inject = ['slots', 'locale'];

    /**
     * 我的消息在 `conversation.chat.node` 上占的键。出厂 ui-chat 用 **priority 0**
     * 注册了同键渲染器（UserMessageNodeView 同时是 user 与 steering），而
     * SlotCore 的判重规则是「同 key 同 priority 即抛」——抛错会一路穿过
     * slots.inject → apply，让整条 client fiber 失败。所以这里必须用**负 priority**
     * 成为该格的 winner（lowest renders），出厂条目退成兜底：插件卸载后自动回退，
     * 也不会把出厂那条挤掉。这条纪律与本 profile 的 dsh-settings-nav 同源。
     */
    const MESSAGE_KEYS = ['user', 'steering'];
    const SHADOW_PRIORITY = -1;

    function apply(ctx) {
      ctxRef = ctx;
      const slots = ctx.get('slots');
      if (slots === undefined || slots === null) return;

      ctx.effect(() => installStyles(), 'message-branches: styles');

      ctx.effect(() => ctx.locale.register(NS, { zh: ZH_DICT, en: EN_DICT }), 'message-branches: dictionaries');

      // 编辑框宿主：root 作用域、常驻，与任何会话条目解耦。
      ctx.effect(() => slots.inject('shell.overlay', () => slots.register({
        name: 'shell.overlay',
        id: 'message-branches-editor',
        order: 40,
        locale: NS,
      }, EditorHost)), 'message-branches: editor host');

      // 接管**我的消息**：普通 user 消息 + 回合中途插进来的 steering 消息——
      // 两者都是我发的，都该有笔和分支导航条。同构气泡 + 动作行末尾一支笔 +
      // 消息下面一条分支导航条；其它键（助手/工具/context…）一律不碰。
      for (const key of MESSAGE_KEYS) {
        ctx.effect(() => slots.inject('conversation.chat.node', () => slots.register({
          name: 'conversation.chat.node',
          key,
          id: `message-branches-${key}-edit`,
          priority: SHADOW_PRIORITY,
          locale: NS,
        }, UserNodeEntry)), `message-branches: ${key} node`);
      }
    }

    return { name: NS, inject, apply };
  },
});
