import { fail } from '@sveltejs/kit'
import { z } from 'zod'
import { envelopeMetaSchema } from '$lib/schema'
import { versionedStore } from '$lib/server/store'
import { EngineError } from '$lib/versioning/engine'

export const load = async () => {
  return { snapshot: await versionedStore.snapshot() }
}

const updateNodeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1, '节点名称不能为空'),
})

export const actions = {
  // 课程 / 毕业要求内容修订：带草稿版本，过期不落地；落地后引用它的未完成审阅失效、锁定基线标记重算。
  updateNode: async ({ request }) => {
    const form = await request.formData()
    const meta = envelopeMetaSchema.safeParse({ opId: form.get('opId'), baseVersion: form.get('baseVersion') })
    if (!meta.success) return fail(400, { action: 'updateNode', errors: meta.error.flatten().fieldErrors })
    const parsed = updateNodeSchema.safeParse({ id: form.get('id'), label: form.get('label') })
    if (!parsed.success) return fail(400, { action: 'updateNode', errors: parsed.error.flatten().fieldErrors })

    try {
      const result = await versionedStore.commit({
        opId: meta.data.opId,
        baseVersion: meta.data.baseVersion,
        at: new Date().toISOString(),
        op: { type: 'updateNode', id: parsed.data.id, label: parsed.data.label },
      })
      if (result.stale && !result.duplicate) {
        return fail(409, {
          action: 'updateNode',
          stale: true,
          serverVersion: result.snapshot.version,
          reason: `草稿版本 ${meta.data.baseVersion} 已过期（当前 v${result.snapshot.version}），节点修订未落地。`,
        })
      }
      return { success: true, action: 'updateNode' as const, duplicate: result.duplicate, snapshot: result.snapshot, opId: meta.data.opId }
    } catch (cause) {
      if (cause instanceof EngineError) {
        return fail(cause.code === 'locked' ? 423 : cause.code === 'not-found' ? 404 : 422, { action: 'updateNode', rejected: cause.message })
      }
      throw cause
    }
  },
}
