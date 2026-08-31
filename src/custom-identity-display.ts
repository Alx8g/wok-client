import {
	type CustomIdentity,
	customIdentitiesAreEqual,
	EMPTY_CUSTOM_IDENTITY,
	extractClanTag,
	formatCustomIdentityLabel,
	isPlausibleRealName,
	mergeRealIdentityCandidates,
	readGameActivityName,
	resolveConfiguredRealIdentity,
	sanitizeCustomClan,
	resolveCustomIdentity,
	resolveCustomIdentityRgbCycle
} from './custom-identity.ts';
import {
	createIdentityTextRewrite,
	IDENTITY_RGB_CLASS,
	IDENTITY_RGB_MARKER_ATTRIBUTE,
	type IdentityMutationRecord,
	type IdentityRewriteApplication,
	type IdentityRewriteEngine,
	type IdentityRewriteObserver,
	type IdentityRewriteNode,
	type IdentityTextRewrite,
	type IdentityTextRewriteResolver,
	type IdentityTextRewriter,
	startIdentityRewriteEngine
} from './identity-rewrite.ts';

const DISCOVERY_INTERVAL_MS = 1_000;

const DISCOVERY_MAX_ATTEMPTS = Number.POSITIVE_INFINITY;

export const DISCOVERY_FAST_ATTEMPTS = 60;

export const DISCOVERY_SLOW_INTERVAL_MS = 5_000;

export const IDENTITY_RGB_CYCLE_DURATION_MS = 500;
const IDENTITY_RGB_DELAY_PROPERTY = '--wok-identity-rgb-delay';
const IDENTITY_RGB_STYLE_ID = 'wokIdentityRgbCycleStyle';
const IDENTITY_RGB_STYLE = `
@keyframes wokIdentityRgbCycle {
	0%, 100% { color: #ff0000; }
	14.285% { color: #ff8000; }
	28.571% { color: #ffff00; }
	42.857% { color: #00ff00; }
	57.142% { color: #00ffff; }
	71.428% { color: #0000ff; }
	85.714% { color: #ff00ff; }
}
.${IDENTITY_RGB_CLASS} {
	animation: wokIdentityRgbCycle ${IDENTITY_RGB_CYCLE_DURATION_MS}ms linear infinite;
	animation-delay: var(${IDENTITY_RGB_DELAY_PROPERTY}, 0ms);
}
`;

export function identityRgbAnimationDelayMs(nowMs = Date.now()): number {
	if (!Number.isFinite(nowMs)) return 0;
	const phase = ((Math.floor(nowMs) % IDENTITY_RGB_CYCLE_DURATION_MS) + IDENTITY_RGB_CYCLE_DURATION_MS)
		% IDENTITY_RGB_CYCLE_DURATION_MS;
	return phase === 0 ? 0 : -phase;
}

export interface RealIdentityDiscoveryOptions {
	clearTimer(handle: number): void;

	getGameActivity(): unknown;

	getRenderedIdentity?(): Readonly<Partial<CustomIdentity>> | undefined;

	getSavedIdentityName?(): unknown;
	intervalMs?: number;
	maxAttempts?: number;
	onClan?(clan: string): void;
	onName(name: string): void;

	requireClan?: boolean;
	setTimer(callback: () => void, delayMs: number): number;
}

