import { json } from '@sveltejs/kit'
import { reviewDecision, WriteError } from '$lib/server/curriculum'
import { baseVersionSchema, opIdSchema, reviewDecisionSchema } from '$lib/schema'

export async function POST({ request }) {
  const body = await request.json().catch(() => null)
  const parsed = reviewDecisionSchema.safeParse(body)
  const opId = opIdSchema.safeParse(body?.opId)
  const baseVersion = baseVersionSchema.safeParse(body?.baseVersion)
  if (!parsed.success || !opId.success || !baseVersion.success) {
    return json({ ok: false, error: '参数校验未通过。', fieldErrors: parsed.error?.flatten().fieldErrors }, { status: 400 })
  }
  try {
    const { view, result, idempotent } = await reviewDecision({
      opId: opId.data,
      baseVersion: baseVersion.data,
      itemId: parsed.data.itemId,
      decision: parsed.data.decision,
      comment: parsed.data.comment || (parsed.data.decision === '已附议' ? '批量附议：证据链完整。' : '请补充可验证的评分记录。'),
    })
    return json({ ok: true, view, item: result.item, idempotent })
  } catch (err) {
    if (err instanceof WriteError) {
      return json({ ok: false, error: err.message, reason: err.reason, payload: err.payload }, { status: err.status })
    }
    throw err
  }
}
