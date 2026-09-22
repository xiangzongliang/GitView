<script setup lang="ts">
import ModalDialog from '../ui/ModalDialog.vue'
import Icon from '../ui/Icon.vue'

const props = defineProps<{
  payload: {
    title?: string
    message?: string
    confirmLabel?: string
    danger?: boolean
    resolve?: (v: boolean) => void
  }
}>()
const emit = defineEmits<{ (e: 'close'): void }>()

let done = false
function finish(v: boolean) {
  if (done) return
  done = true
  if (props.payload?.resolve) props.payload.resolve(v)
  emit('close')
}
</script>

<template>
  <ModalDialog :title="payload?.title || '确认'" :width="420" @close="finish(false)">
    <div class="confirm-body">
      <Icon
        :name="payload?.danger ? 'alert' : 'info'"
        :size="18"
        :class="payload?.danger ? 'ic-danger' : 'ic-info'"
      />
      <p class="msg">{{ payload?.message }}</p>
    </div>
    <template #footer>
      <button class="btn" @click="finish(false)">取消</button>
      <button
        class="btn"
        :class="payload?.danger ? 'btn-danger' : 'btn-primary'"
        @click="finish(true)"
      >{{ payload?.confirmLabel || '确定' }}</button>
    </template>
  </ModalDialog>
</template>

<style scoped>
.confirm-body {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.ic-danger {
  color: var(--red);
  flex: none;
  margin-top: 1px;
}
.ic-info {
  color: var(--accent);
  flex: none;
  margin-top: 1px;
}
.msg {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
  cursor: text;
}
</style>
