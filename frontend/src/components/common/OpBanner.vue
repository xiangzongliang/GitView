<script setup lang="ts">
import { computed } from 'vue'
import { useRepo } from '../../stores/repo'
import Icon from '../ui/Icon.vue'

const repo = useRepo()

const op = computed(() => repo.opInProgress)

const text = computed(() => {
  switch (op.value) {
    case 'merge':
      return '合并进行中 — 解决冲突后提交，或中止合并'
    case 'rebase':
      return 'Rebase 进行中 — 解决冲突后可继续或跳过补丁，也可以中止'
    case 'cherry-pick':
      return 'Cherry-pick 进行中 — 解决冲突后可继续，或中止'
    case 'revert':
      return 'Revert 进行中 — 解决冲突后提交，或中止'
    default:
      return ''
  }
})

async function abort() {
  switch (op.value) {
    case 'merge':
      await repo.mergeAbort()
      break
    case 'rebase':
      await repo.rebaseAbort()
      break
    case 'cherry-pick':
      await repo.cherryPickAbort()
      break
    case 'revert':
      await repo.revertAbort()
      break
  }
}
</script>

<template>
  <div class="op-banner" :class="'op-' + op">
    <Icon name="alert" :size="14" class="op-icon" />
    <span class="op-text">{{ text }}</span>
    <div class="op-actions">
      <template v-if="op === 'rebase'">
        <button class="btn" @click="repo.rebaseContinue()">
          <Icon name="check" :size="12" /> 继续
        </button>
        <button class="btn" @click="repo.rebaseSkip()">跳过补丁</button>
      </template>
      <button v-else-if="op === 'cherry-pick'" class="btn" @click="repo.cherryPickContinue()">
        <Icon name="check" :size="12" /> 继续
      </button>
      <button v-else-if="op === 'merge' || op === 'revert'" class="btn" @click="repo.setView('status')">
        <Icon name="file" :size="12" /> 查看冲突
      </button>
      <button class="btn btn-danger" @click="abort()">中止</button>
    </div>
  </div>
</template>

<style scoped>
.op-banner {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 14px;
  font-size: 12.5px;
  border-bottom: 1px solid var(--border);
}
.op-merge {
  background: #3a2f18;
  color: var(--yellow);
}
.op-rebase {
  background: #21304a;
  color: var(--accent);
}
.op-cherry-pick {
  background: #33213a;
  color: var(--purple);
}
.op-revert {
  background: #3a2325;
  color: #ffa198;
}
.op-icon {
  flex: none;
}
.op-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.op-actions {
  flex: none;
  display: flex;
  gap: 6px;
}
.op-actions .btn {
  height: 22px;
  font-size: 11.5px;
}
</style>
