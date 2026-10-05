<script lang="ts">
  import { enhance } from '$app/forms'
  import type { ActionData } from './$types'
  import { curriculumStore } from '$lib/stores'

  let { form }: { form: ActionData } = $props()
  let selectedIds = $state<string[]>([])
  let reviewComments = $state<Record<string, string>>({})
  let reviewer = $state('院系审阅人')
  // 每个表单持有自己的操作编号；失败重试沿用同一编号，保证同一决定只认一次。
  let submitOpId = $state(curriculumStore.newOpId())
  let decisionOpIds = $state<Record<string, string>>({})
  let bulkOpId = $state(curriculumStore.newOpId())
  let lastError = $state<string | null>(null)

  const pending = $derived($curriculumStore.reviewItems.filter((item) => item.status === '待审阅'))
  const invalidated = $derived($curriculumStore.reviewItems.filter((item) => item.status === '已失效'))
  const courseNames = $derived($curriculumStore.nodes.filter((node) => node.type === '课程'))
  const requirements = $derived($curriculumStore.nodes.filter((node) => node.type === '毕业要求'))
  const lockedBaselines = $derived([...$curriculumStore.baselines].reverse())

  function courseName(id: string) {
    return courseNames.find((node) => node.id === id)?.label.split('\n')[0] ?? id
  }
  function requirementName(id: string) {
    return requirements.find((node) => node.id === id)?.label.split('\n')[0] ?? id
  }
  function opIdFor(reviewId: string) {
    if (!decisionOpIds[reviewId]) decisionOpIds[reviewId] = curriculumStore.newOpId()
    return decisionOpIds[reviewId]
  }

  function hydrateFromResult(result: { type: string; data?: Record<string, unknown> | null }) {
    if ((result.type === 'success' || result.type === 'failure') && result.data?.snapshot) {
      curriculumStore.hydrate(result.data.snapshot as Parameters<typeof curriculumStore.hydrate>[0])
    }
  }

  const formValues = $derived((form as { values?: Record<string, string> } | null)?.values)
</script>

<svelte:head><title>课程改革审阅</title></svelte:head>

