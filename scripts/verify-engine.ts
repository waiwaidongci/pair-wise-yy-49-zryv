import assert from 'node:assert/strict'
import { applyEnvelopeStep, computeCoverage, toSnapshot, type EngineState } from '../src/lib/versioning/engine'
import { createSeedState } from '../src/lib/versioning/seed'
import type { Envelope } from '../src/lib/versioning/types'

let seq = 0
function env(state: EngineState, op: Envelope['op'], opId = `op-${++seq}`, at = `2026-10-05T10:0${seq % 10}:00Z`): Envelope {
  return { opId, baseVersion: state.version, op, at }
}
function apply(state: EngineState, envelope: Envelope) {
  const step = applyEnvelopeStep(state, envelope, envelope.at)
  return { ...step, snapshot: toSnapshot(step.state, envelope.at) }
}

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`✓ ${name}`)
  } catch (error) {
    console.error(`✗ ${name}`)
    throw error
  }
}

test('种子：覆盖结论按映射算出，GR-06 有 C-308 支撑', () => {
  const state = createSeedState()
  const coverage = computeCoverage(state.nodes, state.mappings)
  const gr06 = coverage.find((row) => row.requirementId === 'GR-06')!
  assert.equal(gr06.covered, true)
  assert.deepEqual(gr06.courses.map((c) => c.courseId), ['C-308'])
})

test('提交带草稿版本：版本递增，审阅项记录 baseVersion', () => {
  let state = createSeedState()
  const before = state.version
  const r = apply(state, env(state, {
    type: 'submitRevision',
    courseId: 'C-308',
    requirementId: 'GR-06',
    evidence: '补充了十二个字符以上的评分记录',
    revisionNote: '本轮修订说明足够长',
    submitter: '张三',
  }))
  state = r.state
  assert.equal(r.resultVersion, before + 1)
  assert.equal(state.reviewItems[0].baseVersion, before)
  assert.equal(state.reviewItems[0].status, '待审阅')
})

test('过期提交：改动不落地，但服务端记录保留', () => {
  const state0 = createSeedState()
  const stale: Envelope = { opId: 'stale-1', baseVersion: state0.version - 1, at: '2026-10-05T10:00:00Z', op: {
    type: 'submitRevision', courseId: 'C-308', requirementId: 'GR-06', evidence: '过期的证据内容十二个字', revisionNote: '过期的修订说明文字', submitter: '李四',
  } }
  const r = apply(state0, stale)
  assert.equal(r.stale, true)
  assert.equal(r.state.reviewItems.length, state0.reviewItems.length)
  assert.equal(r.state.version, state0.version)
  assert.equal(r.state.recentOps[0].status, 'stale-rejected')
  assert.match(r.state.recentOps[0].reason!, /已过期/)

  // 同一编号重送：仍然不落地（duplicate+stale），不能借重试绕过版本检查。
  const retry = apply(r.state, stale)
  assert.equal(retry.duplicate, true)
  assert.equal(retry.stale, true)
  assert.equal(retry.state.reviewItems.length, state0.reviewItems.length)
})

test('两人并发：严格串行，后到者过期退回，不互相覆盖', () => {
  let state = createSeedState()
  const base = state.version
  const a = env(state, { type: 'decideReview', reviewId: 'REV-201', decision: '已附议', comment: '同意，证据链完整', reviewer: '王老师' }, 'concurrent-a')
  const b: Envelope = { ...env(state, { type: 'decideReview', reviewId: 'REV-202', decision: '已退回', comment: '请补充评分记录原文', reviewer: '王老师' }, 'concurrent-b'), baseVersion: base }
  const r1 = apply(state, a)
  state = r1.state
  const r2 = apply(state, b)
  state = r2.state
  assert.equal(r1.stale, false)
  assert.equal(r2.stale, true)
  assert.equal(state.reviewItems.find((i) => i.id === 'REV-201')!.status, '已附议')
  assert.equal(state.reviewItems.find((i) => i.id === 'REV-202')!.status, '待审阅')
  // 过期方刷新到新版本后重提即可成功
  const b2: Envelope = { opId: 'concurrent-b2', baseVersion: state.version, at: '2026-10-05T10:09:00Z', op: b.op }
  const r3 = apply(state, b2)
  assert.equal(r3.stale, false)
  assert.equal(r3.state.reviewItems.find((i) => i.id === 'REV-202')!.status, '已退回')
})

