<script setup lang="ts">
import { computed } from 'vue'
import { useRepo } from '../../stores/repo'
import type { SelectedFile } from '../../stores/repo'
import { useUI } from '../../stores/ui'
import type { MenuItem } from '../../stores/ui'
import type { FileStatus } from '../../api'
import { copyText } from '../../api'
import { STATUS_LABELS, statusColor, basename, dirname } from '../../utils/format'
import Icon from '../ui/Icon.vue'

const repo = useRepo()
const ui = useUI()

interface Group {
  key: SelectedFile['group']
  label: string
  files: FileStatus[]
  staged: boolean
  icon: string
}

const groups = computed<Group[]>(() => {
  const st = repo.status
  if (!st) return []
  const out: Group[] = []
  if ((st.conflicted || []).length)
    out.push({ key: 'conflicted', label: '冲突', files: st.conflicted || [], staged: false, icon: 'alert' })
  if ((st.staged || []).length)
    out.push({ key: 'staged', label: '已暂存', files: st.staged || [], staged: true, icon: 'check' })
  if ((st.unstaged || []).length)
    out.push({ key: 'unstaged', label: '未暂存', files: st.unstaged || [], staged: false, icon: 'edit' })
  if ((st.untracked || []).length)
    out.push({ key: 'untracked', label: '未跟踪', files: st.untracked || [], staged: false, icon: 'plus' })
  return out
})

function isSelected(f: FileStatus, g: Group): boolean {
  const sel = repo.selectedFile
  return !!sel && sel.path === f.path && sel.group === g.key
}

function select(f: FileStatus, g: Group) {
  repo.selectStatusFile({ path: f.path, staged: g.staged, group: g.key })
}

async function toggleStage(f: FileStatus, g: Group) {
  if (g.staged) await repo.unstagePaths([f.path])
  else await repo.stagePaths([f.path])
}

function groupStageAll(g: Group) {
  const paths = g.files.map((f) => f.path)
  if (g.staged) repo.unstagePaths(paths)
  else repo.stagePaths(paths)
}

function fileMenu(e: MouseEvent, f: FileStatus, g: Group) {
  e.preventDefault()
  e.stopPropagation()
  const items: MenuItem[] = [
    {
      label: g.staged ? '取消暂存' : '暂存',
      icon: g.staged ? 'minus' : 'plus',
      action: () => toggleStage(f, g),
    },
    { separator: true },
    { label: '复制路径', icon: 'copy', action: () => copyText(f.path) },
    {
      label: '丢弃更改…',
      icon: 'trash',
      danger: true,
      action: async () => {
        const ok = await ui.confirm({
          title: '丢弃更改',
          message:
            '确定丢弃 “' + f.path + '” 的更改吗？\n' +
            (g.key === 'untracked'
              ? '未跟踪文件将被直接删除。'
              : '文件将恢复到 ' + (g.staged ? 'HEAD 状态（同时取消暂存）' : 'HEAD 状态') + '。') +
            '\n此操作不可恢复。',
          confirmLabel: '丢弃',
          danger: true,
        })
        if (ok) await repo.discardPaths([f.path])
      },
    },
  ]
  ui.openMenu(e.clientX, e.clientY, items)
}
</script>

<template>
  <div class="file-list">
    <div v-if="!repo.status" class="empty-hint">
      <span class="spinner" />
      <span>加载状态…</span>
    </div>
    <div v-else-if="groups.length === 0" class="empty-hint">
      <Icon name="check" :size="20" />
      <span>工作区干净，没有待提交的更改</span>
    </div>
    <template v-else>
      <div v-for="g in groups" :key="g.key" class="group">
        <div class="group-head" :class="g.key">
          <Icon :name="g.icon" :size="12" />
          <span class="g-label">{{ g.label }}</span>
          <span class="g-count">{{ g.files.length }}</span>
          <button
            class="btn-icon g-action"
            :title="g.staged ? '全部取消暂存' : '全部暂存'"
            @click="groupStageAll(g)"
          >
            <Icon :name="g.staged ? 'minus' : 'plus'" :size="12" />
          </button>
        </div>
        <div
          v-for="f in g.files"
          :key="g.key + ':' + f.path"
          class="file-row"
          :class="{ selected: isSelected(f, g) }"
          :title="f.path"
          @click="select(f, g)"
          @dblclick="toggleStage(f, g)"
          @contextmenu="fileMenu($event, f, g)"
        >
          <span class="st" :style="{ color: statusColor(f.statusChar) }" :title="STATUS_LABELS[f.statusChar] || f.statusChar">
            {{ f.statusChar }}
          </span>
          <span class="fp">
            <template v-if="f.renamed && f.oldPath">
              <span class="dn old">{{ f.oldPath }}</span>
              <span class="arrow">→</span>
            </template>
            <span class="bn">{{ basename(f.path) }}</span>
            <span v-if="dirname(f.path)" class="dn">{{ dirname(f.path) }}</span>
          </span>
          <button
            class="btn-icon row-action"
            :title="g.staged ? '取消暂存' : '暂存'"
            @click.stop="toggleStage(f, g)"
          >
            <Icon :name="g.staged ? 'minus' : 'plus'" :size="12" />
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.file-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px 4px 10px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-faint);
  position: sticky;
  top: 0;
  background: var(--bg-panel);
  z-index: 1;
  border-bottom: 1px solid var(--border);
}
.group-head.conflicted {
  color: var(--orange);
}
.group-head.staged {
  color: var(--green);
}
.g-label {
  flex: 1;
}
.g-count {
  font-size: 10px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 7px;
  padding: 0 5px;
  line-height: 14px;
  color: var(--text-dim);
}
.g-action {
  width: 20px;
  height: 20px;
  flex: none;
}
.file-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 6px 4px 10px;
  cursor: pointer;
  font-size: 12px;
}
.file-row:hover {
  background: var(--bg-hover);
}
.file-row.selected {
  background: var(--bg-selected);
}
.st {
  flex: none;
  width: 13px;
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 11px;
  text-align: center;
}
.fp {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 5px;
  overflow: hidden;
  white-space: nowrap;
}
.bn {
  color: var(--text-strong);
  flex: none;
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dn {
  color: var(--text-faint);
  font-size: 10.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  min-width: 0;
}
.dn.old {
  flex: none;
  max-width: 35%;
}
.arrow {
  color: var(--text-faint);
  flex: none;
}
.row-action {
  width: 20px;
  height: 20px;
  flex: none;
  opacity: 0;
}
.file-row:hover .row-action,
.file-row.selected .row-action {
  opacity: 1;
}
.empty-hint {
  padding: 36px 14px;
  text-align: center;
}
.spinner {
  width: 15px;
  height: 15px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
</style>
