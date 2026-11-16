/**
 * Offline test for the event-driven detection path in host/hub.js.
 *
 * The orb's whole purpose is "a session finished while you were elsewhere".
 * On this Host `sessionController` exposes no `list()` (see the deep review),
 * so detection runs on `api-session/*` events. This test drives the hub the
 * same way index.js does and asserts the notice behaviour, including the
 * cases that must stay silent.
 *
 * Run: node test/detection.test.mjs
 */
import assert from 'node:assert/strict';

import { Hub } from '../host/hub.js';

/** @returns {{hub: Hub, lines: string[]}} */
function makeHub(options = {}) {
  const lines = [];
  const log = {
    info: (line) => lines.push(`info ${line}`),
    warn: (line) => lines.push(`warn ${line}`),
    error: (line) => lines.push(`error ${line}`),
    debug: () => {},
  };
  const titles = new Map();
  const store = {
    settings: { confirmMs: options.confirmMs ?? 0, bubbleMs: options.bubbleMs ?? 60_000 },
    position: null,
    title: (id) => titles.get(id) ?? '',
    mergeTitles: (patch) => {
      for (const [id, title] of Object.entries(patch)) titles.set(id, title);
    },
    patchSettings: () => {},
  };
  const hub = new Hub({ store, log, getProvider: () => null });
  return { hub, lines, titles };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

const tests = {
  async 'a finished session raises exactly one notice with the learned title'() {
    const { hub } = makeHub();
    hub.start();
    hub.noteEvent('api-session/added');
    hub.noteAdded({ sessionId: 's1', origin: 'web', running: true, title: 'Refactor the parser', cwd: 'D:\\w' });
    assert.equal(hub.snapshot().running, 1, 'added(running) must count as running');

    hub.noteStatus('s1', true);
    assert.equal(hub.snapshot().running, 1);

    hub.noteStatus('s1', false);
    await settle();
    const state = hub.snapshot();
    assert.equal(state.running, 0);
    assert.equal(state.notice?.title, 'Refactor the parser');
    assert.equal(state.notice?.sessionId, 's1');
    assert.equal(state.seq > 0, true);
    assert.equal(hub.summary().counters.confirmed, 1);

    // A repeated idle event must not duplicate the notice.
    hub.noteStatus('s1', false);
    await settle();
    assert.equal(hub.snapshot().notice?.more, 0);
    assert.equal(hub.summary().counters.confirmed, 1);
  },

  async 'a cancelled pause is suppressed'() {
    const { hub } = makeHub({ confirmMs: 40 });
    hub.start();
    hub.noteEvent('api-session/status');
    hub.noteStatus('s2', true);
    hub.noteStatus('s2', false);
    await settle();
    assert.equal(hub.snapshot().notice, null, 'still inside the confirm window');
    assert.equal(hub.summary().pendingConfirm.length, 1);

    hub.noteStatus('s2', true); // resumed before the window closed
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(hub.snapshot().notice, null, 'the resume must cancel the notice');
    assert.equal(hub.summary().counters.suppressed, 1);
    assert.equal(hub.summary().counters.confirmed, 0);
  },

  async 'a subagent finishing stays silent'() {
    const { hub } = makeHub();
    hub.start();
    hub.noteEvent('api-session/added');
    hub.noteAdded({ sessionId: 'sub1', origin: 'subagent', running: true, title: 'child job' });
    hub.noteStatus('sub1', false);
    await settle();
    assert.equal(hub.snapshot().notice, null);
    assert.equal(hub.summary().counters.skipped, 1);
    assert.equal(hub.summary().counters.confirmed, 0);
  },

  async 'a session that was never seen running does not notify'() {
    const { hub } = makeHub();
    hub.start();
    hub.noteStatus('cold', false);
    await settle();
    assert.equal(hub.snapshot().notice, null);
    assert.equal(hub.summary().counters.confirmed, 0);
  },

  async 'rows keyed by sessionId are read from the provider fallback'() {
    const rows = [
      { sessionId: 'a', running: true, title: 'Alpha', cwd: 'D:\\w\\alpha', origin: 'web' },
      { sessionId: 'b', running: false, title: 'Beta' },
    ];
    const provider = { listState: { list: async () => rows } };
    const hub = new Hub({
      store: {
        settings: { confirmMs: 0, bubbleMs: 60_000 },
        position: null,
        title: () => '',
        mergeTitles: () => {},
        patchSettings: () => {},
      },
      log: { info() {}, warn() {}, error() {}, debug() {} },
      getProvider: () => provider,
    });
    hub.start();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual([...hub.previousRunning.keys()], ['a']);
    assert.equal(hub.summary().provider.includes('listState'), true);
    // The baseline pass must not have invented a notice for the idle row.
    assert.equal(hub.summary().counters.confirmed, 0);
  },

  async 'removing a session clears its learned state'() {
    const { hub } = makeHub();
    hub.start();
    hub.noteAdded({ sessionId: 'r1', running: true, origin: 'web', title: 'Gone soon' });
    hub.noteRemoved('r1');
    assert.equal(hub.snapshot().running, 0);
    assert.equal(hub.origins.has('r1'), false);
    assert.equal(hub.meta.has('r1'), false);
  },

  async 'reading the state document does not advance seq'() {
    const { hub } = makeHub();
    hub.start();
    await settle();
    const first = hub.snapshot().seq;
    assert.equal(hub.snapshot().seq, first, 'snapshot() must be a pure read');
    hub.noteAdded({ sessionId: 'seq1', running: true, title: 'Seq probe' });
    await settle();
    assert.equal(hub.snapshot().seq > first, true, 'a real change must advance seq');
  },

  async 'event delivery clears the degraded flag'() {
    const { hub } = makeHub();
    hub.start();
    await hub.tick();
    assert.notEqual(hub.summary().degraded, null, 'no provider and no events yet');
    hub.noteEvent('api-session/status');
    await hub.tick();
    assert.equal(hub.summary().degraded, null);
    assert.deepEqual(hub.summary().events, { 'api-session/status': 1 });
  },
};

let failed = 0;
for (const [name, run] of Object.entries(tests)) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}`);
    console.log(`     ${error?.message ?? error}`);
  }
}
console.log(failed === 0 ? '\nall detection tests passed' : `\n${failed} test(s) failed`);
process.exit(failed === 0 ? 0 : 1);
