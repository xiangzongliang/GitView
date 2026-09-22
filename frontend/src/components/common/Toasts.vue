<script setup lang="ts">
import { useUI } from '../../stores/ui'
import Icon from '../ui/Icon.vue'

const ui = useUI()
const icons: Record<string, string> = { success: 'check', error: 'alert', info: 'info' }
</script>

<template>
  <div class="toasts">
    <TransitionGroup name="toast">
      <div v-for="t in ui.toasts" :key="t.id" class="toast" :class="'toast-' + t.type">
        <Icon :name="icons[t.type]" :size="15" class="toast-icon" />
        <div class="toast-body">
          <div class="toast-title">{{ t.title }}</div>
          <pre v-if="t.detail" class="toast-detail">{{ t.detail }}</pre>
        </div>
        <button class="btn-icon toast-close" @click="ui.dismissToast(t.id)">
          <Icon name="x" :size="12" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  right: 16px;
  bottom: 36px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 460px;
}
.toast {
  display: flex;
  gap: 9px;
  align-items: flex-start;
  background: var(--bg-panel-2);
  border: 1px solid var(--border-strong);
  border-left: 3px solid var(--accent);
  border-radius: 8px;
  padding: 10px 12px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
}
.toast-success { border-left-color: var(--green); }
.toast-success .toast-icon { color: var(--green); }
.toast-error { border-left-color: var(--red); }
.toast-error .toast-icon { color: var(--red); }
.toast-info { border-left-color: var(--accent); }
.toast-info .toast-icon { color: var(--accent); }
.toast-icon { flex: none; margin-top: 1px; }
.toast-body { flex: 1; min-width: 0; }
.toast-title { color: var(--text-strong); font-weight: 500; }
.toast-detail {
  margin-top: 4px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 120px;
  overflow-y: auto;
  user-select: text;
}
.toast-close { flex: none; width: 18px; height: 18px; }
.toast-enter-active, .toast-leave-active { transition: all 0.25s ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateX(20px); }
</style>
