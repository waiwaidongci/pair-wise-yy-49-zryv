import { json } from '@sveltejs/kit'
import { getSnapshot } from '$lib/server/curriculum'

export function GET({ params }) {
  const snapshot = getSnapshot(params.revision)
  if (!snapshot) {
    return json({ ok: false, error: '基线快照不存在。' }, { status: 404 })
  }
  return json({ ok: true, snapshot })
}
