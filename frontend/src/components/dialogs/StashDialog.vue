<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRepo } from '../../stores/repo'
import { useUI } from '../../stores/ui'
import ModalDialog from '../ui/ModalDialog.vue'
import Icon from '../ui/Icon.vue'

const emit = defineEmits<{ (e: 'close'): void }>()

const repo = useRepo()
const ui = useUI()

const message = ref('')
const includeUntracked = ref(true)
const keepIndex = ref(false)

const canStash = computed(() => repo.dirtyCount > 0)

async function submit() {
  if (!canStash.value || ui.opRunning) return
  emit('close')
  await repo.stashSave({
    message: message.value.trim(),
    includeUntracked: includeUntracked.value,
    keepIndex: keepIndex.value,
  })
}
</script>

<template>
  <ModalDialog title="Stash 当前更改" :width="460" @close="emit('close')">
    <div v-if="!canStash" class="warn">
      <Icon name="info" :size="13" /> 工作区没有可 Stash 的更改。
    </div>
    <template v-else>
      <label class="field">
        <span class="label">描述（可选）</span>
        <input
          v-model="message"
          type="text"
          spellcheck="false"
          placeholder="WIP: 未完成的功能…"
          @keydown.enter.prevent="submit"
        />
      </label>
      <label class="check">
        <input v-model="includeUntracked" type="checkbox" />
        包含未跟踪文件（-u）
      </label>
      <label class="check">
        <input v-model="keepIndex" type="checkbox" />
        Stash 后保留已暂存内容（--keep-index）
      </label>
      <p class="hint">共 {{ repo.dirtyCount }} 个文件将被 Stash，之后可随时在侧边栏“Stash”中应用或弹出。</p>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">取消</button>
      <button class="btn btn-primary" :disabled="!canStash || !!ui.opRunning" @click="submit">
        <Icon name="stash" :size="13" /> Stash
      </button>
    </template>
  </ModalDialog>
</template>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.label {
  font-size: 11.5px;
  color: var(--text-dim);
}
input[type='text'] {
  width: 100%;
}
.check {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: var(--text);
  cursor: pointer;
  user-select: none;
}
.check input {
  accent-color: var(--accent);
  cursor: pointer;
}
.hint {
  font-size: 11px;
  color: var(--text-faint);
  line-height: 1.5;
}
.warn {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--text-dim);
  font-size: 12.5px;
}
</style>