export function startRealIdentityDiscovery(options: RealIdentityDiscoveryOptions): () => void {
	const intervalMs = options.intervalMs ?? DISCOVERY_INTERVAL_MS;
	const maxAttempts = options.maxAttempts ?? DISCOVERY_MAX_ATTEMPTS;
	let attempts = 0;
	let timer: number | undefined;
	let cancelled = false;
	let reportedClan = '';
	let reportedName = '';

	const attempt = () => {
		timer = undefined;
		if (cancelled) return;
		attempts += 1;

		const rendered = options.getRenderedIdentity?.();
		const renderedName = isPlausibleRealName(rendered?.name) ? rendered.name : '';
		const renderedClan = sanitizeCustomClan(rendered?.clan);
		const activityName = readGameActivityName(options.getGameActivity());
		const savedValue = options.getSavedIdentityName?.();
		const savedName = isPlausibleRealName(savedValue) ? savedValue : '';

		const premiumAlias = renderedName !== '' && renderedName !== savedName ? renderedName : '';
		const authoritativeName = premiumAlias || activityName;
		const name = authoritativeName || savedName;
		if (name !== '' && name !== reportedName) {
			reportedName = name;
			options.onName(name);
		}
		if (renderedClan !== '' && renderedClan !== reportedClan) {
			reportedClan = renderedClan;
			options.onClan?.(renderedClan);
		}
		if (authoritativeName !== '' && (!options.requireClan || reportedClan !== '')) return;
		if (attempts >= maxAttempts) return;

		const nextInterval = attempts >= DISCOVERY_FAST_ATTEMPTS ? Math.max(intervalMs, DISCOVERY_SLOW_INTERVAL_MS) : intervalMs;
		timer = options.setTimer(attempt, nextInterval);
	};

	attempt();
	return () => {
		cancelled = true;
		if (timer !== undefined) options.clearTimer(timer);
		timer = undefined;
	};
}

export interface CustomIdentityEnvironment {
	clearTimer(handle: number): void;

	onDiagnostic?(message: string): void;
	createObserver(callback: (records: readonly IdentityMutationRecord[]) => void): {
		disconnect(): void;
		observe(target: IdentityRewriteNode, options?: unknown): void;
	};

	observeRoot?(callback: () => void): IdentityRewriteObserver;
	getGameActivity(): unknown;

	getRenderedIdentity?(): Readonly<Partial<CustomIdentity>> | undefined;

	getSavedIdentityName?(): unknown;

	root(): IdentityRewriteNode | undefined;
	schedule(callback: () => void): unknown;
	setTimer(callback: () => void, delayMs: number): number;
	unschedule(handle: unknown): void;
}

function ambientEnvironment(): CustomIdentityEnvironment | undefined {
	if (typeof document === 'undefined' || typeof window === 'undefined') return undefined;
	return {
		clearTimer: handle => { window.clearTimeout(handle); },
		createObserver: callback => new MutationObserver(records => { callback(records as unknown as IdentityMutationRecord[]); }),
		observeRoot: callback => {
			const observer = new MutationObserver(() => { callback(); });
			if (document.documentElement) observer.observe(document.documentElement, { childList: true });
			return observer;
		},

		getGameActivity: () => (typeof window.getGameActivity === 'function'
			? () => window.getGameActivity()
			: undefined),
		getRenderedIdentity: () => {
			const name = document.querySelector('#menuClassNameTag .menuClassPlayerName')?.textContent?.trim() ?? '';
			const clanText = document.querySelector('#menuClassNameTag .menuClassPlayerClan')?.textContent?.trim() ?? '';
			return {
				clan: clanText.replace(/^\[|\]$/gu, '').trim(),
				name
			};
		},
		getSavedIdentityName: () => {
			const getSavedVal = (window as unknown as { getSavedVal?: (key: string) => unknown }).getSavedVal;
			if (typeof getSavedVal !== 'function') return undefined;
			try {
				return getSavedVal('krunker_username');
			} catch (_error) {
				return undefined;
			}
		},
		...(diagnosticSink ? { onDiagnostic: diagnosticSink } : {}),

		root: () => (document.body ?? document.documentElement) as unknown as IdentityRewriteNode,

		schedule: callback => requestAnimationFrame(() => { callback(); }),
		setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
		unschedule: handle => { cancelAnimationFrame(handle as number); }
	};
}

let environment: CustomIdentityEnvironment | undefined;
let engine: IdentityRewriteEngine | undefined;
let stopDiscovery: (() => void) | undefined;
let currentIdentity: CustomIdentity = EMPTY_CUSTOM_IDENTITY;
let configuredReal: CustomIdentity = EMPTY_CUSTOM_IDENTITY;
let currentRgbCycle = false;

let diagnosticSink: ((message: string) => void) | undefined;

