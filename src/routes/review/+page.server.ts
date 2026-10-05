import { fail } from '@sveltejs/kit'
import { revisionSchema, envelopeMetaSchema, decisionSchema, bulkDecisionItemSchema } from '$lib/schema'
import { versionedStore } from '$lib/server/store'
import { EngineError } from '$lib/versioning/engine'

function readMeta(form: FormData) {
  return envelopeMetaSchema.safeParse({
    opId: form.get('opId'),
    baseVersion: form.get('baseVersion'),
  })
}

function failWith(status: number, body: Record<string, unknown>) {
  return fail(status, body)
}

export const load = async () => {
  return { snapshot: await versionedStore.snapshot() }
}

export const actions = {
  // 课程负责人提交修订：携带草稿版本，过期时表单值保留、改动不落地，服务端记录这次过期送达。
  submitRevision: async ({ request }) => {
    const form = await request.formData()
    const meta = readMeta(form)
    if (!meta.success) return fail(400, { action: 'submitRevision', errors: meta.error.flatten().fieldErrors, values: Object.fromEntries(form) })

    const parsed = revisionSchema.safeParse({
      courseId: form.get('courseId'),
      requirementId: form.get('requirementId'),
      evidence: form.get('evidence'),
      revisionNote: form.get('revisionNote'),
      submitter: form.get('submitter'),
    })
    if (!parsed.success) {
      return fail(400, { action: 'submitRevision', errors: parsed.error.flatten().fieldErrors, values: Object.fromEntries(form) })
    }

    const result = await versionedStore.commit({
      opId: meta.data.opId,
      baseVersion: meta.data.baseVersion,
      at: new Date().toISOString(),
      op: { type: 'submitRevision', ...parsed.data },
    })
    if (result.stale && !result.duplicate) {
      return failWith(409, {
        action: 'submitRevision',
        stale: true,
        serverVersion: result.snapshot.version,
        reason: `草稿版本 ${meta.data.baseVersion} 已过期，当前版本为 v${result.snapshot.version}；本次修订未落地，请刷新差异后重新提交。`,
        values: Object.fromEntries(form),
      })
    }
    return { success: true, action: 'submitRevision' as const, duplicate: result.duplicate, snapshot: result.snapshot, opId: meta.data.opId }
  },

  // 院系审阅人处理意见：同一审阅决定用同一操作编号重送只认一次。
  decideReview: async ({ request }) => {
    const form = await request.formData()
    const meta = readMeta(form)
    if (!meta.success) return fail(400, { action: 'decideReview', errors: meta.error.flatten().fieldErrors })

    const parsed = decisionSchema.safeParse({
      reviewId: form.get('reviewId'),
      decision: form.get('decision'),
      comment: form.get('comment'),
      reviewer: form.get('reviewer') || '院系审阅人',
    })
    if (!parsed.success) return fail(400, { action: 'decideReview', errors: parsed.error.flatten().fieldErrors })

    try {
      const result = await versionedStore.commit({
        opId: meta.data.opId,
        baseVersion: meta.data.baseVersion,
        at: new Date().toISOString(),
        op: { type: 'decideReview', ...parsed.data },
      })
      if (result.stale && !result.duplicate) {
        return failWith(409, {
          action: 'decideReview',
          stale: true,
          serverVersion: result.snapshot.version,
          reason: `草稿版本已过期（当前 v${result.snapshot.version}），该审阅意见未落地；可能已有他人先处理或引用数据已变更。`,
        })
      }
      return { success: true, action: 'decideReview' as const, duplicate: result.duplicate, snapshot: result.snapshot, opId: meta.data.opId }
    } catch (cause) {
      if (cause instanceof EngineError) {
        return fail(cause.code === 'not-found' ? 404 : 422, { action: 'decideReview', rejected: cause.message })
      }
      throw cause
    }
  },

  // 批量附议：一条原子操作，要么全部生效，要么全部不生效，不会留下半条审阅。
  bulkApprove: async ({ request }) => {
    const form = await request.formData()
    const meta = readMeta(form)
    if (!meta.success) return fail(400, { action: 'bulkApprove', errors: meta.error.flatten().fieldErrors })

    const ids = form.getAll('reviewIds').map(String)
    const reviewer = String(form.get('reviewer') || '院系审阅人')
    const decisions: Array<{ reviewId: string; decision: '已附议' | '已退回'; comment: string }> = []
    for (const reviewId of ids) {
      const item = bulkDecisionItemSchema.safeParse({ reviewId, decision: '已附议', comment: '批量附议：证据链完整。' })
      if (!item.success) return fail(400, { action: 'bulkApprove', rejected: '批量审阅项数据不合法' })
      decisions.push(item.data)
    }
    if (decisions.length === 0) return fail(400, { action: 'bulkApprove', rejected: '至少选择一条审阅项' })

    try {
      const result = await versionedStore.commit({
        opId: meta.data.opId,
        baseVersion: meta.data.baseVersion,
        at: new Date().toISOString(),
        op: { type: 'bulkDecide', reviewer, decisions },
      })
      if (result.stale && !result.duplicate) {
        return failWith(409, {
          action: 'bulkApprove',
          stale: true,
          serverVersion: result.snapshot.version,
          reason: `草稿版本已过期（当前 v${result.snapshot.version}），批量附议整批未落地，请按最新队列重新选择。`,
        })
      }
      return { success: true, action: 'bulkApprove' as const, duplicate: result.duplicate, snapshot: result.snapshot, count: decisions.length, opId: meta.data.opId }
    } catch (cause) {
      if (cause instanceof EngineError) {
        return fail(cause.code === 'not-found' ? 404 : 422, { action: 'bulkApprove', rejected: cause.message })
      }
      throw cause
    }
  },
}
