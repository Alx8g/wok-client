import { readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { join as pathJoin, resolve as pathResolve } from 'path';
import { ipcRenderer, webFrame } from 'electron';
import { createElement, hiddenClassesImages, toggleSettingCSS, keyboardEventMatchesCustomSetting } from './utils.ts';
import { APP_PROTOCOL, LEGACY_APP_PROTOCOL, WEBSITE_URL } from './branding.ts';
import { GameUsabilitySignal, observeGameUsability } from './game-usability.ts';

// Diagnostic-only startup marks. Inert unless WOK_PERF_MARKS is set in the environment.
const perfMarksEnabled = Boolean(process.env.WOK_PERF_MARKS);
function sendPerfMark(name: string) {
	if (!perfMarksEnabled) return;
	performance.mark(`wok:${name}`);
	ipcRenderer.send('wok_perf_mark', name, Date.now());
}
sendPerfMark('preload-start');

// get rid of client unsupported message
window.OffCliV = true;
window.closeClient = () => ipcRenderer.send('closeClient');

// save some console methods from krunker
export const strippedConsole = {
	error: console.error.bind(console),
	log: console.log.bind(console),
	warn: console.warn.bind(console),
	time: console.time.bind(console),
	timeEnd: console.timeEnd.bind(console)
};

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
		.then(adaptiveValidation => {
			if (adaptiveValidationGeneration !== adaptiveValidationLoadGeneration) return;
			const state = adaptiveValidation.parseAdaptiveValidationState(value);
			if (!state) return;
			stopAdaptiveValidationRuntime = adaptiveValidation.startAdaptiveValidationRuntime({
				onError: error => { strippedConsole.error('Adaptive gameplay validation failed', error); },
				state,
				submitSession: submission => ipcRenderer.invoke('adaptiveValidation_recordSession', submission)
			});
		})
		.catch(error => { strippedConsole.error('Failed to start adaptive gameplay validation', error); });
}

