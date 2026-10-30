#!/usr/bin/env node
/**
 * tests/selection_store_selftest.mjs —— v2.3「Blender 原生选中 → DSH」存储层回归门
 *
 * 为什么需要：v2.3 起选中不再靠 DSH 面板点截图，而是 addon 推 `POST /host/selection`，
 * 客户端轮询 `GET /host/selection/latest` 并 `POST /host/selection/consume`。
 * 这条链路坏掉的表现很安静：面板/按钮都正常，只是**草稿里永远没有选中**。
 * 本测试覆盖存储层的全部纯逻辑（不联网、不需要 Blender）：
 *   · payload 消毒（名字条数 / 字符串长度 / 对象明细 / 非法类型）
 *   · seq / consumed_seq 语义：未消费才出 payload；consume 幂等、只增不减
 *   · 非法 consume（0 / 负数 / 未来 seq / 非整数 / 缺省）不改变消费位
 *   · 空选中合法（count=0，names=[]），客户端据此跳过插入
 *
 * 用法：node tests/selection_store_selftest.mjs
 * 退出码：0 = 全过；1 = 有断言失败
 */
import { createSelectionStore, sanitizeSelectionPayload, MAX_SELECTION_NAMES, MAX_SELECTION_OBJECTS, MAX_SUB_INDICES } from '../runtime/selectionstore.mjs'

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; failures.push(name + (detail !== undefined ? (' — ' + JSON.stringify(detail)) : '')); console.log('  ✗ ' + name + (detail !== undefined ? (' — ' + JSON.stringify(detail)) : '')) }
}
function section(t) { console.log('\n== ' + t + ' ==') }

const sample = {
  v: 1,
  source: 'blender-addon',
  sent_at: 1760000000000,
  selection: {
    count: 2,
    names: ['GEO-blade', 'GEO-guard'],
    truncated: false,
    active: 'GEO-blade',
    mode: 'OBJECT',
    objects: [
      { name: 'GEO-blade', type: 'MESH', dimensions_mm: [120.04, 8.06, 30.02] },
      { name: 'GEO-guard', type: 'MESH', dimensions_mm: [80, 5, 40] },
    ],
  },
  scene: { name: 'Scene', file: 'machine.blend' },
  activity: { state: 'human', human_active: true, agent_active: false },
}

section('1. payload 消毒')
{
  const p = sanitizeSelectionPayload(sample)
  ok('source 保留', p.source === 'blender-addon')
  ok('sent_at 取整', p.sent_at === 1760000000000)
  ok('names 保留顺序', JSON.stringify(p.selection.names) === JSON.stringify(['GEO-blade', 'GEO-guard']))
  ok('count 保留', p.selection.count === 2)
  ok('active/mode 保留', p.selection.active === 'GEO-blade' && p.selection.mode === 'OBJECT')
  ok('dimensions_mm 保留并四舍五入到 0.1', JSON.stringify(p.selection.objects[0].dimensions_mm) === JSON.stringify([120, 8.1, 30]))
  ok('scene/file 保留', p.scene.name === 'Scene' && p.scene.file === 'machine.blend')
  ok('activity 保留三态字段', p.activity.state === 'human' && p.activity.human_active === true && p.activity.agent_active === false)
}
{
  const p = sanitizeSelectionPayload({ selection: { count: 1, names: ['x'.repeat(500)], objects: [{ name: 'big', type: 'MESH', dimensions_mm: [1, 'oops', 3] }] } })
  ok('超长名字被截断到 200 字符', p.selection.names[0].length === 200, p.selection.names[0].length)
  ok('非法 dimensions 被丢弃而不是变成 NaN', p.selection.objects[0].dimensions_mm === undefined)
  ok('缺 scene/activity 时给 null 而不是 undefined', p.scene.name === null && p.activity === null)
}
{
  const names = Array.from({ length: 300 }, (_, i) => 'obj-' + i)
  const objList = Array.from({ length: 80 }, (_, i) => ({ name: 'obj-' + i, type: 'MESH' }))
  const p = sanitizeSelectionPayload({ selection: { names, objects: objList } })
  ok('names 上限 ' + MAX_SELECTION_NAMES, p.selection.names.length === MAX_SELECTION_NAMES)
  ok('objects 上限 ' + MAX_SELECTION_OBJECTS, p.selection.objects.length === MAX_SELECTION_OBJECTS)
  ok('截断后标记 truncated', p.selection.truncated === true)
}
{
  const p = sanitizeSelectionPayload({ selection: { count: 5, names: [] }, junk: 'x' })
  ok('空 names + count=5 → truncated=true（客户端可回"共 5 件"）', p.selection.names.length === 0 && p.selection.truncated === true)
  ok('未知字段不进入存储', p.junk === undefined)
}
{
  const p = sanitizeSelectionPayload(null)
  ok('null payload → 合法空选中（count=0）', p.selection.count === 0 && p.selection.names.length === 0)
  ok('缺省 kind → objects（旧客户端兼容）', p.selection.kind === 'objects')
}

