<script setup lang="ts">
import type { RefDecoration } from '../../api'
import Icon from './Icon.vue'

defineProps<{ refs: RefDecoration[] | null | undefined; head?: boolean }>()

function chipClass(r: RefDecoration): string {
  if (r.type === 'tag') return 'chip chip-tag'
  if (r.type === 'remote') return 'chip chip-remote'
  return r.current ? 'chip chip-current' : 'chip chip-branch'
}
function chipIcon(r: RefDecoration): string {
  return r.type === 'tag' ? 'tag' : r.type === 'remote' ? 'cloud' : 'branch'
}
</script>

<template>
  <span v-if="head" class="chip chip-head">
    <Icon name="commit" :size="10" />
    HEAD
  </span>
  <span v-for="(r, i) in refs || []" :key="i" :class="chipClass(r)">
    <Icon :name="chipIcon(r)" :size="10" />
    {{ r.name }}
  </span>
</template>
