<script setup lang="ts">
// 设置 · 关于：应用版本信息 + 软件更新。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
	AppService,
	UpdateService,
	Events,
	errMsg,
	type UpdateCheckResult,
} from "../../api";
import { useUI } from "../../stores/ui";
import Icon from "../ui/Icon.vue";

const ui = useUI();

const version = ref("");
const author = ref("");
const gitVersion = ref("");

// ------------------------------------------------------------------- 软件更新
const AUTO_CHECK_KEY = "gv.auto-check-update";
const autoCheck = ref(localStorage.getItem(AUTO_CHECK_KEY) !== "0");

const checking = ref(false);
const downloading = ref(false);
const ready = ref(false);
const progress = ref(0);
const errorMsg = ref("");
const updateInfo = ref<UpdateCheckResult | null>(null);

// 每次进入应用只自动检查一次（模块级变量：组件卸载/重新挂载后依然生效）。
let autoChecked = false;

const progressPercent = computed(() =>
	Math.min(Math.round(progress.value), 100),
);

function toggleAutoCheck() {
	autoCheck.value = !autoCheck.value;
	localStorage.setItem(AUTO_CHECK_KEY, autoCheck.value ? "1" : "0");
}

async function checkUpdates(auto = false) {
	if (checking.value || downloading.value) return;
	checking.value = true;
	errorMsg.value = "";
	try {
		const res = await UpdateService.CheckForUpdates();
		updateInfo.value = res ?? null;
		if (res?.updateAvailable) {
			ready.value = false;
			progress.value = 0;
			ui.success("发现新版本", `v${res.latestVersion}`);
		} else if (!auto) {
			ui.success(
				"已是最新版本",
				`当前 v${res?.currentVersion || version.value}`,
			);
		}
	} catch (e) {
		// 检查更新失败仅在调试控制台记录，不在界面上提示
		console.error("检查更新失败", errMsg(e));
	} finally {
		checking.value = false;
	}
}

async function installUpdate() {
	if (!updateInfo.value?.updateAvailable || downloading.value) return;
	downloading.value = true;
	errorMsg.value = "";
	try {
		await UpdateService.DownloadAndInstall();
		// Windows 自解包流程不会触发 updater 的 ready 事件，成功返回后
		// 直接切到「重启并更新」状态，避免界面一直停在「下载中…」。
		if (!ready.value) {
			downloading.value = false;
			progress.value = 100;
			ready.value = true;
			ui.success("新版本已就绪", "重启应用后生效");
		}
	} catch (e) {
		downloading.value = false;
		errorMsg.value = errMsg(e);
		ui.error("下载更新失败", errorMsg.value);
	}
}

async function restartApp() {
	try {
		await UpdateService.Restart();
	} catch (e) {
		ui.error("重启失败", errMsg(e));
	}
}

