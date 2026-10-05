<script lang="ts">
  import { enhance } from '$app/forms'
  import type { ActionData, PageData } from './$types'
  import { curriculumStore } from '$lib/stores'

  let { data, form }: { data: PageData; form: ActionData } = $props()
  let selectedIds = $state<string[]>([])
  let reviewComments = $state<Record<string, string>>({})
  let submitOpId = $state(crypto.randomUUID())
  let decisionOpIds = $state<Record<string, string>>({})

  const pending = $derived($curriculumStore.reviewItems.filter((item) => item.status === '待审阅'))
  const courseNames = $derived($curriculumStore.nodes.filter((node) => node.type === '课程'))
  const requirements = $derived($curriculumStore.nodes.filter((node) => node.type === '毕业要求'))
  const version = $derived($curriculumStore.version)

  $effect(() => {
    if (data?.curriculum) curriculumStore.hydrate(data.curriculum)
  })
  $effect(() => {
    if (form?.ok && form.view) {
      curriculumStore.hydrate(form.view)
      submitOpId = crypto.randomUUID()
    }
  })

  function opIdFor(itemId: string): string {
    if (!decisionOpIds[itemId]) decisionOpIds[itemId] = crypto.randomUUID()
    return decisionOpIds[itemId]
  }

  async function bulkApprove() {
    const targets = selectedIds
    selectedIds = []
    for (const id of targets) {
      const item = $curriculumStore.reviewItems.find((entry) => entry.id === id)
      if (!item || item.status !== '待审阅') continue
      const res = await fetch('/api/reviews/decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          opId: opIdFor(id),
          baseVersion: version,
          itemId: id,
          decision: '已附议',
          comment: reviewComments[id] || '批量附议：证据链完整。',
        }),
      })
      const body = await res.json()
      if (body.ok && body.view) {
        curriculumStore.hydrate(body.view)
      } else if (res.status === 409 && body.reason === 'stale_version') {
        alert('草稿版本已过期，请刷新页面后重新批量处理。')
        break
      }
    }
  }

  function reload() {
    location.reload()
  }
</script>

<svelte:head><title>课程改革审阅</title></svelte:head>