test('同一审阅决定重复送达：只认一次', () => {
  let state = createSeedState()
  const first = env(state, { type: 'decideReview', reviewId: 'REV-201', decision: '已附议', comment: '同意，证据链完整', reviewer: '王老师' }, 'decide-once')
  const r1 = apply(state, first)
  state = r1.state
  // 完全相同的信封再送一次（含相同版本号）
  const r2 = apply(state, first)
  state = r2.state
  assert.equal(r2.duplicate, true)
  assert.equal(r2.resultVersion, r1.resultVersion)
  assert.equal(state.reviewItems.filter((i) => i.decisionOpId === 'decide-once').length, 1)

  // 同一审阅项换编号再决定：冲突，不允许第二次决定
  const again = env(state, { type: 'decideReview', reviewId: 'REV-201', decision: '已退回', comment: '改主意要退回', reviewer: '王老师' })
  assert.throws(() => applyEnvelopeStep(state, again, again.at), /无法重复决定/)
})

test('批量审阅原子性：一条不合法则整批不生效，不留半条', () => {
  const state = createSeedState()
  const bad = env(state, {
    type: 'bulkDecide',
    reviewer: '王老师',
    decisions: [
      { reviewId: 'REV-201', decision: '已附议', comment: '同意' },
      { reviewId: 'REV-404', decision: '已退回', comment: '不存在的项' },
    ],
  }, 'bulk-bad')
  assert.throws(() => applyEnvelopeStep(state, bad, bad.at), /不存在/)
  assert.equal(state.reviewItems.find((i) => i.id === 'REV-201')!.status, '待审阅')
  assert.equal(state.appliedOps.has('bulk-bad'), false)

  const good = env(state, {
    type: 'bulkDecide',
    reviewer: '王老师',
    decisions: [
      { reviewId: 'REV-201', decision: '已附议', comment: '批量同意' },
      { reviewId: 'REV-202', decision: '已附议', comment: '批量同意' },
    ],
  }, 'bulk-good')
  const r = apply(state, good)
  assert.equal(r.state.reviewItems.find((i) => i.id === 'REV-201')!.decisionOpId, 'bulk-good')
  assert.equal(r.state.reviewItems.find((i) => i.id === 'REV-202')!.decisionOpId, 'bulk-good')
})

test('课程一变：引用它的未完成审阅失效，已决定的不受影响', () => {
  let state = createSeedState()
  const r = apply(state, env(state, { type: 'updateNode', id: 'C-308', label: '软件工程实践（认证版）\nC-308' }))
  state = r.state
  const rev201 = state.reviewItems.find((i) => i.id === 'REV-201')!
  const rev202 = state.reviewItems.find((i) => i.id === 'REV-202')!
  const rev203 = state.reviewItems.find((i) => i.id === 'REV-203')!
  assert.equal(rev201.status, '已失效')
  assert.equal(rev202.status, '已失效')
  assert.match(rev201.invalidatedReason!, /内容发生变更/)
  assert.equal(rev203.status, '已附议') // 已完成的审阅不被追溯改写
})

test('映射一变：两端课程/毕业要求关联的未完成审阅失效，无关审阅保留', () => {
  const state = createSeedState()
  const r = apply(state, env(state, { type: 'addMapping', source: 'GR-06', target: 'C-205', relation: '支撑', weight: 0.6 }))
  const statusOf = (id: string) => r.state.reviewItems.find((i) => i.id === id)!.status
  assert.equal(statusOf('REV-202'), '已失效') // GR-06 端的审阅失效
  assert.equal(statusOf('REV-201'), '待审阅') // C-308+GR-03 与新映射两端无关，保留
  assert.equal(statusOf('REV-203'), '已附议') // 已决定的不追溯
})

