import { json } from '@sveltejs/kit'
import { getView, publishBaseline, WriteError } from '$lib/server/curriculum'
import { baseVersionSchema, opIdSchema } from '$lib/schema'

export function GET() {
  const view = getView()
  return json({ baselines: view.snapshots })
}

export async function POST({ request }) {
  const body = await request.json().catch(() => null)
  const opId = opIdSchema.safeParse(body?.opId)
  const baseVersion = baseVersionSchema.safeParse(body?.baseVersion)
  if (!opId.success || !baseVersion.success) {
    return json({ ok: false, error: '缺少操作编号或草稿版本。' }, { status: 400 })
  }
  try {
    const { view, idempotent } = await publishBaseline({ opId: opId.data, baseVersion: baseVersion.data })
    return json({ ok: true, view, idempotent })
  } catch (err) {
    if (err instanceof WriteError) {
      return json({ ok: false, error: err.message, reason: err.reason, payload: err.payload }, { status: err.status })
    }
    throw err
  }
}