function syncRgbStyles(enabled: boolean): void {
	if (typeof document === 'undefined') return;
	const existing = document.getElementById(IDENTITY_RGB_STYLE_ID);
	if (!enabled) {
		existing?.remove();
		return;
	}
	if (existing?.tagName === 'STYLE') {
		if (existing.textContent !== IDENTITY_RGB_STYLE) existing.textContent = IDENTITY_RGB_STYLE;
		return;
	}
	existing?.remove();
	const style = document.createElement('style');
	style.id = IDENTITY_RGB_STYLE_ID;
	style.textContent = IDENTITY_RGB_STYLE;
	(document.head ?? document.body ?? document.documentElement)?.appendChild(style);
}

export function setCustomIdentityDiagnostic(sink: (message: string) => void): void {
	diagnosticSink = sink;
}

let discoveredName = '';
let discoveredClan = '';

let savedNameCandidate = '';
let currentLabel = '';
let engineSignature = '';
let engineRoot: IdentityRewriteNode | undefined;
let rootObserver: IdentityRewriteObserver | undefined;

function effectiveDisplayIdentity(): CustomIdentity {
	return {
		clan: currentIdentity.clan || (currentRgbCycle ? configuredReal.clan || discoveredClan : ''),
		name: currentIdentity.name || (currentRgbCycle ? configuredReal.name || discoveredName : '')
	};
}

export function getCustomIdentity(): Readonly<CustomIdentity> {
	return currentIdentity;
}

export function getRealIdentityForDisplay(): Readonly<CustomIdentity> {
	return {
		clan: configuredReal.clan || discoveredClan,
		name: configuredReal.name || discoveredName
	};
}

export function getCustomIdentityOverlayLines(): string[] {
	if (currentLabel === '' && !currentRgbCycle) return [];
	const real = formatCustomIdentityLabel(getRealIdentityForDisplay());
	const displayed = formatCustomIdentityLabel(effectiveDisplayIdentity()) || 'detecting current identity';
	const matching = real === '' ? 'real name not detected yet' : `matching ${real}`;
	return [
		`local name    ${displayed}${currentRgbCycle ? ' (RGB)' : ''}`,
		`local swap    ${engine ? `${engine.rewrittenNodeCount} live` : 'idle'} - ${matching}`
	];
}

function applyIdentityRgbRewrite(
	node: IdentityRewriteNode,
	_original: string,
	rewrite: IdentityTextRewrite
): IdentityRewriteApplication | undefined {
	if (!currentRgbCycle || node.nodeType !== 3 || typeof document === 'undefined') return undefined;
	const textNode = node as unknown as Text;
	const parent = textNode.parentNode;
	const ownerDocument = textNode.ownerDocument;
	if (!parent || !ownerDocument) return undefined;

	const fragments = [...rewrite.fragments]
		.sort((first, second) => first.start - second.start)
		.filter(fragment => (
			Number.isInteger(fragment.start)
			&& Number.isInteger(fragment.end)
			&& fragment.start >= 0
			&& fragment.end > fragment.start
			&& fragment.end <= rewrite.text.length
		));
	if (fragments.length === 0) return undefined;

	const generated: Node[] = [];
	const markedTextNodes: Text[] = [];
	const container = ownerDocument.createDocumentFragment();
	let cursor = 0;
	for (const fragment of fragments) {
		if (fragment.start < cursor) return undefined;
		if (fragment.start > cursor) {
			const surrounding = ownerDocument.createTextNode(rewrite.text.slice(cursor, fragment.start));
			container.appendChild(surrounding);
			generated.push(surrounding);
		}
		const marker = ownerDocument.createElement('span');
		marker.className = IDENTITY_RGB_CLASS;
		marker.setAttribute(IDENTITY_RGB_MARKER_ATTRIBUTE, '');
		marker.style.setProperty(IDENTITY_RGB_DELAY_PROPERTY, `${identityRgbAnimationDelayMs()}ms`);
		const identityText = ownerDocument.createTextNode(rewrite.text.slice(fragment.start, fragment.end));
		marker.appendChild(identityText);
		container.appendChild(marker);
		generated.push(marker);
		markedTextNodes.push(identityText);
		cursor = fragment.end;
	}
	if (cursor < rewrite.text.length) {
		const surrounding = ownerDocument.createTextNode(rewrite.text.slice(cursor));
		container.appendChild(surrounding);
		generated.push(surrounding);
	}
	if (markedTextNodes.length === 0) return undefined;

	textNode.data = rewrite.text;
	parent.replaceChild(container, textNode);
	let restored = false;
	return {
		connectedNode: generated.find(child => child.nodeType === 1) as IdentityRewriteNode | undefined,
		node,
		applied: rewrite.text,
		original: _original,
		restore: () => {
			if (restored) return;
			restored = true;
			const surviving = generated.filter(child => child.parentNode === parent);
			const first = surviving[0];
			if (!first) {
				textNode.data = _original;
				return;
			}
			const allSurvive = surviving.length === generated.length
				&& surviving.every((child, index) => child === generated[index]);
			const visible = surviving.map(child => child.textContent ?? '').join('');
			textNode.data = allSurvive && visible === rewrite.text ? _original : visible;
			parent.insertBefore(textNode, first);
			for (const child of surviving) child.parentNode?.removeChild(child);
		}
	};
}

