<script setup lang="ts">
// 设置面板：从右侧滑入的独立面板（非弹窗）。三个功能模块互不影响：
//   1. 外观 —— 主题色（应用主色调）+ 亮色/暗色/跟随系统（应用颜色）
//   2. Git 配置 —— 当前用户的全局 git 配置查看与修改
//   3. 关于 —— 应用版本号、作者
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useUI } from "../../stores/ui";
import { useSettings, ACCENT_PRESETS } from "../../stores/settings";
import {
	GitService,
	AppService,
	UpdateService,
	Events,
	errMsg,
	type UpdateCheckResult,
} from "../../api";
import Icon from "../ui/Icon.vue";

const ui = useUI();
const settings = useSettings();

type Tab = "appearance" | "gitconfig" | "about";
const tab = ref<Tab>("appearance");

// ------------------------------------------------------------------ git config
const CONFIG_FIELDS = [
	{ key: "user.name", label: "用户名", placeholder: "提交作者显示的姓名" },
	{ key: "user.email", label: "邮箱", placeholder: "提交作者显示的邮箱" },
	{
		key: "init.defaultBranch",
		label: "默认分支名",
		placeholder: "init 时的默认分支（如 main）",
	},
	{
		key: "core.editor",
		label: "编辑器",
		placeholder: "git 交互时使用的编辑器",
	},
] as const;

const cfgValues = ref<Record<string, string>>({});
const cfgLoading = ref(false);
const cfgSaving = ref(false);
const cfgLoadedOnce = ref(false);

async function loadConfig() {
	cfgLoading.value = true;
	try {
		const res = (await GitService.GlobalConfig()) || {};
		cfgValues.value = { ...(res as Record<string, string>) };
		cfgLoadedOnce.value = true;
	} catch (e) {
		ui.error("读取 Git 配置失败", errMsg(e));
	} finally {
		cfgLoading.value = false;
	}
}

async function saveConfig() {
	if (cfgSaving.value) return;
	cfgSaving.value = true;
	try {
		for (const f of CONFIG_FIELDS) {
			const v = (cfgValues.value[f.key] || "").trim();
			await GitService.SetGlobalConfig(f.key, v);
		}
		ui.success("Git 配置已保存", "全局配置已更新");
		await loadConfig();
	} catch (e) {
		ui.error("保存 Git 配置失败", errMsg(e));
	} finally {
		cfgSaving.value = false;
	}
}

// ---------------------------------------------------------------------- about
const version = ref("");
const author = ref("");
const gitVersion = ref("");

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
});

// ------------------------------------------------------------------- 软件更新
const AUTO_CHECK_KEY = "gv.auto-check-update";
const autoCheck = ref(localStorage.getItem(AUTO_CHECK_KEY) !== "0");

