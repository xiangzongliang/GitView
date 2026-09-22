<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{ title: string; width?: number }>(), {
  width: 460,
})
const emit = defineEmits<{ (e: 'close'): void }>()

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    emit('close')
  }
}
onMounted(() => document.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => document.removeEventListener('keydown', onKey, true))
</script>

<template>
  <Teleport to="body">
    <div class="modal-overlay" @mousedown.self="emit('close')">
      <div class="modal-panel" :style="{ width: props.width + 'px' }">
        <div class="modal-head">
          <span class="modal-title">{{ title }}</span>
          <button class="btn-icon" title="关闭" @click="emit('close')">
            <Icon name="x" :size="14" />
          </button>
        </div>
        <div class="modal-body">
          <slot />
        </div>
        <div class="modal-foot">
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(10, 11, 14, 0.5);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 14vh;
}
.modal-panel {
  background: var(--bg-panel);
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.6);
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 16vh - 40px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.modal-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px 10px 16px;
  border-bottom: 1px solid var(--border);
}
.modal-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-strong);
}
.modal-body {
  padding: 14px 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.modal-foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
}
.modal-foot:empty {
  display: none;
}
</style>
