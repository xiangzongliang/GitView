<script setup lang="ts">
import { computed } from 'vue'
import type { RefDecoration } from '../../api'
import { copyText } from '../../api'
import Icon from '../ui/Icon.vue'
import Tooltip from '../ui/Tooltip.vue'

const props = withDefaults(
  defineProps<{
    refs: RefDecoration[] | null | undefined
    head?: boolean
    /** render at most N chips, collapsing the rest into a "+N" chip (0 = no limit) */
    max?: number
  }>(),
  { max: 0 }
)

const list = computed(() => props.refs || [])
const shown = computed(() => (props.max > 0 ? list.value.slice(0, props.max) : list.value))
const rest = computed(() => (props.max > 0 ? list.value.slice(props.max) : []))
const restTitle = computed(() => rest.value.map((r) => r.name).join('\n'))

function chipClass(r: RefDecoration): string {
  if (r.type === 'tag') return 'chip chip-tag'
  if (r.type === 'remote') return 'chip chip-remote'
  return r.current ? 'chip chip-current' : 'chip chip-branch'
}
function chipIcon(r: RefDecoration): string {
  return r.type === 'tag' ? 'tag' : r.type === 'remote' ? 'cloud' : 'branch'
}

/** 点击 chip 直接复制分支 / 标签名 */
function copyName(r: RefDecoration) {
  void copyText(r.name)
}
</script>

<template>
  <span v-if="head" class="chip chip-head">
    <Icon class="chip-icon" name="commit" :size="10" />
    HEAD
  </span>
  <Tooltip
    v-for="(r, i) in shown"
    :key="i"
    class="chip-tip"
    :text="r.name"
    :delay="250"
  >
    <span
      :class="chipClass(r)"
      class="chip-copy"
      @click.stop="copyName(r)"
      @dblclick.stop
    >
      <Icon class="chip-icon" :name="chipIcon(r)" :size="10" />
      <span class="chip-name">{{ r.name }}</span>
    </span>
  </Tooltip>
  <Tooltip v-if="rest.length" class="chip-tip" :text="restTitle" :delay="250">
    <span class="chip chip-more">+{{ rest.length }}</span>
  </Tooltip>
</template>
