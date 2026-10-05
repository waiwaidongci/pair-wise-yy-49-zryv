// 版本化工作引擎（纯函数，不依赖 SvelteKit 运行时，便于测试与重启重放）。
//
// 不变量：
// 1. 所有写入都必须携带 baseVersion（草稿版本），过期则改动不落库；
// 2. 同一 opId 只生效一次，重复送达返回首次结果；
// 3. 课程 / 毕业要求节点或其映射变更后，引用它们的未完成审阅失效，
//    已锁定但未发布的基线失效并按新数据重算覆盖；
// 4. lock / publish 产出不可变快照，覆盖结论随快照留存。

import type {
  ApplyOutcome,
  Baseline,
  Envelope,
  GraphNode,
  Mapping,
  OpRecord,
  RequirementCoverage,
  ReviewItem,
  ReviewStatus,
  Snapshot,
} from './types'

export type EngineState = {
  revision: string
  version: number
  phase: Snapshot['phase']
  nodes: GraphNode[]
  mappings: Mapping[]
  reviewItems: ReviewItem[]
  baselines: Baseline[]
  /** opId -> 首次落地后的版本号 */
  appliedOps: Map<string, number>
  /** 已被版本检查退回的 opId，重试同一编号不再落地 */
  rejectedOps: Set<string>
  /** 最近操作的服务端记录（含被版本检查退回的操作） */
  recentOps: OpRecord[]
}

export type StepResult = {
  state: EngineState
  duplicate: boolean
  stale: boolean
  resultVersion: number
}

export const MAX_RECENT_OPS = 100

export function computeCoverage(nodes: GraphNode[], mappings: Mapping[]): RequirementCoverage[] {
  const requirements = nodes.filter((node) => node.type === '毕业要求')
  const courses = new Set(nodes.filter((node) => node.type === '课程').map((node) => node.id))
  return requirements.map((requirement) => {
    const links = mappings.filter((mapping) => mapping.source === requirement.id && courses.has(mapping.target))
    const byCourse = new Map<string, number>()
    for (const link of links) byCourse.set(link.target, (byCourse.get(link.target) ?? 0) + link.weight)
    const courseList = [...byCourse.entries()]
      .map(([courseId, weight]) => ({ courseId, weight: Math.round(weight * 1000) / 1000 }))
      .sort((a, b) => a.courseId.localeCompare(b.courseId))
    const totalWeight = Math.round(courseList.reduce((sum, item) => sum + item.weight, 0) * 1000) / 1000
    return {
      requirementId: requirement.id,
      covered: courseList.length > 0,
      courseCount: courseList.length,
      totalWeight,
      courses: courseList,
    }
  })
}

export function toSnapshot(state: EngineState, serverTime: string): Snapshot {
  return {
    revision: state.revision,
    version: state.version,
    phase: state.phase,
    nodes: structuredClone(state.nodes),
    mappings: structuredClone(state.mappings),
    reviewItems: structuredClone(state.reviewItems),
    coverage: computeCoverage(state.nodes, state.mappings),
    baselines: structuredClone(state.baselines),
    recentOps: structuredClone(state.recentOps),
    serverTime,
  }
}

function pushOp(state: EngineState, record: OpRecord) {
  state.recentOps.unshift(record)
  if (state.recentOps.length > MAX_RECENT_OPS) state.recentOps.length = MAX_RECENT_OPS
}

function invalidateReviews(
  state: EngineState,
  courseIds: Set<string>,
  requirementIds: Set<string>,
  reason: string,
  now: string,
) {
  for (const item of state.reviewItems) {
    if (item.status === '待审阅' && (courseIds.has(item.courseId) || requirementIds.has(item.requirementId))) {
      item.status = '已失效'
      item.invalidatedAt = now
      item.invalidatedReason = reason
    }
  }
}

/** 课程 / 毕业要求或映射一变：未完成审阅失效；已锁定基线标记失效并按新数据重算。 */
function invalidateAfterCurriculumChange(
  state: EngineState,
  changedNodeIds: Set<string>,
  reason: string,
  now: string,
) {
  const nodesById = new Map(state.nodes.map((node) => [node.id, node]))
  const courseIds = new Set<string>()
  const requirementIds = new Set<string>()
  for (const id of changedNodeIds) {
    const node = nodesById.get(id)
    if (node?.type === '课程') courseIds.add(id)
    if (node?.type === '毕业要求') requirementIds.add(id)
  }
  invalidateReviews(state, courseIds, requirementIds, reason, now)

  for (const baseline of state.baselines) {
    if (baseline.kind === 'locked' && !baseline.supersededAt) {
      baseline.supersededAt = now
      baseline.supersededReason = reason
    }
  }
}

function bumpVersion(state: EngineState) {
  state.version += 1
}

