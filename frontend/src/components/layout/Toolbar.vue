<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { useRepo } from '../../stores/repo'
import { useRepos } from '../../stores/repos'
import { useUI } from '../../stores/ui'
import Icon from '../common/Icon.vue'

const repo = useRepo()
const repos = useRepos()
const ui = useUI()

const enabled = computed(() => !!repos.activePath)
const busy = computed(() => !!ui.opRunning)

// ------------------------------------------------------------- search debounce
const search = ref(repo.logSearch)
let timer: ReturnType<typeof setTimeout> | null = null
watch(search, (v) => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => repo.setLogSearch(v), 400)
})
watch(
  () => repo.logSearch,
  (v) => {
    if (v !== search.value && !timer) search.value = v
  }
)
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

// ------------------------------------------------------------------ ref filter
const refOptions = computed(() => {
  const branches = (repo.refs?.branches || [])
    .filter((b) => !b.isRemote)
    .map((b) => ({ label: b.name, value: b.name }))
  const remotes = (repo.refs?.remotes || []).flatMap((r) =>
    (r.branches || []).map((b) => ({ label: b.name, value: b.name }))
  )
  const tags = (repo.refs?.tags || []).map((t) => ({
    label: t.name,
    value: 'refs/tags/' + t.name,
  }))
  return { branches, remotes, tags }
})
</script>

<template>
  <div class="toolbar">
    <!-- view tabs -->
    <div class="tabs">
      <button
        class="tab"
        :class="{ active: repo.view === 'history' }"
        :disabled="!enabled"
        @click="repo.setView('history')"
      >
        <Icon name="history" :size="13" />
        历史
      </button>
      <button
        class="tab"
        :class="{ active: repo.view === 'status' }"
        :disabled="!enabled"
        @click="repo.setView('status')"
      >
        <Icon name="file" :size="13" />
        文件状态
        <span v-if="repo.dirtyCount > 0" class="badge">{{ repo.dirtyCount }}</span>
      </button>
    </div>

    <div class="sep" />

    <!-- actions -->
    <button class="btn" :disabled="!enabled || busy" title="Fetch（所有远程，含 prune）" @click="repo.fetch('', true)">
      <Icon name="fetch" :size="13" /> Fetch
    </button>
    <button class="btn" :disabled="!enabled || busy" title="Pull…" @click="ui.openDialog('pull')">
      <Icon name="pull" :size="13" /> Pull
    </button>
    <button class="btn" :disabled="!enabled || busy" title="Push…" @click="ui.openDialog('push')">
      <Icon name="push" :size="13" /> Push
    </button>
    <button class="btn" :disabled="!enabled || busy" title="新建分支…" @click="ui.openDialog('branch')">
      <Icon name="branch" :size="13" /> 分支
    </button>
    <button class="btn" :disabled="!enabled || busy" title="合并…" @click="ui.openDialog('merge')">
      <Icon name="merge" :size="13" /> 合并
    </button>
    <button class="btn" :disabled="!enabled || busy" title="贮藏当前更改…" @click="ui.openDialog('stash')">
      <Icon name="stash" :size="13" /> Stash
    </button>

    <div class="spacer" />

    <!-- ref filter + search + refresh -->
    <select
      class="ref-select"
      :value="repo.logRef"
      :disabled="!enabled"
      title="历史过滤"
      @change="repo.setLogRef(($event.target as HTMLSelectElement).value)"
    >
      <option value="all">所有分支</option>
      <option value="">当前分支 (HEAD)</option>
      <optgroup v-if="refOptions.branches.length" label="本地分支">
        <option v-for="o in refOptions.branches" :key="o.value" :value="o.value">{{ o.label }}</option>
      </optgroup>
      <optgroup v-if="refOptions.remotes.length" label="远程分支">
        <option v-for="o in refOptions.remotes" :key="o.value" :value="o.value">{{ o.label }}</option>
      </optgroup>
      <optgroup v-if="refOptions.tags.length" label="标签">
        <option v-for="o in refOptions.tags" :key="o.value" :value="o.value">{{ o.label }}</option>
      </optgroup>
    </select>

    <div class="search-box">
      <Icon name="search" :size="12" class="search-icon" />
      <input
        v-model="search"
        type="text"
        placeholder="搜索提交信息…"
        :disabled="!enabled"
        spellcheck="false"
      />
      <button v-if="search" class="btn-icon search-clear" title="清除" @click="search = ''">
        <Icon name="x" :size="11" />
      </button>
    </div>

    <button
      class="btn-icon"
      :disabled="!enabled || busy"
      title="刷新"
      @click="repo.refreshAll()"
    >
      <Icon name="refresh" :size="14" :class="{ spin: busy }" />
    </button>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 2px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 2px;
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 10px;
  border-radius: 5px;
  font-size: 12px;
  color: var(--text-dim);
}
.tab:hover:not(:disabled) {
  color: var(--text-strong);
}
.tab.active {
  background: var(--bg-panel-2);
  color: var(--text-strong);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
}
.badge {
  min-width: 16px;
  height: 15px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-size: 10px;
  line-height: 15px;
  text-align: center;
}
.sep {
  width: 1px;
  height: 20px;
  background: var(--border-strong);
  flex: none;
}
.spacer {
  flex: 1;
}
.ref-select {
  height: 26px;
  max-width: 170px;
  padding: 0 6px;
}
.search-box {
  position: relative;
  display: flex;
  align-items: center;
  width: 190px;
}
.search-box input {
  width: 100%;
  height: 26px;
  padding: 0 26px 0 26px;
  font-size: 12px;
}
.search-icon {
  position: absolute;
  left: 8px;
  color: var(--text-faint);
  pointer-events: none;
}
.search-clear {
  position: absolute;
  right: 3px;
  width: 18px;
  height: 18px;
}
</style>
