<script setup lang="ts">
import { computed } from 'vue'
import { useRepos } from '../../stores/repos'
import { useRepo } from '../../stores/repo'
import RefChips from '../common/RefChips.vue'
import type { RefDecoration } from '../../api'

const repos = useRepos()
const repo = useRepo()

const name = computed(() => repos.active?.name || '')
const path = computed(() => repo.path || '')

const branchChips = computed<RefDecoration[] | null>(() => {
  const st = repo.status
  if (!st || !st.branch) return null
  return [
    {
      name: st.branch,
      type: 'branch',
      current: !st.detached,
    } as RefDecoration,
  ]
})
</script>

<template>
  <!-- 顶部 50px 为 macOS 原生拖拽区（InvisibleTitleBarHeight），此处仅做展示，不放可交互控件 -->
  <div class="titlebar">
    <!-- 绝对定位居中：不受左侧红绿灯 padding 影响，相对整个窗口居中 -->
    <div class="title-center">
      <span class="title-name">{{ name || 'Git View' }}</span>
      <span v-if="path" class="title-path" :title="path">{{ path }}</span>
      <span class="title-chips">
        <RefChips :refs="branchChips" />
      </span>
    </div>
  </div>
</template>

<style scoped>
.titlebar {
  position: relative;
}
.title-center {
  position: absolute;
  left: 50%;
  bottom: 6px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 64%;
  min-width: 0;
  white-space: nowrap;
}
.title-name {
  flex: none;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-strong);
  white-space: nowrap;
}
.title-path {
  font-size: 11px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.title-chips {
  display: inline-flex;
  gap: 5px;
  flex: none;
}
</style>
