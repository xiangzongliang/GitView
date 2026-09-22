<script setup lang="ts">
// Custom dropdown select. Native <select> cannot control its popup height or
// style grouped options; this renders a teleported, height-capped, scrollable
// panel instead. Supports option groups via SelectGroup entries.
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import Icon from "./Icon.vue";
import type { SelectEntry, SelectGroup, SelectOption } from "./types";

const props = withDefaults(
	defineProps<{
		modelValue: string;
		options: SelectEntry[];
		placeholder?: string;
		/** max height of the dropdown panel in px */
		maxHeight?: number;
		disabled?: boolean;
		/** min width of the dropdown panel in px (defaults to trigger width) */
		minWidth?: number;
		/** optional Icon name shown in the trigger before the label */
		icon?: string;
		/** stretch trigger to fill the parent width (dialogs) */
		fullWidth?: boolean;
	}>(),
	{
		placeholder: "请选择…",
		maxHeight: 320,
		disabled: false,
		minWidth: 0,
		fullWidth: false,
	},
);
const emit = defineEmits<{ (e: "update:modelValue", v: string): void }>();

type Row =
	{ kind: "group"; label: string } | { kind: "option"; option: SelectOption };

const rows = computed<Row[]>(() => {
	const out: Row[] = [];
	for (const e of props.options) {
		if (isGroup(e)) {
			if (!e.options.length) continue;
			out.push({ kind: "group", label: e.group });
			for (const o of e.options) out.push({ kind: "option", option: o });
		} else {
			out.push({ kind: "option", option: e });
		}
	}
	return out;
});

function isGroup(e: SelectEntry): e is SelectGroup {
	return "group" in e;
}

const allOptions = computed<SelectOption[]>(() =>
	rows.value.flatMap((r) => (r.kind === "option" ? [r.option] : [])),
);

const selected = computed<SelectOption | undefined>(() =>
	allOptions.value.find((o) => o.value === props.modelValue),
);
const label = computed(() => selected.value?.label || props.placeholder);

const open = ref(false);
const trigger = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const panelStyle = ref<Record<string, string>>({});

function place() {
	const el = trigger.value;
	if (!el) return;
	const r = el.getBoundingClientRect();
	const style: Record<string, string> = {
		minWidth: Math.max(r.width, props.minWidth) + "px",
		maxHeight: props.maxHeight + "px",
	};
	// prefer below; flip above when there is not enough room
	const spaceBelow = window.innerHeight - r.bottom - 8;
	const estHeight = Math.min(props.maxHeight, rows.value.length * 26 + 12);
	if (spaceBelow < Math.min(estHeight, 120) && r.top > spaceBelow) {
		style.bottom = window.innerHeight - r.top + 4 + "px";
	} else {
		style.top = r.bottom + 4 + "px";
		style.maxHeight =
			Math.min(props.maxHeight, Math.max(80, spaceBelow)) + "px";
	}
	style.left =
		Math.max(
			8,
			Math.min(
				r.left,
				window.innerWidth - (parseInt(style.minWidth) || r.width) - 8,
			),
		) + "px";
	panelStyle.value = style;
}

function toggle() {
	if (props.disabled) return;
	open.value = !open.value;
	if (open.value) {
		nextTick(() => {
			place();
			// scroll the selected option into view
			const sel = panel.value?.querySelector<HTMLElement>(
				'[data-selected="true"]',
			);
			if (sel) sel.scrollIntoView({ block: "nearest" });
		});
		document.addEventListener("mousedown", onDocDown, true);
		document.addEventListener("keydown", onKey, true);
		window.addEventListener("resize", place);
	} else {
		detach();
	}
}

function close() {
	open.value = false;
	detach();
}

function detach() {
	document.removeEventListener("mousedown", onDocDown, true);
	document.removeEventListener("keydown", onKey, true);
	window.removeEventListener("resize", place);
}

function onDocDown(e: MouseEvent) {
	const t = e.target as Node;
	if (trigger.value?.contains(t) || panel.value?.contains(t)) return;
	close();
}

function onKey(e: KeyboardEvent) {
	if (e.key === "Escape") {
		e.stopPropagation();
		close();
	}
}