function formatPublishedAt(iso: string) {
	if (!iso) return "";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// 订阅 updater 的下载进度 / 就绪 / 错误事件
const offUpdater: Array<() => void> = [];

onMounted(async () => {
	try {
		version.value = (await AppService.Version()) || "";
	} catch {
		/* ignore */
	}
	try {
		author.value = (await AppService.Author()) || "";
	} catch {
		/* ignore */
	}
	try {
		gitVersion.value = (await AppService.GitVersion()) || "";
	} catch {
		/* ignore */
	}

	offUpdater.push(
		Events.On("wails:updater:download-started", () => {
			downloading.value = true;
			progress.value = 0;
		}),
		Events.On("wails:updater:download-progress", (ev) => {
			const p = (ev?.data || {}) as { written?: number; total?: number };
			if (p.total && p.total > 0) {
				progress.value = ((p.written || 0) / p.total) * 100;
			}
		}),
		Events.On("wails:updater:update-ready", () => {
			downloading.value = false;
			progress.value = 100;
			ready.value = true;
			ui.success("新版本已就绪", "重启应用后生效");
		}),
		Events.On("wails:updater:error", (ev) => {
			downloading.value = false;
			const info = (ev?.data || {}) as { message?: string };
			const msg = info.message || "更新失败";
			errorMsg.value = msg;
			ui.error("更新失败", msg);
		}),
	);

	// 首次进入「关于」且开启自动检查时，静默检查一次
	if (autoCheck.value && !autoChecked) {
		autoChecked = true;
		void checkUpdates(true);
	}
});

onBeforeUnmount(() => {
	offUpdater.forEach((off) => off());
	offUpdater.length = 0;
});
</script>

<template>
	<div>
		<section class="group">
			<div class="about-hero">
				<img class="about-icon" src="/appicon.png" alt="Git View" />
				<div class="about-hero-info">
					<h3 class="about-name">Git View</h3>
					<p class="about-line">
						一个现代化、简洁高效的 Git 桌面客户端
					</p>
				</div>
			</div>
			<dl class="about-meta">
				<div class="meta-row">
					<dt>版本</dt>
					<dd class="mono">{{ version || "-" }}</dd>
				</div>
				<div class="meta-row">
					<dt>Git 版本</dt>
					<dd class="mono">{{ gitVersion || "未检测到" }}</dd>
				</div>
				<div class="meta-row">
					<dt>作者</dt>
					<dd>{{ author || "-" }}</dd>
				</div>
			</dl>
		</section>

		<section class="group">
			<div class="update-head">
				<div>
					<h3 class="group-title">软件更新</h3>
					<p class="update-desc">当前版本 v{{ version || "-" }}</p>
				</div>
				<button
					class="btn"
					:disabled="checking || downloading"
					@click="checkUpdates(false)"
				>
					<Icon :name="checking ? 'loading' : 'refresh'" :size="13" />
					{{ checking ? "检查中…" : "检查更新" }}
				</button>
			</div>

			<!-- 自动检查开关 -->
			<button
				type="button"
				class="update-toggle"
				role="switch"
				:aria-checked="autoCheck"
				@click="toggleAutoCheck"
			>
				<span class="toggle-text">
					<span class="toggle-title">进入「关于」时自动检查更新</span>
					<span class="toggle-desc"
						>打开设置 - 关于时自动检查是否有新版本</span
					>
				</span>
				<span class="switch" :class="{ on: autoCheck }">
					<span class="switch-knob" />
				</span>
			</button>

			<!-- 有新版本 -->
			<div v-if="updateInfo?.updateAvailable" class="update-card">
				<div class="update-card-head">
					<Icon name="download" :size="16" class="update-card-icon" />
					<div class="update-card-info">
						<div class="update-version">
							v{{ updateInfo.latestVersion }}
							<span v-if="updateInfo.name" class="update-name"
								>· {{ updateInfo.name }}</span
							>
						</div>
						<div v-if="updateInfo.publishedAt" class="update-time">
							{{ formatPublishedAt(updateInfo.publishedAt) }}
						</div>
						<p v-if="updateInfo.notes" class="update-notes">
							{{ updateInfo.notes }}
						</p>
					</div>
				</div>

				<div v-if="downloading" class="update-progress">
					<div class="progress-track">
						<div
							class="progress-fill"
							:style="{ width: progressPercent + '%' }"
						/>
					</div>
					<div class="progress-text">
						正在下载更新… {{ progressPercent }}%
					</div>
				</div>

				<div class="update-actions">
					<button
						v-if="!ready"
						class="btn btn-primary"
						:disabled="downloading || checking"
						@click="installUpdate"
					>
						<Icon
							:name="downloading ? 'loading' : 'download'"
							:size="13"
						/>
						{{ downloading ? "下载中…" : "下载并安装" }}
					</button>
					<button v-else class="btn btn-primary" @click="restartApp">
						<Icon name="restart" :size="13" />
						重启并更新
					</button>
				</div>
			</div>

			<!-- 已就绪 -->
			<div v-else-if="ready" class="update-card">
				<div class="update-card-head">
					<Icon
						name="check-circle"
						:size="16"
						class="update-card-icon ok"
					/>
					<div class="update-card-info">
						<div class="update-version">新版本已就绪</div>
						<div class="update-time">重启应用后生效</div>
					</div>
				</div>
				<div class="update-actions">
					<button class="btn btn-primary" @click="restartApp">
						<Icon name="restart" :size="13" />
						重启并更新
					</button>
				</div>
			</div>

			<!-- 错误提示 -->
			<div v-if="errorMsg" class="update-error">
				<Icon name="alert-circle" :size="14" />
				<span>{{ errorMsg }}</span>
			</div>
		</section>
	</div>
</template>

<style scoped>
/* 版式（无卡片 + 分割线）由 SettingsPanel 统一提供 */

/* 应用信息 */
.about-hero {
	display: flex;
	align-items: center;
	gap: 13px;
	padding-bottom: 14px;
}
.about-icon {
	flex: none;
	width: 52px;
	height: 52px;
	border-radius: 13px;
}
.about-hero-info {
	min-width: 0;
}
.about-name {
	font-size: 15px;
	font-weight: 600;
	color: var(--text-strong);
}
.about-line {
	margin-top: 3px;
	font-size: 12px;
	color: var(--text-dim);
}
.about-meta {
	display: flex;
	flex-direction: column;
	padding: 3px 0;
	border-top: 1px solid var(--border);
}
.meta-row {
	display: flex;
	justify-content: space-between;
	align-items: center;
	gap: 12px;
	padding: 9px 0;
	font-size: 12.5px;
}
.meta-row + .meta-row {
	border-top: 1px solid var(--border);
}
.meta-row dt {
	flex: none;
	color: var(--text-faint);
}
.meta-row dd {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: var(--text-strong);
}

/* 软件更新 */
.update-head {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 12px;
	margin-bottom: 12px;
}
.update-desc {
	margin-top: 3px;
	font-size: 11.5px;
	color: var(--text-faint);
}

.update-toggle {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	width: 100%;
	padding: 9px 11px;
	border: 1px solid var(--border);
	border-radius: 8px;
	background: var(--bg-input);
	cursor: pointer;
	text-align: left;
}
.toggle-text {
	display: flex;
	flex-direction: column;
	gap: 2px;
}
.toggle-title {
	font-size: 12.5px;
	color: var(--text);
}
.toggle-desc {
	font-size: 11px;
	color: var(--text-faint);
}
.switch {
	position: relative;
	flex: none;
	width: 34px;
	height: 19px;
	border-radius: 10px;
	background: var(--border-strong);
	transition: background 0.15s ease;
}
.switch.on {
	background: var(--accent);
}
.switch-knob {
	position: absolute;
	top: 2px;
	left: 2px;
	width: 15px;
	height: 15px;
	border-radius: 50%;
	background: #fff;
	box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
	transition: transform 0.15s ease;
}
.switch.on .switch-knob {
	transform: translateX(15px);
}

.update-card {
	margin-top: 12px;
	padding: 12px;
	border: 1px solid var(--border);
	border-radius: 8px;
	background: var(--bg-panel-2);
}
.update-card-head {
	display: flex;
	align-items: flex-start;
	gap: 9px;
}
.update-card-icon {
	flex: none;
	margin-top: 1px;
	color: var(--accent);
}
.update-card-icon.ok {
	color: var(--green);
}
.update-card-info {
	min-width: 0;
	flex: 1;
}
.update-version {
	font-size: 12.5px;
	font-weight: 600;
	color: var(--text-strong);
}
.update-name {
	font-weight: 400;
	color: var(--text-faint);
}
.update-time {
	margin-top: 2px;
	font-size: 11px;
	color: var(--text-faint);
}
.update-notes {
	margin-top: 7px;
	font-size: 11.5px;
	line-height: 1.55;
	color: var(--text-dim);
	white-space: pre-wrap;
	word-break: break-word;
}

.update-progress {
	margin-top: 10px;
}
.progress-track {
	height: 5px;
	border-radius: 3px;
	background: var(--bg-input);
	overflow: hidden;
}
.progress-fill {
	height: 100%;
	border-radius: 3px;
	background: var(--accent);
	transition: width 0.2s ease;
}
.progress-text {
	margin-top: 5px;
	font-size: 11px;
	color: var(--text-faint);
}

.update-actions {
	display: flex;
	gap: 8px;
	margin-top: 11px;
}

.update-error {
	display: flex;
	align-items: flex-start;
	gap: 7px;
	margin-top: 12px;
	padding: 9px 11px;
	border: 1px solid var(--red);
	border-radius: 8px;
	background: var(--red-wash);
	font-size: 11.5px;
	line-height: 1.5;
	color: var(--red);
	word-break: break-word;
}
</style>