const checking = ref(false);
const downloading = ref(false);
const ready = ref(false);
const progress = ref(0);
const errorMsg = ref("");
const updateInfo = ref<UpdateCheckResult | null>(null);
const autoChecked = ref(false);

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
onMounted(() => {
	offUpdater.push(
		Events.On("wails:updater:download-started", () => {
			downloading.value = true;
			progress.value = 0;
		}),
		Events.On("wails:updater:download-progress", (ev) => {
			const p = (ev?.data || {}) as {
				written?: number;
				total?: number;
			};
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
});
onBeforeUnmount(() => {
	offUpdater.forEach((off) => off());
	offUpdater.length = 0;
});

// 首次进入「关于」且开启自动检查时，静默检查一次
watch(
	() => ui.settingsOpen && tab.value === "about",
	(visible) => {
		if (visible && autoCheck.value && !autoChecked.value) {
			autoChecked.value = true;
			void checkUpdates(true);
		}
	},
	{ immediate: true },
);

// lazy-load git config the first time it becomes visible
watch(
	() => ui.settingsOpen,
	(open) => {
		if (open && !cfgLoadedOnce.value && !cfgLoading.value) loadConfig();
	},
);

function onKey(e: KeyboardEvent) {
	if (e.key === "Escape" && ui.settingsOpen) {
		e.stopPropagation();
		ui.closeSettings();
	}
}
onMounted(() => document.addEventListener("keydown", onKey));
onBeforeUnmount(() => document.removeEventListener("keydown", onKey));
</script>

<template>
	<Teleport to="body">
		<Transition name="settings">
			<div v-if="ui.settingsOpen" class="settings-root">
				<div class="settings-scrim" @click="ui.closeSettings()" />
				<div class="settings-panel">
					<header class="settings-head">
						<span class="settings-title">
							<Icon name="settings" :size="14" />
							设置
						</span>
						<button
							class="btn-icon"
							title="关闭设置"
							@click="ui.closeSettings()"
						>
							<Icon name="x" :size="14" />
						</button>
					</header>

					<div class="settings-body">
						<nav class="settings-nav">
							<button
								class="nav-item"
								:class="{ active: tab === 'appearance' }"
								@click="tab = 'appearance'"
							>
								<Icon name="refresh" :size="14" />
								外观
							</button>
							<button
								class="nav-item"
								:class="{ active: tab === 'gitconfig' }"
								@click="tab = 'gitconfig'"
							>
								<Icon name="branch" :size="14" />
								Git 配置
							</button>
							<button
								class="nav-item"
								:class="{ active: tab === 'about' }"
								@click="tab = 'about'"
							>
								<Icon name="info" :size="14" />
								关于
							</button>
						</nav>

						<section class="settings-content">
							<!-- ------------------------------------------------ 外观 -->
							<template v-if="tab === 'appearance'">
								<div class="group">
									<h3 class="group-title">主题色</h3>
									<p class="group-desc">
										应用的主色调，与亮色 /
										暗色外观相互独立。
									</p>
									<div class="swatches">
										<button
											v-for="a in ACCENT_PRESETS"
											:key="a.key"
											class="swatch"
											:class="{
												active:
													settings.accent === a.key,
											}"
											:style="{ '--swatch': a.color }"
											:title="a.label"
											@click="settings.setAccent(a.key)"
										>
											<Icon
												v-if="settings.accent === a.key"
												name="check"
												:size="11"
											/>
										</button>
									</div>
								</div>

								<div class="group">
									<h3 class="group-title">外观模式</h3>
									<p class="group-desc">
										应用的整体配色（界面背景、文字颜色）。
									</p>
									<div class="mode-group">
										<button
											class="mode-btn"
											:class="{
												active:
													settings.appearance ===
													'light',
											}"
											@click="
												settings.setAppearance('light')
											"
										>
											亮色
										</button>
										<button
											class="mode-btn"
											:class="{
												active:
													settings.appearance ===
													'dark',
											}"
											@click="
												settings.setAppearance('dark')
											"
										>
											暗色
										</button>
										<button
											class="mode-btn"
											:class="{
												active:
													settings.appearance ===
													'system',
											}"
											@click="
												settings.setAppearance('system')
											"
										>
											跟随系统
										</button>
									</div>
								</div>
							</template>

							<!-- -------------------------------------------- Git 配置 -->
							<template v-else-if="tab === 'gitconfig'">
								<div class="group">
									<h3 class="group-title">全局 Git 配置</h3>
									<p class="group-desc">
										对应 ~/.gitconfig，影响所有仓库。
									</p>
									<div v-if="cfgLoading" class="cfg-loading">
										<span class="spinner" /> 读取配置…
									</div>
									<template v-else>
										<label
											v-for="f in CONFIG_FIELDS"
											:key="f.key"
											class="cfg-field"
										>
											<span class="cfg-label">{{
												f.label
											}}</span>
											<input
												v-model="cfgValues[f.key]"
												type="text"
												spellcheck="false"
												:placeholder="f.placeholder"
											/>
											<code class="cfg-key mono">{{
												f.key
											}}</code>
										</label>
										<div class="cfg-actions">
											<button
												class="btn btn-primary"
												:disabled="cfgSaving"
												@click="saveConfig"
											>
												<Icon name="check" :size="13" />
												{{
													cfgSaving
														? "保存中…"
														: "保存"
												}}
											</button>
											<button
												class="btn"
												:disabled="
													cfgLoading || cfgSaving
												"
												@click="loadConfig"
											>
												<Icon
													name="refresh"
													:size="13"
												/>
												重置
											</button>
										</div>
									</template>
								</div>
							</template>

							<!-- ------------------------------------------------ 关于 -->
							<template v-else>
								<div class="about-card">
									<div class="about-hero">
										<img
											class="about-icon"
											src="/appicon.png"
											alt="Git View"
										/>
										<div class="about-hero-info">
											<h3 class="about-name">
												Git View
											</h3>
											<p class="about-line">
												一个现代化、简洁高效的 Git
												桌面客户端
											</p>
										</div>
									</div>
									<dl class="about-meta">
										<div class="meta-row">
											<dt>版本</dt>
											<dd class="mono">
												{{ version || "-" }}
											</dd>
										</div>
										<div class="meta-row">
											<dt>Git 版本</dt>
											<dd class="mono">
												{{ gitVersion || "未检测到" }}
											</dd>
										</div>
										<div class="meta-row">
											<dt>作者</dt>
											<dd>{{ author || "-" }}</dd>
										</div>
									</dl>

									<div class="about-section">
									<div class="update-head">
										<div>
											<h3 class="group-title">
												软件更新
											</h3>
											<p class="group-desc">
												当前版本 v{{ version || "-" }}
											</p>
										</div>
										<button
											class="btn"
											:disabled="checking || downloading"
											@click="checkUpdates(false)"
										>
											<span
												v-if="checking"
												class="spinner"
											/>
											<Icon
												v-else
												name="refresh"
												:size="13"
											/>
											{{
												checking
													? "检查中…"
													: "检查更新"
											}}
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
											<span class="toggle-title"
												>进入「关于」时自动检查更新</span
											>
											<span class="toggle-desc"
												>打开设置 - 关于时自动检查是否有新版本</span
											>
										</span>
										<span
											class="switch"
											:class="{ on: autoCheck }"
										>
											<span class="switch-knob" />
										</span>
									</button>

									<!-- 有新版本 -->
									<div
										v-if="updateInfo?.updateAvailable"
										class="update-card"
									>
										<div class="update-card-head">
											<Icon
												name="download"
												:size="16"
												class="update-card-icon"
											/>
											<div class="update-card-info">
												<div class="update-version">
													v{{
														updateInfo.latestVersion
													}}
													<span
														v-if="
															updateInfo.name
														"
														class="update-name"
														>·
														{{
															updateInfo.name
														}}</span
													>
												</div>
												<div
													v-if="
														updateInfo.publishedAt
													"
													class="update-time"
												>
													{{
														formatPublishedAt(
															updateInfo.publishedAt,
														)
													}}
												</div>
												<p
													v-if="updateInfo.notes"
													class="update-notes"
												>
													{{ updateInfo.notes }}
												</p>
											</div>
										</div>

										<div
											v-if="downloading"
											class="update-progress"
										>
											<div class="progress-track">
												<div
													class="progress-fill"
													:style="{
														width:
															progressPercent +
															'%',
													}"
												/>
											</div>
											<div class="progress-text">
												正在下载更新…
												{{ progressPercent }}%
											</div>
										</div>

										<div class="update-actions">
											<button
												v-if="!ready"
												class="btn btn-primary"
												:disabled="
													downloading || checking
												"
												@click="installUpdate"
											>
												<span
													v-if="downloading"
													class="spinner"
												/>
												<Icon
													v-else
													name="download"
													:size="13"
												/>
												{{
													downloading
														? "下载中…"
														: "下载并安装"
												}}
											</button>
											<button
												v-else
												class="btn btn-primary"
												@click="restartApp"
											>
												<Icon
													name="restart"
													:size="13"
												/>
												重启并更新
											</button>
										</div>
									</div>

									<!-- 已就绪 -->
									<div
										v-else-if="ready"
										class="update-card"
									>
										<div class="update-card-head">
											<Icon
												name="check-circle"
												:size="16"
												class="update-card-icon ok"
											/>
											<div class="update-card-info">
												<div class="update-version">
													新版本已就绪
												</div>
												<div class="update-time">
													重启应用后生效
												</div>
											</div>
										</div>
										<div class="update-actions">
											<button
												class="btn btn-primary"
												@click="restartApp"
											>
												<Icon
													name="restart"
													:size="13"
												/>
												重启并更新
											</button>
										</div>
									</div>

									<!-- 错误提示 -->
									<div
										v-if="errorMsg"
										class="update-error"
									>
										<Icon
											name="alert-circle"
											:size="14"
										/>
										<span>{{ errorMsg }}</span>
									</div>
								</div>
							</div>
						</template>
						</section>
					</div>
				</div>
			</div>
		</Transition>
	</Teleport>