test('锁定后映射不可改；锁定留存基线快照；退回修订后基线标记失效', () => {
  let state = createSeedState()
  state = apply(state, env(state, { type: 'lock' })).state
  assert.equal(state.phase, 'locked')
  const baseline = state.baselines.find((b) => b.kind === 'locked')!
  assert.ok(baseline)
  assert.equal(baseline.coverage.length, 3)
  assert.equal(baseline.nodes.length, state.nodes.length)

  const lockedAdd = env(state, { type: 'addMapping', source: 'GR-01', target: 'C-308', relation: '支撑', weight: 0.5 })
  assert.throws(() => applyEnvelopeStep(state, lockedAdd, lockedAdd.at), /锁定/)

  state = apply(state, env(state, { type: 'reopenFromLock' })).state
  assert.equal(state.phase, 'draft')
  assert.ok(state.baselines.find((b) => b.kind === 'locked')!.supersededAt)

  // 退回后可以改映射，覆盖重算
  state = apply(state, env(state, { type: 'addMapping', source: 'GR-01', target: 'C-308', relation: '支撑', weight: 0.5 })).state
  const gr01 = computeCoverage(state.nodes, state.mappings).find((c) => c.requirementId === 'GR-01')!
  assert.deepEqual(gr01.courses.map((c) => c.courseId).sort(), ['C-101', 'C-308'])
})

test('发布基线不可变快照可查；发布后开启新一轮修订', () => {
  let state = createSeedState()
  state = apply(state, env(state, { type: 'lock' })).state
  const lockedBaseline = state.baselines.find((b) => b.kind === 'locked')!
  assert.equal(lockedBaseline.version, state.version)
  state = apply(state, env(state, { type: 'publish' })).state
  assert.equal(state.phase, 'published')
  const published = state.baselines.find((b) => b.kind === 'published')!
  assert.ok(published.publishedAt)
  assert.equal(published.version, state.version)
  const snapshotCoverage = JSON.stringify(published.coverage)

  state = apply(state, env(state, { type: 'openRevision', revision: 'R13' })).state
  assert.equal(state.revision, 'R13')
  assert.equal(state.phase, 'draft')
  // 已发布基线保持原样
  assert.equal(JSON.stringify(published.coverage), snapshotCoverage)
  assert.equal(state.baselines.find((b) => b.kind === 'published')!.supersededAt, undefined)
})

test('重启重放：从空状态重放一串信封后，覆盖结论、审阅、基线完全一致', () => {
  const envelopes: Envelope[] = []
  let live = createSeedState()
  const record = (op: Envelope['op']) => {
    const envelope = env(live, op)
    envelopes.push(envelope)
    live = apply(live, envelope).state
  }
  record({ type: 'decideReview', reviewId: 'REV-201', decision: '已附议', comment: '同意，证据链完整', reviewer: '王老师' })
  record({ type: 'addMapping', source: 'GR-06', target: 'C-205', relation: '支撑', weight: 0.5 })
  record({ type: 'lock' })
  record({ type: 'publish' })
  record({ type: 'openRevision' })

  let replayed = createSeedState()
  for (const envelope of envelopes) replayed = applyEnvelopeStep(replayed, envelope, envelope.at).state

  assert.deepEqual(toSnapshot(replayed, 'x').coverage, toSnapshot(live, 'x').coverage)
  assert.deepEqual(
    replayed.reviewItems.map((i) => [i.id, i.status, i.decisionOpId ?? null]),
    live.reviewItems.map((i) => [i.id, i.status, i.decisionOpId ?? null]),
  )
  assert.equal(replayed.version, live.version)
  assert.equal(replayed.phase, live.phase)
  assert.equal(replayed.baselines.length, live.baselines.length)
  // 重放包含一个过期信封时，幂等记录也会重建
  const stale: Envelope = { opId: 'replay-stale', baseVersion: 0, at: '2026-10-05T11:00:00Z', op: {
    type: 'submitRevision', courseId: 'C-308', requirementId: 'GR-06', evidence: '重放的过期证据十二字', revisionNote: '重放的过期修订说明', submitter: '赵六',
  } }
  live = apply(live, stale).state
  replayed = apply(replayed, stale).state
  assert.equal(replayed.version, live.version)
  assert.equal(replayed.rejectedOps.has('replay-stale'), live.rejectedOps.has('replay-stale'))
})

console.log('\n全部引擎不变量验证通过。')
