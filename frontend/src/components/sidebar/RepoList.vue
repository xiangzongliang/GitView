<script setup lang="ts">
import { useRepos } from '../../stores/repos'
import { useUI } from '../../stores/ui'
import { pickDirectory } from '../../api'
import Icon from '../ui/Icon.vue'

const repos = useRepos()
const ui = useUI()

function openAddMenu(e: MouseEvent) {
  ui.openMenu(e.clientX, e.clientY, [
    { label: '打开本地仓库…', icon: 'folder', action: () => repos.pickAndOpen() },
    { label: '克隆远程仓库…', icon: 'cloud', action: () => ui.openDialog('clone') },
    { label: '初始化新仓库…', icon: 'plus', action: initRepo },
  ])
}

async function initRepo() {
  const dir = await pickDirectory('选择用于初始化 Git 仓库的目录')
  if (dir) await repos.initRepo(dir)
}

function repoMenu(e: MouseEvent, path: string) {
  e.preventDefault()
  const entry = repos.entries.find((r) => r.path === path)
  ui.openMenu(e.clientX, e.clientY, [
    {
      label: '在 Finder 中显示',
      icon: 'external',
      disabled: entry?.missing,
      action: () => repos.reveal(path),
    },
    {
      label: '从列表移除',
      icon: 'trash',
      danger: true,
      action: async () => {
        const ok = await ui.confirm({
          title: '移除仓库',
          message: '仅从 Git View 列表中移除，不会删除磁盘上的任何文件。\n\n' + (entry?.name || path),
          confirmLabel: '移除',
        })
        if (ok) await repos.remove(path)
      },
    },
  ])
}
</script>

<template>
  <div class="repo-list">
    <div class="sec-head">
      <span class="sec-title">仓库</span>
      <button class="btn-icon" title="添加仓库" @click="openAddMenu">
        <Icon name="plus" :size="13" />
      </button>
    </div>
    <div
      v-for="r in repos.entries"
      :key="r.path"
      class="repo-row"
      :class="{ active: r.path === repos.activePath, missing: r.missing }"
      :title="r.path"
      @click="!r.missing && repos.setActive(r.path)"
      @contextmenu="repoMenu($event, r.path)"
    >
      <Icon :name="r.missing ? 'alert' : 'repo'" :size="13" class="repo-icon" />
      <span class="repo-name">{{ r.name }}</span>
      <span v-if="r.missing" class="miss-badge">丢失</span>
    </div>
    <div v-if="repos.loaded && repos.entries.length === 0" class="repo-empty">
      还没有仓库，点击 “+” 添加
    </div>
  </div>
</template>

<style scoped>
.sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 8px 4px 12px;
  position: sticky;
  top: 0;
  background: var(--bg-sidebar);
  z-index: 1;
}
.sec-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-faint);
}
.repo-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 10px;
  margin: 0 6px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--text);
}
.repo-row:hover {
  background: var(--bg-hover);
}
.repo-row.active {
  background: var(--bg-selected);
  color: var(--text-strong);
}
.repo-row.missing {
  opacity: 0.55;
  cursor: default;
}
.repo-icon {
  flex: none;
  color: var(--text-dim);
}
.repo-row.active .repo-icon {
  color: var(--accent);
}
.repo-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
}
.miss-badge {
  flex: none;
  font-size: 10px;
  color: var(--red);
  border: 1px solid var(--red);
  border-radius: 7px;
  padding: 0 5px;
}
.repo-empty {
  padding: 6px 14px 10px;
  font-size: 11.5px;
  color: var(--text-faint);
}
</style>
