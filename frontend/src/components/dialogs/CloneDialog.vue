<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRepos } from '../../stores/repos'
import { useUI } from '../../stores/ui'
import { pickDirectory } from '../../api'
import ModalDialog from '../common/ModalDialog.vue'
import Icon from '../common/Icon.vue'

const repos = useRepos()
const ui = useUI()
const emit = defineEmits<{ (e: 'close'): void }>()

const url = ref('')
const parent = ref('')
const name = ref('')
const branch = ref('')
const nameTouched = ref(false)

watch(url, (v) => {
  if (nameTouched.value) return
  const base = v
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split('/')
    .pop()
  name.value = /^[\w.-]+$/.test(base || '') ? base || '' : ''
})

const valid = computed(() => !!url.value.trim())

async function browse() {
  const dir = await pickDirectory('选择克隆目标父目录')
  if (dir) parent.value = dir
}

async function submit() {
  if (!valid.value || ui.opRunning) return
  const entry = await repos.clone({
    url: url.value.trim(),
    parent: parent.value.trim(),
    name: name.value.trim(),
    branch: branch.value.trim(),
  })
  if (entry) emit('close')
}
</script>

<template>
  <ModalDialog title="克隆远程仓库" :width="520" @close="emit('close')">
    <label class="field">
      <span class="label">仓库 URL *</span>
      <input
        v-model="url"
        type="text"
        spellcheck="false"
        placeholder="https://github.com/user/repo.git 或 git@host:user/repo.git"
        @keydown.enter.prevent="submit"
      />
    </label>
    <label class="field">
      <span class="label">目标父目录（留空 = 用户主目录）</span>
      <div class="with-btn">
        <input v-model="parent" type="text" spellcheck="false" placeholder="~/Code" />
        <button class="btn" type="button" @click="browse">
          <Icon name="folder" :size="12" /> 浏览…
        </button>
      </div>
    </label>
    <div class="row2">
      <label class="field">
        <span class="label">目录名（留空 = 从 URL 推导）</span>
        <input
          v-model="name"
          type="text"
          spellcheck="false"
          placeholder="repo"
          @input="nameTouched = true"
        />
      </label>
      <label class="field">
        <span class="label">分支（留空 = 远程默认）</span>
        <input v-model="branch" type="text" spellcheck="false" placeholder="main" />
      </label>
    </div>
    <p class="note">
      <Icon name="info" :size="12" />
      克隆通过系统 git 执行；HTTPS 凭据由系统钥匙串 / git 凭据助手提供，SSH 需已配置好密钥。
    </p>
    <template #footer>
      <button class="btn" @click="emit('close')">取消</button>
      <button class="btn btn-primary" :disabled="!valid || !!ui.opRunning" @click="submit">
        <Icon name="cloud" :size="13" /> 开始克隆
      </button>
    </template>
  </ModalDialog>
</template>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.label {
  font-size: 11.5px;
  color: var(--text-dim);
}
.with-btn {
  display: flex;
  gap: 6px;
}
.with-btn input {
  flex: 1;
  min-width: 0;
}
.with-btn .btn {
  flex: none;
}
.row2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
input {
  width: 100%;
}
.note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-faint);
}
.note svg {
  flex: none;
  margin-top: 1px;
}
</style>