function recordApplied(state: EngineState, envelope: Envelope, now: string, resultVersion: number) {
  state.appliedOps.set(envelope.opId, resultVersion)
  pushOp(state, {
    opId: envelope.opId,
    type: envelope.op.type,
    at: now,
    status: 'applied',
    baseVersion: envelope.baseVersion,
    resultVersion,
  })
}

function rejectStale(state: EngineState, envelope: Envelope, now: string) {
  // 过期改动不落地，但服务端保留这次送达记录。
  pushOp(state, {
    opId: envelope.opId,
    type: envelope.op.type,
    at: now,
    status: 'stale-rejected',
    baseVersion: envelope.baseVersion,
    resultVersion: state.version,
    reason: `草稿版本 ${envelope.baseVersion} 已过期，当前版本 ${state.version}`,
  })
}

function nextReviewId(state: EngineState) {
  const max = state.reviewItems.reduce((acc, item) => {
    const n = Number(item.id.replace(/^REV-/, ''))
    return Number.isFinite(n) ? Math.max(acc, n) : acc
  }, 300)
  return `REV-${max + 1}`
}

function findReview(state: EngineState, reviewId: string) {
  return state.reviewItems.find((item) => item.id === reviewId)
}

function applyDecision(item: ReviewItem, decision: Extract<ReviewStatus, '已附议' | '已退回'>, comment: string, reviewer: string, opId: string, now: string) {
  item.status = decision
  item.comment = comment
  item.decidedAt = now
  item.decidedBy = reviewer
  item.decisionOpId = opId
}

/**
 * 应用一个信封（返回新内部状态，供服务端 WAL 重放使用；不修改入参）。
 * duplicate=true 时不产生新版本，返回首次落地时的版本号。
 * stale=true 时改动不落地，但服务端已记录这次过期送达。
 */
