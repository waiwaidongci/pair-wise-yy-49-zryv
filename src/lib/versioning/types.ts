// 客户端与服务端共享的版本化领域类型。

export type NodeType = '目标' | '毕业要求' | '课程' | '单元' | '教学活动' | '考核'

export type GraphNode = {
  id: string
  label: string
  type: NodeType
  x: number
  y: number
  course?: string
}

export type MappingRelation = '支撑' | '前置' | '考核' | '教学'

export type Mapping = {
  id: string
  source: string
  target: string
  relation: MappingRelation
  weight: number
}

export type ReviewStatus = '待审阅' | '已附议' | '已退回' | '已失效'

export type ReviewItem = {
  id: string
  courseId: string
  requirementId: string
  evidence: string
  revisionNote: string
  submitter: string
  status: ReviewStatus
  comment: string
  /** 提交时所依据的草稿版本号 */
  baseVersion: number
  createdAt: string
  decidedAt?: string
  decidedBy?: string
  /** 生效决定对应的操作编号，用于幂等识别 */
  decisionOpId?: string
  invalidatedAt?: string
  invalidatedReason?: string
  /** 失效后重新提交所产生的新审阅项 */
  supersededBy?: string
}

export type Phase = 'draft' | 'locked' | 'published'

export type CourseCoverage = {
  courseId: string
  weight: number
}

export type RequirementCoverage = {
  requirementId: string
  covered: boolean
  courseCount: number
  totalWeight: number
  courses: CourseCoverage[]
}

export type Baseline = {
  revision: string
  version: number
  kind: 'locked' | 'published'
  createdAt: string
  publishedAt?: string
  /** 基线快照本身不可变；该字段表示它是否已被后续工作替代，仅供检索展示 */
  supersededAt?: string
  supersededReason?: string
  nodes: GraphNode[]
  mappings: Mapping[]
  reviewItems: ReviewItem[]
  coverage: RequirementCoverage[]
}

export type OpStatus = 'applied' | 'stale-rejected'

export type OpRecord = {
  opId: string
  type: string
  at: string
  status: OpStatus
  baseVersion: number
  resultVersion?: number
  reason?: string
}

export type Snapshot = {
  revision: string
  version: number
  phase: Phase
  nodes: GraphNode[]
  mappings: Mapping[]
  reviewItems: ReviewItem[]
  coverage: RequirementCoverage[]
  baselines: Baseline[]
  recentOps: OpRecord[]
  serverTime: string
}

// ---- 操作（写入）定义 -------------------------------------------------------

export type Op =
  | {
      type: 'submitRevision'
      courseId: string
      requirementId: string
      evidence: string
      revisionNote: string
      submitter: string
    }
  | {
      type: 'decideReview'
      reviewId: string
      decision: Extract<ReviewStatus, '已附议' | '已退回'>
      comment: string
      reviewer: string
    }
  | {
      type: 'bulkDecide'
      reviewer: string
      decisions: Array<{ reviewId: string; decision: Extract<ReviewStatus, '已附议' | '已退回'>; comment: string }>
    }
  | { type: 'addMapping'; source: string; target: string; relation: MappingRelation; weight: number }
  | { type: 'updateNode'; id: string; label: string }
  | { type: 'lock' }
  | { type: 'publish' }
  | { type: 'reopenFromLock'; reason?: string }
  | { type: 'openRevision'; revision?: string }

export type Envelope = {
  opId: string
  baseVersion: number
  op: Op
  at: string
}

export type ApplyOutcome = {
  snapshot: Snapshot
  duplicate: boolean
  resultVersion: number
}
