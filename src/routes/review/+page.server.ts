import { fail } from '@sveltejs/kit'
import { revisionSchema, reviewDecisionSchema } from '$lib/schema'
import { getView, submitRevision, reviewDecision, WriteError } from '$lib/server/curriculum'
import type { ReviewItem } from '$lib/seed'

export function load() {
  return { curriculum: getView() }
}

function num(value: FormDataEntryValue | null): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : NaN
}

export const actions = {
  submitRevision: async ({ request }) => {
    const form = await request.formData()
    const parsed = revisionSchema.safeParse({
      courseId: form.get('courseId'),
      requirementId: form.get('requirementId'),
      evidence: form.get('evidence'),
      revisionNote: form.get('revisionNote'),
      submitter: form.get('submitter'),
    })
    const opId = String(form.get('opId') ?? '')
    const baseVersion = num(form.get('baseVersion'))
    if (!parsed.success) {
      return fail(400, { ok: false as const, errors: parsed.error.flatten().fieldErrors, values: Object.fromEntries(form) })
    }
    if (!opId || !Number.isFinite(baseVersion)) {
      return fail(400, { ok: false as const, errors: { opId: ['缺少操作编号或草稿版本。'] }, values: Object.fromEntries(form) })
    }
    try {
      const { view, result, idempotent } = await submitRevision({
        opId,
        baseVersion,
        courseId: parsed.data.courseId,
        requirementId: parsed.data.requirementId,
        evidence: parsed.data.evidence,
        revisionNote: parsed.data.revisionNote,
        submitter: parsed.data.submitter,
      })
      return { ok: true as const, view, item: result.item as ReviewItem, idempotent }
    } catch (err) {
      if (err instanceof WriteError) {
        return fail(err.status, {
          ok: false as const,
          errors: { _: [err.message] },
          values: Object.fromEntries(form),
          reason: err.reason,
          uncommitted: (err.payload?.payload as { evidence?: string } | undefined) ?? null,
          currentVersion: err.payload?.currentVersion ?? null,
        })
      }
      throw err
    }
  },

  reviewDecision: async ({ request }) => {
    const form = await request.formData()
    const parsed = reviewDecisionSchema.safeParse({
      itemId: form.get('itemId'),
      decision: form.get('decision'),
      comment: form.get('comment'),
    })
    const opId = String(form.get('opId') ?? '')
    const baseVersion = num(form.get('baseVersion'))
    if (!parsed.success || !opId || !Number.isFinite(baseVersion)) {
      return fail(400, { ok: false as const, errors: parsed.success ? { opId: ['缺少操作编号或草稿版本。'] } : parsed.error.flatten().fieldErrors })
    }
    try {
      const { view, result, idempotent } = await reviewDecision({
        opId,
        baseVersion,
        itemId: parsed.data.itemId,
        decision: parsed.data.decision,
        comment: parsed.data.comment || (parsed.data.decision === '已附议' ? '证据充分，同意纳入修订。' : '请补充可验证的评分记录。'),
      })
      return { ok: true as const, view, item: result.item as ReviewItem, idempotent }
    } catch (err) {
      if (err instanceof WriteError) {
        return fail(err.status, {
          ok: false as const,
          errors: { _: [err.message] },
          reason: err.reason,
          currentVersion: err.payload?.currentVersion ?? null,
        })
      }
      throw err
    }
  },
}