function choose(o: SelectOption) {
	if (o.disabled) return;
	emit("update:modelValue", o.value);
	close();
}

onBeforeUnmount(detach);
</script>

<template>
	<div class="selectmenu" :class="{ disabled, full: fullWidth }">
		<button
			ref="trigger"
			type="button"
			class="sm-trigger"
			:class="{ open }"
			:disabled="disabled"
			@click="toggle"
		>
			<Icon v-if="icon" :name="icon" :size="12" class="sm-trigger-icon" />
			<span class="sm-label" :class="{ placeholder: !selected }">{{
				label
			}}</span>
			<Icon name="chevron-down" :size="12" class="sm-arrow" />
		</button>

		<Teleport to="body">
			<div
				v-if="open"
				ref="panel"
				class="sm-panel"
				:style="panelStyle"
				role="listbox"
			>
				<template v-for="(row, i) in rows" :key="i">
					<div v-if="row.kind === 'group'" class="sm-group">
						{{ row.label }}
					</div>
					<div
						v-else
						class="sm-option"
						:class="{ disabled: row.option.disabled }"
						:data-selected="
							row.option.value === modelValue ? 'true' : undefined
						"
						role="option"
						:aria-selected="row.option.value === modelValue"
						@click="choose(row.option)"
					>
						<Icon
							v-if="row.option.icon"
							:name="row.option.icon"
							:size="12"
							class="sm-opt-icon"
						/>
						<span class="sm-opt-label">{{ row.option.label }}</span>
						<Icon
							v-if="row.option.value === modelValue"
							name="check"
							:size="12"
							class="sm-check"
						/>
					</div>
				</template>
				<div v-if="!rows.length" class="sm-empty">无可用选项</div>
			</div>
		</Teleport>
	</div>
</template>

<style scoped>
.selectmenu {
	display: inline-flex;
	min-width: 0;
}
.selectmenu.full {
	display: flex;
	width: 100%;
}
.selectmenu.full .sm-trigger {
	width: 100%;
}
.sm-trigger {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	height: 26px;
	max-width: 100%;
	min-width: 0;
	padding: 0 7px;
	border: 1px solid var(--border-strong);
	border-radius: var(--radius);
	background: var(--bg-input);
	color: var(--text-strong);
	font-size: 12px;
	cursor: pointer;
	outline: none;
}
.sm-trigger:hover:not(:disabled) {
	border-color: var(--accent);
}
.sm-trigger.open {
	border-color: var(--accent);
	box-shadow: 0 0 0 2px var(--accent-soft);
}
.sm-trigger-icon {
	flex: none;
	color: var(--text-faint);
}
.sm-label {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.sm-label.placeholder {
	color: var(--text-faint);
}
.sm-arrow {
	flex: none;
	color: var(--text-faint);
}
.sm-panel {
	position: fixed;
	z-index: 1500;
	overflow-y: auto;
	padding: 4px;
	background: var(--bg-panel-2);
	border: 1px solid var(--border-strong);
	border-radius: 8px;
	box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
}
.sm-group {
	padding: 5px 8px 3px;
	font-size: 10.5px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.05em;
	color: var(--text-faint);
	white-space: nowrap;
}
.sm-option {
	display: flex;
	align-items: center;
	gap: 6px;
	height: 26px;
	padding: 0 8px;
	border-radius: 5px;
	font-size: 12px;
	color: var(--text);
	cursor: pointer;
	white-space: nowrap;
}
.sm-option:hover {
	background: var(--bg-hover);
	color: var(--text-strong);
}
.sm-option[data-selected="true"] {
	color: var(--accent);
}
.sm-option.disabled {
	opacity: 0.45;
	cursor: default;
}
.sm-option.disabled:hover {
	background: transparent;
}
.sm-opt-icon {
	flex: none;
	color: var(--text-faint);
}
.sm-opt-label {
	overflow: hidden;
	text-overflow: ellipsis;
	max-width: 320px;
}
.sm-check {
	flex: none;
	margin-left: auto;
	color: var(--accent);
}
.sm-empty {
	padding: 8px 10px;
	font-size: 11.5px;
	color: var(--text-faint);
	text-align: center;
}
</style>
