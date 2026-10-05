import { z } from 'zod'

// 课程负责人提交修订的表单校验。
export const revisionSchema = z.object({
  courseId: z.string().min(1, '请选择课程'),
  requirementId: z.string().min(1, '请选择毕业要求'),
  evidence: z.string().min(12, '证据说明至少需要 12 个字符'),
  revisionNote: z.string().min(8, '修订说明至少需要 8 个字符'),
  submitter: z.string().min(2, '请填写提交人'),
})

// 每条写入都必须携带草稿版本与操作编号。
export const envelopeMetaSchema = z.object({
  opId: z.string().min(1, '缺少操作编号'),
  baseVersion: z.coerce.number().int().nonnegative('草稿版本号不合法'),
})

export const decisionSchema = z.object({
  reviewId: z.string().min(1),
  decision: z.enum(['已附议', '已退回']),
  comment: z.string().min(2, '请填写审阅意见'),
  reviewer: z.string().min(2, '请填写审阅人'),
})

export const bulkDecisionItemSchema = z.object({
  reviewId: z.string().min(1),
  decision: z.enum(['已附议', '已退回']),
  comment: z.string().min(1),
})

const weightSchema = z.number().min(0).max(1)

const opSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('submitRevision'),
    courseId: z.string().min(1),
    requirementId: z.string().min(1),
    evidence: z.string().min(1),
    revisionNote: z.string().min(1),
    submitter: z.string().min(1),
  }),
  z.object({
    type: z.literal('decideReview'),
    reviewId: z.string().min(1),
    decision: z.enum(['已附议', '已退回']),
    comment: z.string().min(1),
    reviewer: z.string().min(1),
  }),
  z.object({
    type: z.literal('bulkDecide'),
    reviewer: z.string().min(1),
    decisions: z.array(bulkDecisionItemSchema).min(1, '至少选择一条审阅项'),
  }),
  z.object({
    type: z.literal('addMapping'),
    source: z.string().min(1),
    target: z.string().min(1),
    relation: z.enum(['支撑', '前置', '考核', '教学']),
    weight: weightSchema,
  }),
  z.object({ type: z.literal('updateNode'), id: z.string().min(1), label: z.string().min(1, '节点名称不能为空') }),
  z.object({ type: z.literal('lock') }),
  z.object({ type: z.literal('publish') }),
  z.object({ type: z.literal('reopenFromLock'), reason: z.string().optional() }),
  z.object({ type: z.literal('openRevision'), revision: z.string().min(1).optional() }),
])

export const envelopeSchema = z.object({
  opId: z.string().min(1, '缺少操作编号'),
  baseVersion: z.number().int().nonnegative('草稿版本号不合法'),
  at: z.string().optional(),
  op: opSchema,
})

export type RevisionInput = z.infer<typeof revisionSchema>
export type DecisionInput = z.infer<typeof decisionSchema>
export type EnvelopeInput = z.infer<typeof envelopeSchema>