function renderSettings() {
	if (settingsRenderPromise) return;
	settingsRenderPromise = import('./settingsui.ts')
		.then(async settingsUI => {
			await settingsUI.settingsReady;
			settingsUI.renderSettings();
		})
		.catch(error => { strippedConsole.error('Failed to load WOK Client settings UI', error); })
		.finally(() => { settingsRenderPromise = undefined; });
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


const waitForElement = (selector: string, timeoutMs = 15_000): Promise<HTMLElement> => {
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

const waitForGameReady = (timeoutMs = 15_000): Promise<void> => {
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
	const targetNameElement = Array.from(allMapNameElements).find(
		(el) => (el as HTMLElement).innerText.trim() === mapIdOrName.trim()
	);
	if (targetNameElement?.parentElement) {
		return targetNameElement.parentElement.querySelector('input[type="checkbox"]');
	}

	return null;
};

const automateCompHost = async (params: CompHostParams) => {
    await waitForGameReady();
	window.openHostWindow(false, 1);
	await waitForElement(".hostTb0");

	const mapCheckbox = findMapCheckbox(params.mapId);

	if (!mapCheckbox) {
        strippedConsole.error(`[WOK Client] Automation failed: Could not find map '${params.mapId}'`);
        window.closeHostWindow();
        return;
    }

	if (!mapCheckbox.checked) {
		mapCheckbox.click();
	}

	// biome-ignore lint/suspicious/noExplicitAny: function provided by krunker
	(window.windows[7] as any).switchTab(2);

	const team1Input = await waitForElement("#customSnameTeam1") as HTMLInputElement;
	team1Input.value = params.team1Name;

	const team2Input = await waitForElement("#customSnameTeam2") as HTMLInputElement;
	team2Input.value = params.team2Name;

	const teamSizeSelect = await waitForElement("#customStmSize") as HTMLSelectElement;

	const teamSizeMap: { [key: string]: string } = {
		"1v1": "0",
		"2v2": "1",
		"3v3": "2",
		"4v4": "3",
	};
	const finalTeamSize = teamSizeMap[params.teamSize] || params.teamSize;
	teamSizeSelect.value = finalTeamSize;

	setInputValue('#customSteam1Players', params.team1Players);
	setInputValue('#customSteam2Players', params.team2Players);
	setInputValue('#customSspectators', params.spectators);

    if (params.webhook) {
        try {
            const webhookInput = await waitForElement("#customSwebhook") as HTMLInputElement;
            webhookInput.value = params.webhook;
        } catch(e) {
            strippedConsole.error("[WOK Client] Could not find webhook input element.", e);
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
		if (args.length > 4_096) return;
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

		const webhook = url.searchParams.has('webhook')
			? window.prompt('Paste the competition webhook URL. WOK does not accept webhook secrets inside launch links.')?.trim()
			: undefined;
		const params: CompHostParams = {
			mapId,
			team1Name,
			team2Name,
			teamSize,
			team1Players: readCompHostParameter(url, 'team1Players', 4_096),
			team2Players: readCompHostParameter(url, 'team2Players', 4_096),
			spectators: readCompHostParameter(url, 'spectators', 4_096),
			...(webhook && webhook.length <= 2_048 ? { webhook } : {})
		};
		void automateCompHost(params).catch(error => {
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

	const css = readFileSync(pathJoin($assets, `${name}.css`), { encoding: 'utf-8' })
		+ (name === 'quickClassPicker' ? hiddenClassesImages(16) : '');
	styleSettingsCSSCache.set(name, css);
	return css;
}

/** CSS for style-based settings, loaded and cached only when a setting uses it. */
export const styleSettingsCSS = {
	get hideAds() { return loadStyleSettingCSS('hideAds'); },
	get menuTimer() { return loadStyleSettingCSS('menuTimer'); },
	get quickClassPicker() { return loadStyleSettingCSS('quickClassPicker'); }
};

ipcRenderer.on('adaptiveValidation_stateUpdated', (_event, value: unknown) => {
	updateAdaptiveValidationRuntime(value);
});

ipcRenderer.on('main_did-finish-load', (_event, _userPrefs: UserPrefs, graphicsRuntimeInfo: GraphicsRuntimeInfo, competitiveRuntimeInfo: CompetitiveModeRuntimeInfo) => {
	competitionAutomationEnabled = Boolean(_userPrefs.competitionAutomation);
	competitiveModeEnabled = Boolean(_userPrefs.competitiveMode);
	updateAdaptiveValidationRuntime(competitiveRuntimeInfo.adaptiveValidationState);

	if (_userPrefs.performanceOverlay) {
		void import('./performance-monitor.ts')
			.then(performanceMonitor => { performanceMonitor.startPerformanceMonitor(graphicsRuntimeInfo); })
			.catch(error => { strippedConsole.error('Failed to start performance diagnostics', error); });
	}

	if (_userPrefs.competitiveMode || competitiveRuntimeInfo.hasGameSettingsBackup) {
		void import('./competitive-mode.ts')
			.then(competitiveMode => competitiveMode.synchronizeCompetitiveMode(Boolean(_userPrefs.competitiveMode), competitiveRuntimeInfo.hasGameSettingsBackup))
			.catch(error => { strippedConsole.error('Failed to synchronize Competitive mode game settings', error); });
	}
	patchSettings(_userPrefs);

	// fix fps dropping on scroll
	// https://github.com/bigjakk/Krunker-Civilian-Client/blob/573de775d4b299db87d45d67d568264eb7d7e0f0/src/preload/index.ts#L29
	window.addEventListener('wheel', (event: WheelEvent) => {
		if (document.pointerLockElement) {
			event.preventDefault();
			return;
		}

		for (const target of event.composedPath()) {
			if (!(target instanceof HTMLElement) || target === document.body || target === document.documentElement) continue;
			const hasScrollableContent = target.scrollHeight > target.clientHeight || target.scrollWidth > target.clientWidth;
			if (!hasScrollableContent) continue;

			const style = getComputedStyle(target);
			if (/^(?:auto|scroll)$/u.test(style.overflowY) || /^(?:auto|scroll)$/u.test(style.overflowX)) return;
		}

		event.preventDefault();
	}, { capture: true, passive: false });

	if (!_userPrefs.saveMatchResultJSONButton) return;
	const copyStr = 'Copy';
	const copiedStr = 'Copied to Clipboard!';
	const failedToCopy = 'Failed to get data. Make sure you are on the Leaderboard tab.';
	const buttonElement = createElement('div', { text: copyStr, class: ['matchResultButton'] });
	let lastCopied = 0;
	const copyCooldownMS = 2000;

	function copyScoreboardToClipboard() {
		if (Date.now() - lastCopied < copyCooldownMS) return;
		lastCopied = Date.now();
		const lbRows = document.querySelector('#endTable')?.children[0]?.children;
		if (!lbRows) return setButtonText(failedToCopy);

		const isHardpoint = lbRows[0]?.children[5]?.textContent === 'Obj';

		const output = [...lbRows].slice(2).map(leaderboardRow => {
			const rowChildren = [...leaderboardRow.children] as HTMLElement[];
			const returnObj = {
				position: rowChildren[0].innerText.replace('.', ''),
				name: rowChildren[1].innerText,
				score: rowChildren[2].innerText,
				kills: rowChildren[3].innerText,
				deaths: rowChildren[4].innerText
			};
			if (isHardpoint) {
				Object.assign(returnObj, {
					objective: rowChildren[5].innerText,
					damage: rowChildren[6].innerText
				});
			}
			return returnObj;
		});

		strippedConsole.log(output);
		navigator.clipboard.writeText(JSON.stringify(output, null, 2));
		setButtonText(copiedStr);
	}

	buttonElement.onclick = copyScoreboardToClipboard;

	function setButtonText(text: string) {
		buttonElement.textContent = text;
		setTimeout(() => {
			buttonElement.textContent = copyStr;
		}, copyCooldownMS);
	}

	document.getElementById('endMidHolder').appendChild(buttonElement);
});

ipcRenderer.once('initDiscordRPC', () => {
	function updateRPC() {
		strippedConsole.log('> updated RPC');
		const classElem = document.getElementById('menuClassName');
		const skinElem = document.querySelector('#menuClassSubtext > span');
		const mapElem = document.getElementById('mapInfo');

		const gameActivity = Object.hasOwn(window, 'getGameActivity') ? window.getGameActivity() as Partial<GameInfo> : {};
		let overWriteDetails: string | false = false;
		if (!Object.hasOwn(gameActivity, 'class')) gameActivity.class = { name: classElem?.textContent ?? '' };
		if (!Object.hasOwn(gameActivity, 'map') || !Object.hasOwn(gameActivity, 'mode')) overWriteDetails = mapElem?.textContent ?? 'Loading game...';

		const data: RPCargs = {
			details: overWriteDetails || `${gameActivity.mode} on ${gameActivity.map}`,
			state: `${gameActivity.class.name} • ${skinElem === null ? '' : skinElem.textContent}`
		};
		if (!skinElem) { // as long as we have skinElem, we can fill in the other blanks
			ipcRenderer.send('preload_updates_DiscordRPC', { details: 'Loading krunker...', state: new URL(WEBSITE_URL).hostname });
		} else {
			ipcRenderer.send('preload_updates_DiscordRPC', data);
		}
	}

	// updating rpc
	ipcRenderer.on('main_did-finish-load', updateRPC);
	window.addEventListener('load', () => {
		updateRPC();
		setTimeout(() => {
			// hook elements that update rpc
			try { document.getElementById('windowCloser').addEventListener('click', updateRPC); } catch (e) { strippedConsole.error("didn't hook wincloser", e); }
			try { document.getElementById('customizeButton').addEventListener('click', updateRPC); } catch (e) { strippedConsole.error("didn't hook customizeButton", e); }
		}, 4000);
	});
	document.addEventListener('pointerlockchange', updateRPC); // thank God this exists
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

/** Parse the boot payload main passes through webPreferences.additionalArguments. */
function parseWokBootPayload(): WokBootPayload | undefined {
	try {
		const bootArgument = process.argv.find(argument => argument.startsWith('--wok-boot='));
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

/** Run a callback immediately when the DOM is already parsed, otherwise at DOMContentLoaded. */
function whenDOMReady(callback: () => void) {
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { callback(); }, { once: true });
	else callback();
}

/** Resolve an element by id as soon as the parser creates it, giving up at DOMContentLoaded. */
function waitForElementById(id: string): Promise<HTMLElement | null> {
	return new Promise(resolve => {
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

/** Register the Escape/matchmaker keydown handler once; later calls only refresh its config. */
function applyClientHotkeys(_userPrefs: UserPrefs) {
	const alreadyRegistered = clientHotkeyConfig !== undefined;
	clientHotkeyConfig = {
		matchmakerEnabled: Boolean(_userPrefs.matchmaker),
		matchmakerKey: _userPrefs.matchmakerKey as KeybindUserPref,
		overrideURL: typeof _userPrefs.overrideURL === 'string' ? _userPrefs.overrideURL : undefined
	};
	if (alreadyRegistered) return;

	document.addEventListener('keydown', event => {
		if (event.code === 'Escape') document.exitPointerLock();
		if (event.repeat) return;
		const config = clientHotkeyConfig;
		if (!config || !keyboardEventMatchesCustomSetting(config.matchmakerKey, event)) return;
		if (config.matchmakerEnabled) {
			event.preventDefault();
			event.stopPropagation();
			ipcRenderer.send('matchmaker_requests_userPrefs');
		} else {
			window.location.href = `${config.overrideURL || 'https://krunker.io'}`;
		}
	});
}

let gameUsableObservationStarted = false;
const gameUsableSignal = new GameUsabilitySignal({
	onFirstReport: () => {
		sendPerfMark('game-usable');
		ipcRenderer.send('wok_game_usable');
	},
	onListenerError: error => {
		strippedConsole.error(
			'Game usability listener failed',
			error
		);
	}
});

/** Report gameplay readiness once, independently of whether the optional client splash is enabled. */
function reportGameUsable(): void {
	gameUsableSignal.report();
}

function onGameUsable(listener: () => void): () => void {
	return gameUsableSignal.subscribe(listener);
}

/**
 * Krunker's populated #instructions UI is the earliest stable readiness signal used by the
 * original splash. Pointer lock is an independent definitive signal. Observe both on every
 * launch so disabled or failed presentation code cannot prevent the adaptive intro profile from
 * learning, including when #instructions is created after the window load event.
 */
function observeGameUsable(): void {
	if (gameUsableObservationStarted) return;
	gameUsableObservationStarted = true;
	observeGameUsability({
		document,
		onUsable: reportGameUsable
	});
}

let splashMountAttempted = false;

async function mountClientSplash(_userPrefs: UserPrefs): Promise<void> {
	if (splashMountAttempted) return;
	splashMountAttempted = true;
	// The title-card colour preference no longer applies: the loading screen carries the launch
	// animation's final frame rather than a card that can be recoloured.
	const { immersiveSplash, immersiveSplashBackgroundColor } = _userPrefs;

	const [splashCSS, splashFrame] = await Promise.all([
		readFile(pathJoin($assets, 'splash.css'), { encoding: 'utf-8' }),
		// The launch animation's own final frame. Inlined as a data URI because this stylesheet is
		// injected into Krunker's document, where a relative url() would resolve against
		// krunker.io and a file:// URL would be blocked.
		readFile(pathJoin($assets, 'splash-frame.webp'))
	]);
	webFrame.insertCSS(splashCSS);

	// Mount as soon as the parser creates #uiBase so the splash covers the page-load window.
	const uiBaseElement = await waitForElementById('uiBase');
	if (uiBaseElement === null) {
		strippedConsole.error("Krunker didn't create #uiBase; skipping the client splash.");
		return;
	}

	const splashBackground = createElement('div', { class: ['crankshaft-loading-background'] });
	if (immersiveSplash) {
		splashBackground.classList.add('immersive');
		splashBackground.style.setProperty('background-color', `${immersiveSplashBackgroundColor}`);
	}

	/*
	 * The stage reproduces exactly the rectangle the launch animation occupies under
	 * object-fit: cover, and paints that animation's own final frame into it. The video therefore
	 * hands over to this screen without the lockup moving by a pixel - which matters because the
	 * V8 lockup in the animation does not match assets/full_logo.svg (its mark is 1.40x the
	 * wordmark cap height rather than 1.26x, with a much tighter gap), so redrawing it from the
	 * SVG would land in a visibly different place.
	 */
	const stage = createElement('div', { class: 'wok-splash-stage' });
	stage.style.setProperty('background-image', `url("data:image/webp;base64,${splashFrame.toString('base64')}")`);
	splashBackground.appendChild(stage);

	/*
	 * Mounted on <body>, NOT inside #uiBase. Krunker applies its UI scale to #uiBase as a CSS
	 * transform (measured: matrix(0.869, 0, 0, 0.869, 0, 0)), which rescaled this overlay to 86.9%
	 * and shrank the lockup by 13% relative to the launch animation that hands over to it. The
	 * element still waits for #uiBase to exist, because that is the earliest reliable signal that
	 * the parser has reached Krunker's UI, but it must not inherit that transform.
	 */
	document.body.appendChild(splashBackground);

	let splashCleared = false;
	let removeGameUsableListener: () => void = () => {};
	const clearSplash = () => {
		if (splashCleared) return;
		splashCleared = true;
		sendPerfMark('splash-cleared');
		splashBackground.remove();
		removeGameUsableListener();
	};
	removeGameUsableListener = onGameUsable(clearSplash);
}

let clientCSSInjected = false;
let matchmakerCSSInjected = false;
let hideAdsCSSApplied = false;
let menuTimerCSSApplied = false;
let quickClassPickerCSSApplied = false;
let customCSSElement: HTMLElement | undefined;
let appliedCustomCSSName: string | undefined;

/** Keep the hot-swap style element mounted and synchronized with the selected CSS file. */
async function applyCustomCSSSwap(cssSwapper: string, cssPath: string): Promise<void> {
	// Add the style element regardless because otherwise the hot-swap functionality doesn't work unless the page loaded with a CSS selected beforehand.
	if (!customCSSElement) {
		customCSSElement = createElement('style', { id: 'crankshaftCustomCSS' });
		document.body.appendChild(customCSSElement);
	}
	if (appliedCustomCSSName === cssSwapper) return;
	appliedCustomCSSName = cssSwapper;
	if (cssSwapper === 'None') {
		customCSSElement.textContent = '';
		return;
	}
	try {
		customCSSElement.textContent = await readFile(pathJoin(cssPath, `${cssSwapper}`), { encoding: 'utf-8' });
	} catch (error) {
		strippedConsole.error(`Failed to load the CSS swapper file ${cssSwapper}`, error);
	}
}

/*
 * Animate transforms instead of position properties
 * https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count
 */
function injectKeyframeFix() {
	if (document.getElementById('crankshaftKeyframeFix')) return;
	const keyframeStyle = createElement('style', { id: 'crankshaftKeyframeFix' });
	keyframeStyle.textContent = '@keyframes chat-moveup { 0% { transform: translateY(375px); } 100% { transform: translateY(0px); } } @keyframes death-ui-moveup { 0% { transform: translateY(340px); } 100% { transform: translateY(0px); } }';
	document.body.appendChild(keyframeStyle);
}

/**
 * Apply hotkeys, client CSS, and the splash screen. Runs at document start when the boot
 * payload is available and again on the injectClientCSS IPC message; every step is
 * idempotent per document and later calls reconcile preference changes (reload flow).
 */
// _version is retained to keep the boot-payload and injectClientCSS IPC shapes unchanged; the
// loading screen no longer prints a version string.
async function applyClientVisuals(_userPrefs: UserPrefs, _version: string, cssPath: string): Promise<void> {
	applyClientHotkeys(_userPrefs);
	observeGameUsable();

	const { matchmaker, hideAds, menuTimer, quickClassPicker, clientSplash, cssSwapper } = _userPrefs;

	if (!clientCSSInjected) {
		clientCSSInjected = true;
		webFrame.insertCSS(await readFile(pathJoin($assets, 'settings.css'), { encoding: 'utf-8' }));
		sendPerfMark('css-injected');
	}
	if (matchmaker && !matchmakerCSSInjected) {
		matchmakerCSSInjected = true;
		webFrame.insertCSS(await readFile(pathJoin($assets, 'matchmaker.css'), { encoding: 'utf-8' }));
	}

	if (clientSplash && !splashMountAttempted) {
		void mountClientSplash(_userPrefs).catch(error => {
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

	whenDOMReady(() => {
		document.getElementById('hiddenClasses')?.classList.toggle('hiddenClasses-hideAds-bottomOffset', adsHidden);
		void applyCustomCSSSwap(`${cssSwapper}`, cssPath);
		injectKeyframeFix();
	});
}

// Kept for reloads and as the fallback when the boot payload is unavailable.
ipcRenderer.on('injectClientCSS', (_event, _userPrefs: UserPrefs, version: string, cssPath: string) => {
	void applyClientVisuals(_userPrefs, version, cssPath)
		.catch(error => { strippedConsole.error('Failed to apply client visuals', error); });
});

const wokBootPayload = parseWokBootPayload();
if (wokBootPayload) {
	void applyClientVisuals(wokBootPayload.userPrefs, wokBootPayload.version, wokBootPayload.cssPath)
		.catch(error => { strippedConsole.error('Failed to apply early client visuals', error); });
}

// warning: timezone calculation may be slighty innacurate: no special logic for DST and approx. offsets for BRZ, BHN and AFR
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
	{ name: 'Brazil', id: 'brz', code: 'BRZ', timezone: 'America/Sao_Paulo' }, // BRT
	{ name: 'Middle East', id: 'me-bhn', code: 'BHN', timezone: 'Asia/Riyadh' }, // Saudi Arabia
	{ name: 'South Africa', id: 'af-ct', code: 'AFR', timezone: 'Africa/Johannesburg' }, // SAST

	// found in matchmaker, but not region picker
	{ name: 'China (hidden)', id: '', code: 'CHI', timezone: 'Asia/Shanghai' }, // Beijing
	{ name: 'London (hidden)', id: '', code: 'LON', timezone: 'Europe/London' },
	{ name: 'Seattle (hidden)', id: '', code: 'STL', timezone: 'America/Los_Angeles' },
	{ name: 'Mexico (hidden)', id: '', code: 'MX', timezone: 'America/Mexico_City' },

	// FRVR 'Super Secret' testing server
	{ name: 'EU Super Secret Servers', id: 'sss', code: 'FRA', timezone: 'Europe/Berlin' }
];

// find option elements of the region setting, + select closing tag
const regionOptionsRegex = /s*<option value=.*(de-fra).*(us-ca-sv).*<\/option>/gu;

/** get a timezone in format '[HH:mm]' for a region by it's 3-letter code (e.g. FRA) or id (e.g. de-fra) */
export function getTimezoneByRegionKey(key: 'code' | 'id', value: string) {
	if (key === 'id' && value === '') throw new Error('getTimezoneByRegionKey: forbidden to get regions by id with empty id, would match multiple hidden regions');
	const possibleRegions = regionMappings.filter(reg => reg[key] === value);
	if (possibleRegions.length === 0) throw new Error(`getTimezoneByRegionKey: couldn't get region object for '${key}' === '${value}'`);
	const region = possibleRegions[0];
	const localTime = new Date().toLocaleTimeString('en-US', { timeZone: region.timezone, hour12: false, hour: '2-digit', minute: '2-digit' });
	return `[${localTime}]`;
}

function patchSettings(_userPrefs: UserPrefs) {
	// hooking & binding credit: https://github.com/asger-finding/anotherkrunkerclient/blob/main/src/preload/game-settings.ts
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

		function safeRenderSettings() {
			if (isClientTab()) renderSettings();
		}

		const showWindowHook = window.showWindow.bind(window);
		const getSettingsHook = settingsWindow.getSettings.bind(settingsWindow);
		const changeTabHook = settingsWindow.changeTab.bind(settingsWindow);
		const searchHook = settingsWindow.searchList.bind(settingsWindow);
		let searchRenderTimer: number | undefined;

		window.showWindow = (...args: unknown[]) => {
			const result = showWindowHook(...args);

			if (args[0] === 1) {
				if (settingsWindow.settingType === 'basic') settingsWindow.toggleType({ checked: true });
				const advSliderElem: HTMLInputElement = document.querySelector('.advancedSwitch input#typeBtn');
				advSliderElem.disabled = true;
				advSliderElem.nextElementSibling.setAttribute('title', 'WOK Client auto-enables advanced settings mode');

				// We check the search query here because krunker reloads the search each time the settings page is closed/reopened, causing any client settings to be erased
				const searchQuery = (document.getElementById('settSearch') as (HTMLInputElement | undefined))?.value ?? "";
				if (isClientTab() || searchQuery.length > 0) renderSettings();
			}

			if (args[0] === 4) {
				// This makes the model viewer link open in a new window. Krunker doesn't currently have it set to target _blank for some reason.
				const modelViewerElement = Array.from(document.getElementsByClassName('menuLink')).find((elem: Element) => {
					if (elem instanceof HTMLElement) {
						elem.innerText === "Model Viewer"
					}
				});
				if (modelViewerElement) modelViewerElement.setAttribute('target', '_blank');
			}

			return result;
		};

		// whenever we change tabs, if it's client tab, run renderSettings, otherwise remove our class
		settingsWindow.changeTab = (...args: unknown[]) => {
			const result = changeTabHook(...args);
			selectedTab = settingsWindow.tabIndex;

			safeRenderSettings();

			return result;
		};

		settingsWindow.getSettings = (...args: unknown[]) => {
			const result: string = getSettingsHook(...args);
			if (!_userPrefs.regionTimezones) return result;

			if (result.includes('window.setSetting("defaultRegion"') && result.match(regionOptionsRegex).length > 0) {
				const optionsHTML = result.match(regionOptionsRegex)[0];
				const optionElements = [...createElement('div', { innerHTML: optionsHTML }).children] as HTMLOptionElement[];

				for (let i = 0; i < optionElements.length; i++) {
					const opt = optionElements[i];
					// bad hack to fix it getting added multiple times (don't know why..)
					if (opt.textContent.includes("[")) continue;
					try {
						opt.textContent += ` ${getTimezoneByRegionKey('id', opt.value)}`;
					} catch (_error) {
						strippedConsole.error('Error getting timezone for: ', opt);
						opt.textContent += ' [??:??]';
					}
				}

				const tempHolder = document.createElement('div');
				optionElements.forEach(opt => tempHolder.appendChild(opt));

				const patchedHTML = tempHolder.innerHTML;
				return result.replace(optionsHTML, patchedHTML);
			}

			return result;
		};

		settingsWindow.searchList = (...args: unknown[]) => {
			// biome-ignore lint/suspicious/noExplicitAny: hook code, expected to be hacky
			const result: any = searchHook(...args); // Do normal krunker settings search things
			if (searchRenderTimer !== undefined) window.clearTimeout(searchRenderTimer);
			searchRenderTimer = window.setTimeout(() => {
				searchRenderTimer = undefined;
				renderSettings();
			}, 75);
			return result;
		}

		safeRenderSettings();
	}
	const waitForWindow0: TimerHandler = () => {
		if (
			Object.hasOwn(window, 'showWindow')
			&& typeof window.showWindow === 'function'
			&& Object.hasOwn(window, 'windows')
			&& Array.isArray(window.windows)
			&& window.windows.length >= 0
			&& typeof window.windows[0] !== 'undefined'
			&& typeof window.windows[0].changeTab === 'function'
		) {
			stopWaiting();
			window.removeEventListener('beforeunload', stopWaitingOnUnload);
			strippedConsole.log('hooking settings');
			hookSettings();
		}
	}
	interval = window.setInterval(waitForWindow0, 250);
	timeout = window.setTimeout(() => {
		stopWaiting();
		strippedConsole.warn('WOK Client stopped waiting for Krunker settings APIs after 30 seconds.');
	}, 30_000);
}