export function applyEnvelopeStep(prev: EngineState, envelope: Envelope, now: string): StepResult {
  const appliedVersion = prev.appliedOps.get(envelope.opId)
  if (appliedVersion !== undefined) {
    return { state: prev, duplicate: true, stale: false, resultVersion: appliedVersion }
  }
  if (prev.rejectedOps.has(envelope.opId)) {
    return { state: prev, duplicate: true, stale: true, resultVersion: prev.version }
  }

  if (envelope.baseVersion !== prev.version) {
    const rejected = cloneState(prev)
    rejected.rejectedOps.add(envelope.opId)
    rejectStale(rejected, envelope, now)
    return { state: rejected, duplicate: false, stale: true, resultVersion: prev.version }
  }

  const state = cloneState(prev)
  const op = envelope.op

  switch (op.type) {
    case 'submitRevision': {
      state.reviewItems.unshift({
        id: nextReviewId(state),
        courseId: op.courseId,
        requirementId: op.requirementId,
        evidence: op.evidence,
        revisionNote: op.revisionNote,
        submitter: op.submitter,
        status: '待审阅',
        comment: '',
        baseVersion: envelope.baseVersion,
        createdAt: now,
      })
      bumpVersion(state)
      break
    }
    case 'decideReview': {
      const item = findReview(state, op.reviewId)
      if (!item) throw new EngineError('not-found', `审阅项 ${op.reviewId} 不存在`)
      if (item.status !== '待审阅') throw new EngineError('conflict', `审阅项 ${op.reviewId} 当前状态为 ${item.status}，无法重复决定`)
      applyDecision(item, op.decision, op.comment, op.reviewer, envelope.opId, now)
      bumpVersion(state)
      break
    }
    case 'bulkDecide': {
      const targets = op.decisions.map((d) => {
        const item = findReview(state, d.reviewId)
        if (!item) throw new EngineError('not-found', `审阅项 ${d.reviewId} 不存在`)
        if (item.status !== '待审阅') throw new EngineError('conflict', `审阅项 ${d.reviewId} 当前状态为 ${item.status}，无法重复决定`)
        return { item, ...d }
      })
      // 全部校验通过后一次性生效，避免留下半条审阅。
      for (const target of targets) {
        applyDecision(target.item, target.decision, target.comment, op.reviewer, envelope.opId, now)
      }
      bumpVersion(state)
      break
    }
    case 'addMapping': {
      if (state.phase === 'locked') throw new EngineError('locked', '版本已锁定，映射不可修改；请开启新一轮修订')
      if (op.source === op.target) throw new EngineError('conflict', '不能建立自环映射')
      if (!state.nodes.some((node) => node.id === op.source)) throw new EngineError('not-found', `来源节点 ${op.source} 不存在`)
      if (!state.nodes.some((node) => node.id === op.target)) throw new EngineError('not-found', `目标节点 ${op.target} 不存在`)
      const duplicated = state.mappings.some(
        (mapping) => mapping.source === op.source && mapping.target === op.target && mapping.relation === op.relation,
      )
      if (duplicated) throw new EngineError('conflict', '相同来源、目标和关系的映射已存在')
      state.mappings.push({
        // 用版本号生成确定性 ID，保证 WAL 重放产生完全一致的状态。
        id: `M-V${state.version + 1}`,
        source: op.source,
        target: op.target,
        relation: op.relation,
        weight: op.weight,
      })
      invalidateAfterCurriculumChange(state, new Set([op.source, op.target]), '映射发生变更，相关审阅与锁定基线需重算', now)
      bumpVersion(state)
      break
    }
    case 'updateNode': {
      if (state.phase === 'locked') throw new EngineError('locked', '版本已锁定，课程与毕业要求不可修改；请开启新一轮修订')
      const node = state.nodes.find((item) => item.id === op.id)
      if (!node) throw new EngineError('not-found', `节点 ${op.id} 不存在`)
      if (!['课程', '毕业要求'].includes(node.type)) throw new EngineError('conflict', `仅课程 / 毕业要求的修订受版本管控，${node.type} 不走此通道`)
      node.label = op.label
      invalidateAfterCurriculumChange(state, new Set([op.id]), `${node.type} ${op.id} 内容发生变更`, now)
      bumpVersion(state)
      break
    }
    case 'lock': {
      if (state.phase === 'locked') throw new EngineError('conflict', '当前版本已锁定')
      if (state.phase === 'published') throw new EngineError('conflict', '当前版本已发布，请开启新一轮修订')
      state.phase = 'locked'
      bumpVersion(state)
      state.baselines.push(makeBaseline(state, 'locked', now))
      break
    }
    case 'publish': {
      if (state.phase !== 'locked') throw new EngineError('conflict', '只有已锁定版本可以发布')
      const locked = [...state.baselines].reverse().find((baseline) => baseline.kind === 'locked' && !baseline.supersededAt)
      if (!locked) throw new EngineError('conflict', '不存在有效的锁定基线，请重新锁定')
      state.phase = 'published'
      bumpVersion(state)
      // 发布基线按当前数据重算覆盖结论，与锁定快照一同留存，二者都可查。
      state.baselines.push(makeBaseline(state, 'published', now))
      break
    }
    case 'reopenFromLock': {
      if (state.phase !== 'locked') throw new EngineError('conflict', '只有已锁定版本可以退回修订')
      state.phase = 'draft'
      for (const baseline of state.baselines) {
        if (baseline.kind === 'locked' && !baseline.supersededAt) {
          baseline.supersededAt = now
          baseline.supersededReason = op.reason || '锁定版本被退回修订，需重算'
        }
      }
      bumpVersion(state)
      break
    }
    case 'openRevision': {
      if (state.phase !== 'published') throw new EngineError('conflict', '仅已发布版本可以开启新一轮修订')
      state.phase = 'draft'
      state.revision = op.revision ?? nextRevision(state.revision)
      bumpVersion(state)
      break
    }
  }

  recordApplied(state, envelope, now, state.version)
  return { state, duplicate: false, stale: false, resultVersion: state.version }
}

/** 应用信封并返回对外快照（供无 WAL 的测试场景直接调用）。 */
export function applyEnvelope(prev: EngineState, envelope: Envelope, now: string): ApplyOutcome {
  const result = applyEnvelopeStep(prev, envelope, now)
  return { snapshot: toSnapshot(result.state, now), duplicate: result.duplicate, resultVersion: result.resultVersion }
}

function makeBaseline(state: EngineState, kind: Baseline['kind'], now: string): Baseline {
  return {
    revision: state.revision,
    version: state.version,
    kind,
    createdAt: now,
    ...(kind === 'published' ? { publishedAt: now } : {}),
    nodes: structuredClone(state.nodes),
    mappings: structuredClone(state.mappings),
    reviewItems: structuredClone(state.reviewItems),
    coverage: computeCoverage(state.nodes, state.mappings),
  }
}

function nextRevision(current: string) {
  const n = Number(current.replace(/^R/, ''))
  return `R${Number.isFinite(n) ? n + 1 : 1}`
}

export class EngineError extends Error {
  constructor(
    public code: 'not-found' | 'conflict' | 'locked',
    message: string,
  ) {
    super(message)
    this.name = 'EngineError'
  }
}

export function cloneState(state: EngineState): EngineState {
  return {
    revision: state.revision,
    version: state.version,
    phase: state.phase,
    nodes: structuredClone(state.nodes),
    mappings: structuredClone(state.mappings),
    reviewItems: structuredClone(state.reviewItems),
    baselines: structuredClone(state.baselines),
    appliedOps: new Map(state.appliedOps),
    rejectedOps: new Set(state.rejectedOps),
    recentOps: structuredClone(state.recentOps),
  }
}
