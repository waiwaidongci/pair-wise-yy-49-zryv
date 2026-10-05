import { json } from '@sveltejs/kit'
import { envelopeSchema } from '$lib/schema'
import { versionedStore } from '$lib/server/store'
import { EngineError } from '$lib/versioning/engine'

export async function GET() {
  return json(await versionedStore.snapshot())
}

export async function POST({ request }) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: '请求体不是合法 JSON' }, { status: 400 })
  }
  const parsed = envelopeSchema.safeParse(body)
  if (!parsed.success) {
    return json({ error: parsed.error.issues.map((issue) => issue.message).join('；') || '请求校验失败' }, { status: 400 })
  }
  const envelope = {
    opId: parsed.data.opId,
    baseVersion: parsed.data.baseVersion,
    at: parsed.data.at ?? new Date().toISOString(),
    op: parsed.data.op,
  }
  try {
    const result = await versionedStore.commit(envelope)
    // 过期改动不落地，snapshot 为当前最新状态，客户端据此回退未落地改动。
    return json(result, { status: result.stale && !result.duplicate ? 409 : 200 })
  } catch (cause) {
    if (cause instanceof EngineError) {
      return json({ error: cause.message, code: cause.code }, { status: cause.code === 'locked' ? 423 : cause.code === 'not-found' ? 404 : 422 })
    }
    throw cause
  }
}
