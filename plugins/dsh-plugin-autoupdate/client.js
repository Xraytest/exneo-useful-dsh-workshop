/**
 * dsh-plugin-autoupdate —— 浏览器半边（设置页「插件更新」）。
 *
 * 只读面板 + 两个动作：「检查更新」（可带 apply=true 顺带应用）与单个
 * 「更新」按钮。真正的安装走 host 的 pluginManager 服务（与设置页插件管理
 * 同一入口，享有文件锁/兼容性检查/回滚），本半边只做呈现与触发。
 *
 * @module dsh-plugin-autoupdate/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-autoupdate',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    const ROUTE = '/dsh-plugin-autoupdate';

    const ZH = {
      section: '插件更新',
      title: '插件源自动更新',
      desc: '监看已安装 bundle 的插件源：link: 目录源改完点「检查并应用」即重装生效；git/npm 源默认只报告（git 一律手动），npm 可在 host config 打开 autoApplyRemote。',
      check: '检查更新',
      checkApply: '检查并应用',
      checking: '检查中…',
      update: '更新',
      updating: '更新中…',
      updated: '已更新',
      none: '（本轮没有可更新的插件）',
      busy: '上一轮还没跑完，稍候',
      name: '插件',
      kind: '源类型',
      current: '已装版本',
      latest: '源版本',
      status: '状态',
      hint: 'link: 源的「源版本」就是源目录 package.json 里的版本——改完代码 + 升版本号，点「检查并应用」即可；git 源显示远端 HEAD，更新要走单个「更新」按钮。',
      loadFailed: '读取状态失败',
      retry: '重试',
      empty: 'profile 里还没有已启用的 bundle。',
    };
    const EN = {
      section: 'Plugin updates',
      title: 'Plugin source auto-update',
      desc: 'Watches installed bundles. link: directory sources reinstall on demand via "Check & apply"; git/npm sources report by default (git always manual; npm can enable autoApplyRemote in host config).',
      check: 'Check',
      checkApply: 'Check & apply',
      checking: 'Checking…',
      update: 'Update',
      updating: 'Updating…',
      updated: 'Updated',
      none: '(nothing to update this round)',
      busy: 'previous round still running',
      name: 'Plugin',
      kind: 'Source',
      current: 'Installed',
      latest: 'Source',
      status: 'Status',
      hint: 'For link: sources the source version is the workspace package.json version — bump it, then press Check & apply. git sources show remote HEAD; update them one by one.',
      loadFailed: 'could not load status',
      retry: 'Retry',
      empty: 'No enabled bundles in this profile.',
    };

    const CSS = [
      '.pau-page { padding: 4px 2px 24px; display: flex; flex-direction: column; gap: 12px; color: var(--dsw-alias-label-primary); font-size: 13px; }',
      '.pau-title { font-size: 15px; font-weight: 600; }',
      '.pau-desc { font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-secondary); }',
      '.pau-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm, 10px); background: var(--dsw-alias-bg-layer-1); overflow: auto; }',
      '.pau-table { width: 100%; border-collapse: collapse; font-size: 12px; }',
      '.pau-table th { text-align: left; font-weight: 600; padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); white-space: nowrap; }',
      '.pau-table td { padding: 7px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: top; }',
      '.pau-table tr:last-child td { border-bottom: 0; }',
      '.pau-btn { font: inherit; font-size: 12px; line-height: 1; padding: 7px 11px; border-radius: var(--dsw-radius-sm, 8px); border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; transition: border-color .15s ease, background .15s ease; }',
      '.pau-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-interactive-bg-hover-solid); }',
      '.pau-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }',
      '.pau-btn:disabled { opacity: .5; cursor: default; }',
      '.pau-row { display: flex; gap: 8px; flex-wrap: wrap; }',
      '.pau-note { font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }',
      '.pau-ok { color: var(--dsw-alias-state-success-primary); }',
      '.pau-warn { color: var(--dsw-alias-state-warn-primary); }',
      '.pau-err { color: var(--dsw-alias-state-error-primary); font-size: 12px; }',
    ].join('\n');

    async function api(path, options) {
      const response = await fetch(path, options);
      let body = null;
      try { body = await response.json(); } catch { /* 非 JSON */ }
      if (!response.ok) throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
      return body;
    }

    function useTranslate(ctx) {
      const [, bump] = useState(0);
      useEffect(() => {
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
        if (locale === undefined || typeof locale.subscribe !== 'function') return undefined;
        return locale.subscribe(() => bump((n) => n + 1));
      }, [ctx]);
      let active = '';
      try {
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
        if (locale !== undefined) active = String(locale.getLocale().active || '');
      } catch { /* 快照读失败不致命 */ }
      const dict = active === '' || /^zh/i.test(active) ? ZH : EN;
      const t = (key) => dict[key] ?? key;
      return t;
    }

    function AutoUpdatePage(props) {
      const ctx = props.ctx;
      const t = useTranslate(ctx);
      const [snapshot, setSnapshot] = useState(null);
      const [phase, setPhase] = useState('loading');
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [busyName, setBusyName] = useState('');

      const load = useCallback(async () => {
        setPhase((current) => (current === 'ready' ? 'ready' : 'loading'));
        setError('');
        try {
          const payload = await api(`${ROUTE}/status`, { headers: { accept: 'application/json' } });
          setSnapshot(payload);
          setPhase('ready');
        } catch (cause) {
          setError(`${t('loadFailed')}：${String(cause?.message ?? cause)}`);
          setPhase('error');
        }
      }, [t]);

      useEffect(() => { void load(); }, [load]);

      const runCheck = async (apply) => {
        setNotice('');
        try {
          const payload = await api(`${ROUTE}/check`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apply }),
          });
          setSnapshot(payload);
          setPhase('ready');
          const applied = payload.check?.applied ?? [];
          setNotice(applied.length > 0 ? `${t('updated')}: ${applied.map((a) => a.name).join(', ')}` : t('none'));
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        }
      };

      const applyOne = async (name) => {
        setBusyName(name);
        setNotice('');
        try {
          const payload = await api(`${ROUTE}/apply`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          setSnapshot(payload);
          setNotice(`${name}: ${t('updated')}`);
        } catch (cause) {
          setError(`${name}: ${String(cause?.message ?? cause)}`);
        } finally {
          setBusyName('');
        }
      };

      const results = snapshot?.lastCheck?.results ?? [];
      const lastAt = snapshot?.lastCheck?.at ?? 0;

      const table = results.length === 0
        ? h('div', { className: 'pau-note', style: { padding: '12px' } }, phase === 'ready' ? t('empty') : '…')
        : h('table', { className: 'pau-table' },
          h('thead', null, h('tr', null,
            h('th', null, t('name')), h('th', null, t('kind')),
            h('th', null, t('current')), h('th', null, t('latest')),
            h('th', null, t('status')))),
          h('tbody', null, ...results.map((entry) => h('tr', { key: entry.name },
            h('td', null, entry.name),
            h('td', null, entry.kind),
            h('td', null, entry.current === '' ? '—' : entry.current),
            h('td', null, entry.latest === '' ? '—' : entry.latest),
            h('td', null,
              entry.updateAvailable === true
                ? h('button', {
                  type: 'button',
                  className: 'pau-btn',
                  disabled: busyName === entry.name || (snapshot?.busy ?? false),
                  onClick: () => { void applyOne(entry.name); },
                }, busyName === entry.name ? t('updating') : t('update'))
                : h('span', { className: 'pau-ok' }, '✓'),
              entry.note !== '' ? h('div', { className: 'pau-note' }, entry.note) : null,
            ),
          ))));

      return h(React.Fragment, null,
        h('style', { key: 'pau-style' }, CSS),
        h('div', { className: 'pau-page' },
          h('div', { className: 'pau-title' }, t('title')),
          h('div', { className: 'pau-desc' }, t('desc')),
          h('div', { className: 'pau-row' },
            h('button', {
              type: 'button', className: 'pau-btn',
              disabled: phase !== 'ready' || (snapshot?.busy ?? false),
              onClick: () => { void runCheck(false); },
            }, t('check')),
            h('button', {
              type: 'button', className: 'pau-btn',
              disabled: phase !== 'ready' || (snapshot?.busy ?? false),
              onClick: () => { void runCheck(true); },
            }, t('checkApply')),
            lastAt > 0 ? h('span', { className: 'pau-note' }, `上次检查：${new Date(lastAt).toLocaleString()}`) : null,
            (snapshot?.busy ?? false) ? h('span', { className: 'pau-warn' }, t('busy')) : null,
          ),
          phase === 'loading' ? h('div', { className: 'pau-note' }, '…')
            : phase === 'error' ? h('div', { className: 'pau-err' }, error, ' ', h('button', { type: 'button', className: 'pau-btn', onClick: () => { void load(); } }, t('retry')))
            : h('div', { className: 'pau-card' }, table),
          notice !== '' ? h('div', { className: 'pau-ok' }, notice) : null,
          error !== '' && phase === 'ready' ? h('div', { className: 'pau-err' }, error) : null,
          (snapshot?.notes ?? []).length > 0 ? h('div', { className: 'pau-warn' }, snapshot.notes.join('；')) : null,
          h('div', { className: 'pau-note' }, t('hint')),
        ),
      );
    }

    let pluginCtx = null;

    function sectionLabel(ctx) {
      try {
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
        if (locale !== undefined) {
          const active = String(locale.getLocale().active || '');
          if (active !== '' && !/^zh/i.test(active)) return EN.section;
        }
      } catch { /* 用中文 */ }
      return ZH.section;
    }

    function apply(ctx) {
      pluginCtx = ctx;
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'plugin-autoupdate', order: 46, label: () => sectionLabel(ctx) },
        () => h(AutoUpdatePage, { ctx: pluginCtx }),
      ));
    }

    const exports = { inject: ['slots'], apply };
    return exports;
  },
});
