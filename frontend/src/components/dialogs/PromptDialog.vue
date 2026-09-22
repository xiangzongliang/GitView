<script setup lang="ts">
import { ref, onMounted } from 'vue'
import ModalDialog from '../ui/ModalDialog.vue'

const props = defineProps<{
  payload: {
    title?: string
    label?: string
    value?: string
    placeholder?: string
    resolve?: (v: string) => void
  }
}>()
const emit = defineEmits<{ (e: 'close'): void }>()

const value = ref(props.payload?.value || '')
const input = ref<HTMLInputElement | null>(null)
onMounted(() => {
  input.value?.focus()
  input.value?.select()
})

let done = false
function finish(v: string | null) {
  if (done) return
  done = true
  if (props.payload?.resolve) props.payload.resolve(v ?? '')
  emit('close')
}
function submit() {
  const v = value.value.trim()
  if (!v) return
  finish(v)
}
</script>

<template>
  <ModalDialog :title="payload?.title || '输入'" :width="420" @close="finish(null)">
    <label class="field">
      <span v-if="payload?.label" class="label">{{ payload.label }}</span>
      <input
        ref="input"
        v-model="value"
        type="text"
        spellcheck="false"
        :placeholder="payload?.placeholder || ''"
        @keydown.enter.prevent="submit"
      />
    </label>
    <template #footer>
      <button class="btn" @click="finish(null)">取消</button>
      <button class="btn btn-primary" :disabled="!value.trim()" @click="submit">确定</button>
    </template>
  </ModalDialog>
</template>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.label {
  font-size: 12px;
  color: var(--text-dim);
}
input {
  width: 100%;
}
</style>
