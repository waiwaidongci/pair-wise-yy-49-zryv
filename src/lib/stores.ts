import { writable } from 'svelte/store'
import type { View } from './server/curriculum'
import type { GraphNode, Mapping } from './seed'

/**
 * 客户端状态只是服务端版本的只读镜像（缓存）。
 * 不再各自在 localStorage 存一份草稿：所有写入都走服务端版本校验，
 * 成功后用服务端返回的最新 View 整体替换，保证课程、毕业要求、审阅意见围绕同一份版本。
 */
export type CurriculumState = View

const empty: CurriculumState = {
  version: 1,
  revision: 'R12',
  locked: false,
  draft: '',
  nodes: [],
  mappings: [],
  reviewItems: [],
  coverage: [],
  snapshots: [],
  rejectedCount: 0,
}

function createCurriculumStore() {
  const { subscribe, set, update } = writable<CurriculumState>(empty)
  return {
    subscribe,
    /** 用服务端返回的最新版本整体替换客户端镜像。 */
    hydrate(view: View) {
      set(view)
    },
    /** 拖拽节点仅为本地视图调整，不涉及内容变更，不触发版本校验与失效重算。 */
    moveNode(id: string, x: number, y: number) {
      update((state) => ({ ...state, nodes: state.nodes.map((node) => (node.id === id ? { ...node, x, y } : node)) }))
    },
  }
}

export const curriculumStore = createCurriculumStore()

export function validateCurriculum(state: CurriculumState) {
  const issues: Array<{ id: string; severity: '错误' | '警告'; title: string; detail: string }> = []
  const outgoing = new Map<string, Mapping[]>()
  state.mappings.forEach((mapping) => outgoing.set(mapping.source, [...(outgoing.get(mapping.source) ?? []), mapping]))
  state.nodes.filter((node) => node.type === '毕业要求').forEach((node) => {
    if (!(outgoing.get(node.id) ?? []).some((mapping) => state.nodes.find((item) => item.id === mapping.target)?.type === '课程')) {
      issues.push({ id: `coverage-${node.id}`, severity: '错误', title: `${node.label.split('\n')[0]} 存在覆盖缺口`, detail: '未关联任何课程支撑证据。' })
    }
  })
  const seen = new Set<string>()
  state.mappings.forEach((mapping) => {
    const key = `${mapping.source}-${mapping.target}-${mapping.relation}`
    if (seen.has(key)) issues.push({ id: `dup-${mapping.id}`, severity: '警告', title: `${mapping.id} 为重复映射`, detail: '相同来源、目标和关系重复录入，可合并。' })
    seen.add(key)
  })
  return issues
}

export type { GraphNode }
