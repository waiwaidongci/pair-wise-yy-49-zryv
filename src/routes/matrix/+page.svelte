<script lang="ts">
  import { curriculumStore, validateCurriculum, StaleVersionError, CommitRejectedError } from '$lib/stores'
  import type { Mapping } from '$lib/versioning/types'

  let dragging = $state<string | null>(null)
  let offset = $state({ x: 0, y: 0 })
  let selectedNode = $state('C-308')
  let source = $state('GR-03')
  let target = $state('C-308')
  let relation = $state<Mapping['relation']>('支撑')
  let weight = $state(1)
  let query = $state('')
  let actionError = $state<string | null>(null)
  let actionInfo = $state<string | null>(null)
  const issues = $derived(validateCurriculum($curriculumStore))
  const visibleIds = $derived(new Set($curriculumStore.nodes.filter((node) => !query || node.label.includes(query) || node.id.includes(query)).map((node) => node.id)))
  const selected = $derived($curriculumStore.nodes.find((item) => item.id === selectedNode))
  const locked = $derived($curriculumStore.phase === 'locked')
  const published = $derived($curriculumStore.phase === 'published')
  const activeBaseline = $derived([...$curriculumStore.baselines].reverse().find((baseline) => baseline.kind === 'locked' && !baseline.supersededAt))
  const baselines = $derived([...$curriculumStore.baselines].reverse())

  function startDrag(event: MouseEvent, id: string) {
    const node = $curriculumStore.nodes.find((item) => item.id === id)
    if (!node) return
    const svg = (event.currentTarget as SVGElement).ownerSVGElement
    const rect = svg?.getBoundingClientRect()
    if (!rect) return
    dragging = id
    offset = { x: ((event.clientX - rect.left) / rect.width) * 1200 - node.x, y: ((event.clientY - rect.top) / rect.height) * 520 - node.y }
  }

  function drag(event: MouseEvent) {
    if (!dragging) return
    const svg = event.currentTarget as SVGSVGElement
    const rect = svg.getBoundingClientRect()
    const x = Math.max(50, Math.min(1140, ((event.clientX - rect.left) / rect.width) * 1200 - offset.x))
    const y = Math.max(30, Math.min(480, ((event.clientY - rect.top) / rect.height) * 520 - offset.y))
    curriculumStore.patchLocal((view) => ({ ...view, nodes: view.nodes.map((node) => (node.id === dragging ? { ...node, x, y } : node)) }))
  }

  function clearMessages() {
    actionError = null
    actionInfo = null
  }

  async function run(label: string, task: () => Promise<unknown>) {
    clearMessages()
    try {
      await task()
    } catch (error) {
      if (error instanceof StaleVersionError) actionError = `${label}失败：${error.message}`
      else if (error instanceof CommitRejectedError) actionError = `${label}被拒绝：${error.message}`
      else actionError = `${label}失败，请重试`
    }
  }

  async function addMapping() {
    if (source === target) return
    await run('新增连边', () => curriculumStore.commit({ type: 'addMapping', source, target, relation, weight }))
  }

  async function lockVersion() {
    await run('锁定版本', async () => {
      await curriculumStore.commit({ type: 'lock' })
      actionInfo = `已锁定并留存 v${$curriculumStore.version} 的覆盖快照；锁定后映射冻结。`
    })
  }

  async function publishVersion() {
    await run('发布版本', async () => {
      await curriculumStore.commit({ type: 'publish' })
      actionInfo = `已发布基线 {$curriculumStore.revision}，快照与覆盖结论永久可查。`
    })
  }

  async function reopenFromLock() {
    await run('退回修订', async () => {
      await curriculumStore.commit({ type: 'reopenFromLock', reason: '锁定后退回修订，锁定基线失效并重算' })
      actionInfo = '已退回草稿，原锁定基线标记失效，引用变更将触发重算。'
    })
  }

  async function openRevision() {
    await run('开启新一轮修订', async () => {
      await curriculumStore.commit({ type: 'openRevision' })
      actionInfo = `已开启新一轮修订 {$curriculumStore.revision}。`
    })
  }

  function exportMap() {
    const blob = new Blob([JSON.stringify($curriculumStore, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `课程地图-${$curriculumStore.revision}-v${$curriculumStore.version}.json`
    link.click()
    URL.revokeObjectURL(url)
  }
</script>

<svelte:head><title>映射图谱与覆盖矩阵</title></svelte:head>

<section class="page">
  <div class="page-head">
    <div><p class="eyebrow">CURRICULUM MAP / 映射图谱</p><h1>有向关系与覆盖矩阵</h1><p class="muted">拖动节点调整布局（纯视觉）；连边写入带草稿版本，版本锁定后映射冻结，发布留存基线快照。</p></div>
    <div class="actions">
      <button class="btn-secondary" onclick={exportMap}>导出课程地图</button>
      {#if $curriculumStore.phase === 'draft'}
        <button class="btn-primary" onclick={lockVersion}>锁定当前版本 v{$curriculumStore.version}</button>
      {:else if locked}
        <button class="btn-primary" onclick={publishVersion}>发布已锁定版本</button>
        <button class="btn-danger" onclick={reopenFromLock}>退回修订（基线失效重算）</button>
      {:else}
        <button class="btn-primary" onclick={openRevision}>开启新一轮修订</button>
      {/if}
    </div>
  </div>

  {#if actionError}<div class="notice error">{actionError}</div>{/if}
  {#if actionInfo}<div class="notice success">{actionInfo}</div>{/if}
  {#if $curriculumStore.notice}<div class="notice {$curriculumStore.syncState === 'stale' ? 'error' : ''}">{$curriculumStore.notice}</div>{/if}

  <div class="matrix-toolbar panel" class:frozen={locked}>
    <input bind:value={query} placeholder="搜索目标、课程或单元" />
    <select bind:value={source} disabled={locked}>{#each $curriculumStore.nodes as node}<option value={node.id}>{node.id} · {node.label.split('\n')[0]}</option>{/each}</select>
    <span>→</span>
    <select bind:value={target} disabled={locked}>{#each $curriculumStore.nodes as node}<option value={node.id}>{node.id} · {node.label.split('\n')[0]}</option>{/each}</select>
    <select bind:value={relation} disabled={locked}><option>支撑</option><option>前置</option><option>教学</option><option>考核</option></select>
    <input bind:value={weight} type="number" min="0" max="1" step="0.1" disabled={locked} />
    <button class="btn-primary" onclick={addMapping} disabled={locked}>{locked ? '版本已锁定 · 映射冻结' : '新增连边'}</button>
    <span class="muted">{issues.length} 项校验提示 · 草稿 v{$curriculumStore.version}</span>
  </div>

  <div class="matrix-layout">
    <section class="panel graph-panel">
      <div class="panel-head"><h3>课程改革有向图</h3><span class="muted">拖拽节点重排 · 点击查看详情</span></div>
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <svg role="application" aria-label="课程映射拖拽图" viewBox="0 0 1200 520" onmousemove={drag} onmouseup={() => (dragging = null)} onmouseleave={() => (dragging = null)}>
        <defs><marker id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="#688086" /></marker></defs>
        {#each $curriculumStore.mappings as mapping (mapping.id)}
          {@const from = $curriculumStore.nodes.find((node) => node.id === mapping.source)}
          {@const to = $curriculumStore.nodes.find((node) => node.id === mapping.target)}
          {#if from && to && visibleIds.has(from.id) && visibleIds.has(to.id)}
            <line x1={from.x + 80} y1={from.y + 28} x2={to.x} y2={to.y + 28} class:relation={true} marker-end="url(#arrow)" />
            <text x={(from.x + to.x) / 2 + 80} y={(from.y + to.y) / 2 + 22} class="edge-label">{mapping.relation}</text>
          {/if}
        {/each}
        {#each $curriculumStore.nodes as node (node.id)}
          {#if visibleIds.has(node.id)}
            <g
              class:selected={selectedNode === node.id}
              class:coverage-gap={issues.some((issue) => issue.id === `coverage-${node.id}`)}
              onmousedown={(event) => startDrag(event, node.id)}
              onclick={() => (selectedNode = node.id)}
              onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') selectedNode = node.id }}
              role="button"
              tabindex="0"
            >
              <rect x={node.x} y={node.y} width="160" height="58" rx="9" class={`node node-${node.type}`} />
              <text x={node.x + 80} y={node.y + 24} text-anchor="middle" class="node-label">{node.label.split('\n')[0]}</text>
              <text x={node.x + 80} y={node.y + 42} text-anchor="middle" class="node-id">{node.id} · {node.type}</text>
            </g>
          {/if}
        {/each}
      </svg>
    </section>

    <aside class="panel">
      <div class="panel-head"><h3>覆盖矩阵（服务端结论）</h3><span class="muted">Σ 权重</span></div>
      <div class="coverage-matrix">
        {#each $curriculumStore.coverage as row}
          {@const requirement = $curriculumStore.nodes.find((node) => node.id === row.requirementId)}
          <div class="matrix-row">
            <strong title={requirement?.label}>{row.requirementId}</strong>
            {#each $curriculumStore.nodes.filter((node) => node.type === '课程') as courses}
              {@const cell = row.courses.find((item) => item.courseId === courses.id)}
              <span class:covered={!!cell} title={requirement?.label}>{cell ? Math.round(cell.weight * 100) : '—'}</span>
            {/each}
          </div>
        {/each}
      </div>
      <div class="legend"><span><i class="covered-dot"></i>已有映射</span><span><i class="gap-dot"></i>覆盖缺口</span></div>
      {#if activeBaseline}
        <div class="node-detail baseline-active">
          <strong>有效锁定基线 v{activeBaseline.version}</strong>
          <p>锁定于 {activeBaseline.createdAt.slice(0, 16).replace('T', ' ')}；若引用的课程 / 毕业要求变更，该基线会标记失效并按新数据重算。</p>
        </div>
      {/if}
      <div class="node-detail">
        {#if selected}
          <strong>{selected.label.split('\n')[0]}</strong><p>{selected.id} · {selected.type}</p>
        {/if}
      </div>
      <div class="baseline-list">
        <h4>基线快照（{baselines.length}）</h4>
        {#each baselines.slice(0, 5) as baseline}
          <div class="baseline-row">
            <b>{baseline.revision} · v{baseline.version}</b>
            <span class={baseline.kind === 'published' ? 'tag-published' : 'tag-locked'}>{baseline.kind === 'published' ? '已发布' : '锁定'}</span>
            {#if baseline.supersededAt}<span class="tag-superseded">已失效</span>{/if}
            <small>覆盖 {baseline.coverage.filter((row) => row.covered).length}/{baseline.coverage.length} · {baseline.reviewItems.length} 条审阅</small>
          </div>
        {/each}
        {#if baselines.length === 0}<small class="muted">尚无基线，锁定后生成第一份快照。</small>{/if}
      </div>
    </aside>
  </div>
</section>

<style>
  .actions { display: flex; gap: 8px; }
  .notice { margin-bottom: 12px; padding: 12px 14px; border-left: 3px solid #3f8869; color: #27634d; background: #ebf6f0; font-size: 12px; }
  .notice.error { border-color: #bd4d35; color: #913c2b; background: #fff1ec; }
  .matrix-toolbar { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; margin-bottom: 12px; padding: 12px; }
  .matrix-toolbar.frozen { background: #eef2f8; }
  .matrix-toolbar > input:first-child { max-width: 220px; }
  .matrix-toolbar select { max-width: 230px; }
  .matrix-layout { display: grid; grid-template-columns: minmax(0,1fr) 360px; gap: 14px; align-items: start; }
  svg { display: block; width: 100%; min-width: 900px; background: radial-gradient(circle,#dce2e2 1px,transparent 1px); background-size: 22px 22px; }
  .graph-panel { overflow: auto; }
  line { stroke: #688086; stroke-width: 1.8; opacity: .65; }
  .edge-label { fill: #60757b; font-size: 9px; }
  g { cursor: grab; }
  g.selected .node { stroke-width: 3; }
  g.coverage-gap .node { stroke: #c14932; stroke-dasharray: 7 4; }
  .node { fill: white; stroke: #3c7c7d; stroke-width: 1.5; }
  .node-目标 { fill: #edf7f4; stroke: #3d7e70; }
  .node-课程 { fill: #fff5e9; stroke: #bd7437; }
  .node-毕业要求 { fill: #edf3f6; stroke: #50758a; }
  .node-单元 { fill: #f5f1f8; stroke: #806a9d; }
  .node-label { fill: #263b42; font-size: 12px; font-weight: 700; pointer-events: none; }
  .node-id { fill: #75848a; font-size: 9px; pointer-events: none; }
  .coverage-matrix { padding: 14px; overflow-x: auto; }
  .matrix-row { display: grid; grid-template-columns: 70px repeat(3,50px); gap: 6px; align-items: center; min-width: 270px; margin-bottom: 8px; }
  .matrix-row strong { font-size: 11px; }
  .matrix-row span { display: grid; height: 32px; place-items: center; border-radius: 5px; color: #8b969b; background: #f1f3f3; font-size: 11px; }
  .matrix-row span.covered { color: #276a55; background: #e4f3eb; font-weight: 800; }
  .legend { display: flex; gap: 14px; padding: 0 14px 14px; color: #6e7c82; font-size: 10px; }
  .legend i { display: inline-block; width: 8px; height: 8px; margin-right: 4px; border-radius: 50%; }
  .covered-dot { background: #3f8c6b; }
  .gap-dot { background: #c14932; }
  .node-detail { margin: 0 14px 14px; padding: 13px; border-left: 3px solid #377c7b; background: #f3f7f6; }
  .node-detail.baseline-active { border-left-color: #335e9a; background: #eef3fa; }
  .node-detail strong { display: block; }
  .node-detail p { margin: 5px 0 0; color: #748188; font-size: 11px; }
  .baseline-list { margin: 0 14px 14px; padding: 12px; border: 1px solid #dbe3e3; border-radius: 8px; background: #f6f8f7; }
  .baseline-list h4 { margin-bottom: 8px; font-size: 12px; }
  .baseline-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 0; border-top: 1px dashed #d3dcdc; font-size: 11px; }
  .baseline-row small { flex-basis: 100%; color: #8a969b; }
  .baseline-row span { padding: 2px 6px; border-radius: 4px; font-size: 9px; }
  .tag-published { color: #2e7359; background: #e1f1e8; }
  .tag-locked { color: #335e9a; background: #e3ecf8; }
  .tag-superseded { color: #a94331; background: #fbe7e2; }
  @media (max-width: 1050px) { .matrix-layout { grid-template-columns: 1fr; } }
</style>
