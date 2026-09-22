<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRepo } from '../../stores/repo'
import { useUI } from '../../stores/ui'
import { shortHash } from '../../utils/format'
import ModalDialog from '../common/ModalDialog.vue'
import Icon from '../common/Icon.vue'

const props = defineProps<{ payload?: { target?: string } }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const repo = useRepo()
const ui = useUI()

const target = ref(props.payload?.target || 'HEAD')
const mode = ref<'soft' | 'mixed' | 'hard'>('mixed')

const targetLabel = computed(() => {
  const t = target.value
  if (/^[0-9a-f]{7,40}$/i.test(t)) return '提交 ' + shortHash(t)
  return t
})

const modes = [
  { value: 'soft', label: 'Soft', desc: '仅移动分支指针；暂存区与工作区都保留更改' },
  { value: 'mixed', label: 'Mixed（默认）', desc: '移动分支指针并重置暂存区；工作区保留更改' },
  { value: 'hard', label: 'Hard', desc: '移动分支指针并丢弃暂存区与工作区的全部更改' },
] as const

async function submit() {
  if (ui.opRunning) return
  if (mode.value === 'hard') {
    const ok = await ui.confirm({
      title: 'Hard Reset 确认',
      message:
        'Hard reset 到 ' + targetLabel.value + ' 将永久丢弃未提交的更改，此操作不可恢复。确定继续吗？',
      confirmLabel: '确定 Reset',
      danger: true,
    })
    if (!ok) return
  }
  emit('close')
  await repo.reset(target.value, mode.value)
}
</script>

<template>
  <ModalDialog title="Reset 当前分支" :width="500" @close="emit('close')">
    <p class="target">
      目标：<span class="mono target-val">{{ targetLabel }}</span>
      <span v-if="repo.status?.branch" class="dim">（当前分支 {{ repo.status.branch }}）</span>
    </p>
    <div class="modes">
      <label v-for="m in modes" :key="m.value" class="mode" :class="{ danger: m.value === 'hard' }">
        <input v-model="mode" type="radio" :value="m.value" />
        <span class="mode-body">
          <span class="mode-label">{{ m.label }}</span>
          <span class="mode-desc">{{ m.desc }}</span>
        </span>
      </label>
    </div>
    <p v-if="mode === 'hard'" class="hard-warn">
      <Icon name="alert" :size="13" />
      工作区中所有未提交的更改将被永久丢弃！
    </p>
    <template #footer>
      <button class="btn" @click="emit('close')">取消</button>
      <button
        class="btn"
        :class="mode === 'hard' ? 'btn-danger' : 'btn-primary'"
        :disabled="!!ui.opRunning"
        @click="submit"
      >
        <Icon name="reset" :size="13" /> Reset（{{ mode }}）
      </button>
    </template>
  </ModalDialog>
</template>

<style scoped>
.target {
  font-size: 12.5px;
  color: var(--text-dim);
}
.target-val {
  color: var(--text-strong);
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 6px;
}
.modes {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mode {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  user-select: none;
}
.mode:hover {
  border-color: var(--border-strong);
  background: var(--bg-hover);
}
.mode input {
  margin-top: 2px;
  accent-color: var(--accent);
  cursor: pointer;
}
.mode:has(input:checked) {
  border-color: var(--accent);
  background: rgba(76, 141, 255, 0.08);
}
.mode.danger:has(input:checked) {
  border-color: var(--red);
  background: rgba(240, 85, 77, 0.08);
}
.mode-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.mode-label {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-strong);
}
.mode-desc {
  font-size: 11.5px;
  color: var(--text-dim);
  line-height: 1.45;
}
.hard-warn {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--red);
  font-size: 12px;
}
</style>
