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

const name = ref('')
const message = ref('')
const push = ref(false)

const remotes = computed(() => repo.refs?.remotes || [])
const remote = ref(
  remotes.value.some((r) => r.name === 'origin') ? 'origin' : remotes.value[0]?.name || ''
)

const target = computed(() => props.payload?.target || '')
const targetLabel = computed(() => {
  const t = target.value
  if (!t) return 'HEAD' + (repo.status?.head ? '（' + shortHash(repo.status.head) + '）' : '')
  if (/^[0-9a-f]{7,40}$/i.test(t)) return '提交 ' + shortHash(t)
  return t
})

const valid = computed(() => !!name.value.trim())

async function submit() {
  if (!valid.value || ui.opRunning) return
  emit('close')
  await repo.createTag({
    name: name.value.trim(),
    target: target.value,
    message: message.value.trim(),
    push: push.value && !!remote.value,
    remote: push.value ? remote.value : '',
  })
}
</script>

<template>
  <ModalDialog title="新建标签" :width="480" @close="emit('close')">
    <p class="target">打在：<span class="mono target-val">{{ targetLabel }}</span></p>
    <label class="field">
      <span class="label">标签名 *</span>
      <input
        v-model="name"
        type="text"
        spellcheck="false"
        placeholder="v1.0.0"
        @keydown.enter.prevent="submit"
      />
    </label>
    <label class="field">
      <span class="label">附注信息（留空 = 轻量标签）</span>
      <input v-model="message" type="text" spellcheck="false" placeholder="发布 1.0.0 正式版" />
    </label>
    <label class="check">
      <input v-model="push" type="checkbox" :disabled="!remotes.length" />
      创建后推送到远程
      <select v-if="push && remotes.length" v-model="remote" class="remote-select" @click.stop>
        <option v-for="r in remotes" :key="r.name" :value="r.name">{{ r.name }}</option>
      </select>
    </label>
    <template #footer>
      <button class="btn" @click="emit('close')">取消</button>
      <button class="btn btn-primary" :disabled="!valid || !!ui.opRunning" @click="submit">
        <Icon name="tag" :size="13" /> 创建标签
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
.check input[type='checkbox'] {
  accent-color: var(--accent);
  cursor: pointer;
}
.remote-select {
  height: 24px;
  padding: 0 6px;
  font-size: 12px;
}
</style>