function stopRootObserver(): void {
	rootObserver?.disconnect();
	rootObserver = undefined;
	engineRoot = undefined;
}

function watchRoot(env: CustomIdentityEnvironment, root: IdentityRewriteNode): void {
	const rootChanged = () => {
		if (environment !== env || env.root() === root) return;
		reconcile();
	};
	if (env.observeRoot) {
		rootObserver = env.observeRoot(rootChanged);
		return;
	}
	const parent = root.parentNode;
	if (!parent) return;
	rootObserver = env.createObserver(() => { rootChanged(); });
	rootObserver.observe(parent, { childList: true });
}

function stopEngine(): void {
	if (engine) {
		engine.restoreAll();
		engine.stop();
	}
	engine = undefined;
	engineSignature = '';
	stopRootObserver();
}

function reconcile(): void {
	const env = environment;
	if (!env) {
		stopEngine();
		return;
	}

	const candidates = mergeRealIdentityCandidates(configuredReal, {
		clan: discoveredClan,
		name: discoveredName
	});
	if (savedNameCandidate !== '' && !candidates.names.includes(savedNameCandidate)) candidates.names.push(savedNameCandidate);
	const displayIdentity = effectiveDisplayIdentity();
	const detailedRewriter = createIdentityTextRewrite({
		clans: candidates.clans,
		decorateUnchanged: currentRgbCycle,
		displayClan: displayIdentity.clan,
		displayName: displayIdentity.name,
		names: candidates.names
	});
	const rewriter: IdentityTextRewriter | undefined = detailedRewriter
		? (text: string) => detailedRewriter(text)?.text
		: undefined;

	const learningClan = (currentIdentity.clan !== '' || currentRgbCycle)
		&& candidates.clans.length === 0
		&& candidates.names.length > 0;
	if (!rewriter && !learningClan) {
		stopEngine();
		return;
	}

	const root = env.root();
	if (!root) {
		stopEngine();
		return;
	}
	const signature = JSON.stringify([currentIdentity, candidates, learningClan, currentRgbCycle]);
	if (engine && signature === engineSignature && root === engineRoot) return;
	stopEngine();

	const names = candidates.names;
	const detailed: IdentityTextRewriteResolver | undefined = learningClan
		? text => {

			if (discoveredClan !== '') return detailedRewriter?.(text);
			for (const name of names) {
				const tag = extractClanTag(text, name);
				if (tag === '') continue;
				discoveredClan = tag;

				env.schedule(() => { reconcile(); });
				break;
			}
			return detailedRewriter?.(text);
		}
		: detailedRewriter;
	const rewrite: IdentityTextRewriter | undefined = detailed
		? text => detailed(text)?.text
		: undefined;
	if (!rewrite || !detailed) return;

	engineSignature = signature;
	engine = startIdentityRewriteEngine({
		applyRewrite: applyIdentityRgbRewrite,
		createObserver: callback => env.createObserver(callback),
		isExcluded: node => node.hasAttribute?.(IDENTITY_RGB_MARKER_ATTRIBUTE) === true,
		rewrite,
		rewriteDetailed: detailed,
		root,
		schedule: callback => env.schedule(callback),
		unschedule: handle => { env.unschedule(handle); }
	});
	engineRoot = root;
	watchRoot(env, root);
}