</template>

<style scoped>
.settings-root {
	position: fixed;
	inset: 0;
	z-index: 1200;
	display: flex;
	justify-content: flex-end;
}
.settings-scrim {
	position: absolute;
	inset: 0;
	background: var(--overlay-bg);
}
.settings-panel {
	position: relative;
	width: min(620px, calc(100vw - 80px));
	height: 100%;
	display: flex;
	flex-direction: column;
	background: var(--bg-panel);
	border-left: 1px solid var(--border-strong);
	box-shadow: var(--shadow-panel);
}
/* slide-in / out */
.settings-enter-active,
.settings-leave-active {
	transition: opacity 0.18s ease;
}
.settings-enter-active .settings-panel,
.settings-leave-active .settings-panel {
	transition: transform 0.22s cubic-bezier(0.2, 0.7, 0.3, 1);
}
.settings-enter-from,
.settings-leave-to {
	opacity: 0;
}
.settings-enter-from .settings-panel,
.settings-leave-to .settings-panel {
	transform: translateX(40px);
}

.settings-head {
	flex: none;
	display: flex;
	align-items: center;
	justify-content: space-between;
	height: 40px;
	padding: 0 8px 0 14px;
	border-bottom: 1px solid var(--border);
}
.settings-title {
	display: inline-flex;
	align-items: center;
	gap: 7px;
	font-size: 13px;
	font-weight: 600;
	color: var(--text-strong);
}

