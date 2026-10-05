import { json, error } from '@sveltejs/kit'
import { versionedStore } from '$lib/server/store'

// 按操作编号恢复：写入失败或客户端超时后，用原编号查询是否已落地，避免重复提交 / 半条审阅。
export async function GET({ params }) {
  if (!params.opId) throw error(400, '缺少操作编号')
  return json(await versionedStore.lookupOp(params.opId))
}