<section class="page">
  <div class="page-head">
    <div>
      <p class="eyebrow">REFORM REVIEW / 改革审阅</p>
      <h1>修订提交与逐项审阅</h1>
      <p class="muted">
        全部写入带草稿版本号 v{$curriculumStore.version}（{$curriculumStore.revision} · {$curriculumStore.phase === 'draft' ? '草稿' : $curriculumStore.phase === 'locked' ? '已锁定' : '已发布'}）；过期提交退回不落地，重复决定只认一次。
      </p>
    </div>
    <div class="actions">
      <form method="POST" action="?/bulkApprove" use:enhance={() => {
        lastError = null
        return async ({ result, update }) => {
          hydrateFromResult(result)
          if (result.type === 'failure') {
            const data = result.data as { reason?: string; rejected?: string }
            lastError = data.reason ?? data.rejected ?? '批量附议失败'
          }
          if (result.type === 'success') {
            selectedIds = []
            bulkOpId = curriculumStore.newOpId()
          }
          await update({ reset: false })
        }
      }} style="display:contents">
        <input type="hidden" name="opId" value={bulkOpId} />
        <input type="hidden" name="baseVersion" value={$curriculumStore.version} />
        <input type="hidden" name="reviewer" value={reviewer} />
        {#each selectedIds as id}<input type="hidden" name="reviewIds" value={id} />{/each}
        <button class="btn-secondary" type="submit" disabled={selectedIds.length === 0}>批量附议 {selectedIds.length ? `(${selectedIds.length})` : ''}</button>
      </form>
      <button class="btn-secondary" onclick={() => window.print()}>打印审阅单</button>
    </div>
  </div>

  <div class="version-bar panel">
    <span>状态：<b class:phase-draft={$curriculumStore.phase === 'draft'} class:phase-locked={$curriculumStore.phase === 'locked'} class:phase-published={$curriculumStore.phase === 'published'}>{$curriculumStore.phase === 'draft' ? '草稿修订中（映射可改）' : $curriculumStore.phase === 'locked' ? '已锁定（映射冻结）' : '已发布（基线已固化）'}</b></span>
    <span>草稿版本号 <b>v{$curriculumStore.version}</b></span>
    <span>待审阅 <b>{pending.length}</b></span>
    {#if invalidated.length > 0}<span class="invalid-count">引用变更已失效 <b>{invalidated.length}</b></span>{/if}
    <input value={reviewer} oninput={(event) => (reviewer = event.currentTarget.value)} placeholder="审阅人" class="reviewer-input" />
  </div>

  {#if form?.success}
    <div class="notice success">
      操作已落地（{form.opId}）{form.duplicate ? '，该编号此前已送达，服务端只认第一次结果。' : '。'}
    </div>
  {/if}
  {#if form?.stale}
    <div class="notice error">版本冲突：{form.reason}</div>
  {:else if form?.errors || form?.rejected}
    <div class="notice error">表单未通过校验：{form.rejected ?? Object.values(form.errors ?? {}).flat().join('；')}</div>
  {/if}
  {#if lastError}
    <div class="notice error">{lastError}</div>
  {/if}
  {#if $curriculumStore.notice}
    <div class="notice {$curriculumStore.syncState === 'stale' ? 'error' : ''}">{$curriculumStore.notice}</div>
  {/if}

  <div class="review-layout">
    <section class="panel">
      <div class="panel-head"><h3>审阅队列</h3><span class="muted">{pending.length} 项待处理 · 已决定 {$curriculumStore.reviewItems.filter((item) => item.status === '已附议' || item.status === '已退回').length} 项</span></div>
      <div class="review-list">
        {#each $curriculumStore.reviewItems as item (item.id)}
          <article class:selected={selectedIds.includes(item.id)} class:invalid={item.status === '已失效'}>
            {#if item.status === '待审阅'}
              <div class="select"><input type="checkbox" checked={selectedIds.includes(item.id)} onchange={(event) => (selectedIds = event.currentTarget.checked ? [...selectedIds, item.id] : selectedIds.filter((id) => id !== item.id))} /></div>
            {:else}
              <div class="select"></div>
            {/if}
            <div class="review-main">
              <div class="review-title">
                <strong>{item.id} · {courseName(item.courseId)}</strong>
                <span class={item.status === '已附议' ? 'approved' : item.status === '已退回' ? 'returned' : item.status === '已失效' ? 'invalid' : ''}>{item.status}</span>
              </div>
              <p>{item.evidence}</p>
              {#if item.revisionNote}<p class="revision-note">修订说明：{item.revisionNote}</p>{/if}
              <small>
                对应 {requirementName(item.requirementId)} · {item.submitter} 提交 · 基于 v{item.baseVersion}
                {#if item.decidedBy} · {item.decidedBy} 于 {item.decidedAt?.slice(0, 16).replace('T', ' ')}{/if}
              </small>
              {#if item.status === '已失效'}
                <div class="decision invalid-decision">引用的课程 / 毕业要求已变更，本项失效需重算：{item.invalidatedReason}</div>
              {:else if item.status !== '待审阅'}
                <div class:returned={item.status === '已退回'} class="decision">审阅意见：{item.comment}</div>
              {:else}
                <form method="POST" action="?/decideReview" use:enhance={() => {
                  lastError = null
                  return async ({ result, update }) => {
                    hydrateFromResult(result)
                    if (result.type === 'failure') {
                      const data = result.data as { reason?: string; rejected?: string }
                      lastError = data.reason ?? data.rejected ?? '审阅失败，请重试'
                    } else {
                      decisionOpIds[item.id] = curriculumStore.newOpId()
                    }
                    await update({ reset: false })
                  }
                }}>
                  <div class="review-actions">
                    <input type="hidden" name="opId" value={opIdFor(item.id)} />
                    <input type="hidden" name="baseVersion" value={$curriculumStore.version} />
                    <input type="hidden" name="reviewId" value={item.id} />
                    <input type="hidden" name="reviewer" value={reviewer} />
                    <input name="comment" bind:value={reviewComments[item.id]} placeholder="填写附议或退回意见" />
                    <button class="btn-primary" name="decision" value="已附议" type="submit">附议</button>
                    <button class="btn-danger" name="decision" value="已退回" type="submit">退回补充</button>
                  </div>
                </form>
              {/if}
            </div>
          </article>
        {/each}
      </div>
    </section>

    <aside class="panel">
      <div class="panel-head"><h3>提交课程修订</h3><span class="muted">服务端校验 · 乐观锁</span></div>
      <form method="POST" action="?/submitRevision" use:enhance={() => {
        lastError = null
        return async ({ result, update, formElement }) => {
          hydrateFromResult(result)
          if (result.type === 'success') {
            formElement.reset()
            submitOpId = curriculumStore.newOpId()
          }
          await update({ reset: false })
        }
      }}>
        <input type="hidden" name="opId" value={submitOpId} />
        <input type="hidden" name="baseVersion" value={$curriculumStore.version} />
        <label>课程<select name="courseId" value={formValues?.courseId}>{#each courseNames as course}<option value={course.id}>{course.id} · {course.label.split('\n')[0]}</option>{/each}</select></label>
        <label>毕业要求<select name="requirementId" value={formValues?.requirementId}>{#each requirements as requirement}<option value={requirement.id}>{requirement.id} · {requirement.label.split('\n')[0]}</option>{/each}</select></label>
        <label>证据说明<textarea name="evidence" rows="4" placeholder="说明教学活动、考核记录与达成证据" value={formValues?.evidence ?? ''}></textarea></label>
        <label>修订说明<textarea name="revisionNote" rows="3" placeholder="说明本轮为什么调整映射或证据" value={formValues?.revisionNote ?? ''}></textarea></label>
        <label>提交人<input name="submitter" placeholder="课程负责人姓名" value={formValues?.submitter ?? ''} /></label>
        <button class="btn-primary" type="submit">提交院系审阅</button>
        <small class="form-meta">操作编号 {submitOpId.slice(0, 13)}… · 草稿版本 v{$curriculumStore.version}</small>
      </form>

      <div class="baseline-box">
        <h4>发布基线快照</h4>
        {#if lockedBaselines.length === 0}
          <p class="muted">尚无锁定 / 发布基线。在图谱页锁定后会留存不可变快照。</p>
        {/if}
        {#each lockedBaselines as baseline}
          <div class="baseline-item">
            <div class="baseline-head">
              <b>{baseline.revision} · v{baseline.version}</b>
              <span class={baseline.kind === 'published' ? 'tag-published' : 'tag-locked'}>{baseline.kind === 'published' ? '已发布' : '锁定'}</span>
              {#if baseline.supersededAt}<span class="tag-superseded">已失效重算</span>{/if}
            </div>
            <small>{baseline.kind === 'published' ? `发布于 ${baseline.publishedAt?.slice(0, 16).replace('T', ' ')}` : `锁定于 ${baseline.createdAt.slice(0, 16).replace('T', ' ')}`}</small>
            {#if baseline.supersededReason}<small class="superseded-reason">{baseline.supersededReason}</small>{/if}
            <div class="baseline-coverage">
              {#each baseline.coverage as row}
                <span><i class={row.covered ? 'dot-covered' : 'dot-gap'}></i>{row.requirementId} · {row.covered ? `${row.courseCount} 门 / Σ${row.totalWeight}` : '缺口'}</span>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    </aside>
  </div>
</section>

<style>
  .actions { display: flex; gap: 8px; }
  .version-bar { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; margin-bottom: 12px; padding: 10px 14px; font-size: 12px; color: #5f6e74; }
  .version-bar b { color: #2e4b52; }
  .phase-draft { color: #b0732c !important; }
  .phase-locked { color: #335e9a !important; }
  .phase-published { color: #2e7359 !important; }
  .invalid-count b { color: #a94331; }
  .reviewer-input { max-width: 130px; margin-left: auto; }
  .notice { margin-bottom: 12px; padding: 12px 14px; border-left: 3px solid #3f8869; color: #27634d; background: #ebf6f0; font-size: 12px; }
  .notice.error { border-color: #bd4d35; color: #913c2b; background: #fff1ec; }
  .review-layout { display: grid; grid-template-columns: minmax(0,1fr) 380px; gap: 14px; align-items: start; }
  .review-list { padding: 8px 16px 16px; }
  .review-list article { display: grid; grid-template-columns: 28px minmax(0,1fr); gap: 9px; padding: 14px 0; border-bottom: 1px solid #e8eded; }
  .review-list article.selected { background: #f4f8f7; }
  .review-list article.invalid { opacity: .82; }
  .review-title { display: flex; justify-content: space-between; gap: 10px; }
  .review-title span { padding: 3px 6px; border-radius: 5px; color: #9b5a25; background: #fff0de; font-size: 10px; }
  .review-title span.approved { color: #2e7359; background: #e7f4ec; }
  .review-title span.returned { color: #a94331; background: #ffebe6; }
  .review-title span.invalid { color: #8a6d3b; background: #f6efd9; }
  .review-main p { margin: 7px 0; color: #5f6e74; font-size: 12px; line-height: 1.55; }
  .revision-note { color: #8a6840 !important; }
  .review-main small { color: #839096; font-size: 10px; }
  .review-actions { display: flex; gap: 7px; margin-top: 10px; }
  .review-actions input { flex: 1; }
  .decision { margin-top: 9px; padding: 8px; color: #2f6f58; background: #edf7f1; font-size: 11px; }
  .decision.returned { color: #a54431; background: #fff0ec; }
  .invalid-decision { color: #8a6d3b; background: #faf3e0; }
  form { display: grid; gap: 12px; padding: 16px; }
  form button { margin-top: 3px; }
  .form-meta { color: #93a0a5; }
  .baseline-box { margin: 0 16px 16px; padding: 12px; border: 1px solid #dbe3e3; border-radius: 8px; background: #f6f8f7; }
  .baseline-box h4 { margin-bottom: 9px; font-size: 12px; }
  .baseline-item { padding: 9px 0; border-top: 1px dashed #d3dcdc; }
  .baseline-head { display: flex; align-items: center; gap: 6px; }
  .baseline-head span { padding: 2px 6px; border-radius: 4px; font-size: 9px; }
  .tag-published { color: #2e7359; background: #e1f1e8; }
  .tag-locked { color: #335e9a; background: #e3ecf8; }
  .tag-superseded { color: #a94331; background: #fbe7e2; }
  .baseline-item small { display: block; margin-top: 3px; color: #8a969b; }
  .superseded-reason { color: #a94331 !important; }
  .baseline-coverage { display: grid; gap: 3px; margin-top: 6px; }
  .baseline-coverage span { display: flex; align-items: center; gap: 5px; font-size: 10px; color: #5f6e74; }
  .dot-covered { width: 7px; height: 7px; border-radius: 50%; background: #3f8c6b; display: inline-block; }
  .dot-gap { width: 7px; height: 7px; border-radius: 50%; background: #c14932; display: inline-block; }
  @media (max-width: 1050px) { .review-layout { grid-template-columns: 1fr; } }
</style>
