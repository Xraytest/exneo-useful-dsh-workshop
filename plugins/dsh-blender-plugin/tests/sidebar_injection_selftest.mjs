#!/usr/bin/env node
/** Behavior regression for optional Cordis services. No browser, backend, or Blender required.
 * Unlike the static bundle test, the parent ctx deliberately cannot access sidebar services.
 * Run: node tests/sidebar_injection_selftest.mjs [--bundle /path/to/client.js]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv.indexOf('--bundle');
const bundle = arg < 0 ? path.join(ROOT, 'lib/client.js') : process.argv[arg + 1];
const source = fs.readFileSync(bundle, 'utf8');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
}
function fixture() {
  let entry;
  const logs = [];
  const effects = [];
  const window = { __ModuleLoader__: { load(value) { entry = value; } } };
  const sandbox = vm.createContext({ window, console: { warn: (...v) => logs.push(v.join(' ')), info() {} } });
  vm.runInContext(source, sandbox, { timeout: 2000 });
  const mod = entry.factory((name) => {
    assert.equal(name, 'react');
    return {};
  });
  let injection;
  const state = { session: undefined, registers: 0, slots: 0, typeDisposed: 0, paneDisposed: 0,
    fallback: 0, fallbackDisposed: 0, opens: 0, openAttempts: 0, failOpen: false, failPane: false, closed: [] };
  const tabs = {
    register(definition) {
      assert.equal(definition.kind, 'blender-viewport');
      assert.equal(definition.id, '@dsh-external/dsh-blender-plugin');
      // Host contract (dsh-client-ui-sidebar-right/lib/client.js:512-521): the type title and every
      // guide entry's title/description are CALLED, not read. Strings throw at render time and the
      // slot error boundary blanks the whole right column.
      assert.equal(typeof definition.title, 'function', 'type title must be a function: host calls title()');
      assert.ok(Array.isArray(definition.guide) && definition.guide.length > 0, 'guide must list at least one entry');
      const seen = new Set();
      for (const entry of definition.guide) {
        assert.equal(typeof entry.id, 'string', 'guide entry id must be a string');
        assert.ok(!seen.has(entry.id), 'guide entry ids must be unique');
        seen.add(entry.id);
        assert.equal(typeof entry.title, 'function', 'guide entry title must be a function: host calls title()');
        assert.ok(entry.description === undefined || typeof entry.description === 'function',
          'guide entry description must be a function when present: host calls description?.()');
        assert.equal(typeof entry.order, 'number', 'guide entry order must be numeric so the host sort is deterministic');
      }
      state.registers++;
      return () => { state.typeDisposed++; };
    }
  };
  const right = {
    mounted: { getSnapshot: () => state.session },
    openTab(kind) {
      assert.equal(kind, 'blender-viewport');
      state.openAttempts++;
      if (state.failOpen) throw Error('session surface not adopted yet');
      state.opens++;
    },
    tabsIn: () => [{ kind: 'blender-viewport', id: 'ours' }, { kind: 'file', id: 'other' }],
    close: (id) => state.closed.push(id)
  };
  const ctx = {
    get(name) { throw Error('undeclared parent dependency: ' + name); },
    inject(names, callback) { if (names.includes('sidebarRightTabs')) injection = callback; },
    effect(callback, name) { effects.push({ callback, name }); return () => {}; },
    slots: {
      inject(name, callback) { assert.equal(name, 'sidebar.right.pane.tab'); return callback(); },
      register(options) {
        if (state.failPane) throw Error('pane registration failed');
        assert.equal(options.key, '@dsh-external/dsh-blender-plugin');
        state.slots++;
        return () => { state.paneDisposed++; };
      }
    }
  };
  for (const name of ['sidebarRightTabs', 'sidebarRight']) {
    Object.defineProperty(ctx, name, { get() { throw Error('undeclared parent property: ' + name); } });
  }
  mod.apply(ctx); // Register callbacks, but do not start the network polling effect.
  const gate = mod.__selftest.createPaneGate(ctx, {
    paneBody() {},
    fallbackRegister() { state.fallback++; return () => { state.fallbackDisposed++; }; }
  });
  return { state, gate, logs, provide({ replace = false } = {}) {
    assert.equal(typeof injection, 'function', 'optional services must be injected');
    const instance = { replacement: replace, registered: false, registers: 0, opens: 0, closed: [] };
    const providedTabs = {
      register(definition) {
        instance.registered = true; instance.registers++;
        const dispose = tabs.register(definition);
        return () => { instance.registered = false; dispose(); };
      }
    };
    const providedRight = {
      ...right,
      openTab(kind) {
        assert.equal(instance.registered, true, 'kind must be registered in this controller registry');
        right.openTab(kind); instance.opens++;
      },
      close(id) { instance.closed.push(id); right.close(id); }
    };
    let cleanup = () => {};
    injection({
      get: (name) => name === 'sidebarRightTabs' ? providedTabs : providedRight,
      effect(callback) { cleanup = callback(); return cleanup; }
    });
    const remove = () => cleanup();
    remove.instance = instance;
    return remove;
  }, disposePlugin() {
    const reset = effects.find((effect) => String(effect.name).includes('reset apply guard'));
    assert.ok(reset);
    reset.callback()();
    return mod.__selftest.sidebarRightServices(ctx);
  } };
}

test('injected services register and open despite inaccessible parent ctx', () => {
  const { state, gate, provide } = fixture();
  provide(); state.session = 's1'; gate.applyReady(true);
  assert.equal(gate.state().mode, 'sidebar');
  assert.equal(state.registers, 1); assert.equal(state.slots, 1);
  assert.equal(state.opens, 1); assert.equal(state.fallback, 0);
});
test('late optional services upgrade fallback and dispose it exactly once', () => {
  const { state, gate, provide } = fixture();
  state.session = 's1'; gate.applyReady(true); gate.applyReady(true);
  assert.equal(gate.state().mode, 'fallback'); assert.equal(state.fallback, 1);
  provide(); gate.applyReady(true); gate.applyReady(true);
  assert.equal(gate.state().mode, 'sidebar'); assert.equal(state.fallbackDisposed, 1);
  assert.equal(state.opens, 1); assert.equal(state.registers, 1);
});
test('no mounted session does not consume the one-time opening', () => {
  const { state, gate, provide } = fixture();
  provide(); gate.applyReady(true); gate.applyReady(true);
  assert.equal(state.openAttempts, 0); assert.equal(Object.keys(gate.state().openedSessions).length, 0);
  state.session = 's1'; gate.applyReady(true);
  assert.equal(state.opens, 1);
});
test('failed open retries without a ready edge and warning is deduplicated', () => {
  const { state, gate, provide, logs } = fixture();
  provide(); state.session = 's1'; state.failOpen = true;
  gate.applyReady(true); gate.applyReady(true);
  assert.equal(state.opens, 0); assert.equal(gate.state().openedSessions.s1, undefined);
  assert.equal(logs.filter((line) => line.includes('openTab failed')).length, 1);
  state.failOpen = false; gate.applyReady(true); gate.applyReady(true);
  assert.equal(state.openAttempts, 3); assert.equal(state.opens, 1);
});
test('successful opening is once per session, including after manual close', () => {
  const { state, gate, provide } = fixture();
  provide(); state.session = 's1'; gate.applyReady(true);
  gate.applyReady(true); // A user close must not cause another automatic open.
  state.session = 's2'; gate.applyReady(true); gate.applyReady(true);
  state.session = 's1'; gate.applyReady(true);
  assert.equal(state.opens, 2);
});
test('ready false disposes registrations and only closes our mounted tab', () => {
  const { state, gate, provide } = fixture();
  provide(); state.session = 's1'; gate.applyReady(true); gate.applyReady(false); gate.applyReady(false);
  assert.equal(gate.state().mode, 'idle'); assert.equal(state.typeDisposed, 1);
  assert.equal(state.paneDisposed, 1); assert.deepEqual(state.closed, ['ours']);
});
test('partial registration failure rolls back type before fallback and can recover', () => {
  const { state, gate, provide, logs } = fixture();
  provide(); state.session = 's1'; state.failPane = true; gate.applyReady(true);
  assert.equal(state.typeDisposed, 1); assert.equal(state.fallback, 1);
  assert.ok(logs.some((line) => line.includes('register pane failed')));
  state.failPane = false; gate.applyReady(true);
  assert.equal(gate.state().mode, 'sidebar'); assert.equal(state.fallbackDisposed, 1);
});
test('gate disposal releases type and pane registrations', () => {
  const { state, gate, provide } = fixture();
  provide(); gate.applyReady(true); gate.dispose(); gate.dispose();
  assert.equal(state.typeDisposed, 1); assert.equal(state.paneDisposed, 1);
});
test('optional scope removal falls back and replacement re-registers and reopens', () => {
  const f = fixture(); const remove = f.provide();
  f.state.session = 's1'; f.gate.applyReady(true);
  remove(); f.gate.applyReady(true);
  assert.equal(f.gate.state().mode, 'fallback');
  assert.equal(f.state.typeDisposed, 1); assert.equal(f.state.paneDisposed, 1);
  assert.deepEqual(f.state.closed, ['ours']);
  const replacement = f.provide({ replace: true }); f.gate.applyReady(true); f.gate.applyReady(true);
  assert.equal(f.gate.state().mode, 'sidebar'); assert.equal(f.state.registers, 2);
  assert.equal(f.state.opens, 2); assert.equal(f.state.fallbackDisposed, 1);
  assert.deepEqual(remove.instance.closed, ['ours']);
  assert.equal(remove.instance.registered, false); assert.equal(remove.instance.opens, 1);
  assert.equal(replacement.instance.registers, 1); assert.equal(replacement.instance.opens, 1);
  assert.deepEqual(replacement.instance.closed, []);
});
test('late cleanup from replaced scope cannot erase newer injected services', () => {
  const f = fixture(); const removeOld = f.provide();
  f.state.session = 's1'; f.gate.applyReady(true);
  f.provide({ replace: true }); f.gate.applyReady(true);
  removeOld(); f.gate.applyReady(true);
  assert.equal(f.gate.state().mode, 'sidebar'); assert.equal(f.state.registers, 2);
  assert.equal(f.state.opens, 2); assert.equal(f.state.fallback, 0);
});
test('plugin disposal clears cached optional service references', () => {
  const f = fixture(); f.provide();
  assert.equal(f.disposePlugin().ok, false);
});
console.log(`Sidebar injection regression: ${passed} passed / ${failed} failed`);
process.exitCode = failed ? 1 : 0;
