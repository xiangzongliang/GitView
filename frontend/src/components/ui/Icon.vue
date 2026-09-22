<script setup lang="ts">
// Thin wrapper around @lucide/vue. The rest of the app references icons by
// short semantic names (e.g. "fetch", "stash") so swapping icon sets never
// touches consuming components.
import { computed, type Component } from "vue";
import {
	Archive,
	Check,
	Cherry,
	ChevronDown,
	ChevronRight,
	Cloud,
	CloudDownload,
	Copy,
	Download,
	ExternalLink,
	FilePlus,
	FileText,
	Folder,
	FolderGit2,
	GitBranch,
	GitCommitHorizontal,
	GitGraph,
	GitMerge,
	Info,
	Minus,
	Moon,
	Pencil,
	Plus,
	RefreshCw,
	RotateCcw,
	Search,
	Settings,
	Sun,
	Tag,
	Terminal,
	Trash,
	TriangleAlert,
	Undo2,
	Upload,
	X,
} from "@lucide/vue";

const props = withDefaults(defineProps<{ name: string; size?: number }>(), {
	size: 14,
});

const map: Record<string, Component> = {
	history: GitGraph,
	file: FileText,
	"file-plus": FilePlus,
	branch: GitBranch,
	merge: GitMerge,
	commit: GitCommitHorizontal,
	tag: Tag,
	cloud: Cloud,
	stash: Archive,
	fetch: CloudDownload,
	pull: Download,
	push: Upload,
	refresh: RefreshCw,
	search: Search,
	plus: Plus,
	minus: Minus,
	folder: Folder,
	check: Check,
	x: X,
	"chevron-down": ChevronDown,
	"chevron-right": ChevronRight,
	trash: Trash,
	copy: Copy,
	alert: TriangleAlert,
	reset: RotateCcw,
	cherry: Cherry,
	revert: Undo2,
	edit: Pencil,
	external: ExternalLink,
	terminal: Terminal,
	info: Info,
	repo: FolderGit2,
	settings: Settings,
	sun: Sun,
	moon: Moon,
};

const icon = computed<Component>(() => map[props.name] || Info);
</script>

<template>
	<component :is="icon" :size="size" :stroke-width="1.9" aria-hidden="true" />
</template>
