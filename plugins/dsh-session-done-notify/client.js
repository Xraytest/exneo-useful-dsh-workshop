window.__ModuleLoader__.load({
  id: 'dsh-session-done-notify',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-session-done-notify';

    // localStorage key for the user's on/off preference. The browser grants
    // notification permission per site, so "enabled" is stored per device.
    const STORAGE_KEY = 'dsh.sessionDoneNotify.enabled';

    const css = [
      '.sdn_row{border-bottom:.5px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:center;gap:24px;padding:16px 0;display:flex}',
      '.sdn_rowText{flex-direction:column;gap:4px;min-width:0;display:flex}',
      '.sdn_title{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;font-weight:400}',
      '.sdn_desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-weight:400}',
      '.sdn_alert{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin-top:4px}',
      // Switch copied from the host's Switch primitive (behavior + tokens kept,
      // classes renamed under this plugin's prefix).
      '.sdn_switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer}',
      '.sdn_switch[aria-checked=\'true\']{background:var(--dsw-alias-brand-primary)}',
      '.sdn_switch:disabled{cursor:default;opacity:.5}',
      '.sdn_switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.sdn_thumb{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground);transition:transform 120ms ease}',
      '.sdn_switch[aria-checked=\'false\'] .sdn_thumb{background:var(--dsw-alias-switch-thumb)}',
      '.sdn_switch[aria-checked=\'true\'] .sdn_thumb{transform:translateX(16px)}',
    ].join('\n');
    const cssTagId = `${NS}/settings.module.css`;
    if (typeof document !== 'undefined'
      && document.querySelector(`style[data-plugin-css=${JSON.stringify(cssTagId)}]`) === null) {
      const tag = document.createElement('style');
      tag.dataset.pluginCss = cssTagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    const notificationsSupported = typeof Notification !== 'undefined';

    function readEnabled() {
      try {
        return localStorage.getItem(STORAGE_KEY) === '1';
      } catch {
        return false;
      }
    }

    function writeEnabled(value) {
      try {
        if (value) localStorage.setItem(STORAGE_KEY, '1');
        else localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* storage unavailable: preference is session-only */
      }
    }

    /** Ask for notification permission (must run inside a user gesture). */
    async function requestPermission() {
      if (!notificationsSupported) return 'unsupported';
      if (Notification.permission === 'granted') return 'granted';
      if (Notification.permission === 'denied') return 'denied';
      try {
        return await Notification.requestPermission();
      } catch {
        return 'denied';
      }
    }

    /** Settings → General preference row. */
    function NotifyRow({ useEnabled, setEnabled, t }) {
      const enabled = useEnabled((value) => value);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const next = () => {
        setError('');
        if (enabled) {
          // Turning off never needs the browser permission dialog.
          setEnabled(false);
          return;
        }
        setBusy(true);
        requestPermission().then((result) => {
          if (result === 'granted') setEnabled(true);
          else if (result === 'denied') setError(t('notifications.denied'));
          else if (result === 'unsupported') setError(t('notifications.unsupported'));
        }).finally(() => {
          setBusy(false);
        });
      };
      return h('div', { className: 'sdn_row' },
        h('div', { className: 'sdn_rowText' },
          h('div', { className: 'sdn_title' }, t('settings.title')),
          h('div', { className: 'sdn_desc' }, t('settings.description')),
          error ? h('div', { role: 'alert', className: 'sdn_alert' }, error) : null,
        ),
        h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': enabled,
          'aria-label': t('settings.title'),
          disabled: busy,
          className: 'sdn_switch',
          onClick: next,
        }, h('span', { className: 'sdn_thumb' })),
      );
    }

    return {
      inject: ['slots', 'sessions', 'remote', 'locale'],
      apply(ctx) {
        // All of this plugin's copy lives under its own namespace: the locale
        // service rejects a second registration of the same (ns, locale)
        // pair, so sharing the host's "settings" namespace would collide.
        const dict = {
          zh: {
            'settings.title': '会话完成通知',
            'settings.description': '会话回合结束时弹出系统通知（Windows / Android）。仅在该页面未聚焦时提示。',
            'notifications.denied': '浏览器通知权限已被拒绝，请在站点设置中重新允许。',
            'notifications.unsupported': '当前浏览器不支持系统通知。',
            'notify.title': '会话已完成',
            'notify.body': '回合已结束，点按返回对话。',
            'notify.fallbackTitle': '会话',
          },
          en: {
            'settings.title': 'Session done notifications',
            'settings.description': 'Show a system notification (Windows / Android) when a session turn completes. Only shown while this page is not focused.',
            'notifications.denied': 'Notification permission was denied. Re-enable it in the site settings.',
            'notifications.unsupported': 'This browser does not support system notifications.',
            'notify.title': 'Session finished',
            'notify.body': 'The turn has ended — tap to return to the conversation.',
            'notify.fallbackTitle': 'Session',
          },
        };
        ctx.effect(() => ctx.locale.register(NS, dict), 'session-done-notify: dictionary');

        const t = ctx.locale.bind(NS);

        // Preference state shared between the settings row and the event
        // handler: a tiny observable snapshot so the row re-renders on change.
        const listeners = new Set();
        let enabled = readEnabled();
        const snapshotStore = {
          getSnapshot: () => enabled,
          subscribe(listener) {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        };
        const setEnabledValue = (value) => {
          if (value === enabled) return;
          enabled = value;
          writeEnabled(value);
          for (const listener of listeners) listener();
        };

        // Sessions seen running: the completion signal is running -> idle.
        const runningSessions = new Set();

        const titleFor = (sessionId) => {
          const { byId } = ctx.sessions.list.getSnapshot();
          const entry = byId[sessionId];
          return typeof entry?.title === 'string' && entry.title !== ''
            ? entry.title
            : t('notify.fallbackTitle');
        };

        const showNotification = (sessionId) => {
          if (!enabled
            || !notificationsSupported
            || Notification.permission !== 'granted'
            || document.visibilityState === 'visible') return;
          const title = `${t('notify.title')} — ${titleFor(sessionId)}`;
          try {
            const notification = new Notification(title, {
              body: t('notify.body'),
              tag: `dsh-session-${sessionId}`,
            });
            notification.onclick = () => {
              window.focus();
              ctx.get('uiWorkspace')?.openSession({ sessionId });
              notification.close();
            };
          } catch {
            /* some engines restrict the constructor; permission state stands */
          }
        };

        ctx.effect(() => {
          const disposeStatus = ctx.remote.$on('api-session/status', (sessionId, running) => {
            if (running) {
              runningSessions.add(sessionId);
              return;
            }
            if (!runningSessions.has(sessionId)) return;
            runningSessions.delete(sessionId);
            showNotification(sessionId);
          });
          return () => {
            disposeStatus();
          };
        }, 'session-done-notify: session status listener');

        // The General preference row; the toggle click is the user gesture
        // the notification permission prompt requires.
        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item',
          id: 'session-done-notify',
          order: 21,
          locale: NS,
          inject: () => ({
            hooks: { enabled: snapshotStore },
            setEnabled: setEnabledValue,
          }),
        }, NotifyRow));
      },
    };
  },
});
