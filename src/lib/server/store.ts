// 服务端唯一权威存储：课程、毕业要求、映射、审阅围绕同一份版本化状态工作。
//
// 持久化策略：
// - 所有写入先追加 WAL（write-ahead log），再提交内存状态；
// - 每 N 次写入做一次快照检查点（tmp + rename 原子落盘），随后截断旧 WAL；
// - 服务重启时先载入快照，再重放其后的 WAL，覆盖结论随基线快照留存，不会对不上。
//
// 并发策略：
// - Node 单线程 + 单写者队列，两个并发提交严格串行，后到者因版本过期被退回，不会互相覆盖；
// - 同一 opId 只生效一次，崩溃恢复后仍可按编号查询落地结果（写入失败不会留下半条审阅）。

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { applyEnvelopeStep, cloneState, toSnapshot, type EngineState } from '$lib/versioning/engine'
import { createSeedState } from '$lib/versioning/seed'
import type { Envelope, OpRecord, Snapshot } from '$lib/versioning/types'

const DATA_DIR = process.env.CURRICULUM_DATA_DIR ?? path.join(process.cwd(), '.data')
const SNAPSHOT_FILE = path.join(DATA_DIR, 'snapshot.json')
const WAL_FILE = path.join(DATA_DIR, 'wal.log')
const CHECKPOINT_EVERY = 20

type SerializedState = {
  revision: string
  version: number
  phase: EngineState['phase']
  nodes: EngineState['nodes']
  mappings: EngineState['mappings']
  reviewItems: EngineState['reviewItems']
  baselines: EngineState['baselines']
  recentOps: EngineState['recentOps']
  appliedOps: Array<[string, number]>
  rejectedOps: string[]
  checkpointSeq: number
}

type PersistedEnvelope = { seq: number; envelope: Envelope }

export type CommitResult = {
  snapshot: Snapshot
  duplicate: boolean
  stale: boolean
  resultVersion: number
}

export type OpLookup =
  | { known: false }
  | { known: true; duplicate: boolean; stale: boolean; resultVersion: number; record?: OpRecord }

class VersionedStore {
  #state: EngineState
  #seq = 0
  #sinceCheckpoint = 0
  #queue: Promise<unknown> = Promise.resolve()
  #ready: Promise<void>

  constructor() {
    this.#state = createSeedState()
    this.#ready = this.#recover()
  }

  async #recover() {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true })
    } catch {
      // 目录已存在即可。
    }
    let state: EngineState | null = null
    let checkpointSeq = 0
    try {
      const raw = await fs.readFile(SNAPSHOT_FILE, 'utf-8')
      const saved = JSON.parse(raw) as SerializedState
      state = deserializeState(saved)
      checkpointSeq = saved.checkpointSeq
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    let tail: PersistedEnvelope[] = []
    try {
      const raw = await fs.readFile(WAL_FILE, 'utf-8')
      tail = raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as PersistedEnvelope)
        .filter((entry) => entry.seq > checkpointSeq)
        .sort((a, b) => a.seq - b.seq)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    if (!state) state = createSeedState()
    for (const entry of tail) {
      state = applyEnvelopeStep(state, entry.envelope, entry.envelope.at).state
      this.#seq = Math.max(this.#seq, entry.seq)
    }
    this.#state = state
  }

  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn)
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async snapshot(): Promise<Snapshot> {
    await this.#ready
    return toSnapshot(this.#state, nowIso())
  }

  /** 按操作编号查询落地状态，供写入失败 / 超时后的客户端恢复使用。 */
  async lookupOp(opId: string): Promise<OpLookup> {
    await this.#ready
    return this.#serialize(async () => {
      const applied = this.#state.appliedOps.get(opId)
      if (applied !== undefined) {
        return { known: true, duplicate: true, stale: false, resultVersion: applied, record: this.#findRecord(opId) }
      }
      if (this.#state.rejectedOps.has(opId)) {
        return { known: true, duplicate: true, stale: true, resultVersion: this.#state.version, record: this.#findRecord(opId) }
      }
      return { known: false }
    })
  }

  #findRecord(opId: string): OpRecord | undefined {
    return this.#state.recentOps.find((record) => record.opId === opId)
  }

  async commit(envelope: Envelope): Promise<CommitResult> {
    await this.#ready
    return this.#serialize(async () => {
      // 纯函数计算下一步，不碰当前状态；校验失败（如重复决定）直接抛出，状态与 WAL 都不变。
      const step = applyEnvelopeStep(this.#state, envelope, envelope.at)

      const seq = this.#seq + 1
      await appendWal({ seq, envelope })

      this.#state = step.state
      this.#seq = seq
      this.#sinceCheckpoint += 1
      if (this.#sinceCheckpoint >= CHECKPOINT_EVERY) {
        await this.#checkpoint(seq)
        this.#sinceCheckpoint = 0
      }
      return {
        snapshot: toSnapshot(this.#state, nowIso()),
        duplicate: step.duplicate,
        stale: step.stale,
        resultVersion: step.resultVersion,
      }
    })
  }

  async #checkpoint(seq: number) {
    const payload: SerializedState = {
      ...cloneState(this.#state),
      appliedOps: [...this.#state.appliedOps.entries()],
      rejectedOps: [...this.#state.rejectedOps],
      checkpointSeq: seq,
    }
    const tmp = `${SNAPSHOT_FILE}.tmp`
    await fs.writeFile(tmp, JSON.stringify(payload), 'utf-8')
    await fs.rename(tmp, SNAPSHOT_FILE)
    // 快照原子生效后再截断 WAL；崩溃在这之前只会重放一遍已包含在快照里的信封，幂等无副作用。
    await fs.writeFile(WAL_FILE, '', 'utf-8')
  }
}

async function appendWal(entry: PersistedEnvelope) {
  await fs.appendFile(WAL_FILE, `${JSON.stringify(entry)}\n`, 'utf-8')
}

function deserializeState(saved: SerializedState): EngineState {
  const { appliedOps, rejectedOps, checkpointSeq, revision, version, phase, nodes, mappings, reviewItems, baselines, recentOps } = saved
  void checkpointSeq
  return {
    revision,
    version,
    phase,
    nodes,
    mappings,
    reviewItems,
    baselines,
    recentOps,
    appliedOps: new Map(appliedOps),
    rejectedOps: new Set(rejectedOps),
  }
}

function nowIso() {
  return new Date().toISOString()
}

// dev HMR 与单例测试下复用同一实例。
const globalRef = globalThis as unknown as { __curriculumVersionedStore?: VersionedStore }
export const versionedStore = globalRef.__curriculumVersionedStore ?? new VersionedStore()
if (!globalRef.__curriculumVersionedStore) globalRef.__curriculumVersionedStore = versionedStore
