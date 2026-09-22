<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRepos } from "../../stores/repos";
import { useUI } from "../../stores/ui";
import { pickDirectory, RepoService, errMsg } from "../../api";
import type { SelectOption } from "../ui/types";
import ModalDialog from "../ui/ModalDialog.vue";
import SelectMenu from "../ui/SelectMenu.vue";
import Icon from "../ui/Icon.vue";

const repos = useRepos();
const ui = useUI();
const emit = defineEmits<{ (e: "close"): void }>();

const url = ref("");
const parent = ref("");
const name = ref("");
const branch = ref("");
const nameTouched = ref(false);

// 认证（可选）
const username = ref("");
const password = ref("");
const authOpen = ref(false);
const hasCreds = computed(() => !!(username.value.trim() || password.value));

// 远程分支拉取
const branchOptions = ref<SelectOption[]>([]);
const loadingBranches = ref(false);
const branchError = ref("");
const lastFetchedKey = ref("");
let fetchSeq = 0;
let debounceTimer: number | undefined;

watch(url, (v) => {
	if (nameTouched.value) return;
	const base = v
		.trim()
		.replace(/\/+$/, "")
		.replace(/\.git$/, "")
		.split("/")
		.pop();
	name.value = /^[\w.-]+$/.test(base || "") ? base || "" : "";

	// URL 变化后，旧远程的分支列表不再适用
	const t = v.trim();
	if (t !== lastFetchedKey.value) {
		branch.value = "";
		branchOptions.value = [];
		branchError.value = "";
	}

	if (debounceTimer) window.clearTimeout(debounceTimer);
	// trim 后非空且像 URL（含 "://" 或 ":"）才拉取
	if (t && t.includes(":")) {
		debounceTimer = window.setTimeout(fetchBranches, 600);
	}
});

onBeforeUnmount(() => {
	if (debounceTimer) window.clearTimeout(debounceTimer);
});

function looksLikeUrl(t: string): boolean {
	return !!t && t.includes(":");
}

const AUTH_ERR_RE =
	/auth|401|403|could not read|terminal prompt|身份|权限|credential/i;

function isAuthError(msg: string): boolean {
	return AUTH_ERR_RE.test(msg);
}

async function fetchBranches() {
	const u = url.value.trim();
	if (!looksLikeUrl(u)) return;
	const seq = ++fetchSeq;
	loadingBranches.value = true;
	branchError.value = "";
	try {
		const list = await RepoService.RemoteBranches(
			u,
			username.value.trim(),
			password.value,
		);
		if (seq !== fetchSeq) return; // 已被更新的请求取代
		lastFetchedKey.value = u;
		branchOptions.value = (list || []).map((b) => ({
			label: b,
			value: b,
			icon: "branch",
		}));
		branch.value = "";
	} catch (e) {
		if (seq !== fetchSeq) return;
		branchOptions.value = [];
		branch.value = "";
		const msg = errMsg(e);
		branchError.value = `无法获取远程分支：${msg}`;
		// 需要认证时自动展开认证区域
		if (isAuthError(msg)) authOpen.value = true;
	} finally {
		if (seq === fetchSeq) loadingBranches.value = false;
	}
}

/** 手动重试（也是认证信息变化后重新拉取的唯一入口） */
function retryFetch() {
	if (debounceTimer) window.clearTimeout(debounceTimer);
	fetchBranches();
}

const valid = computed(() => !!url.value.trim());

async function browse() {
	const dir = await pickDirectory("选择克隆目标父目录");
	if (dir) parent.value = dir;
}

async function submit() {
	if (!valid.value || ui.opRunning) return;
	const entry = await repos.clone({
		url: url.value.trim(),
		parent: parent.value.trim(),
		name: name.value.trim(),
		branch: branch.value.trim(),
		username: username.value.trim(),
		password: password.value,
	});
	if (entry) emit("close");
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
				<input
					v-model="parent"
					type="text"
					spellcheck="false"
					placeholder="~/Code"
				/>
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
			<div class="field">
				<span class="label">分支（留空 = 远程默认）</span>
				<SelectMenu
					v-model="branch"
					:options="branchOptions"
					:disabled="loadingBranches"
					:placeholder="
						loadingBranches ? '获取分支中…' : '远程默认分支'
					"
					icon="branch"
					full-width
				/>
				<p v-if="branchError" class="branch-error">
					<Icon name="alert" :size="12" />
					<span class="branch-error-msg">{{ branchError }}</span>
					<button
						class="btn btn-mini"
						type="button"
						@click="retryFetch"
					>
						重试
					</button>
				</p>
			</div>
		</div>
		<div class="auth">
			<button
				class="auth-toggle"
				type="button"
				@click="authOpen = !authOpen"
			>
				<Icon
					name="chevron-down"
					:size="12"
					class="auth-chev"
					:class="{ open: authOpen }"
				/>
				认证（可选）
				<span v-if="hasCreds" class="auth-hint">已填写凭据</span>
			</button>
			<div v-if="authOpen" class="row2">
				<label class="field">
					<span class="label">用户名</span>
					<input
						v-model="username"
						type="text"
						spellcheck="false"
						autocomplete="off"
						placeholder="user"
					/>
				</label>
				<label class="field">
					<span class="label">密码 / Token</span>
					<input
						v-model="password"
						type="password"
						autocomplete="new-password"
						placeholder="••••••••"
					/>
				</label>
			</div>
		</div>
		<p class="note">
			<Icon name="info" :size="12" />
			克隆通过系统 git 执行；HTTPS 凭据由系统钥匙串 / git
			凭据助手提供，SSH 需已配置好密钥。
		</p>
		<template #footer>
			<button class="btn" @click="emit('close')">取消</button>
			<button
				class="btn btn-primary"
				:disabled="!valid || !!ui.opRunning"
				@click="submit"
			>
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
.branch-error {
	display: flex;
	align-items: center;
	gap: 6px;
	font-size: 11px;
	line-height: 1.5;
	color: var(--red);
}
.branch-error svg {
	flex: none;
}
.branch-error-msg {
	flex: 1;
	min-width: 0;
}
.btn-mini {
	flex: none;
	height: 20px;
	padding: 0 8px;
	font-size: 11px;
}
.auth {
	display: flex;
	flex-direction: column;
	gap: 6px;
}
.auth-toggle {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	align-self: flex-start;
	padding: 0;
	border: none;
	background: none;
	font-size: 11.5px;
	color: var(--text-dim);
	cursor: pointer;
}
.auth-toggle:hover {
	color: var(--text-strong);
}
.auth-chev {
	transition: transform 0.15s ease;
}
.auth-chev.open {
	transform: rotate(180deg);
}
.auth-hint {
	font-size: 10.5px;
	color: var(--text-faint);
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
