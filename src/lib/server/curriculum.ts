import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { nodes as seedNodes, mappings as seedMappings, reviewItems as seedReviewItems } from '$lib/seed'
import type { GraphNode, Mapping, ReviewItem } from '$lib/seed'

/**
 * 服务端唯一的课程状态存储。
 *
 * 课程、毕业要求、审阅意见围绕同一份版本（version）工作：
 * - 每次写入都携带草稿版本 baseVersion，过期则退回未落地改动并保留服务端记录。
 * - 每次写入携带客户端生成的 opId，同一操作重复送达只认一次（幂等）。
 * - 写入先落盘 pending 操作记录（WAL），再在内存中一次性提交，最后原子落盘 committed；
 *   重启时按操作编号恢复，绝不留下半条审阅。
 * - 课程/毕业要求/映射变更会级联失效引用它们的未完成审阅，并重算覆盖结论。
 * - 发布基线生成不可变快照，快照中的覆盖结论随引用变更重算并标记 stale。
 */

export type CoverageConclusion = {
  requirementId: string
  covered: boolean
  weight: number
  courses: string[]
  hasAssessment: boolean
}

export type Snapshot = {
  revision: string
  version: number
  publishedAt: string
  nodes: GraphNode[]
  mappings: Mapping[]
  reviewItems: ReviewItem[]
  coverage: CoverageConclusion[]
  stale: boolean
  opSeq: number
}

export type OperationType =
  | 'submitRevision'
  | 'reviewDecision'
  | 'addMapping'
  | 'updateNode'
  | 'publishBaseline'

export type OperationRecord = {
  seq: number
  opId: string
  type: OperationType
  payload: Record<string, unknown>
  baseVersion: number
  status: 'pending' | 'committed' | 'rejected' | 'aborted'
  result?: Record<string, unknown>
  reason?: string
  createdAt: string
  updatedAt: string
}

export type RejectedRecord = {
  seq: number
  opId: string
  type: OperationType
  reason: 'stale_version' | 'locked' | 'invalid' | 'business'
  baseVersion: number
  currentVersion: number
  payload: Record<string, unknown>
  createdAt: string
}

export type ServerState = {
  version: number
  revision: string
  locked: boolean
  draft: string
  nodes: GraphNode[]
  mappings: Mapping[]
  reviewItems: ReviewItem[]
  snapshots: Snapshot[]
  operations: OperationRecord[]
  rejected: RejectedRecord[]
}

export type View = {
  version: number
  revision: string
  locked: boolean
  draft: string
  nodes: GraphNode[]
  mappings: Mapping[]
  reviewItems: ReviewItem[]
  coverage: CoverageConclusion[]
  snapshots: Array<{ revision: string; version: number; publishedAt: string; stale: boolean }>
  rejectedCount: number
}

export class WriteError extends Error {
  status: number
  reason: RejectedRecord['reason']
  payload?: Record<string, unknown>
  constructor(status: number, reason: RejectedRecord['reason'], message: string, payload?: Record<string, unknown>) {
    super(message)
    this.name = 'WriteError'
    this.status = status
    this.reason = reason
    this.payload = payload
  }
}

const DATA_DIR = resolve(process.cwd(), 'data')
const STATE_FILE = resolve(DATA_DIR, 'curriculum-state.json')
const MAX_OPERATIONS = 500

function seedState(): ServerState {
  return {
    version: 1,
    revision: 'R12',
    locked: false,
    draft: 'C-308 对 GR-06 的案例证据不足，需补充评分记录。',
    nodes: structuredClone(seedNodes),
    mappings: structuredClone(seedMappings),
    reviewItems: structuredClone(seedReviewItems),
    snapshots: [],
    operations: [],
    rejected: [],
  }
}

let state: ServerState | null = null
let queue: Promise<unknown> = Promise.resolve()

