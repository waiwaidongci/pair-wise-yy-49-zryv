<script lang="ts">
  import { enhance } from '$app/forms'
  import type { ActionData } from './$types'
  import { curriculumStore } from '$lib/stores'

  let { form }: { form: ActionData } = $props()
  let selectedCourse = $state('C-308')
  let query = $state('')
  let newLabel = $state('')
  let nodeOpId = $state(curriculumStore.newOpId())
  let actionMessage = $state<string | null>(null)
  const types = ['课程', '单元', '教学活动', '考核'] as const
  const visible = $derived($curriculumStore.nodes.filter((node) => types.includes(node.type as typeof types[number]) && `${node.label}${node.id}`.includes(query)))
  const selected = $derived(visible.find((node) => node.id === selectedCourse) ?? visible[0])
  $effect(() => {
    if (selected) newLabel = selected.label.split('\n')[0]
  })
  const affectedReviews = $derived(
    selected ? $curriculumStore.reviewItems.filter((item) => item.courseId === selected.id && (item.status === '待审阅' || item.status === '已失效')) : [],
  )
</script>

<svelte:head><title>课程、单元与考核</title></svelte:head>

<section class="page">
  <div class="page-head">
    <div><p class="eyebrow">COURSE STRUCTURE / 课程结构</p><h1>课程、单元、教学与考核</h1><p class="muted">课程内容修订受版本管控：保存后引用该课程的未完成审阅失效、锁定基线标记重算；当前草稿 v{$curriculumStore.version}。</p></div>
    <span class="phase-tag">{$curriculumStore.phase === 'draft' ? '草稿可改' : $curriculumStore.phase === 'locked' ? '已锁定 · 需先退回修订' : '已发布'}</span>
  </div>

  {#if form?.success}
    <div class="notice success">课程修订已落地（{form.opId}）{form.duplicate ? '，重复编号只认第一次。' : '，相关审阅已按新版本失效重算。'}</div>
  {/if}
  {#if form?.stale}<div class="notice error">版本过期：{form.reason}</div>{/if}
  {#if form?.errors || form?.rejected}<div class="notice error">{form.rejected ?? Object.values(form.errors ?? {}).flat().join('；')}</div>{/if}
  {#if actionMessage}<div class="notice error">{actionMessage}</div>{/if}

  <div class="course-layout">
    <section class="panel">
      <div class="panel-head"><h3>课程图谱节点</h3><input bind:value={query} placeholder="搜索课程、单元或考核" style="max-width:240px" /></div>
      <div class="node-list">
        {#each visible as node}
          <button class:active={selected?.id === node.id} onclick={() => (selectedCourse = node.id)}>
            <span class={`type type-${node.type}`}>{node.type}</span>
            <strong>{node.label.split('\n')[0]}</strong>
            <small>{node.id}</small>
          </button>
        {/each}
      </div>
    </section>

    <section class="panel detail-panel">
      {#if selected}
        <div class="panel-head"><h3>{selected.label.split('\n')[0]}</h3><span class="muted">{selected.id} · {selected.type}</span></div>
        <div class="detail-body">
          <form method="POST" action="?/updateNode" class="form-grid" use:enhance={() => {
            actionMessage = null
            return async ({ result, update }) => {
              const snapshot = (result as { data?: { snapshot?: unknown } }).data?.snapshot
              if (snapshot) curriculumStore.hydrate(snapshot as Parameters<typeof curriculumStore.hydrate>[0])
              if (result.type === 'failure') {
                const data = result.data as { reason?: string; rejected?: string }
                actionMessage = data.reason ?? data.rejected ?? '保存失败'
              } else {
                nodeOpId = curriculumStore.newOpId()
              }
              await update({ reset: false })
            }
          }}>
            <input type="hidden" name="opId" value={nodeOpId} />
            <input type="hidden" name="baseVersion" value={$curriculumStore.version} />
            <input type="hidden" name="id" value={selected.id} />
            {#if selected.type === '课程'}
              <label>节点名称<input name="label" bind:value={newLabel} /></label>
              <label>所属学期<select><option>2026 秋季</option><option>2027 春季</option></select></label>
              <label>课程负责人<input value="顾明 / 副教授" /></label>
              <label>节点类型<select value={selected.type} disabled><option>{selected.type}</option></select></label>
              <div class="form-actions">
                <button class="btn-primary" type="submit" disabled={$curriculumStore.phase !== 'draft'}>{$curriculumStore.phase === 'draft' ? '保存课程修订（带草稿版本）' : '当前阶段不可改'}</button>
                <small class="form-meta">编号 {nodeOpId.slice(0, 13)}… · v{$curriculumStore.version}</small>
              </div>
            {:else}
              <label>节点名称<input value={selected.label.split('\n')[0]} disabled /></label>
              <label>节点类型<select value={selected.type} disabled><option>{selected.type}</option></select></label>
              <small class="form-meta">单元、教学活动与考核不在版本管控的修订通道内。</small>
            {/if}
          </form>
          <h3>直接映射</h3>
          <div class="mapping-list">
            {#each $curriculumStore.mappings.filter((mapping) => mapping.source === selected.id || mapping.target === selected.id) as mapping}
              {@const source = $curriculumStore.nodes.find((node) => node.id === mapping.source)}
              {@const target = $curriculumStore.nodes.find((node) => node.id === mapping.target)}
              <div><span>{source?.label.split('\n')[0]} → {target?.label.split('\n')[0]}</span><b>{mapping.relation}</b><small>权重 {Math.round(mapping.weight * 100)}%</small></div>
            {/each}
          </div>
          {#if selected.type === '课程'}
            <h3>引用本课程的审阅（变更后失效重算）</h3>
            <div class="review-refs">
              {#if affectedReviews.length === 0}<small class="muted">暂无待处理或已失效的引用审阅。</small>{/if}
              {#each affectedReviews as item}
                <div><strong>{item.id} → {item.requirementId}</strong><span class={item.status === '已失效' ? 'ref-invalid' : 'ref-pending'}>{item.status}</span></div>
              {/each}
            </div>
          {/if}
          <h3>教学活动与考核证据</h3>
          <div class="evidence-grid">
            <article><strong>课前任务</strong><p>阅读需求追踪矩阵案例，完成术语卡。</p><span>形成性评价 · 10%</span></article>
            <article><strong>迭代评审演练</strong><p>小组评审需求与测试覆盖，提交问题闭环记录。</p><span>表现性评价 · 25%</span></article>
            <article><strong>需求追踪矩阵</strong><p>覆盖 12 条需求，提交双向追踪和自动化测试报告。</p><span>终结性评价 · 40%</span></article>
          </div>
        </div>
      {/if}
    </section>
  </div>
</section>

<style>
  .phase-tag { padding: 6px 12px; border-radius: 6px; color: #2f6f58; background: #e7f4ec; font-size: 12px; }
  .notice { margin-bottom: 12px; padding: 12px 14px; border-left: 3px solid #3f8869; color: #27634d; background: #ebf6f0; font-size: 12px; }
  .notice.error { border-color: #bd4d35; color: #913c2b; background: #fff1ec; }
  .course-layout { display: grid; grid-template-columns: 330px minmax(0,1fr); gap: 14px; align-items: start; }
  .node-list { padding: 8px; }
  .node-list button { display: grid; width: 100%; grid-template-columns: 80px 1fr auto; align-items: center; gap: 8px; padding: 11px 10px; border: 0; border-radius: 7px; text-align: left; background: transparent; cursor: pointer; }
  .node-list button.active { background: #edf6f4; }
  .node-list strong { font-size: 12px; }
  .node-list small { color: #849096; }
  .type { padding: 3px 5px; border-radius: 4px; color: #3b6970; background: #e7eff0; text-align: center; font-size: 10px; }
  .type-课程 { color: #8b5529; background: #fff0df; }
  .detail-body { padding: 18px; }
  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .form-actions { display: flex; align-items: center; gap: 12px; grid-column: 1 / -1; }
  .form-meta { color: #8a969b; font-size: 10px; }
  .detail-body h3 { margin: 24px 0 10px; font-size: 14px; }
  .mapping-list { display: grid; gap: 7px; }
  .mapping-list div { display: grid; grid-template-columns: 1fr 80px 100px; gap: 10px; padding: 10px; border: 1px solid #e0e6e6; border-radius: 7px; font-size: 12px; }
  .mapping-list b { color: #2d7375; }
  .mapping-list small { color: #79868c; }
  .review-refs { display: grid; gap: 6px; }
  .review-refs div { display: flex; justify-content: space-between; padding: 8px 10px; border: 1px solid #e0e6e6; border-radius: 7px; font-size: 12px; }
  .review-refs span { padding: 2px 7px; border-radius: 5px; font-size: 10px; }
  .ref-pending { color: #9b5a25; background: #fff0de; }
  .ref-invalid { color: #a94331; background: #ffebe6; }
  .evidence-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 10px; }
  .evidence-grid article { padding: 12px; border-top: 3px solid #377d7a; background: #f6f8f7; }
  .evidence-grid p { margin: 6px 0 9px; color: #66757b; font-size: 11px; line-height: 1.55; }
  .evidence-grid span { color: #946436; font-size: 10px; font-weight: 700; }
  @media (max-width: 1000px) { .course-layout { grid-template-columns: 1fr; } .evidence-grid { grid-template-columns: 1fr; } }
</style>
