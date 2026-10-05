import { json } from '@sveltejs/kit'
import { addMapping, WriteError } from '$lib/server/curriculum'
import { baseVersionSchema, mappingSchema, opIdSchema } from '$lib/schema'

export async function POST({ request }) {
  const body = await request.json().catch(() => null)
  const parsed = mappingSchema.safeParse(body)
  const opId = opIdSchema.safeParse(body?.opId)
  const baseVersion = baseVersionSchema.safeParse(body?.baseVersion)
  if (!parsed.success || !opId.success || !baseVersion.success) {
    return json({ ok: false, error: '参数校验未通过。', fieldErrors: parsed.error?.flatten().fieldErrors }, { status: 400 })
  }
  try {
    const { view, idempotent } = await addMapping({
      opId: opId.data,
      baseVersion: baseVersion.data,
      source: parsed.data.source,
      target: parsed.data.target,
      relation: parsed.data.relation,
      weight: parsed.data.weight,
    })
    return json({ ok: true, view, idempotent })
  } catch (err) {
    if (err instanceof WriteError) {
      return json({ ok: false, error: err.message, reason: err.reason, payload: err.payload }, { status: err.status })
    }
    throw err
  }
}