function withMutex<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function persist(s: ServerState) {
  mkdirSync(DATA_DIR, { recursive: true })
  const tmp = `${STATE_FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(s), 'utf-8')
  renameSync(tmp, STATE_FILE)
}

function nextSeq(s: ServerState): number {
  return s.operations.reduce((max, op) => Math.max(max, op.seq), 0) + 1
}

function nextRevision(rev: string): string {
  const n = parseInt(rev.slice(1), 10)
  return `R${Number.isFinite(n) ? n + 1 : 1}`
}

function hasPathToAssessment(startId: string, nodes: GraphNode[], mappings: Mapping[]): boolean {
  const visited = new Set<string>()
  const stack = [startId]
  while (stack.length) {
    const id = stack.pop() as string
    if (visited.has(id)) continue
    visited.add(id)
    const node = nodes.find((n) => n.id === id)
    if (node?.type === '考核') return true
    for (const m of mappings.filter((m) => m.source === id)) {
      if (!visited.has(m.target)) stack.push(m.target)
    }
  }
  return false
}

export function computeCoverage(nodes: GraphNode[], mappings: Mapping[]): CoverageConclusion[] {
  return nodes
    .filter((n) => n.type === '毕业要求')
    .map((req) => {
      const links = mappings.filter((m) => m.source === req.id)
      const courseIds = [...new Set(links.map((m) => m.target).filter((id) => nodes.some((n) => n.id === id && n.type === '课程')))]
      const weight = links.filter((m) => courseIds.includes(m.target)).reduce((sum, m) => sum + m.weight, 0)
      return {
        requirementId: req.id,
        covered: courseIds.length > 0,
        weight: Math.round(weight * 100) / 100,
        courses: courseIds,
        hasAssessment: courseIds.some((cid) => hasPathToAssessment(cid, nodes, mappings)),
      }
    })
}

/** 课程/毕业要求/映射变更后，级联失效引用它们的未完成审阅，并重算快照覆盖结论。 */
function invalidateReferences(s: ServerState, changedIds: Set<string>) {
  s.reviewItems.forEach((item) => {
    if (item.status === '待审阅' && (changedIds.has(item.courseId) || changedIds.has(item.requirementId))) {
      item.status = '已失效'
      item.comment = '引用的课程或毕业要求已变更，审阅结论失效，请重新提交修订。'
    }
  })
  s.snapshots.forEach((snap) => {
    const references =
      snap.mappings.some((m) => changedIds.has(m.source) || changedIds.has(m.target)) ||
      snap.reviewItems.some((i) => changedIds.has(i.courseId) || changedIds.has(i.requirementId)) ||
      [...changedIds].some((id) => snap.nodes.some((n) => n.id === id && (n.type === '课程' || n.type === '毕业要求')))
    if (references) {
      snap.stale = true
      snap.coverage = computeCoverage(s.nodes, s.mappings)
    }
  })
}

/** 纯应用函数：只做内存变更，不做版本校验、不落盘。commit 与 recovery 共用。 */
function applyOperation(s: ServerState, type: OperationType, payload: Record<string, unknown>, seq: number): Record<string, unknown> {
  switch (type) {
    case 'submitRevision': {
      const courseId = String(payload.courseId ?? '')
      const requirementId = String(payload.requirementId ?? '')
      const evidence = String(payload.evidence ?? '')
      const submitter = String(payload.submitter ?? '')
      const course = s.nodes.find((n) => n.id === courseId && n.type === '课程')
      const req = s.nodes.find((n) => n.id === requirementId && n.type === '毕业要求')
      if (!course || !req) throw new WriteError(400, 'invalid', '课程或毕业要求不存在。')
      const id = `REV-${String(s.reviewItems.length + 1).padStart(3, '0')}`
      const item: ReviewItem = { id, courseId, requirementId, evidence, submitter, status: '待审阅', comment: '' }
      s.reviewItems.unshift(item)
      return { item }
    }
    case 'reviewDecision': {
      const itemId = String(payload.itemId ?? '')
      const decision = payload.decision as ReviewItem['status']
      const comment = String(payload.comment ?? '')
      const item = s.reviewItems.find((i) => i.id === itemId)
      if (!item) throw new WriteError(404, 'invalid', '审阅项不存在。')
      if (item.status !== '待审阅') {
        throw new WriteError(409, 'business', `该审阅项已处理（${item.status}），同一决定不能重复执行。`)
      }
      item.status = decision
      item.comment = comment
      return { item }
    }
    case 'addMapping': {
      const source = String(payload.source ?? '')
      const target = String(payload.target ?? '')
      const relation = payload.relation as Mapping['relation']
      const weight = Number(payload.weight ?? 0)
      if (source === target) throw new WriteError(400, 'invalid', '来源与目标不能相同。')
      if (!s.nodes.some((n) => n.id === source) || !s.nodes.some((n) => n.id === target)) {
        throw new WriteError(400, 'invalid', '映射端点不存在。')
      }
      const id = `M-${String(s.mappings.length + 1).padStart(2, '0')}`
      const mapping: Mapping = { id, source, target, relation, weight }
      s.mappings.push(mapping)
      invalidateReferences(s, new Set([source, target]))
      return { mapping }
    }
    case 'updateNode': {
      const nodeId = String(payload.nodeId ?? '')
      const node = s.nodes.find((n) => n.id === nodeId)
      if (!node) throw new WriteError(404, 'invalid', '节点不存在。')
      if (payload.label !== undefined) node.label = String(payload.label)
      if (payload.x !== undefined) node.x = Number(payload.x)
      if (payload.y !== undefined) node.y = Number(payload.y)
      if (node.type === '课程' || node.type === '毕业要求') invalidateReferences(s, new Set([nodeId]))
      return { node }
    }
    case 'publishBaseline': {
      const revision = s.revision
      const snapshot: Snapshot = {
        revision,
        version: s.version,
        publishedAt: new Date().toISOString(),
        nodes: structuredClone(s.nodes),
        mappings: structuredClone(s.mappings),
        reviewItems: structuredClone(s.reviewItems),
        coverage: computeCoverage(s.nodes, s.mappings),
        stale: false,
        opSeq: seq,
      }
      s.snapshots.push(snapshot)
      s.revision = nextRevision(revision)
      s.locked = false
      s.draft = `已发布基线 ${revision}，当前为 ${s.revision} 草稿，可继续修订。`
      return { snapshot: { revision: snapshot.revision, version: snapshot.version, publishedAt: snapshot.publishedAt, stale: snapshot.stale } }
    }
  }
}

/** 启动恢复：pending 操作因崩溃未落地，按操作编号重放；同一 opId 已 committed 则跳过。 */
function recover(s: ServerState) {
  const pending = s.operations
    .filter((op) => op.status === 'pending')
    .sort((a, b) => a.seq - b.seq)
  if (!pending.length) return
  for (const op of pending) {
    if (s.operations.some((o) => o.opId === op.opId && o.status === 'committed')) {
      op.status = 'aborted'
      op.updatedAt = new Date().toISOString()
      continue
    }
    try {
      const result = applyOperation(s, op.type, op.payload, op.seq)
      s.version += 1
      op.status = 'committed'
      op.result = result
      op.updatedAt = new Date().toISOString()
    } catch (err) {
      op.status = 'aborted'
      op.reason = err instanceof Error ? err.message : String(err)
      op.updatedAt = new Date().toISOString()
    }
  }
  persist(s)
}

function load(): ServerState {
  if (state) return state
  if (existsSync(STATE_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as ServerState
      state = parsed
      recover(state)
      return state
    } catch {
      // 状态文件损坏时回退到种子，避免服务不可用。
    }
  }
  state = seedState()
  persist(state)
  return state
}

function prune(s: ServerState) {
  if (s.operations.length > MAX_OPERATIONS) {
    s.operations = s.operations.slice(-MAX_OPERATIONS)
  }
}

type CommitInput = {
  opId: string
  type: OperationType
  baseVersion: number
  payload: Record<string, unknown>
}

type CommitResult = { view: View; result: Record<string, unknown>; idempotent: boolean }

/** 写入管线：幂等去重 → 落盘 pending → 版本校验 → 一次性提交 → 落盘 committed。 */
function commit(input: CommitInput): Promise<CommitResult> {
  return withMutex(async () => {
    const s = load()
    const now = new Date().toISOString()

    const done = s.operations.find((op) => op.opId === input.opId && op.status === 'committed')
    if (done) {
      return { view: toView(s), result: { ...(done.result ?? {}), idempotent: true }, idempotent: true }
    }
    const inflight = s.operations.find((op) => op.opId === input.opId && op.status === 'pending')
    if (inflight) {
      throw new WriteError(409, 'business', '相同操作正在处理中，请勿重复提交。')
    }

    const seq = nextSeq(s)
    const op: OperationRecord = {
      seq,
      opId: input.opId,
      type: input.type,
      payload: input.payload,
      baseVersion: input.baseVersion,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    }
    s.operations.push(op)
    persist(s)

    try {
      if (input.baseVersion !== s.version) {
        throw new WriteError(
          409,
          'stale_version',
          `草稿版本已过期（提交基于 v${input.baseVersion}，当前 v${s.version}）。未落地的改动已退回，请刷新到最新草稿后重新提交。`,
          { currentVersion: s.version, payload: input.payload },
        )
      }
      if (s.locked && input.type !== 'reviewDecision') {
        throw new WriteError(409, 'locked', '当前草稿已锁定并发布基线，不能修改。请基于新草稿操作。', {
          currentVersion: s.version,
        })
      }
      const result = applyOperation(s, input.type, input.payload, seq)
      s.version += 1
      op.status = 'committed'
      op.result = result
      op.updatedAt = new Date().toISOString()
      prune(s)
      persist(s)
      return { view: toView(s), result: { ...result, version: s.version }, idempotent: false }
    } catch (err) {
      op.status = 'rejected'
      op.reason = err instanceof Error ? err.message : String(err)
      op.updatedAt = new Date().toISOString()
      if (err instanceof WriteError && (err.reason === 'stale_version' || err.reason === 'locked')) {
        s.rejected.push({
          seq,
          opId: input.opId,
          type: input.type,
          reason: err.reason,
          baseVersion: input.baseVersion,
          currentVersion: s.version,
          payload: input.payload,
          createdAt: now,
        })
      }
      persist(s)
      throw err
    }
  })
}

function toView(s: ServerState): View {
  return {
    version: s.version,
    revision: s.revision,
    locked: s.locked,
    draft: s.draft,
    nodes: s.nodes,
    mappings: s.mappings,
    reviewItems: s.reviewItems,
    coverage: computeCoverage(s.nodes, s.mappings),
    snapshots: s.snapshots.map((snap) => ({
      revision: snap.revision,
      version: snap.version,
      publishedAt: snap.publishedAt,
      stale: snap.stale,
    })),
    rejectedCount: s.rejected.length,
  }
}

export function getView(): View {
  return toView(load())
}

export function getSnapshot(revision: string): Snapshot | null {
  const s = load()
  return s.snapshots.find((snap) => snap.revision === revision) ?? null
}

export function listRejected(): RejectedRecord[] {
  return load().rejected.slice(-20).reverse()
}

// ---- 对外的写入入口（均携带 opId 与 baseVersion）----

export function submitRevision(input: {
  opId: string
  baseVersion: number
  courseId: string
  requirementId: string
  evidence: string
  revisionNote: string
  submitter: string
}) {
  const evidence = `${input.evidence} 修订说明：${input.revisionNote}`
  return commit({
    opId: input.opId,
    type: 'submitRevision',
    baseVersion: input.baseVersion,
    payload: {
      courseId: input.courseId,
      requirementId: input.requirementId,
      evidence,
      submitter: input.submitter,
    },
  })
}

export function reviewDecision(input: {
  opId: string
  baseVersion: number
  itemId: string
  decision: '已附议' | '已退回'
  comment: string
}) {
  return commit({
    opId: input.opId,
    type: 'reviewDecision',
    baseVersion: input.baseVersion,
    payload: { itemId: input.itemId, decision: input.decision, comment: input.comment },
  })
}

export function addMapping(input: {
  opId: string
  baseVersion: number
  source: string
  target: string
  relation: Mapping['relation']
  weight: number
}) {
  return commit({
    opId: input.opId,
    type: 'addMapping',
    baseVersion: input.baseVersion,
    payload: { source: input.source, target: input.target, relation: input.relation, weight: input.weight },
  })
}

export function updateNode(input: {
  opId: string
  baseVersion: number
  nodeId: string
  label?: string
  x?: number
  y?: number
}) {
  return commit({
    opId: input.opId,
    type: 'updateNode',
    baseVersion: input.baseVersion,
    payload: { nodeId: input.nodeId, label: input.label, x: input.x, y: input.y },
  })
}

export function publishBaseline(input: { opId: string; baseVersion: number }) {
  return commit({ opId: input.opId, type: 'publishBaseline', baseVersion: input.baseVersion, payload: {} })
}