.settings-body {
	flex: 1;
	min-height: 0;
	display: flex;
}
.settings-nav {
	flex: none;
	width: 148px;
	padding: 12px 10px;
	border-right: 1px solid var(--border);
	display: flex;
	flex-direction: column;
	gap: 3px;
	background: var(--bg-sidebar);
}
.nav-item {
	position: relative;
	display: flex;
	align-items: center;
	gap: 8px;
	height: 32px;
	padding: 0 10px;
	border-radius: 7px;
	font-size: 12.5px;
	color: var(--text-dim);
	text-align: left;
	transition:
		background 0.12s ease,
		color 0.12s ease;
}
.nav-item:hover {
	background: var(--bg-hover);
	color: var(--text-strong);
}
.nav-item.active {
	font-weight: 600;
}
/* 选中项左侧强调条（不改变背景与文字颜色） */
.nav-item.active::before {
	content: "";
	position: absolute;
	left: 0;
	top: 50%;
	transform: translateY(-50%);
	width: 2px;
	height: 15px;
	border-radius: 0 2px 2px 0;
	background: var(--accent);
}

.settings-content {
	flex: 1;
	min-width: 0;
	overflow-y: auto;
	padding: 16px 18px;
}
.group {
	background: var(--bg-panel-2);
	border: 1px solid var(--border);
	border-radius: 10px;
	padding: 14px 14px 16px;
	margin-bottom: 12px;
}
.group-title {
	font-size: 13px;
	font-weight: 600;
	color: var(--text-strong);
	margin-bottom: 3px;
}
.group-desc {
	font-size: 11.5px;
	color: var(--text-faint);
	margin-bottom: 10px;
}

/* 主题色色板 */
.swatches {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
}
.swatch {
	width: 22px;
	height: 22px;
	border-radius: 50%;
	background: var(--swatch);
	border: 2px solid transparent;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	color: #fff;
	transition:
		transform 0.12s ease,
		box-shadow 0.12s ease;
}
.swatch:hover {
	transform: scale(1.1);
}
.swatch.active {
	box-shadow:
		0 0 0 2px var(--bg-panel),
		0 0 0 4px var(--swatch);
}

/* 外观模式：整体一个按钮组，中间用分隔线分割，选中项有独立样式 */
.mode-group {
	display: inline-flex;
	border: 1px solid var(--border-strong);
	border-radius: 8px;
	overflow: hidden;
	background: var(--bg-input);
}
.mode-btn {
	height: 30px;
	padding: 0 18px;
	background: transparent;
	color: var(--text-dim);
	font-size: 12.5px;
}
.mode-btn + .mode-btn {
	border-left: 1px solid var(--border);
}
.mode-btn:hover {
	color: var(--text-strong);
}
.mode-btn.active {
	background: var(--accent);
	color: #fff;
	font-weight: 600;
}
.mode-btn.active:hover {
	color: #fff;
}

/* Git 配置 */
.cfg-loading {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 12px 0;
	font-size: 12px;
	color: var(--text-faint);
}
.cfg-field {
	display: grid;
	grid-template-columns: 84px 1fr;
	gap: 4px 10px;
	align-items: center;
	margin-bottom: 12px;
}
.cfg-label {
	grid-column: 1;
	font-size: 12.5px;
	color: var(--text);
}
.cfg-field input {
	grid-column: 2;
	width: 100%;
}
.cfg-key {
	grid-column: 2;
	font-size: 10.5px;
	color: var(--text-faint);
}
.cfg-actions {
	display: flex;
	gap: 8px;
	margin-top: 14px;
}

/* 关于：应用信息与软件更新合并为一张卡片，用分割线区分区块 */
.about-card {
	border: 1px solid var(--border);
	border-radius: 12px;
	background: var(--bg-panel-2);
	overflow: hidden;
}
.about-hero {
	display: flex;
	align-items: center;
	gap: 13px;
	padding: 18px 16px;
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
	padding: 3px 16px;
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

.spinner {
	width: 13px;
	height: 13px;
	border: 2px solid var(--border-strong);
	border-top-color: var(--accent);
	border-radius: 50%;
	animation: spin 0.8s linear infinite;
}

/* 软件更新 */
.about-section {
	padding: 14px 16px 16px;
	/* 信息区与操作区用稍强的分割线区分 */
	border-top: 1px solid var(--border-strong);
}
.update-head {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 12px;
	margin-bottom: 12px;
}
.update-head .group-desc {
	margin-bottom: 0;
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
	background: var(--bg-panel);
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
