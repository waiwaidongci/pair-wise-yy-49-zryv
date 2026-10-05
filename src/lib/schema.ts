import { z } from 'zod'

export const revisionSchema = z.object({
  courseId: z.string().min(1, '请选择课程'),
  requirementId: z.string().min(1, '请选择毕业要求'),
  evidence: z.string().min(12, '证据说明至少需要 12 个字符'),
  revisionNote: z.string().min(8, '修订说明至少需要 8 个字符'),
  submitter: z.string().min(2, '请填写提交人'),
})

export const mappingSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  relation: z.enum(['支撑', '前置', '考核', '教学']),
  weight: z.coerce.number().min(0).max(1),
})

export const opIdSchema = z.string().min(1, '缺少操作编号')
export const baseVersionSchema = z.coerce.number().int().min(1)

export const reviewDecisionSchema = z.object({
  itemId: z.string().min(1),
  decision: z.enum(['已附议', '已退回']),
  comment: z.string().default(''),
})

export const nodeUpdateSchema = z.object({
  nodeId: z.string().min(1),
  label: z.string().optional(),
  x: z.coerce.number().optional(),
  y: z.coerce.number().optional(),
})

export type RevisionInput = z.infer<typeof revisionSchema>
