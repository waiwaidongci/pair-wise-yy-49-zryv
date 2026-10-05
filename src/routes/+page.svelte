<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query'
  import { browser } from '$app/environment'
  import { curriculumStore, validateCurriculum } from '$lib/stores'
  import type { Snapshot } from '$lib/versioning/types'

  const query = createQuery<Snapshot>(() => ({
    queryKey: ['curriculum'],
    enabled: browser,
    queryFn: async () => {
      const response = await fetch('/api/curriculum')
      return response.json()
    },
  }))
  $effect(() => {
    if (query.data) curriculumStore.hydrate(query.data)
  })
  const issues = $derived(validateCurriculum($curriculumStore))
  const reviewOpen = $derived($curriculumStore.reviewItems.filter((item) => item.status === '待审阅').length)
  const reviewInvalid = $derived($curriculumStore.reviewItems.filter((item) => item.status === '已失效').length)
  const coverageRows = $derived($curriculumStore.coverage)
  const covered = $derived(coverageRows.filter((row) => row.covered).length)
</script>

<svelte:head><title>课程标准映射总览</title></svelte:head>

<section class="page">
  <div class="page-head">
    <div><p class="eyebrow">CURRICULUM REFORM / 课程改革</p><h1>专业课程图谱总览</h1><p class="muted">课程、毕业要求与审阅意见围绕服务端同一份版本工作，当前为 {$curriculumStore.revision}（v{$curriculumStore.version}）。</p></div>
    <div class="actions"><a class="btn-secondary" href="/matrix">查看图谱</a><a class="btn-primary" href="/review">处理审阅</a></div>
  </div>

  <div class="metric-grid">
    <article class="metric"><span>培养目标</span><strong>{$curriculumStore.nodes.filter((node) => node.type === '目标').length}</strong><small>{$curriculumStore.nodes.filter((node) => node.type === '毕业要求').length} 条毕业要求主链</small></article>
    <article class="metric"><span>毕业要求覆盖（服务端）</span><strong>{covered}/{coverageRows.length}</strong><small>{issues.filter((issue) => issue.severity === '错误').length} 个阻断缺口</small></article>
    <article class="metric"><span>课程映射</span><strong>{$curriculumStore.mappings.length}</strong><small>{$curriculumStore.phase === 'locked' ? '版本已锁定，映射冻结' : '草稿期映射可改'}</small></article>
    <article class="metric"><span>待审阅提交</span><strong style="color:#b45c34">{reviewOpen}</strong><small>{reviewInvalid} 项因引用变更失效重算</small></article>
  </div>

  <div class="overview-grid">
    <section class="panel">
      <div class="panel-head"><h3>培养目标达成链</h3>{#if $curriculumStore.serverTime}<span class="muted">服务端版本 {$curriculumStore.serverTime.slice(11,16)}</span>{/if}</div>
      <div class="chain">
        {#each $curriculumStore.nodes.filter((node) => node.type === '目标') as objective}
          <article>
            <div class="node-title">{objective.label.split('\n')[0]}</div>
            <p>{objective.label.split('\n')[1]}</p>
            <div class="arrow">↓</div>
            <div class="requirements">
              {#each $curriculumStore.mappings.filter((mapping) => mapping.source === objective.id) as mapping}
                {@const requirement = $curriculumStore.nodes.find((node) => node.id === mapping.target)}
                <div>{requirement?.label.split('\n')[0]} <span>权重 {Math.round(mapping.weight * 100)}%</span></div>
              {/each}
            </div>
          </article>
        {/each}
      </div>
    </section>

    <aside class="panel">
      <div class="panel-head"><h3>结构校验</h3><span class="muted">{issues.length} 项提示</span></div>
      <div class="issue-list">
        {#each issues as issue}
          <article class:error={issue.severity === '错误'}>
            <strong>{issue.title}</strong><p>{issue.detail}</p><span>{issue.severity}</span>
          </article>
        {/each}
        {#if issues.length === 0}<div class="empty">未发现覆盖缺口或重复映射。</div>{/if}
      </div>
      <div class="hint-box">
        <strong>版本工作区</strong>
        <p>{$curriculumStore.revision} · 草稿版本 v{$curriculumStore.version} · {$curriculumStore.phase === 'draft' ? '草稿修订中' : $curriculumStore.phase === 'locked' ? '已锁定' : '已发布'}；过期提交会被退回，发布基线保留快照可查。</p>
      </div>
    </aside>
  </div>
</section>

<style>
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .actions a { text-decoration: none; }
  .overview-grid { display: grid; grid-template-columns: minmax(0,1fr) 340px; gap: 14px; }
  .chain { padding: 16px; }
  .chain article { padding: 14px; border-left: 4px solid #347d7b; background: #f5f8f8; }
  .chain article + article { margin-top: 12px; }
  .node-title { font-weight: 800; }
  .chain p { margin: 5px 0 12px; color: #6f7d83; font-size: 12px; }
  .arrow { color: #6b8a8b; font-size: 18px; }
  .requirements { display: grid; gap: 7px; margin-top: 9px; }
  .requirements div { display: flex; justify-content: space-between; padding: 8px 10px; border: 1px solid #dce6e5; border-radius: 6px; background: white; font-size: 12px; }
  .requirements span { color: #537579; }
  .issue-list { padding: 8px 16px 16px; }
  .issue-list article { position: relative; padding: 12px 0; border-bottom: 1px solid #edf0f0; }
  .issue-list article strong { color: #9c6d25; font-size: 13px; }
  .issue-list article.error strong { color: #ac4433; }
  .issue-list p { margin: 5px 0 0; color: #68767d; font-size: 12px; line-height: 1.5; }
  .issue-list article > span { position: absolute; top: 12px; right: 0; color: #809096; font-size: 10px; }
  .empty { padding: 22px 0; color: #3d7b63; font-size: 12px; }
  .hint-box { margin: 0 16px 16px; padding: 13px; border-left: 3px solid #cd813a; background: #fff6e9; }
  .hint-box strong { font-size: 12px; }
  .hint-box p { margin: 6px 0 0; color: #6c6256; font-size: 11px; line-height: 1.5; }
  @media (max-width: 1000px) { .overview-grid { grid-template-columns: 1fr; } }
</style>
