import { readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { join as pathJoin, resolve as pathResolve } from 'path';
import { ipcRenderer, webFrame } from 'electron';
import { createElement, hiddenClassesImages, toggleSettingCSS, keyboardEventMatchesCustomSetting } from './utils.ts';
import { APP_PROTOCOL, LEGACY_APP_PROTOCOL, WEBSITE_URL } from './branding.ts';
import { describeGameUsability, formatGameUsabilitySnapshot, GameUsabilitySignal, observeGameUsability } from './game-usability.ts';
import { installDrawCallCensus } from './draw-call-stats.ts';
import { startGameplayFpsLog } from './gameplay-fps-log.ts';
import { describeError, formatLoadingDeadlineEvent, formatLoadingOverrunMessage, SPLASH_REVEAL_DEADLINE_MS, startLoadingDeadline } from './loading-deadline.ts';
import { probeMenuStructure } from './menu-dom-probe.ts';
import { formatIdentityContext, formatIdentityProbe, probeIdentitySources } from './identity-source-probe.ts';
import { RollingPerformanceStats } from './performance-stats.ts';
import { mountWeaponParticleLoader, type WeaponParticleLoader } from './weapon-particle-loader.ts';
import { applyCustomIdentity, setCustomIdentityDiagnostic, stopCustomIdentityDisplay, withRealIdentity } from './custom-identity-display.ts';
import { resolveTheme } from './themes.ts';
import { installRawPointerLock } from './raw-pointer-lock.ts';
import { HUD_CONTAINMENT_CSS } from './hud-containment.ts';
import { captureIdentityDiagnostic } from './preload-diagnostics.ts';
import type { MotionBlurController } from './motion-blur.ts';
const identityDiagnostic = captureIdentityDiagnostic(process.env);
try {
	webFrame.insertCSS(HUD_CONTAINMENT_CSS, { cssOrigin: 'user' });
} catch (error) {
	console.error('Failed to install WOK HUD containment.', error);
}
const wokBootPayload = parseWokBootPayload();
const rawPointerLockController = installRawPointerLock(Element.prototype, wokBootPayload?.userPrefs.rawMouseInput !== false);
if (process.env.WOK_DRAW_STATS) {
	const glPrototype = typeof WebGL2RenderingContext === 'function' ? (WebGL2RenderingContext.prototype as unknown as Record<string, unknown>) : undefined;
	if (glPrototype) {
		installDrawCallCensus({
			isActive: () => document.pointerLockElement !== null,
			report: (report) => {
				ipcRenderer.send('wok_draw_stats', report);
			},
			requestFrame: (callback) => {
				requestAnimationFrame(() => {
					callback();
				});
			},
			target: glPrototype
		});
	}
}
if (process.env.WOK_DUMP_DOM) {
	const keywords = (process.env.WOK_DUMP_DOM_KEYWORDS ?? 'live stream,featured,streaming').split(',');
	const runProbe = () => {
		probeMenuStructure({
			keywords,
			queryAll: (selector) => [...document.querySelectorAll(selector)],
			report: (text) => {
				ipcRenderer.send('wok_dom_probe', text);
			}
		});
	};
	window.setTimeout(runProbe, 12000);
	window.setTimeout(runProbe, 30000);
}
if (identityDiagnostic.enabled) {
	const runIdentityProbe = () => {
		const hits = probeIdentitySources({
			needle: identityDiagnostic.needle,
			readActivity: () => (typeof window.getGameActivity === 'function' ? window.getGameActivity() : undefined),
			readGlobals: () => {
				const globals: Record<string, unknown> = {};
				for (const key of Object.getOwnPropertyNames(window)) {
					if (/^(webkit|on|CSS|HTML|SVG|Audio|Media|RTC|IDB|WebGL|Speech|Performance)/u.test(key)) continue;
					try {
						const value = (window as unknown as Record<string, unknown>)[key];
						if (value && (typeof value === 'object' || typeof value === 'string')) globals[key] = value;
					} catch (_error) {}
				}
				return globals;
			},
			readStorage: () => {
				const entries: Record<string, string> = {};
				try {
					for (let index = 0; index < localStorage.length; index++) {
						const key = localStorage.key(index);
						if (key) entries[key] = localStorage.getItem(key) ?? '';
					}
				} catch (_error) {}
				return entries;
			},
			searchDom: (value) => {
				const found: {
					location: string;
					sample: string;
				}[] = [];
				for (const element of document.querySelectorAll('[id]')) {
					const text = (element.textContent ?? '').trim();
					if (text.includes(value) && text.length < 400) found.push({ location: `#${element.id}`, sample: text });
					if (found.length >= 12) break;
				}
				return found;
			}
		});
		ipcRenderer.send('wok_identity_probe', formatIdentityProbe(hits));
		{
			const activity = typeof window.getGameActivity === 'function' ? window.getGameActivity() : undefined;
			const storageKeys: string[] = [];
			try {
				for (let index = 0; index < localStorage.length; index++) {
					const key = localStorage.key(index);
					if (key) storageKeys.push(key);
				}
			} catch (_error) {}
			const bodyText = (document.body?.textContent ?? '').replace(/\s+/gu, ' ').trim();
			ipcRenderer.send(
				'wok_identity_probe',
				formatIdentityContext({
					'getGameActivity()': activity,
					'getGameActivity typeof': typeof window.getGameActivity,
					'Object.hasOwn(window, getGameActivity)': Object.hasOwn(window, 'getGameActivity'),
					'in window': 'getGameActivity' in window,
					'localStorage keys': storageKeys,
					'document.body text (first 400)': bodyText.slice(0, 400),
					'window.me': (window as unknown as Record<string, unknown>).me,
					'window.account': (window as unknown as Record<string, unknown>).account
				})
			);
		}
	};
	for (const delay of [3000, 8000, 15000, 25000, 45000]) window.setTimeout(runIdentityProbe, delay);
}
if (process.env.WOK_FPS_LOG) {
	const stats = new RollingPerformanceStats();
	startGameplayFpsLog({
		emit: (sample) => {
			ipcRenderer.send('wok_fps_log', sample);
		},
		isActive: () => document.pointerLockElement !== null,
		now: () => performance.now(),
		recordFrame: (timestamp, frameTimeMs) => {
			stats.recordFrame(timestamp, frameTimeMs);
		},
		requestFrame: (callback) => {
			requestAnimationFrame(callback);
		},
		snapshot: (now) => stats.snapshot(now)
	});
}
window.setTimeout(() => {
	traceStartup('top-level identity kick');
	beginCustomIdentityWatch();
}, 1000);
const perfMarksEnabled = Boolean(process.env.WOK_PERF_MARKS);
function sendPerfMark(name: string) {
	if (!perfMarksEnabled) return;
	performance.mark(`wok:${name}`);
	ipcRenderer.send('wok_perf_mark', name, Date.now());
}
sendPerfMark('preload-start');
window.OffCliV = true;
window.closeClient = () => ipcRenderer.send('closeClient');
export const strippedConsole = {
	error: console.error.bind(console),
	log: console.log.bind(console),
	warn: console.warn.bind(console),
	time: console.time.bind(console),
	timeEnd: console.timeEnd.bind(console)
};
let motionBlurController: MotionBlurController | undefined;
let motionBlurLoadGeneration = 0;
let motionBlurModulePromise: Promise<typeof import('./motion-blur.ts')> | undefined;
function stopMotionBlurRuntime(): void {
	motionBlurLoadGeneration++;
	motionBlurController?.destroy();
	motionBlurController = undefined;
}
export function applyClientMotionBlurSettings(preferences: UserPrefs): void {
	const generation = ++motionBlurLoadGeneration;
	if (preferences.motionBlur !== true) {
		motionBlurController?.destroy();
		motionBlurController = undefined;
		return;
	}
	if (!motionBlurModulePromise) motionBlurModulePromise = import('./motion-blur.ts');
	const modulePromise = motionBlurModulePromise;
	void modulePromise
		.then((motionBlur) => {
			if (generation !== motionBlurLoadGeneration || preferences.motionBlur !== true) return;
			const options = motionBlur.motionBlurOptionsFromUserPrefs(preferences);
			if (motionBlurController) {
				motionBlurController.update(options);
				return;
			}
			let nextController: MotionBlurController;
			nextController = motionBlur.startMotionBlur(options, {
				onError: (error) => {
					if (motionBlurController === nextController) motionBlurController = undefined;
					strippedConsole.error('Motion blur stopped after a rendering error', error);
				}
			});
			motionBlurController = nextController;
		})
		.catch((error) => {
			if (motionBlurModulePromise === modulePromise) motionBlurModulePromise = undefined;
			if (generation === motionBlurLoadGeneration) strippedConsole.error('Failed to start motion blur', error);
		});
}
window.addEventListener('beforeunload', stopMotionBlurRuntime, { once: true });
let settingsRenderPromise: Promise<void> | undefined;
let stopAdaptiveValidationRuntime: (() => void) | undefined;
let adaptiveValidationLoadGeneration = 0;
let competitiveModeEnabled = false;
function updateAdaptiveValidationRuntime(value: unknown) {
	const adaptiveValidationGeneration = ++adaptiveValidationLoadGeneration;
	stopAdaptiveValidationRuntime?.();
	stopAdaptiveValidationRuntime = undefined;
	if (!competitiveModeEnabled || value === undefined) return;
	void import('./adaptive-validation-runtime.ts')
		.then((adaptiveValidation) => {
			if (adaptiveValidationGeneration !== adaptiveValidationLoadGeneration) return;
			const state = adaptiveValidation.parseAdaptiveValidationState(value);
			if (!state) return;
			stopAdaptiveValidationRuntime = adaptiveValidation.startAdaptiveValidationRuntime({
				onError: (error) => {
					strippedConsole.error('Adaptive gameplay validation failed', error);
				},
				state,
				submitSession: (submission) => ipcRenderer.invoke('adaptiveValidation_recordSession', submission)
			});
		})
		.catch((error) => {
			strippedConsole.error('Failed to start adaptive gameplay validation', error);
		});
}
let keybindCaptureActive: () => boolean = () => false;
function renderSettings() {
	if (settingsRenderPromise) return;
	settingsRenderPromise = import('./settingsui.ts')
		.then(async (settingsUI) => {
			keybindCaptureActive = settingsUI.isKeybindCaptureActive;
			await settingsUI.settingsReady;
			settingsUI.renderSettings();
		})
		.catch((error) => {
			strippedConsole.error('Failed to load WOK Client settings UI', error);
		})
		.finally(() => {
			settingsRenderPromise = undefined;
		});
}
const $assets = pathResolve(import.meta.dirname, '..', 'assets');
let competitionAutomationEnabled = false;
interface CompHostParams {
	mapId: string;
	team1Name: string;
	team2Name: string;
	teamSize: string;
	team1Players?: string;
	team2Players?: string;
	spectators?: string;
	webhook?: string;
}
const waitForElement = (selector: string, timeoutMs = 15000): Promise<HTMLElement> => {
	return new Promise((resolve, reject) => {
		const existingElement = document.querySelector<HTMLElement>(selector);
		if (existingElement) return resolve(existingElement);
		let settled = false;
		const observer = new MutationObserver(() => {
			const element = document.querySelector<HTMLElement>(selector);
			if (element) finish(element);
		});
		const finish = (element?: HTMLElement) => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timeout);
			observer.disconnect();
			if (element) resolve(element);
			else reject(new Error(`Timed out waiting for ${selector}.`));
		};
		const timeout = window.setTimeout(() => finish(), timeoutMs);
		observer.observe(document.body, { childList: true, subtree: true });
	});
};
const waitForGameReady = (timeoutMs = 15000): Promise<void> => {
	return new Promise((resolve, reject) => {
		if (typeof window.openHostWindow === 'function') return resolve();
		const startedAt = performance.now();
		const interval = window.setInterval(() => {
			if (typeof window.openHostWindow === 'function') {
				window.clearInterval(interval);
				resolve();
			} else if (performance.now() - startedAt >= timeoutMs) {
				window.clearInterval(interval);
				reject(new Error('Timed out waiting for Krunker competition hosting APIs.'));
			}
		}, 100);
	});
};
const setInputValue = (selector: string, value?: string) => {
	if (!value) return;
	const input = document.querySelector<HTMLInputElement>(selector);
	if (!input) return;
	input.value = value;
};
const findMapCheckbox = (mapIdOrName: string): HTMLInputElement | null => {
	if (!mapIdOrName) return null;
	const byId = document.querySelector<HTMLInputElement>(`#${mapIdOrName}`);
	if (byId) return byId;
	const allMapNameElements = document.querySelectorAll('.hostMap .hostMapName');
	const targetNameElement = Array.from(allMapNameElements).find((el) => (el as HTMLElement).innerText.trim() === mapIdOrName.trim());
	if (targetNameElement?.parentElement) {
		return targetNameElement.parentElement.querySelector('input[type="checkbox"]');
	}
	return null;
};
const automateCompHost = async (params: CompHostParams) => {
	await waitForGameReady();
	window.openHostWindow(false, 1);
	await waitForElement('.hostTb0');
	const mapCheckbox = findMapCheckbox(params.mapId);
	if (!mapCheckbox) {
		strippedConsole.error(`[WOK Client] Automation failed: Could not find map '${params.mapId}'`);
		window.closeHostWindow();
		return;
	}
	if (!mapCheckbox.checked) {
		mapCheckbox.click();
	}
	(window.windows[7] as any).switchTab(2);
	const team1Input = (await waitForElement('#customSnameTeam1')) as HTMLInputElement;
	team1Input.value = params.team1Name;
	const team2Input = (await waitForElement('#customSnameTeam2')) as HTMLInputElement;
	team2Input.value = params.team2Name;
	const teamSizeSelect = (await waitForElement('#customStmSize')) as HTMLSelectElement;
	const teamSizeMap: {
		[key: string]: string;
	} = {
		'1v1': '0',
		'2v2': '1',
		'3v3': '2',
		'4v4': '3'
	};
	const finalTeamSize = teamSizeMap[params.teamSize] || params.teamSize;
	teamSizeSelect.value = finalTeamSize;
	setInputValue('#customSteam1Players', params.team1Players);
	setInputValue('#customSteam2Players', params.team2Players);
	setInputValue('#customSspectators', params.spectators);
	if (params.webhook) {
		try {
			const webhookInput = (await waitForElement('#customSwebhook')) as HTMLInputElement;
			webhookInput.value = params.webhook;
		} catch (e) {
			strippedConsole.error('[WOK Client] Could not find webhook input element.', e);
		}
	}
	window.createPrivateRoom();
};
function readCompHostParameter(url: URL, key: string, maximumLength: number, required = false): string | undefined {
	const value = url.searchParams.get(key)?.trim();
	if (!value) return required ? undefined : '';
	return value.length <= maximumLength ? value : undefined;
}
const parseStartupArgs = (args: string) => {
	try {
		if (args.length > 4096) return;
		const url = new URL(args);
		if (url.protocol !== `${APP_PROTOCOL}:` && url.protocol !== `${LEGACY_APP_PROTOCOL}:`) return;
		if (url.searchParams.get('action') !== 'host-comp') return;
		if (!competitionAutomationEnabled) {
			strippedConsole.warn('[WOK Client] Competition host automation is disabled in settings.');
			return;
		}
		const mapId = readCompHostParameter(url, 'mapId', 100, true);
		const team1Name = readCompHostParameter(url, 'team1Name', 64, true);
		const team2Name = readCompHostParameter(url, 'team2Name', 64, true);
		const teamSize = readCompHostParameter(url, 'teamSize', 8, true);
		if (!mapId || !team1Name || !team2Name || !teamSize || !/^(?:[1-4]v[1-4]|[0-3])$/u.test(teamSize)) {
			strippedConsole.warn('[WOK Client] Competition link contains invalid or missing room settings.');
			return;
		}
		if (!window.confirm(`Create a private ${teamSize} competition room on ${mapId}?`)) return;
		const webhook = url.searchParams.has('webhook') ? window.prompt('Paste the competition webhook URL. WOK does not accept webhook secrets inside launch links.')?.trim() : undefined;
		const params: CompHostParams = {
			mapId,
			team1Name,
			team2Name,
			teamSize,
			team1Players: readCompHostParameter(url, 'team1Players', 4096),
			team2Players: readCompHostParameter(url, 'team2Players', 4096),
			spectators: readCompHostParameter(url, 'spectators', 4096),
			...(webhook && webhook.length <= 2048 ? { webhook } : {})
		};
		void automateCompHost(params).catch((error) => {
			strippedConsole.error('[WOK Client] Competition host automation failed.', error);
		});
	} catch (error) {
		strippedConsole.error('[WOK Client] Error parsing startup URL.', error);
	}
};
ipcRenderer.on('process-startup-url', (_event, url: string) => {
	parseStartupArgs(url);
});
const styleSettingsCSSCache = new Map<string, string>();
function loadStyleSettingCSS(name: 'hideAds' | 'menuTimer' | 'quickClassPicker') {
	const cached = styleSettingsCSSCache.get(name);
	if (cached !== undefined) return cached;
	const css = readFileSync(pathJoin($assets, `${name}.css`), { encoding: 'utf-8' }) + (name === 'quickClassPicker' ? hiddenClassesImages(16) : '');
	styleSettingsCSSCache.set(name, css);
	return css;
}
export const styleSettingsCSS = {
	get hideAds() {
		return loadStyleSettingCSS('hideAds');
	},
	get menuTimer() {
		return loadStyleSettingCSS('menuTimer');
	},
	get quickClassPicker() {
		return loadStyleSettingCSS('quickClassPicker');
	}
};
ipcRenderer.on('adaptiveValidation_stateUpdated', (_event, value: unknown) => {
	updateAdaptiveValidationRuntime(value);
});
ipcRenderer.on('main_did-finish-load', (_event, _userPrefs: UserPrefs, graphicsRuntimeInfo: GraphicsRuntimeInfo, competitiveRuntimeInfo: CompetitiveModeRuntimeInfo) => {
	applyRawMouseInputPreference(_userPrefs);
	applyClientMotionBlurSettings(_userPrefs);
	competitionAutomationEnabled = Boolean(_userPrefs.competitionAutomation);
	competitiveModeEnabled = Boolean(_userPrefs.competitiveMode);
	updateAdaptiveValidationRuntime(competitiveRuntimeInfo.adaptiveValidationState);
	if (_userPrefs.performanceOverlay) {
		void import('./performance-monitor.ts')
			.then((performanceMonitor) => {
				performanceMonitor.startPerformanceMonitor(graphicsRuntimeInfo);
			})
			.catch((error) => {
				strippedConsole.error('Failed to start performance diagnostics', error);
			});
	}
	if (_userPrefs.competitiveMode || competitiveRuntimeInfo.hasGameSettingsBackup) {
		void import('./competitive-mode.ts')
			.then((competitiveMode) => competitiveMode.synchronizeCompetitiveMode(Boolean(_userPrefs.competitiveMode), competitiveRuntimeInfo.hasGameSettingsBackup))
			.catch((error) => {
				strippedConsole.error('Failed to synchronize Competitive mode game settings', error);
			});
	}
	patchSettings(_userPrefs);
	const scrollableOverflowPattern = /^(?:auto|scroll)$/u;
	window.addEventListener(
		'wheel',
		(event: WheelEvent) => {
			if (document.pointerLockElement) {
				event.preventDefault();
				return;
			}
			for (const target of event.composedPath()) {
				if (!(target instanceof HTMLElement) || target === document.body || target === document.documentElement) continue;
				const hasScrollableContent = target.scrollHeight > target.clientHeight || target.scrollWidth > target.clientWidth;
				if (!hasScrollableContent) continue;
				const style = getComputedStyle(target);
				if (scrollableOverflowPattern.test(style.overflowY) || scrollableOverflowPattern.test(style.overflowX)) return;
			}
			event.preventDefault();
		},
		{ capture: true, passive: false }
	);
});
ipcRenderer.once('initDiscordRPC', () => {
	function updateRPC() {
		strippedConsole.log('> updated RPC');
		const presence = withRealIdentity(() => {
			const skinElem = document.querySelector('#menuClassSubtext > span');
			return {
				className: document.getElementById('menuClassName')?.textContent ?? '',
				hasSkinElement: skinElem !== null,
				mapText: document.getElementById('mapInfo')?.textContent ?? null,
				skinText: skinElem?.textContent ?? ''
			};
		});
		const gameActivity = Object.hasOwn(window, 'getGameActivity') ? (window.getGameActivity() as Partial<GameInfo>) : {};
		let overWriteDetails: string | false = false;
		if (!Object.hasOwn(gameActivity, 'class')) gameActivity.class = { name: presence.className };
		if (!Object.hasOwn(gameActivity, 'map') || !Object.hasOwn(gameActivity, 'mode')) overWriteDetails = presence.mapText ?? 'Loading game...';
		const data: RPCargs = {
			details: overWriteDetails || `${gameActivity.mode} on ${gameActivity.map}`,
			state: `${gameActivity.class.name} • ${presence.skinText}`
		};
		if (!presence.hasSkinElement) {
			ipcRenderer.send('preload_updates_DiscordRPC', { details: 'Loading krunker...', state: new URL(WEBSITE_URL).hostname });
		} else {
			ipcRenderer.send('preload_updates_DiscordRPC', data);
		}
	}
	ipcRenderer.on('main_did-finish-load', updateRPC);
	window.addEventListener('load', () => {
		updateRPC();
		setTimeout(() => {
			try {
				document.getElementById('windowCloser').addEventListener('click', updateRPC);
			} catch (e) {
				strippedConsole.error("didn't hook wincloser", e);
			}
			try {
				document.getElementById('customizeButton').addEventListener('click', updateRPC);
			} catch (e) {
				strippedConsole.error("didn't hook customizeButton", e);
			}
		}, 4000);
	});
	document.addEventListener('pointerlockchange', updateRPC);
});
ipcRenderer.on('matchmakerRedirect', async (_event, _userPrefs: UserPrefs) => {
	const { fetchGame } = await import('./matchmaker.ts');
	await fetchGame(_userPrefs);
});
interface WokBootPayload {
	cssPath: string;
	userPrefs: UserPrefs;
	version: string;
}
function parseWokBootPayload(): WokBootPayload | undefined {
	try {
		const bootArgument = process.argv.find((argument) => argument.startsWith('--wok-boot='));
		if (!bootArgument) return undefined;
		const parsed: unknown = JSON.parse(decodeURIComponent(bootArgument.slice('--wok-boot='.length)));
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
		const payload = parsed as Record<string, unknown>;
		if (typeof payload.cssPath !== 'string' || typeof payload.version !== 'string') return undefined;
		if (!payload.userPrefs || typeof payload.userPrefs !== 'object' || Array.isArray(payload.userPrefs)) return undefined;
		return { cssPath: payload.cssPath, userPrefs: payload.userPrefs as UserPrefs, version: payload.version };
	} catch (_error) {
		return undefined;
	}
}
function applyRawMouseInputPreference(_userPrefs: UserPrefs): void {
	rawPointerLockController.setEnabled(_userPrefs.rawMouseInput !== false);
}
function whenDOMReady(callback: () => void) {
	let ran = false;
	const run = () => {
		if (ran) return;
		ran = true;
		observer?.disconnect();
		window.clearInterval(poll);
		document.removeEventListener('DOMContentLoaded', run);
		callback();
	};
	if (document.body) {
		run();
		return;
	}
	document.addEventListener('DOMContentLoaded', run, { once: true });
	const observer =
		typeof MutationObserver === 'function'
			? new MutationObserver(() => {
					if (document.body) run();
				})
			: undefined;
	observer?.observe(document.documentElement, { childList: true, subtree: true });
	const poll = window.setInterval(() => {
		if (document.body) run();
	}, 250);
}
function waitForElementById(id: string): Promise<HTMLElement | null> {
	return new Promise((resolve) => {
		const existing = document.getElementById(id);
		if (existing) return resolve(existing);
		if (document.readyState !== 'loading') return resolve(null);
		const finish = () => {
			observer.disconnect();
			document.removeEventListener('DOMContentLoaded', finish);
			resolve(document.getElementById(id));
		};
		const observer = new MutationObserver(() => {
			if (document.getElementById(id)) finish();
		});
		observer.observe(document, { childList: true, subtree: true });
		document.addEventListener('DOMContentLoaded', finish, { once: true });
	});
}
interface ClientHotkeyConfig {
	matchmakerEnabled: boolean;
	matchmakerKey: KeybindUserPref;
	overrideURL?: string;
}
let clientHotkeyConfig: ClientHotkeyConfig | undefined;
function applyClientHotkeys(_userPrefs: UserPrefs) {
	const alreadyRegistered = clientHotkeyConfig !== undefined;
	clientHotkeyConfig = {
		matchmakerEnabled: Boolean(_userPrefs.matchmaker),
		matchmakerKey: _userPrefs.matchmakerKey as KeybindUserPref,
		overrideURL: typeof _userPrefs.overrideURL === 'string' ? _userPrefs.overrideURL : undefined
	};
	if (alreadyRegistered) return;
	window.addEventListener(
		'keydown',
		(event) => {
			if (event.code === 'Escape') document.exitPointerLock();
			if (event.repeat || keybindCaptureActive()) return;
			const config = clientHotkeyConfig;
			if (!config || !keyboardEventMatchesCustomSetting(config.matchmakerKey, event)) return;
			if (config.matchmakerEnabled) {
				document.exitPointerLock();
				event.preventDefault();
				event.stopImmediatePropagation();
				ipcRenderer.send('matchmaker_requests_userPrefs');
			} else {
				window.location.href = `${config.overrideURL || 'https://krunker.io'}`;
			}
		},
		{ capture: true }
	);
}
export function applyClientMatchmakerSettings(_userPrefs: UserPrefs) {
	applyClientHotkeys(_userPrefs);
	if (_userPrefs.matchmaker) {
		void ensureMatchmakerStylesheet().catch((error) => {
			strippedConsole.error('Failed to apply matchmaker styles', error);
		});
	}
}
let gameUsableObservationStarted = false;
const gameUsableSignal = new GameUsabilitySignal({
	onFirstReport: () => {
		sendPerfMark('game-usable');
		ipcRenderer.send('wok_game_usable');
	},
	onListenerError: (error) => {
		strippedConsole.error('Game usability listener failed', error);
	}
});
function reportGameUsable(): void {
	gameUsableSignal.report();
}
function onGameUsable(listener: () => void): () => void {
	return gameUsableSignal.subscribe(listener);
}
function observeGameUsable(): void {
	if (gameUsableObservationStarted) return;
	gameUsableObservationStarted = true;
	observeGameUsability({
		document,
		onError: (error) => {
			readinessErrors += 1;
			lastReadinessError = describeError(error);
			strippedConsole.error('Krunker readiness check failed', error);
		},
		onUsable: reportGameUsable
	});
}
let readinessErrors = 0;
let lastReadinessError: string | undefined;
const splashLogEnabled = Boolean(process.env.WOK_SPLASH_LOG);
function describeLocation(): string {
	try {
		const url = new URL(location.href);
		return `${url.origin}${url.pathname}`;
	} catch {
		return 'unknown';
	}
}
function sendLoadingDiagnostic(line: string, always = false): void {
	if (!always && !splashLogEnabled) return;
	strippedConsole.log(`[wok-load] ${line}`);
	try {
		ipcRenderer.send('wok_loading_diag', line.slice(0, 2000));
	} catch (error) {
		strippedConsole.error('Failed to forward a loading diagnostic', error);
	}
}
function forceElementGone(element: Element): void {
	try {
		element.remove();
		return;
	} catch (error) {
		strippedConsole.error('Failed to remove a WOK overlay element', error);
	}
	try {
		const style = (element as HTMLElement).style;
		style.setProperty('display', 'none', 'important');
		style.setProperty('opacity', '0', 'important');
		style.setProperty('pointer-events', 'none', 'important');
	} catch (error) {
		strippedConsole.error('Failed to hide a WOK overlay element', error);
	}
}
function showLoadingOverrunNotice(elapsedMs: number): () => void {
	try {
		if (!document.body) return () => {};
		const notice = createElement('div', { class: 'wok-loading-notice' });
		notice.setAttribute('role', 'status');
		const card = createElement('div', { class: 'wok-loading-notice-card' });
		card.appendChild(
			createElement('span', {
				class: 'wok-loading-notice-text',
				text: formatLoadingOverrunMessage(elapsedMs)
			})
		);
		const dismiss = createElement('button', {
			class: 'wok-loading-notice-dismiss',
			text: 'Dismiss',
			type: 'button'
		});
		const remove = () => {
			forceElementGone(notice);
		};
		dismiss.addEventListener('click', remove);
		card.appendChild(dismiss);
		notice.appendChild(card);
		document.body.appendChild(notice);
		return remove;
	} catch (error) {
		strippedConsole.error('Failed to show the WOK loading notice', error);
		return () => {};
	}
}
let splashMountAttempted = false;
async function mountClientSplash(_userPrefs: UserPrefs): Promise<void> {
	if (splashMountAttempted) return;
	splashMountAttempted = true;
	const [splashCSS, splashFrame] = await Promise.all([readFile(pathJoin($assets, 'splash.css'), { encoding: 'utf-8' }), readFile(pathJoin($assets, 'splash-frame.webp'))]);
	webFrame.insertCSS(splashCSS);
	const uiBaseElement = await waitForElementById('uiBase');
	if (uiBaseElement === null) {
		strippedConsole.error("Krunker didn't create #uiBase; skipping the client splash.");
		return;
	}
	if (gameUsableSignal.hasReported || !document.body) return;
	const splashBackground = createElement('div', { class: ['crankshaft-loading-background'] });
	splashBackground.setAttribute('aria-label', 'WOK Client loading');
	splashBackground.setAttribute('role', 'status');
	const stage = createElement('div', {
		class: 'wok-splash-stage'
	});
	stage.style.setProperty('background-image', `url("data:image/webp;base64,${splashFrame.toString('base64')}")`);
	const weaponLoaderHost = createElement('div', {
		class: 'wok-weapon-loader'
	});
	stage.appendChild(weaponLoaderHost);
	splashBackground.appendChild(stage);
	document.body.appendChild(splashBackground);
	let weaponParticles: WeaponParticleLoader | undefined;
	let splashCleared = false;
	const clearSplash = (): void => {
		if (splashCleared) return;
		splashCleared = true;
		sendPerfMark('splash-cleared');
		try {
			weaponParticles?.destroy();
		} catch (error) {
			strippedConsole.error('Failed to stop the WOK loading animation', error);
		}
		forceElementGone(splashBackground);
	};
	let retireOverrunNotice: () => void = () => {};
	const deadline = startLoadingDeadline({
		deadlineMs: SPLASH_REVEAL_DEADLINE_MS,
		now: () => performance.now(),
		onDiagnostic: (event) => {
			sendLoadingDiagnostic(formatLoadingDeadlineEvent('splash', event));
		},
		onFailsafe: (error) => {
			strippedConsole.error('WOK splash teardown failed; forcing it off the page', error);
			forceElementGone(splashBackground);
		},
		onLateReady: (elapsedMs) => {
			retireOverrunNotice();
			sendLoadingDiagnostic(`splash late-ready elapsed=${Math.round(elapsedMs)}ms`, true);
		},
		onResolve: (resolution) => {
			clearSplash();
			if (resolution.outcome !== 'overrun') return;
			sendLoadingDiagnostic(
				`splash overrun elapsed=${Math.round(resolution.elapsedMs)}ms ` +
					`readinessErrors=${readinessErrors} lastError=${lastReadinessError ?? 'none'} ` +
					`url=${describeLocation()} ${formatGameUsabilitySnapshot(describeGameUsability(document))}`,
				true
			);
			retireOverrunNotice = showLoadingOverrunNotice(resolution.elapsedMs);
		},
		subscribe: onGameUsable
	});
	window.addEventListener(
		'beforeunload',
		() => {
			deadline.dispose();
		},
		{ once: true }
	);
	try {
		weaponParticles = await mountWeaponParticleLoader(weaponLoaderHost);
		if (splashCleared) weaponParticles.destroy();
	} catch (error) {
		strippedConsole.error('Failed to start the WOK loading animation', error);
	}
}
let clientCSSInjected = false;
let matchmakerCSSInjected = false;
let hideAdsCSSApplied = false;
let menuTimerCSSApplied = false;
let quickClassPickerCSSApplied = false;
let themeBaseElement: HTMLElement | undefined;
let themeElement: HTMLElement | undefined;
let appliedThemeSelection: string | undefined;
let themeLoadGeneration = 0;
const themeAssetCache = new Map<string, string>();
async function readThemeAsset(name: string): Promise<string> {
	const cached = themeAssetCache.get(name);
	if (cached !== undefined) return cached;
	const css = await readFile(pathJoin($assets, name), { encoding: 'utf-8' });
	themeAssetCache.set(name, css);
	return css;
}
function ensureThemeElements(): boolean {
	if (themeBaseElement && themeElement) return true;
	if (!document.body) return false;
	themeBaseElement = createElement('style', { id: 'wokThemeBase' });
	themeElement = createElement('style', { id: 'crankshaftCustomCSS' });
	document.body.append(themeBaseElement, themeElement);
	return true;
}
export async function applyTheme(selection: string, cssPath: string): Promise<void> {
	if (!ensureThemeElements()) return;
	if (appliedThemeSelection === selection) return;
	const generation = ++themeLoadGeneration;
	appliedThemeSelection = selection;
	const source = resolveTheme(selection);
	let baseCSS = '';
	let themeCSS = '';
	try {
		if (source.kind === 'bundled') {
			const files = await Promise.all(source.assets.map((asset) => readThemeAsset(asset)));
			themeCSS = files.pop() ?? '';
			baseCSS = files.join('\n');
		} else if (source.kind === 'user') {
			themeCSS = await readFile(pathJoin(cssPath, source.file), { encoding: 'utf-8' });
		}
	} catch (error) {
		strippedConsole.error(`Failed to load the theme ${selection}`, error);
		if (generation === themeLoadGeneration) appliedThemeSelection = undefined;
	}
	if (generation !== themeLoadGeneration) return;
	themeBaseElement.textContent = baseCSS;
	themeElement.textContent = themeCSS;
}
let customIdentityTeardownRegistered = false;
async function readClientStylesheet(file: string, timeoutMs = 5000): Promise<string | undefined> {
	try {
		return await Promise.race([
			readFile(pathJoin($assets, file), { encoding: 'utf-8' }),
			new Promise<undefined>((resolve) => {
				window.setTimeout(() => {
					resolve(undefined);
				}, timeoutMs);
			})
		]);
	} catch (error) {
		traceStartup(`stylesheet '${file}' failed: ${String(error)}`);
		strippedConsole.error(`WOK Client could not read ${file}`, error);
		return undefined;
	}
}
async function ensureMatchmakerStylesheet(): Promise<void> {
	if (matchmakerCSSInjected) return;
	matchmakerCSSInjected = true;
	const matchmakerCSS = await readClientStylesheet('matchmaker.css');
	if (matchmakerCSS !== undefined) webFrame.insertCSS(matchmakerCSS);
	else traceStartup('matchmaker.css read timed out; continuing');
}
let latestUserPrefs: UserPrefs | undefined;
let identityStarterHandle: number | undefined;
let authoritativeUserPrefsReceived = false;
let userPrefsRecoveryStarted = false;
let userPrefsFetchInFlight = false;
function beginCustomIdentityWatch() {
	traceStartup(`watch called; started=${identityStarterHandle !== undefined} prefs=${latestUserPrefs ? 'yes' : 'no'} body=${document.body ? 'yes' : 'no'}`);
	if (identityStarterHandle !== undefined) return;
	const tryStart = () => {
		if (!latestUserPrefs) return;
		window.clearInterval(identityStarterHandle);
		identityStarterHandle = undefined;
		traceStartup('independent identity start');
		try {
			startCustomIdentity(latestUserPrefs);
		} catch (error) {
			traceStartup(`independent identity start FAILED: ${String(error)}`);
			strippedConsole.error('WOK Client could not start the custom identity', error);
		}
	};
	identityStarterHandle = window.setInterval(tryStart, 500);
	tryStart();
	if (userPrefsRecoveryStarted) return;
	userPrefsRecoveryStarted = true;
	const fetchPrefs = () => {
		if (authoritativeUserPrefsReceived || userPrefsFetchInFlight) return;
		userPrefsFetchInFlight = true;
		void ipcRenderer
			.invoke('wok_get_user_prefs')
			.then((prefs: UserPrefs | undefined) => {
				if (authoritativeUserPrefsReceived) return;
				if (!prefs) {
					traceStartup('preference fetch returned nothing (sender not trusted yet)');
					return;
				}
				authoritativeUserPrefsReceived = true;
				latestUserPrefs = prefs;
				applyRawMouseInputPreference(prefs);
				applyClientMatchmakerSettings(prefs);
				applyClientMotionBlurSettings(prefs);
				traceStartup('authoritative preferences fetched and applied');
				tryStart();
			})
			.catch((error) => {
				traceStartup(`preference fetch failed: ${String(error)}`);
			})
			.finally(() => {
				userPrefsFetchInFlight = false;
			});
	};
	fetchPrefs();
	const PREFS_POLL_MAX_ATTEMPTS = 15;
	let prefsPollAttempts = 0;
	const prefsPoll = window.setInterval(() => {
		if (authoritativeUserPrefsReceived || ++prefsPollAttempts >= PREFS_POLL_MAX_ATTEMPTS) {
			window.clearInterval(prefsPoll);
			return;
		}
		fetchPrefs();
	}, 2000);
}
function traceStartup(message: string) {
	if (!identityDiagnostic.enabled) return;
	ipcRenderer.send('wok_identity_probe', `[wok-identity] startup: ${message}`);
}
function startCustomIdentity(_userPrefs: UserPrefs) {
	if (identityDiagnostic.enabled) {
		setCustomIdentityDiagnostic((message) => {
			ipcRenderer.send('wok_identity_probe', `[wok-identity] ${message}`);
		});
	}
	applyCustomIdentity(_userPrefs);
	if (customIdentityTeardownRegistered) return;
	customIdentityTeardownRegistered = true;
	window.addEventListener(
		'beforeunload',
		() => {
			stopCustomIdentityDisplay();
		},
		{ once: true }
	);
}
function injectKeyframeFix() {
	if (document.getElementById('crankshaftKeyframeFix')) return;
	const parent = document.body ?? document.head ?? document.documentElement;
	if (!parent) return;
	const keyframeStyle = createElement('style', { id: 'crankshaftKeyframeFix' });
	keyframeStyle.textContent =
		'@keyframes chat-moveup { 0% { transform: translateY(375px); } 100% { transform: translateY(0px); } } @keyframes death-ui-moveup { 0% { transform: translateY(340px); } 100% { transform: translateY(0px); } }';
	parent.appendChild(keyframeStyle);
}
async function applyClientVisuals(_userPrefs: UserPrefs, _version: string, cssPath: string): Promise<void> {
	latestUserPrefs = _userPrefs;
	applyRawMouseInputPreference(_userPrefs);
	beginCustomIdentityWatch();
	traceStartup(`applyClientVisuals entered; readyState=${document.readyState} body=${document.body ? 'present' : 'null'}`);
	applyClientHotkeys(_userPrefs);
	observeGameUsable();
	const { matchmaker, hideAds, menuTimer, quickClassPicker, clientSplash, theme } = _userPrefs;
	traceStartup('before settings.css read');
	if (!clientCSSInjected) {
		clientCSSInjected = true;
		const settingsCSS = await readClientStylesheet('settings.css');
		if (settingsCSS !== undefined) webFrame.insertCSS(settingsCSS);
		else traceStartup('settings.css read timed out; continuing');
		sendPerfMark('css-injected');
	}
	traceStartup('settings.css done; before matchmaker.css');
	if (matchmaker) await ensureMatchmakerStylesheet();
	traceStartup('matchmaker.css done; before splash');
	if (clientSplash && !splashMountAttempted) {
		void mountClientSplash(_userPrefs).catch((error) => {
			strippedConsole.error('Failed to mount the client splash screen', error);
		});
	}
	const adsHidden = hideAds === 'block' || hideAds === 'hide';
	if (adsHidden !== hideAdsCSSApplied) {
		hideAdsCSSApplied = adsHidden;
		toggleSettingCSS(styleSettingsCSS.hideAds, 'hideAds', adsHidden);
	}
	if (Boolean(menuTimer) !== menuTimerCSSApplied) {
		menuTimerCSSApplied = Boolean(menuTimer);
		toggleSettingCSS(styleSettingsCSS.menuTimer, 'menuTimer', menuTimerCSSApplied);
	}
	if (Boolean(quickClassPicker) !== quickClassPickerCSSApplied) {
		quickClassPickerCSSApplied = Boolean(quickClassPicker);
		toggleSettingCSS(styleSettingsCSS.quickClassPicker, 'quickClassPicker', quickClassPickerCSSApplied);
	}
	traceStartup('reached whenDOMReady registration');
	whenDOMReady(() => {
		traceStartup('whenDOMReady callback running');
		const step = (name: string, run: () => void) => {
			try {
				run();
				traceStartup(`step '${name}' ok`);
			} catch (error) {
				traceStartup(`step '${name}' FAILED: ${String(error)}`);
				strippedConsole.error(`WOK Client step '${name}' failed`, error);
			}
		};
		step('hide-ads-offset', () => {
			document.getElementById('hiddenClasses')?.classList.toggle('hiddenClasses-hideAds-bottomOffset', adsHidden);
		});
		step('theme', () => {
			void applyTheme(`${theme}`, cssPath);
		});
		step('keyframe-fix', injectKeyframeFix);
		step('custom-identity', () => {
			startCustomIdentity(_userPrefs);
		});
	});
}
ipcRenderer.on('injectClientCSS', (_event, _userPrefs: UserPrefs, version: string, cssPath: string) => {
	void applyClientVisuals(_userPrefs, version, cssPath).catch((error) => {
		traceStartup(`applyClientVisuals REJECTED: ${String(error)}`);
		strippedConsole.error('Failed to apply client visuals', error);
	});
});
if (wokBootPayload) {
	void applyClientVisuals(wokBootPayload.userPrefs, wokBootPayload.version, wokBootPayload.cssPath).catch((error) => {
		traceStartup(`early applyClientVisuals REJECTED: ${String(error)}`);
		strippedConsole.error('Failed to apply early client visuals', error);
	});
}
export const regionMappings = [
	{ name: 'Frankfurt', id: 'de-fra', code: 'FRA', timezone: 'Europe/Berlin' },
	{ name: 'Silicon Valley', id: 'us-ca-sv', code: 'SV', timezone: 'America/Los_Angeles' },
	{ name: 'Sydney', id: 'au-syd', code: 'SYD', timezone: 'Australia/Sydney' },
	{ name: 'Tokyo', id: 'jb-hnd', code: 'TOK', timezone: 'Asia/Tokyo' },
	{ name: 'Miami', id: 'us-fl', code: 'MIA', timezone: 'America/New_York' },
	{ name: 'Singapore', id: 'sgp', code: 'SIN', timezone: 'Asia/Singapore' },
	{ name: 'New York', id: 'us-nj', code: 'NY', timezone: 'America/New_York' },
	{ name: 'Mumbai', id: 'as-mb', code: 'MBI', timezone: 'Asia/Kolkata' },
	{ name: 'Dallas', id: 'us-tx', code: 'DAL', timezone: 'America/Chicago' },
	{ name: 'Iowa', id: 'iow', code: 'IOW', timezone: 'America/Chicago' },
	{ name: 'Brazil', id: 'brz', code: 'BRZ', timezone: 'America/Sao_Paulo' },
	{ name: 'Middle East', id: 'me-bhn', code: 'BHN', timezone: 'Asia/Riyadh' },
	{ name: 'South Africa', id: 'af-ct', code: 'AFR', timezone: 'Africa/Johannesburg' },
	{ name: 'China (hidden)', id: '', code: 'CHI', timezone: 'Asia/Shanghai' },
	{ name: 'London (hidden)', id: '', code: 'LON', timezone: 'Europe/London' },
	{ name: 'Seattle (hidden)', id: '', code: 'STL', timezone: 'America/Los_Angeles' },
	{ name: 'Mexico (hidden)', id: '', code: 'MX', timezone: 'America/Mexico_City' },
	{ name: 'EU Super Secret Servers', id: 'sss', code: 'FRA', timezone: 'Europe/Berlin' }
];
const regionOptionsRegex = /s*<option value=.*(de-fra).*(us-ca-sv).*<\/option>/gu;
export function getTimezoneByRegionKey(key: 'code' | 'id', value: string) {
	if (key === 'id' && value === '') throw new Error('getTimezoneByRegionKey: forbidden to get regions by id with empty id, would match multiple hidden regions');
	const possibleRegions = regionMappings.filter((reg) => reg[key] === value);
	if (possibleRegions.length === 0) throw new Error(`getTimezoneByRegionKey: couldn't get region object for '${key}' === '${value}'`);
	const region = possibleRegions[0];
	const localTime = new Date().toLocaleTimeString('en-US', { timeZone: region.timezone, hour12: false, hour: '2-digit', minute: '2-digit' });
	return `[${localTime}]`;
}
function patchSettings(_userPrefs: UserPrefs) {
	let interval: number | undefined;
	let timeout: number | undefined;
	const stopWaiting = () => {
		if (interval !== undefined) window.clearInterval(interval);
		if (timeout !== undefined) window.clearTimeout(timeout);
		interval = undefined;
		timeout = undefined;
	};
	const stopWaitingOnUnload = () => stopWaiting();
	window.addEventListener('beforeunload', stopWaitingOnUnload, { once: true });
	strippedConsole.log('waiting to hook settings...');
	function hookSettings() {
		const settingsWindow = window.windows[0];
		let selectedTab = settingsWindow.tabIndex;
		function isClientTab() {
			const allTabsCount = settingsWindow.tabs[settingsWindow.settingType].length - 1;
			return selectedTab === allTabsCount;
		}
		function renameClientTab() {
			for (const tab of document.querySelectorAll('#settingsTabs .tab, #settHolder .tab, .settingTab')) {
				if (tab.textContent?.trim() === 'Client') tab.textContent = 'WOK';
			}
		}
		function safeRenderSettings() {
			renameClientTab();
			if (isClientTab()) renderSettings();
		}
		const showWindowHook = window.showWindow.bind(window);
		const getSettingsHook = settingsWindow.getSettings.bind(settingsWindow);
		const changeTabHook = settingsWindow.changeTab.bind(settingsWindow);
		const searchHook = settingsWindow.searchList.bind(settingsWindow);
		let searchRenderTimer: number | undefined;
		const runHookExtras = (label: string, extras: () => void) => {
			try {
				extras();
			} catch (error) {
				strippedConsole.error(`WOK Client ${label} hook failed`, error);
			}
		};
		window.showWindow = (...args: unknown[]) => {
			const result = showWindowHook(...args);
			runHookExtras('showWindow', () => {
				if (args[0] === 1) {
					if (settingsWindow.settingType === 'basic') settingsWindow.toggleType({ checked: true });
					const advSliderElem = document.querySelector<HTMLInputElement>('.advancedSwitch input#typeBtn');
					if (advSliderElem) {
						advSliderElem.disabled = true;
						advSliderElem.nextElementSibling?.setAttribute('title', 'WOK Client auto-enables advanced settings mode');
					}
					const searchQuery = (document.getElementById('settSearch') as HTMLInputElement | undefined)?.value ?? '';
					if (isClientTab() || searchQuery.length > 0) renderSettings();
				}
				if (args[0] === 4) {
					const modelViewerElement = Array.from(document.getElementsByClassName('menuLink')).find((elem) => elem instanceof HTMLElement && elem.innerText === 'Model Viewer');
					if (modelViewerElement) modelViewerElement.setAttribute('target', '_blank');
				}
			});
			return result;
		};
		settingsWindow.changeTab = (...args: unknown[]) => {
			const result = changeTabHook(...args);
			runHookExtras('changeTab', () => {
				selectedTab = settingsWindow.tabIndex;
				safeRenderSettings();
			});
			return result;
		};
		settingsWindow.getSettings = (...args: unknown[]) => {
			const result: string = getSettingsHook(...args);
			if (!_userPrefs.regionTimezones) return result;
			let patched = result;
			runHookExtras('getSettings', () => {
				const regionOptionMatches = typeof result === 'string' && result.includes('window.setSetting("defaultRegion"') ? result.match(regionOptionsRegex) : null;
				if (!regionOptionMatches || regionOptionMatches.length === 0) return;
				const optionsHTML = regionOptionMatches[0];
				const optionElements = [...createElement('div', { innerHTML: optionsHTML }).children] as HTMLOptionElement[];
				for (let i = 0; i < optionElements.length; i++) {
					const opt = optionElements[i];
					if ((opt.textContent ?? '').includes('[')) continue;
					try {
						opt.textContent += ` ${getTimezoneByRegionKey('id', opt.value)}`;
					} catch (_error) {
						strippedConsole.error('Error getting timezone for: ', opt);
						opt.textContent += ' [??:??]';
					}
				}
				const tempHolder = document.createElement('div');
				optionElements.forEach((opt) => tempHolder.appendChild(opt));
				patched = result.replace(optionsHTML, tempHolder.innerHTML);
			});
			return patched;
		};
		settingsWindow.searchList = (...args: unknown[]) => {
			const result: any = searchHook(...args);
			runHookExtras('searchList', () => {
				if (searchRenderTimer !== undefined) window.clearTimeout(searchRenderTimer);
				searchRenderTimer = window.setTimeout(() => {
					searchRenderTimer = undefined;
					renderSettings();
				}, 75);
			});
			return result;
		};
		runHookExtras('initial render', safeRenderSettings);
	}
	const waitForWindow0: TimerHandler = () => {
		if (
			Object.hasOwn(window, 'showWindow') &&
			typeof window.showWindow === 'function' &&
			Object.hasOwn(window, 'windows') &&
			Array.isArray(window.windows) &&
			typeof window.windows[0] !== 'undefined' &&
			typeof window.windows[0].changeTab === 'function'
		) {
			stopWaiting();
			window.removeEventListener('beforeunload', stopWaitingOnUnload);
			strippedConsole.log('hooking settings');
			try {
				hookSettings();
			} catch (error) {
				strippedConsole.error('Failed to hook the Krunker settings window', error);
			}
		}
	};
	interval = window.setInterval(waitForWindow0, 250);
	timeout = window.setTimeout(() => {
		stopWaiting();
		strippedConsole.warn('WOK Client stopped waiting for Krunker settings APIs after 30 seconds.');
	}, 30000);
}
