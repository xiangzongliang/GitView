<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRepo } from '../../stores/repo'
import { useUI } from '../../stores/ui'
import { shortHash } from '../../utils/format'
import ModalDialog from '../common/ModalDialog.vue'
import Icon from '../common/Icon.vue'

const props = defineProps<{ payload?: { start?: string; name?: string } }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const repo = useRepo()
const ui = useUI()

const name = ref(props.payload?.name || '')
const start = ref(props.payload?.start || '')
const checkout = ref(true)

const isCommitStart = computed(() => /^[0-9a-f]{7,40}$/i.test(start.value))

const headLabel = computed(
  () => 'HEAD（当前提交' + (repo.status?.head ? ' ' + shortHash(repo.status.head) : '') + '）'
)

const localBranches = computed(() =>
  (repo.refs?.branches || []).filter((b) => !b.isRemote)
)
const remoteBranches = computed(() =>
  (repo.refs?.branches || []).filter((b) => b.isRemote)
)
const tags = computed(() => repo.refs?.tags || [])

const valid = computed(() => !!name.value.trim())

async function submit() {
  if (!valid.value || ui.opRunning) return
  await repo.createBranch({ name: name.value.trim(), start: start.value, checkout: checkout.value })
  emit('close')
}
</script>

<template>
  <ModalDialog title="新建分支" :width="480" @close="emit('close')">
    <label class="field">
      <span class="label">分支名 *</span>
      <input
        v-model="name"
        type="text"
        spellcheck="false"
        placeholder="feature/my-branch"
        @keydown.enter.prevent="submit"
      />
    </label>
    <label class="field">
      <span class="label">起点（留空 = HEAD）</span>
      <select v-model="start">
        <option value="">{{ headLabel }}</option>
        <option v-if="isCommitStart" :value="start">提交 {{ shortHash(start) }}</option>
        <optgroup v-if="localBranches.length" label="本地分支">
          <option v-for="b in localBranches" :key="b.name" :value="b.name">
            {{ b.name }}{{ b.isCurrent ? '（当前）' : '' }}
          </option>
        </optgroup>
        <optgroup v-if="remoteBranches.length" label="远程分支">
          <option v-for="b in remoteBranches" :key="b.name" :value="b.name">{{ b.name }}</option>
        </optgroup>
        <optgroup v-if="tags.length" label="标签">
          <option v-for="t in tags" :key="t.name" :value="'refs/tags/' + t.name">{{ t.name }}</option>
        </optgroup>
      </select>
    </label>
    <label class="check">
      <input v-model="checkout" type="checkbox" />
      创建后立即检出
    </label>
    <template #footer>
      <button class="btn" @click="emit('close')">取消</button>
      <button class="btn btn-primary" :disabled="!valid || !!ui.opRunning" @click="submit">
        <Icon name="branch" :size="13" /> 创建分支
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
input[type='text'],
select {
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
</style>
