<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRepo } from '../../stores/repo'
import { useUI } from '../../stores/ui'
import FileList from './FileList.vue'
import DiffViewer from '../common/DiffViewer.vue'
import Icon from '../common/Icon.vue'

const repo = useRepo()
const ui = useUI()

const ta = ref<HTMLTextAreaElement | null>(null)

const stagedCount = computed(() => repo.status?.staged?.length || 0)
const canCommit = computed(
  () => !ui.opRunning && (stagedCount.value > 0 || (repo.amend && !!repo.status?.head))
)
const merging = computed(() => !!repo.status?.merging)

function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    if (canCommit.value) repo.doCommit()
  }
}

// When switching to this view, focus the message box if empty.
watch(
  () => repo.view,
  (v) => {
    if (v === 'status' && ta.value) ta.value.focus()
  }
)
</script>

<template>
  <div class="status-view">
    <div class="left">
      <FileList />
      <div class="commit-form">
        <textarea
          ref="ta"
          v-model="repo.commitMessage"
          class="msg"
          rows="4"
          spellcheck="false"
          :placeholder="merging ? '合并提交信息（Ctrl+Enter 提交合并）' : '提交信息，第一行为标题…（Ctrl+Enter 提交）'"
          @keydown="onKeydown"
        />
        <div class="form-row">
          <label class="amend" title="修改最近一次提交（替换 HEAD）">
            <input v-model="repo.amend" type="checkbox" :disabled="!repo.status?.head" />
            Amend
          </label>
          <div class="spacer" />
          <button class="btn" :disabled="!repo.dirtyCount || !!ui.opRunning" title="暂存所有更改" @click="repo.stageAll()">
            <Icon name="plus" :size="12" /> 全部暂存
          </button>
          <button class="btn" :disabled="!stagedCount || !!ui.opRunning" title="取消暂存所有文件" @click="repo.unstageAll()">
            <Icon name="minus" :size="12" /> 全部取消
          </button>
          <button class="btn btn-primary commit-btn" :disabled="!canCommit" @click="repo.doCommit()">
            <Icon name="commit" :size="13" />
            {{ merging ? '提交合并' : repo.amend ? 'Amend 提交' : '提交' }}
          </button>
        </div>
      </div>
    </div>
    <DiffViewer
      :raw="repo.fileDiff"
      :loading="repo.fileDiffLoading"
      :filename="repo.selectedFile?.path"
      empty-text="选择左侧文件查看差异"
    />
  </div>
</template>

<style scoped>
.status-view {
  flex: 1;
  min-height: 0;
  display: flex;
}
.left {
  width: 340px;
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--border);
  background: var(--bg-panel);
}
.commit-form {
  flex: none;
  border-top: 1px solid var(--border);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  background: var(--bg-panel);
}
.msg {
  width: 100%;
  min-height: 64px;
  max-height: 160px;
  font-size: 12.5px;
}
.form-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.amend {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
  user-select: none;
}
.amend input {
  accent-color: var(--accent);
  cursor: pointer;
}
.spacer {
  flex: 1;
}
.commit-btn {
  min-width: 84px;
}
</style>