<section class="page">
  <div class="page-head">
    <div><p class="eyebrow">REFORM REVIEW / 改革审阅</p><h1>修订提交与逐项审阅</h1><p class="muted">课程、毕业要求与审阅意见围绕服务端同一份版本工作；退回必须补充证据要求。</p></div>
    <div class="actions">
      <button class="btn-secondary" disabled={selectedIds.length === 0} onclick={bulkApprove}>批量附议 {selectedIds.length ? `(${selectedIds.length})` : ''}</button>
      <button class="btn-secondary" onclick={() => window.print()}>打印审阅单</button>
    </div>
  </div>

  {#if form?.ok}
    <div class="notice success">
      {#if form.idempotent}该审阅决定已处理过，本次重复送达已忽略（幂等）。{:else}修订 {form.item?.id} 已提交，进入院系审阅队列。{/if}
    </div>
  {:else if form?.errors}
    <div class="notice error">
      表单未通过校验：{Object.values(form.errors).flat().join('；')}
      {#if form.reason === 'stale_version'}
        <div class="conflict">
          <strong>草稿版本已过期</strong>：服务端已更新到新版本，你基于旧版本的改动未落地。
          {#if form.uncommitted?.evidence}<p>退回的修订内容：{form.uncommitted.evidence}</p>{/if}
          <button class="btn-secondary" onclick={reload}>刷新到最新草稿</button>
        </div>
      {/if}
    </div>
  {/if}

  <div class="review-layout">
    <section class="panel">
      <div class="panel-head"><h3>审阅队列</h3><span class="muted">{pending.length} 项待处理 · 草稿 v{version}</span></div>
      <div class="review-list">
        {#each $curriculumStore.reviewItems as item}
          <article class:selected={selectedIds.includes(item.id)} class:invalidated={item.status === '已失效'}>
            <div class="select"><input type="checkbox" checked={selectedIds.includes(item.id)} onchange={(event) => selectedIds = event.currentTarget.checked ? [...selectedIds, item.id] : selectedIds.filter((id) => id !== item.id)} /></div>
            <div class="review-main">
              <div class="review-title">
                <strong>{item.id} · {courseNames.find((node) => node.id === item.courseId)?.label.split('\n')[0]}</strong>
                <span class:approved={item.status === '已附议'} class:returned={item.status === '已退回'} class:invalid={item.status === '已失效'}>{item.status}</span>
              </div>
              <p>{item.evidence}</p>
              <small>对应 {requirements.find((node) => node.id === item.requirementId)?.label.split('\n')[0]} · {item.submitter} 提交</small>
              {#if item.status === '待审阅'}
                <form method="POST" action="?/reviewDecision" use:enhance class="review-actions">
                  <input type="hidden" name="itemId" value={item.id} />
                  <input type="hidden" name="baseVersion" value={version} />
                  <input type="hidden" name="opId" value={opIdFor(item.id)} />
                  <input name="comment" bind:value={reviewComments[item.id]} placeholder="填写附议或退回意见" />
                  <button class="btn-primary" type="submit" name="decision" value="已附议">附议</button>
                  <button class="btn-danger" type="submit" name="decision" value="已退回">退回补充</button>
                </form>
              {:else if item.status === '已失效'}
                <div class="decision invalid">审阅已失效：{item.comment}</div>
              {:else}
                <div class:returned={item.status === '已退回'} class="decision">审阅意见：{item.comment}</div>
              {/if}
            </div>
          </article>
        {/each}
      </div>
    </section>

    <aside class="panel">
      <div class="panel-head"><h3>提交课程修订</h3><span class="muted">服务端版本校验</span></div>
      <form method="POST" action="?/submitRevision" use:enhance>
        <input type="hidden" name="baseVersion" value={version} />
        <input type="hidden" name="opId" value={submitOpId} />
        <label>课程<select name="courseId">{#each courseNames as course}<option value={course.id}>{course.id} · {course.label.split('\n')[0]}</option>{/each}</select></label>
        <label>毕业要求<select name="requirementId">{#each requirements as requirement}<option value={requirement.id}>{requirement.id} · {requirement.label.split('\n')[0]}</option>{/each}</select></label>
        <label>证据说明<textarea name="evidence" rows="4" placeholder="说明教学活动、考核记录与达成证据"></textarea></label>
        <label>修订说明<textarea name="revisionNote" rows="3" placeholder="说明本轮为什么调整映射或证据"></textarea></label>
        <label>提交人<input name="submitter" placeholder="课程负责人姓名" /></label>
        <button class="btn-primary" type="submit">提交院系审阅</button>
      </form>
      <div class="version-compare">
        <strong>围绕同一份版本</strong>
        <div><span>当前草稿</span><b>{$curriculumStore.revision} · v{version}</b></div>
        <div><span>已发布基线</span><b>{$curriculumStore.snapshots.length} 个</b></div>
        <div><span>覆盖结论</span><b class:returned={$curriculumStore.coverage.some((c) => !c.covered)}>{$curriculumStore.coverage.filter((c) => c.covered).length}/{$curriculumStore.coverage.length} 项覆盖</b></div>
      </div>
    </aside>
  </div>
</section>

<style>
  .actions { display: flex; gap: 8px; }
  .notice { margin-bottom: 12px; padding: 12px 14px; border-left: 3px solid #3f8869; color: #27634d; background: #ebf6f0; }
  .notice.error { border-color: #bd4d35; color: #913c2b; background: #fff1ec; }
  .conflict { margin-top: 10px; padding: 10px; border: 1px dashed #bd4d35; border-radius: 6px; background: #fff7f4; }
  .conflict p { margin: 6px 0; color: #7a3a2a; font-size: 12px; }
  .review-layout { display: grid; grid-template-columns: minmax(0,1fr) 360px; gap: 14px; align-items: start; }
  .review-list { padding: 8px 16px 16px; }
  .review-list article { display: grid; grid-template-columns: 28px minmax(0,1fr); gap: 9px; padding: 14px 0; border-bottom: 1px solid #e8eded; }
  .review-list article.selected { background: #f4f8f7; }
  .review-list article.invalidated { opacity: .72; }
  .review-title { display: flex; justify-content: space-between; gap: 10px; }
  .review-title span { padding: 3px 6px; border-radius: 5px; color: #9b5a25; background: #fff0de; font-size: 10px; }
  .review-title span.approved { color: #2e7359; background: #e7f4ec; }
  .review-title span.returned { color: #a94331; background: #ffebe6; }
  .review-title span.invalid { color: #6b7280; background: #eef1f1; }
  .review-main p { margin: 7px 0; color: #5f6e74; font-size: 12px; line-height: 1.55; }
  .review-main small { color: #839096; }
  .review-actions { display: flex; gap: 7px; margin-top: 10px; }
  .review-actions input { flex: 1; }
  .decision { margin-top: 9px; padding: 8px; color: #2f6f58; background: #edf7f1; font-size: 11px; }
  .decision.returned { color: #a54431; background: #fff0ec; }
  .decision.invalid { color: #6b7280; background: #f1f3f3; }
  form { display: grid; gap: 12px; padding: 16px; }
  form button { margin-top: 3px; }
  .review-actions { padding: 0; }
  .version-compare { margin: 0 16px 16px; padding: 12px; border: 1px solid #dbe3e3; border-radius: 8px; background: #f6f8f7; }
  .version-compare strong { display: block; margin-bottom: 9px; font-size: 12px; }
  .version-compare div { display: flex; justify-content: space-between; gap: 8px; padding: 5px 0; color: #66757b; font-size: 10px; }
  .version-compare b { color: #2e7359; }
  .version-compare b.returned { color: #aa4933; }
  @media (max-width: 1050px) { .review-layout { grid-template-columns: 1fr; } }
</style>
