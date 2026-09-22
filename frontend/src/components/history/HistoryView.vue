<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRepo } from '../../stores/repo'
import { ROW_H, layoutGraph } from '../../utils/graph'
import CommitRow from './CommitRow.vue'
import CommitDetail from './CommitDetail.vue'
import Icon from '../common/Icon.vue'

const repo = useRepo()

const root = ref<HTMLElement | null>(null)
const scroller = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewH = ref(600)

const layout = computed(() => layoutGraph(repo.commits))
const rows = computed(() => layout.value.rows)
const laneCount = computed(() => layout.value.laneCount)
const total = computed(() => rows.value.length * ROW_H)

const OVERSCAN = 10
const start = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_H) - OVERSCAN))
const end = computed(() =>
  Math.min(rows.value.length, Math.ceil((scrollTop.value + viewH.value) / ROW_H) + OVERSCAN)
)
const slice = computed(() => rows.value.slice(start.value, end.value))

function onScroll(e: Event) {
  const el = e.target as HTMLElement
  scrollTop.value = el.scrollTop
  viewH.value = el.clientHeight
  if (el.scrollTop + el.clientHeight >= total.value - 400) repo.loadMoreLog()
}

// reset scroll position when the log query changes
watch(
  () => [repo.logRef, repo.logSearch],
  () => {
    scrollTop.value = 0
    if (scroller.value) scroller.value.scrollTop = 0
  }
)

// auto-select the newest commit when nothing is selected
watch(
  () => rows.value.length,
  (n) => {
    if (n > 0 && !repo.selectedHash && !repo.detailLoading) {
      repo.selectCommit(rows.value[0].commit.hash)
    }
  }
)

// ------------------------------------------------------------ keyboard nav
function onKey(e: KeyboardEvent) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  if (!rows.value.length) return
  e.preventDefault()
  const idx = rows.value.findIndex((r) => r.commit.hash === repo.selectedHash)
  let next: number
  if (idx < 0) next = 0
  else next = e.key === 'ArrowDown' ? Math.min(idx + 1, rows.value.length - 1) : Math.max(idx - 1, 0)
  repo.selectCommit(rows.value[next].commit.hash)
  const el = scroller.value
  if (el) {
    const top = next * ROW_H
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight
  }
}

// ------------------------------------------------------- resizable detail pane
const detailH = ref(0)
function clampDetail() {
  if (!root.value) return
  const h = root.value.clientHeight
  detailH.value = Math.min(Math.max(110, detailH.value), Math.max(110, h - 150))
}
function measure() {
  if (scroller.value) viewH.value = scroller.value.clientHeight
  if (root.value && detailH.value === 0) {
    detailH.value = Math.round(root.value.clientHeight * 0.45)
  }
  clampDetail()
}

function startDrag(e: MouseEvent) {
  e.preventDefault()
  const startY = e.clientY
  const startH = detailH.value
  const move = (ev: MouseEvent) => {
    detailH.value = startH + (startY - ev.clientY)
    clampDetail()
  }
  const up = () => {
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
    document.body.style.cursor = ''
  }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
  document.body.style.cursor = 'row-resize'
}

let ro: ResizeObserver | null = null
onMounted(() => {
  measure()
  ro = new ResizeObserver(measure)
  if (root.value) ro.observe(root.value)
  if (scroller.value) ro.observe(scroller.value)
})
onBeforeUnmount(() => {
  if (ro) ro.disconnect()
  ro = null
})

const unborn = computed(() => !!repo.status && !repo.status.head && !repo.logSearch)
</script>

<template>
  <div class="history" ref="root">
    <div class="list-pane">
      <div
        ref="scroller"
        class="scroller"
        tabindex="0"
        @scroll="onScroll"
        @keydown="onKey"
      >
        <div v-if="rows.length" class="inner" :style="{ height: total + 'px' }">
          <div class="slice" :style="{ transform: 'translateY(' + start * ROW_H + 'px)' }">
            <CommitRow
              v-for="r in slice"
              :key="r.commit.hash"
              :row="r"
              :lane-count="laneCount"
              :selected="r.commit.hash === repo.selectedHash"
            />
          </div>
        </div>

        <div v-if="repo.logLoading" class="load-more">
          <span class="spinner" />
          加载提交…
        </div>

        <div v-else-if="repo.statusError" class="empty-hint error">
          <Icon name="alert" :size="20" />
          <span>{{ repo.statusError }}</span>
          <button class="btn" @click="repo.refreshAll()">重试</button>
        </div>

        <div v-else-if="unborn" class="empty-hint">
          <Icon name="repo" :size="22" />
          <span>此仓库还没有任何提交</span>
          <button class="btn" @click="repo.setView('status')">
            <Icon name="file" :size="12" /> 去文件状态创建第一个提交
          </button>
        </div>

        <div v-else-if="!rows.length" class="empty-hint">
          <Icon name="search" :size="20" />
          <span>没有匹配的提交</span>
        </div>
      </div>
    </div>

    <div class="splitter" title="拖动调整高度" @mousedown="startDrag">
      <div class="splitter-grip" />
    </div>

    <div class="detail-pane" :style="{ height: detailH + 'px' }">
      <CommitDetail />
    </div>
  </div>
</template>

<style scoped>
.history {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-app);
}
.list-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.scroller {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  outline: none;
  display: flex;
  flex-direction: column;
}
.inner {
  position: relative;
  flex: none;
}
.slice {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
}
.load-more {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px;
  color: var(--text-faint);
  font-size: 11.5px;
}
.empty-hint {
  padding: 48px 20px;
}
.empty-hint.error {
  color: var(--red);
}
.splitter {
  flex: none;
  height: 7px;
  margin-top: -3px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: row-resize;
  z-index: 5;
  background: transparent;
}
.splitter-grip {
  width: 34px;
  height: 3px;
  border-radius: 2px;
  background: var(--border-strong);
}
.splitter:hover .splitter-grip {
  background: var(--accent);
}
.detail-pane {
  flex: none;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--border);
  overflow: hidden;
}
.spinner {
  width: 13px;
  height: 13px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
</style>
