import {
	type CustomIdentity,
	customIdentitiesAreEqual,
	EMPTY_CUSTOM_IDENTITY,
	extractClanTag,
	formatCustomIdentityLabel,
	mergeRealIdentityCandidates,
	readGameActivityName,
	resolveConfiguredRealIdentity,
	resolveCustomIdentity
} from './custom-identity.ts';
import { createIdentityTextRewriter, type IdentityMutationRecord, type IdentityRewriteEngine, type IdentityRewriteNode, type IdentityTextRewriter, startIdentityRewriteEngine } from './identity-rewrite.ts';
const DISCOVERY_INTERVAL_MS = 1000;
const DISCOVERY_MAX_ATTEMPTS = Number.POSITIVE_INFINITY;
export const DISCOVERY_FAST_ATTEMPTS = 60;
export const DISCOVERY_SLOW_INTERVAL_MS = 5000;
export interface RealIdentityDiscoveryOptions {
	clearTimer(handle: number): void;
	getGameActivity(): unknown;
	intervalMs?: number;
	maxAttempts?: number;
	onName(name: string): void;
	setTimer(callback: () => void, delayMs: number): number;
}
export function startRealIdentityDiscovery(options: RealIdentityDiscoveryOptions): () => void {
	const intervalMs = options.intervalMs ?? DISCOVERY_INTERVAL_MS;
	const maxAttempts = options.maxAttempts ?? DISCOVERY_MAX_ATTEMPTS;
	let attempts = 0;
	let timer: number | undefined;
	let cancelled = false;
	const attempt = () => {
		timer = undefined;
		if (cancelled) return;
		attempts += 1;
		const name = readGameActivityName(options.getGameActivity());
		if (name !== '') {
			options.onName(name);
			return;
		}
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
	getGameActivity(): unknown;
	root(): IdentityRewriteNode | undefined;
	schedule(callback: () => void): unknown;
	setTimer(callback: () => void, delayMs: number): number;
	unschedule(handle: unknown): void;
}
function ambientEnvironment(): CustomIdentityEnvironment | undefined {
	if (typeof document === 'undefined' || typeof window === 'undefined') return undefined;
	return {
		clearTimer: (handle) => {
			window.clearTimeout(handle);
		},
		createObserver: (callback) =>
			new MutationObserver((records) => {
				callback(records as unknown as IdentityMutationRecord[]);
			}),
		getGameActivity: () => (typeof window.getGameActivity === 'function' ? () => window.getGameActivity() : undefined),
		...(diagnosticSink ? { onDiagnostic: diagnosticSink } : {}),
		root: () => (document.body ?? document.documentElement) as unknown as IdentityRewriteNode,
		schedule: (callback) =>
			requestAnimationFrame(() => {
				callback();
			}),
		setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
		unschedule: (handle) => {
			cancelAnimationFrame(handle as number);
		}
	};
}
let environment: CustomIdentityEnvironment | undefined;
let engine: IdentityRewriteEngine | undefined;
let stopDiscovery: (() => void) | undefined;
let currentIdentity: CustomIdentity = EMPTY_CUSTOM_IDENTITY;
let configuredReal: CustomIdentity = EMPTY_CUSTOM_IDENTITY;
let diagnosticSink: ((message: string) => void) | undefined;
export function setCustomIdentityDiagnostic(sink: (message: string) => void): void {
	diagnosticSink = sink;
}
let discoveredName = '';
let discoveredClan = '';
let currentLabel = '';
let engineSignature = '';
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
	if (currentLabel === '') return [];
	const real = formatCustomIdentityLabel(getRealIdentityForDisplay());
	const matching = real === '' ? 'real name not detected yet' : `matching ${real}`;
	return [`local name    ${currentLabel}`, `local swap    ${engine ? `${engine.rewrittenNodeCount} live` : 'idle'} - ${matching}`];
}
function stopEngine(): void {
	if (!engine) return;
	engine.restoreAll();
	engine.stop();
	engine = undefined;
	engineSignature = '';
}
function reconcile(): void {
	const env = environment;
	if (!env) {
		stopEngine();
		return;
	}
	const candidates = mergeRealIdentityCandidates(configuredReal, { clan: discoveredClan, name: discoveredName });
	const rewriter = createIdentityTextRewriter({
		clans: candidates.clans,
		displayClan: currentIdentity.clan,
		displayName: currentIdentity.name,
		names: candidates.names
	});
	const learningClan = currentIdentity.clan !== '' && candidates.clans.length === 0 && candidates.names.length > 0;
	if (!rewriter && !learningClan) {
		stopEngine();
		return;
	}
	const signature = JSON.stringify([currentIdentity, candidates, learningClan]);
	if (engine && signature === engineSignature) return;
	stopEngine();
	const root = env.root();
	if (!root) return;
	const names = candidates.names;
	const rewrite: IdentityTextRewriter = learningClan
		? (text) => {
				if (discoveredClan !== '') return rewriter?.(text);
				for (const name of names) {
					const tag = extractClanTag(text, name);
					if (tag === '') continue;
					discoveredClan = tag;
					env.schedule(() => {
						reconcile();
					});
					break;
				}
				return rewriter?.(text);
			}
		: rewriter;
	if (!rewrite) return;
	engineSignature = signature;
	engine = startIdentityRewriteEngine({
		createObserver: (callback) => env.createObserver(callback),
		rewrite,
		root,
		schedule: (callback) => env.schedule(callback),
		unschedule: (handle) => {
			env.unschedule(handle);
		}
	});
}
function ensureDiscovery(): void {
	const env = environment;
	if (stopDiscovery || !env) return;
	if (currentIdentity.name === '' && currentIdentity.clan === '') return;
	env.onDiagnostic?.(`discovery starting; custom name=${JSON.stringify(currentIdentity.name)} clan=${JSON.stringify(currentIdentity.clan)}`);
	stopDiscovery = startRealIdentityDiscovery({
		clearTimer: (handle) => {
			env.clearTimer(handle);
		},
		getGameActivity: () => {
			const activity = env.getGameActivity();
			env.onDiagnostic?.(`poll: getGameActivity resolved to ${typeof activity}`);
			return activity;
		},
		onName: (name) => {
			env.onDiagnostic?.(`discovered real name ${JSON.stringify(name)}`);
			if (name === discoveredName) return;
			discoveredName = name;
			reconcile();
		},
		setTimer: (callback, delayMs) => env.setTimer(callback, delayMs)
	});
}
export function applyCustomIdentity(prefs: Readonly<Partial<UserPrefs>> | undefined, nextEnvironment?: CustomIdentityEnvironment): Readonly<CustomIdentity> {
	environment = nextEnvironment ?? environment ?? ambientEnvironment();
	const identity = resolveCustomIdentity(prefs);
	const real = resolveConfiguredRealIdentity(prefs);
	const unchanged = customIdentitiesAreEqual(identity, currentIdentity) && customIdentitiesAreEqual(real, configuredReal);
	currentIdentity = identity;
	configuredReal = real;
	currentLabel = formatCustomIdentityLabel(identity);
	if (unchanged && engine) return currentIdentity;
	ensureDiscovery();
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
	}
}
export function stopCustomIdentityDisplay(): void {
	stopDiscovery?.();
	stopDiscovery = undefined;
	stopEngine();
	environment = undefined;
	currentIdentity = EMPTY_CUSTOM_IDENTITY;
	configuredReal = EMPTY_CUSTOM_IDENTITY;
	discoveredName = '';
	discoveredClan = '';
	currentLabel = '';
}