function ensureDiscovery(): void {
	const env = environment;
	if (stopDiscovery || !env) return;

	if (currentIdentity.name === '' && currentIdentity.clan === '' && !currentRgbCycle) return;

	env.onDiagnostic?.(`discovery starting; custom name=${JSON.stringify(currentIdentity.name)} clan=${JSON.stringify(currentIdentity.clan)}`);
	stopDiscovery = startRealIdentityDiscovery({
		clearTimer: handle => { env.clearTimer(handle); },
		getGameActivity: () => {
			const activity = env.getGameActivity();
			env.onDiagnostic?.(`poll: getGameActivity resolved to ${typeof activity}`);
			return activity;
		},
		getRenderedIdentity: () => withRealIdentity(() => env.getRenderedIdentity?.()),
		getSavedIdentityName: () => {
			const savedValue = env.getSavedIdentityName?.();
			const savedName = isPlausibleRealName(savedValue) ? savedValue : '';
			if (savedName === savedNameCandidate) return savedValue;
			savedNameCandidate = savedName;
			if (engine) env.schedule(() => { reconcile(); });
			return savedValue;
		},
		onClan: clan => {
			env.onDiagnostic?.(`discovered rendered clan ${JSON.stringify(clan)}`);
			if (clan === discoveredClan) return;
			discoveredClan = clan;
			reconcile();
		},
		onName: name => {
			env.onDiagnostic?.(`discovered displayed name ${JSON.stringify(name)}`);
			if (name === discoveredName) return;
			discoveredName = name;
			reconcile();
		},
		requireClan: currentIdentity.clan !== '' || currentRgbCycle,
		setTimer: (callback, delayMs) => env.setTimer(callback, delayMs)
	});
}

export function applyCustomIdentity(
	prefs: Readonly<Partial<UserPrefs>> | undefined,
	nextEnvironment?: CustomIdentityEnvironment
): Readonly<CustomIdentity> {
	environment = nextEnvironment ?? environment ?? ambientEnvironment();

	const identity = resolveCustomIdentity(prefs);
	const real = resolveConfiguredRealIdentity(prefs);
	const rgbCycle = resolveCustomIdentityRgbCycle(prefs);
	const unchanged = customIdentitiesAreEqual(identity, currentIdentity)
		&& customIdentitiesAreEqual(real, configuredReal)
		&& rgbCycle === currentRgbCycle;
	currentIdentity = identity;
	configuredReal = real;
	currentRgbCycle = rgbCycle;
	currentLabel = formatCustomIdentityLabel(identity);
	syncRgbStyles(currentRgbCycle);
	if (unchanged && engine && environment?.root() === engineRoot) return currentIdentity;

	if (currentIdentity.name === '' && currentIdentity.clan === '' && !currentRgbCycle) {
		stopDiscovery?.();
		stopDiscovery = undefined;
	} else {
		ensureDiscovery();
	}
	reconcile();
	return currentIdentity;
}

export function withRealIdentity<T>(read: () => T): T {
	const active = engine;
	if (!active || active.rewrittenNodeCount === 0) return read();
	active.restoreAll();
	try {
		return read();
	} finally {
		active.refresh();
		active.flush();
	}
}

export function stopCustomIdentityDisplay(): void {
	stopDiscovery?.();
	stopDiscovery = undefined;
	stopEngine();
	environment = undefined;
	currentIdentity = EMPTY_CUSTOM_IDENTITY;
	configuredReal = EMPTY_CUSTOM_IDENTITY;
	currentRgbCycle = false;
	syncRgbStyles(false);
	discoveredName = '';
	discoveredClan = '';
	savedNameCandidate = '';
	currentLabel = '';
}