section('1b. 集合 payload（v2.3，大装配体不逐个发对象）')
{
  const collPayload = {
    v: 1, source: 'blender-addon',
    selection: {
      kind: 'collection', collection: 'COL-armor', count: 500,
      names: ['part-001', 'part-002', 'part-003'], truncated: true,
      active: null, mode: 'OBJECT',
      objects: [{ name: 'part-001', type: 'MESH', dimensions_mm: [10, 10, 10] }],
      collections: [{ name: 'COL-armor', count: 500 }],
    },
    scene: { name: 'Scene', file: 'mech.blend' },
  }
  const p = sanitizeSelectionPayload(collPayload)
  ok('kind=collection 保留', p.selection.kind === 'collection')
  ok('集合名保留', p.selection.collection === 'COL-armor', p.selection.collection)
  ok('件数保留（500）', p.selection.count === 500, p.selection.count)
  ok('成员名单只保留前 3（原样）', p.selection.names.length === 3)
  ok('truncated=true 如实保留', p.selection.truncated === true)
  ok('collections 摘要保留', p.selection.collections.length === 1 && p.selection.collections[0].count === 500, p.selection.collections)
}
{
  const p = sanitizeSelectionPayload({ selection: { kind: 'weird', count: 1, names: ['x'] } })
  ok('未知 kind → 回退 objects', p.selection.kind === 'objects')
  const cap = Array.from({ length: 120 }, (_, i) => ({ name: 'C' + i, count: i }))
  const p2 = sanitizeSelectionPayload({ selection: { kind: 'collection', collection: 'C', names: ['x'], collections: cap } })
  ok('collections 摘要上限 50', p2.selection.collections.length === 50, p2.selection.collections.length)
  ok('collections 里 count 取整', p2.selection.collections[1].count === 1)
}

section('2. seq / consumed_seq / consume 语义')
{
  let t = 1000
  const store = createSelectionStore(() => t)
  const s0 = store.snapshot()
  ok('初始态：seq=0 / 无未消费', s0.seq === 0 && s0.unconsumed === false && s0.selection === null)

  const r1 = store.put(sample)
  ok('put → ok + seq=1', r1.ok === true && r1.seq === 1, r1)
  const s1 = store.snapshot()
  ok('snapshot：unconsumed=true 且带 selection', s1.unconsumed === true && s1.selection && s1.selection.count === 2)
  ok('snapshot 带 activity/scene 供面板展示', s1.activity && s1.activity.state === 'human' && s1.scene && s1.scene.name === 'Scene')
  ok('stale_ms 可计算', typeof s1.stale_ms === 'number' && s1.stale_ms >= 0)

  t += 5000
  const s1b = store.snapshot()
  ok('过 5s 后 stale_ms ≈ 5000', s1b.stale_ms === 5000, s1b.stale_ms)

  const c1 = store.consume(1)
  ok('consume(1) → consumed_seq=1', c1.ok === true && c1.consumed_seq === 1, c1)
  const s2 = store.snapshot()
  ok('消费后 unconsumed=false 且 selection=null（不会重复插入）', s2.unconsumed === false && s2.selection === null)
  ok('消费后 seq 仍是 1（序号不回退）', s2.seq === 1)
  ok('不带 meta 的 consume → last_consume.ok=null（兼容 curl/老客户端）',
    s2.last_consume && s2.last_consume.seq === 1 && s2.last_consume.ok === null, s2.last_consume)

  const c2 = store.consume(1)
  ok('重复 consume 幂等', c2.ok === true && c2.consumed_seq === 1)

  const r2 = store.put(sample)
  ok('第二次 put → seq=2', r2.ok === true && r2.seq === 2, r2)
  const s3 = store.snapshot()
  ok('新事件重新变成未消费', s3.unconsumed === true && s3.selection !== null)
  const c2b = store.consume(2, { ok: true, how: 'actions' })
  ok('带插入回执的 consume 接受', c2b.ok === true)
  const lc = store.snapshot().last_consume
  ok('last_consume 记录插入结果（按钮点了但草稿没字时可查）',
    lc && lc.seq === 2 && lc.ok === true && lc.how === 'actions', lc)

  // 非法 consume：不得推进消费位
  const bad = store.consume(0)
  ok('consume(0) → 拒绝且不改消费位', bad.ok === false && bad.consumed_seq === 2, bad)
  ok('consume(-3) → 拒绝', store.consume(-3).ok === false)
  ok('consume(99)（未来 seq）→ 拒绝', store.consume(99).ok === false)
  ok('consume(1.5) → 拒绝', store.consume(1.5).ok === false)
  ok('consume(null) → 拒绝', store.consume(null).ok === false)
  store.put(sample)   // seq=3
  ok('consume("3") → 接受（HTTP JSON 字符串数字化）', store.consume('3').ok === true)
  const s4 = store.snapshot()
  ok('字符串 consume 后 unconsumed=false', s4.unconsumed === false)

  const r3 = store.put(null)
  ok('put(null) → ok=false（路由回 400）', r3.ok === false && r3.error === 'invalid_payload', r3)
}

