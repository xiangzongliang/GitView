<script setup lang="ts">
// Built-in terminal for the active repository. Commands run through
// GitService.RunCommand (/bin/sh in the repo directory); the working
// directory is tracked so `cd` persists between commands.
import { nextTick, onMounted, ref, watch } from 'vue'
import { useRepo } from '../../stores/repo'
import { useUI } from '../../stores/ui'
import { GitService, errMsg } from '../../api'
import Icon from '../ui/Icon.vue'

interface TermLine {
  kind: 'cmd' | 'out' | 'err' | 'sys'
  text: string
}

const MAX_LINES = 5000

const repo = useRepo()
const ui = useUI()

const lines = ref<TermLine[]>([])
const input = ref('')
const cwd = ref('')
const busy = ref(false)
const scroller = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)

const history: string[] = []
let histIdx = 0

function push(kind: TermLine['kind'], text: string) {
  for (const ln of text.split('\n')) lines.value.push({ kind, text: ln })
  if (lines.value.length > MAX_LINES) {
    lines.value.splice(0, lines.value.length - MAX_LINES)
  }
}

function prompt(): string {
  const p = cwd.value || repo.path
  if (!p) return ''
  const i = p.lastIndexOf('/')
  return i >= 0 && i < p.length - 1 ? p.slice(i + 1) : p
}

function resetSession() {
  cwd.value = repo.path
  lines.value = []
  if (repo.path) {
    push('sys', '终端会话 — ' + repo.path)
    push('sys', '回车执行命令；↑/↓ 浏览历史；clear 清屏。命令在当前仓库目录下运行。')
  }
}

watch(() => repo.path, resetSession)

// auto-focus the input whenever the panel becomes visible
watch(
  () => ui.terminalOpen,
  (open) => {
    if (open) focusInput()
  }
)

onMounted(() => {
  resetSession()
  focusInput()
})

function scrollBottom() {
  nextTick(() => {
    const el = scroller.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

function focusInput() {
  nextTick(() => inputEl.value?.focus())
}

async function execute() {
  const cmd = input.value.trim()
  if (!cmd || busy.value || !repo.path) return
  history.push(cmd)
  histIdx = history.length
  input.value = ''

  if (cmd === 'clear' || cmd === 'cls') {
    lines.value = []
    return
  }

  push('cmd', prompt() + ' ❯ ' + cmd)
  scrollBottom()
  busy.value = true
  const startPath = repo.path
  try {
    const res = await GitService.RunCommand(startPath, cwd.value, cmd)
    if (startPath !== repo.path) return // repo switched while running; discard
    if (res) {
      const out = (res.output || '').replace(/\n$/, '')
      if (out) push('out', out)
      if (res.newCwd) cwd.value = res.newCwd
      if (res.timeout) push('err', '命令超时（5 分钟），已终止')
      else if (res.exitCode !== 0) push('err', '退出码 ' + res.exitCode)
    }
  } catch (e) {
    push('err', errMsg(e))
  } finally {
    busy.value = false
    scrollBottom()
    focusInput()
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    execute()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (histIdx > 0) {
      histIdx--
      input.value = history[histIdx]
    }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (histIdx < history.length - 1) {
      histIdx++
      input.value = history[histIdx]
    } else {
      histIdx = history.length
      input.value = ''
    }
  } else if (e.key === 'l' && e.ctrlKey) {
    // ctrl+L clears, like most shells
    e.preventDefault()
    lines.value = []
  }
}

function lineClass(l: TermLine): string {
  return 'term-line ' + l.kind
}
</script>

<template>
  <div v-if="ui.terminalOpen" class="terminal-panel">
    <div class="term-head">
      <Icon name="terminal" :size="12" />
      <span class="term-title">终端</span>
      <span class="term-cwd mono" :title="cwd">{{ cwd }}</span>
      <div class="term-actions">
        <button class="btn-icon" title="清屏" @click="lines = []">
          <Icon name="trash" :size="12" />
        </button>
        <button class="btn-icon" title="关闭终端" @click="ui.toggleTerminal()">
          <Icon name="x" :size="12" />
        </button>
      </div>
    </div>

    <div ref="scroller" class="term-body mono" @click="focusInput">
      <div v-if="!repo.path" class="term-line sys">请先打开一个仓库</div>
      <div v-for="(l, i) in lines" :key="i" :class="lineClass(l)">{{ l.text || ' ' }}</div>
    </div>

    <div class="term-input-row" @click="focusInput">
      <span class="term-prompt mono">{{ prompt() }} ❯</span>
      <input
        ref="inputEl"
        v-model="input"
        class="term-input mono"
        type="text"
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
        placeholder="输入命令，回车执行…"
        :disabled="busy || !repo.path"
        @keydown="onKey"
      />
      <span v-if="busy" class="spinner" />
    </div>
  </div>
</template>

<style scoped>
.terminal-panel {
  flex: none;
  height: 240px;
  display: flex;
  flex-direction: column;
  background: #14161b;
  border-top: 1px solid var(--border-strong);
  min-height: 0;
}
.term-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 7px;
  height: 28px;
  padding: 0 8px 0 12px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
  color: var(--text-dim);
}
.term-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-faint);
  flex: none;
}
.term-cwd {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
  font-size: 11px;
  color: var(--text-faint);
}
.term-actions {
  flex: none;
  display: flex;
  gap: 2px;
}
.term-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 12px;
  font-size: 12px;
  line-height: 1.55;
  cursor: text;
}
.term-line {
  white-space: pre-wrap;
  word-break: break-all;
  user-select: text;
}
.term-line.cmd {
  color: var(--text-strong);
  margin-top: 4px;
}
.term-line.out {
  color: var(--text);
}
.term-line.err {
  color: var(--red);
}
.term-line.sys {
  color: var(--text-faint);
}
.term-input-row {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-top: 1px solid var(--border);
  cursor: text;
}
.term-prompt {
  flex: none;
  color: var(--green);
  font-size: 12px;
}
.term-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  padding: 0;
  font-size: 12px;
  color: var(--text-strong);
}
.term-input:focus {
  box-shadow: none;
}
.spinner {
  flex: none;
  width: 12px;
  height: 12px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
</style>
