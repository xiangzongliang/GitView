<script setup lang="ts">
import { useUI } from "../../stores/ui";
import ConfirmDialog from "./ConfirmDialog.vue";
import PromptDialog from "./PromptDialog.vue";
import CloneDialog from "./CloneDialog.vue";
import BranchDialog from "./BranchDialog.vue";
import MergeDialog from "./MergeDialog.vue";
import MergeIntoDialog from "./MergeIntoDialog.vue";
import PushDialog from "./PushDialog.vue";
import PullDialog from "./PullDialog.vue";
import StashDialog from "./StashDialog.vue";
import StashDetailDialog from "./StashDetailDialog.vue";
import ResetDialog from "./ResetDialog.vue";
import TagDialog from "./TagDialog.vue";
import RemoteDialog from "./RemoteDialog.vue";
import RemoteEditDialog from "./RemoteEditDialog.vue";
import AiCommitDialog from "../ai/AiCommitDialog.vue";

const ui = useUI();
</script>

<template>
	<template v-if="ui.dialog">
		<ConfirmDialog
			v-if="ui.dialog.kind === 'confirm'"
			:payload="ui.dialog.payload"
			@close="ui.closeDialog()"
		/>
		<PromptDialog
			v-else-if="ui.dialog.kind === 'prompt'"
			:payload="ui.dialog.payload"
			@close="ui.closeDialog()"
		/>
		<CloneDialog
			v-else-if="ui.dialog.kind === 'clone'"
			@close="ui.closeDialog()"
		/>
		<BranchDialog
			v-else-if="ui.dialog.kind === 'branch'"
			:payload="ui.dialog.payload"
			@close="ui.closeDialog()"
		/>
		<MergeDialog
			v-else-if="ui.dialog.kind === 'merge'"
			:payload="ui.dialog.payload"
			@close="ui.closeDialog()"
		/>
		<MergeIntoDialog
			v-else-if="ui.dialog.kind === 'merge-into'"
			:payload="ui.dialog.payload"
			@close="ui.closeDialog()"
		/>
		<PushDialog
			v-else-if="ui.dialog.kind === 'push'"
			@close="ui.closeDialog()"
		/>
		<PullDialog
			v-else-if="ui.dialog.kind === 'pull'"
			@close="ui.closeDialog()"
		/>
		<StashDialog
			v-else-if="ui.dialog.kind === 'stash'"
			@close="ui.closeDialog()"
		/>
		<StashDetailDialog
			v-else-if="ui.dialog.kind === 'stash-detail'"
			:payload="ui.dialog.payload"
			@close="ui.closeDialog()"
		/>
		<ResetDialog
			v-else-if="ui.dialog.kind === 'reset'"
			:payload="ui.dialog.payload"
			@close="ui.closeDialog()"
		/>
		<TagDialog
			v-else-if="ui.dialog.kind === 'tag'"
			:payload="ui.dialog.payload"
			@close="ui.closeDialog()"
		/>
		<RemoteDialog
			v-else-if="ui.dialog.kind === 'remote'"
			:payload="ui.dialog.payload"
			@close="ui.closeDialog()"
		/>
		<RemoteEditDialog
			v-else-if="ui.dialog.kind === 'remote-edit'"
			:payload="ui.dialog.payload"
			@close="ui.closeDialog()"
		/>
		<AiCommitDialog
			v-else-if="ui.dialog.kind === 'ai-commit'"
			:payload="ui.dialog.payload"
			@close="ui.closeDialog()"
		/>
	</template>
</template>
