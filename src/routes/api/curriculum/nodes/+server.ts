import { json } from '@sveltejs/kit'
import { updateNode, WriteError } from '$lib/server/curriculum'
import { baseVersionSchema, nodeUpdateSchema, opIdSchema } from '$lib/schema'

export async function POST({ request }) {
  const body = await request.json().catch(() => null)
  const parsed = nodeUpdateSchema.safeParse(body)
  const opId = opIdSchema.safeParse(body?.opId)
  const baseVersion = baseVersionSchema.safeParse(body?.baseVersion)
  if (!parsed.success || !opId.success || !baseVersion.success) {
    return json({ ok: false, error: '参数校验未通过。', fieldErrors: parsed.error?.flatten().fieldErrors }, { status: 400 })
  }
  try {
    const { view, idempotent } = await updateNode({
      opId: opId.data,
      baseVersion: baseVersion.data,
      nodeId: parsed.data.nodeId,
      label: parsed.data.label,
      x: parsed.data.x,
      y: parsed.data.y,
    })
    return json({ ok: true, view, idempotent })
  } catch (err) {
    if (err instanceof WriteError) {
      return json({ ok: false, error: err.message, reason: err.reason, payload: err.payload }, { status: err.status })
    }
    throw err
  }
}