section('2.5 v2.4 子元素选择（编辑模式 / 骨骼）')
{
  const sub = {
    type: 'MESH', object: 'Cube', mode: 'EDIT_MESH',
    select_mode: { vertex: true, edge: false, face: false },
    counts: { vertices: 3, edges: 1, faces: 0 },
    indices: { vertices: [0, 1, 2], edges: [5], faces: [] },
    truncated: false,
  };
  const store = createSelectionStore(() => 7);
  store.put({ selection: { kind: 'objects', count: 1, names: ['Cube'], sub } });
  const sel = store.snapshot().selection;
  ok('sub 原样保留类型/对象/模式', sel.sub && sel.sub.type === 'MESH' && sel.sub.object === 'Cube' && sel.sub.mode === 'EDIT_MESH', sel.sub);
  ok('sub 计数与索引保留', sel.sub.counts.vertices === 3 && sel.sub.indices.vertices.join(',') === '0,1,2', sel.sub);
  ok('sub 选择模式保留', sel.sub.select_mode.vertex === true && sel.sub.select_mode.face === false, sel.sub.select_mode);

  const arm = sanitizeSelectionPayload({ selection: { names: ['Rig'], sub: {
    type: 'ARMATURE', object: 'Rig', mode: 'POSE', counts: { bones: 2 }, bones: ['BoneA', 'BoneB'] } } });
  ok('骨骼 sub 消毒后保留名字', arm.selection.sub && arm.selection.sub.type === 'ARMATURE'
    && arm.selection.sub.bones.join(',') === 'BoneA,BoneB', arm.selection.sub);

  const bad = sanitizeSelectionPayload({ selection: { names: ['X'], sub: { type: 'BOGUS', object: 'X' } } });
  ok('未知 sub 类型归为 OTHER 且不伪造成 MESH', bad.selection.sub && bad.selection.sub.type === 'OTHER', bad.selection.sub);
  const noObj = sanitizeSelectionPayload({ selection: { names: ['X'], sub: { type: 'MESH' } } });
  ok('sub 缺 object → 丢弃（不凭空造对象名）', noObj.selection.sub === null, noObj.selection.sub);

  const huge = sanitizeSelectionPayload({ selection: { names: ['X'], sub: {
    type: 'MESH', object: 'X', counts: { vertices: 5000 },
    indices: { vertices: Array.from({ length: 5000 }, (_, i) => i) } } } });
  ok('sub 索引夹到 MAX_SUB_INDICES 且 truncated=true',
    huge.selection.sub.indices.vertices.length === MAX_SUB_INDICES && huge.selection.sub.truncated === true,
    huge.selection.sub.indices.vertices.length);
  const junk = sanitizeSelectionPayload({ selection: { names: ['X'], sub: {
    type: 'MESH', object: 'X', indices: { vertices: ['a', -1, 1.5, 3] } } } });
  ok('sub 索引过滤非整数/负数', junk.selection.sub.indices.vertices.join(',') === '3', junk.selection.sub.indices.vertices);
}

section('3. 路由契约形状（存储层输出，客户端/面板直接消费）')
{
  const t = 42
  const store = createSelectionStore(() => t)
  store.put(sample)
  const snap = store.snapshot()
  const keys = ['ok', 'seq', 'consumed_seq', 'unconsumed', 'received_at', 'stale_ms', 'selection', 'activity', 'scene', 'last_consume']
  ok('snapshot 字段齐全（客户端按名取值）', keys.every((k) => Object.prototype.hasOwnProperty.call(snap, k)), keys.filter((k) => !(k in snap)))
  ok('snapshot.ok=true（路由直接透传）', snap.ok === true)
  ok('received_at 来自注入时钟', snap.received_at === t, snap.received_at)
}

console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ' — ' + pass + ' passed, ' + fail + ' failed' + (fail ? '\n  ' + failures.join('\n  ') : ''))
process.exit(fail === 0 ? 0 : 1)
