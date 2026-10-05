import { writable } from 'svelte/store'
import { browser } from '$app/environment'
import { createSeedState } from './versioning/seed'
import { toSnapshot } from './versioning/engine'
import type { Op, Snapshot } from './versioning/types'

// 客户端不再持有自己的草稿副本：这里只是服务端版本化快照的缓存视图，
// 课程、毕业要求与审阅意见全部围绕同一份版本工作。

export type SyncState = 'ready' | 'syncing' | 'stale' | 'error'

export type CurriculumView = Snapshot & {
  syncState: SyncState
  notice: string | null
}

export class StaleVersionError extends Error {
  constructor(
    public baseVersion: number,
    public serverVersion: number,
    public opType: string,
  ) {
    super(`草稿版本 ${baseVersion} 已过期，服务端当前为 ${serverVersion}，本次${opType}改动未落地`)
    this.name = 'StaleVersionError'
  }
}

export class CommitRejectedError extends Error {}

function seedView(): CurriculumView {
  return { ...toSnapshot(createSeedState(), ''), syncState: 'ready', notice: null }
}

function createCurriculumStore() {
  const { subscribe, set, update } = writable<CurriculumView>(seedView())
  // 客户端写入严格排队：同一浏览器里的并发提交也会串行，后到者按版本过期退回。
  let queue: Promise<unknown> = Promise.resolve()
  let latest: CurriculumView = seedView()
  subscribe((view) => {
    latest = view
  })

  function hydrate(snapshot: Snapshot, syncState: SyncState = 'ready', notice: string | null = null) {
    set({ ...snapshot, syncState, notice })
  }

  async function refresh(notice: string | null = null) {
    if (!browser) return latest
    const response = await fetch('/api/curriculum')
    if (!response.ok) throw new Error('同步服务端状态失败')
    const snapshot = (await response.json()) as Snapshot
    hydrate(snapshot, 'ready', notice)
    return snapshot
  }

  function newOpId() {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
    return `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }

  /**
   * 提交一个版本化操作：自动携带当前草稿版本。
   * - 过期（409）：服务端改动不落地，本地视图回退到服务端最新快照，抛出 StaleVersionError；
   * - 网络失败：按同一操作编号查询服务端是否已落地，能恢复就恢复，不能则抛错，绝不重复提交；
   * - 其他拒绝（422/423）：改动未落地，抛出原因。
   */
  function commit(op: Op, opId = newOpId()): Promise<Snapshot> {
    const run = queue.then(async () => {
      const current = latest
      update((view) => ({ ...view, syncState: 'syncing', notice: null }))
      const envelope = { opId, baseVersion: current.version, op, at: new Date().toISOString() }
      let response: Response
      try {
        response = await fetch('/api/curriculum', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(envelope),
        })
      } catch {
        return recoverAfterNetworkFailure(opId, op.type)
      }
      const payload = await response.json().catch(() => null)
      if (response.status === 409 && payload?.snapshot) {
        hydrate(payload.snapshot, 'stale', payload.stale && !payload.duplicate ? '草稿版本已过期，未落地的改动已退回；页面已同步到最新版本。' : null)
        throw new StaleVersionError(envelope.baseVersion, payload.snapshot.version, op.type)
      }
      if (!response.ok) {
        update((view) => ({ ...view, syncState: 'error', notice: null }))
        throw new CommitRejectedError(payload?.error ?? `提交被拒绝（${response.status}）`)
      }
      hydrate(payload.snapshot, 'ready', payload.duplicate ? '该操作编号已送达过，服务端只认了第一次结果。' : null)
      return payload.snapshot as Snapshot
    })
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function recoverAfterNetworkFailure(opId: string, opType: string): Promise<Snapshot> {
    // 写入可能已经在服务端落地，只是响应丢失：按编号查证，绝不重发。
    try {
      const lookup = await fetch(`/api/ops/${encodeURIComponent(opId)}`)
      const result = await lookup.json()
      if (result.known) {
        const snapshot = await refresh('网络中断后已按操作编号恢复，未重复提交。')
        return snapshot
      }
    } catch {
      // 查证也失败，落到下面的错误提示。
    }
    update((view) => ({
      ...view,
      syncState: 'error',
      notice: `网络中断，${opType} 是否落地无法确认；请保持操作编号 ${opId} 以便恢复。`,
    }))
    throw new CommitRejectedError(`网络中断，操作 ${opId} 状态未知，已挂起等待恢复`)
  }

  async function recoverByOpId(opId: string) {
    const response = await fetch(`/api/ops/${encodeURIComponent(opId)}`)
    const result = await response.json()
    if (!result.known) return { recovered: false as const }
    await refresh(result.stale ? '该编号是一次过期提交，改动未落地；已同步最新版本。' : '已按操作编号恢复到服务端落地结果。')
    return { recovered: true as const, stale: Boolean(result.stale), resultVersion: result.resultVersion as number }
  }

  return {
    subscribe,
    hydrate,
    refresh,
    commit,
    recoverByOpId,
    newOpId,
    /** 仅用于节点拖拽布局，纯视觉，不产生写入、不影响版本。 */
    patchLocal(patch: (view: CurriculumView) => CurriculumView) {
      update(patch)
    },
  }
}

export const curriculumStore = createCurriculumStore()

if (browser) {
  // 首屏先拉取服务端权威快照，覆盖种子视图。
  void curriculumStore.refresh()
}

export { toSnapshot as snapshotOf, createSeedState }

export function validateCurriculum(view: Pick<CurriculumView, 'nodes' | 'mappings'>) {
  const issues: Array<{ id: string; severity: '错误' | '警告'; title: string; detail: string }> = []
  const outgoing = new Map<string, typeof view.mappings>()
  view.mappings.forEach((mapping) => outgoing.set(mapping.source, [...(outgoing.get(mapping.source) ?? []), mapping]))
  view.nodes
    .filter((node) => node.type === '毕业要求')
    .forEach((node) => {
      if (!(outgoing.get(node.id) ?? []).some((mapping) => view.nodes.find((item) => item.id === mapping.target)?.type === '课程')) {
        issues.push({ id: `coverage-${node.id}`, severity: '错误', title: `${node.label.split('\n')[0]} 存在覆盖缺口`, detail: '未关联任何课程支撑证据。' })
      }
    })
  const seen = new Set<string>()
  view.mappings.forEach((mapping) => {
    const key = `${mapping.source}-${mapping.target}-${mapping.relation}`
    if (seen.has(key)) issues.push({ id: `dup-${mapping.id}`, severity: '警告', title: `${mapping.id} 为重复映射`, detail: '相同来源、目标和关系重复录入，可合并。' })
    seen.add(key)
  })
  return issues
}
