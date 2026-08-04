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
import {
	createIdentityTextRewriter,
	type IdentityMutationRecord,
	type IdentityRewriteEngine,
	type IdentityRewriteNode,
	type IdentityTextRewriter,
	startIdentityRewriteEngine
} from './identity-rewrite.ts';

/**
 * Local display identity: the renderer-side wiring.
 *
 * This module owns the two things the pure engine cannot do for itself - finding out what the
 * player is actually called, and keeping one engine alive against the live document - and it is
 * the only place the two meet.
 *
 * What it replaces: every text node under <body> that mentions the player's real name or clan
 * tag. That is chat lines the player sends, the kill feed, the in-game scoreboard, the end-of-
 * match leaderboard, the HUD, and the menu's account card, without this file knowing that any of
 * those exist. Working from the player's name instead of from Krunker's class names is what keeps
 * the feature alive across game updates.
 *
 * What it never touches: the network. Krunker still sends and receives the real account identity,
 * every other player still sees the real name, and text this client copies back out - the match
 * results button, Discord presence - is read through withRealIdentity() so the real name is what
 * leaves the process. Form fields and editable regions are excluded by the engine itself.
 *
 * What it costs when unused: nothing. This is a performance client, and the observer, the timer
 * and the walk only exist once a custom name or clan is set and there is a real one to search
 * for. Players who never open these settings never pay for them.
 */

/** Discovery retries at this cadence until Krunker's activity object exists and carries a name. */
const DISCOVERY_INTERVAL_MS = 1_000;

/**
 * Discovery must outlive the menu.
 *
 * Krunker's activity object only carries `user` once the player is in a match - it is game
 * activity, not account data. The previous minute-long ceiling therefore expired while the player
 * was still loading, signing in or picking a lobby, and by the time the name existed nothing was
 * watching for it: the feature silently required the name to be typed in by hand, which is the
 * thing it exists to avoid.
 *
 * Polling costs one function call at this cadence and stops permanently on the first name found,
 * so an open-ended watch is cheaper than the class of bug a ceiling creates. The cadence eases off
 * after the first minute so a client left on the menu all evening is not paying a per-second poll.
 */
const DISCOVERY_MAX_ATTEMPTS = Number.POSITIVE_INFINITY;

/** Attempts at the fast cadence before easing off; the first minute covers a normal launch. */
export const DISCOVERY_FAST_ATTEMPTS = 60;

/** Cadence once a name has not appeared quickly - the player is probably still in the menu. */
export const DISCOVERY_SLOW_INTERVAL_MS = 5_000;

export interface RealIdentityDiscoveryOptions {
	clearTimer(handle: number): void;
	/** Hands back Krunker's own getGameActivity, or undefined while the game has not defined it. */
	getGameActivity(): unknown;
	intervalMs?: number;
	maxAttempts?: number;
	onName(name: string): void;
	setTimer(callback: () => void, delayMs: number): number;
}

/**
 * Poll Krunker's game-activity object until it names the signed-in player, then stop.
 *
 * Polling rather than hooking: the object appears somewhere in the game's own start-up and this
 * client has no event for it, the same reason patchSettings() waits for window.windows[0]. One
 * call per second, each one a property read, and it ends the moment it succeeds.
 */
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
		// Ease off once a launch-time appearance is clearly not happening.
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

/** The ambient pieces of the renderer the runtime needs, injected so tests can supply their own. */
export interface CustomIdentityEnvironment {
	clearTimer(handle: number): void;
	/** Optional diagnostic sink; set only when the identity probe is enabled. */
	onDiagnostic?(message: string): void;
	createObserver(callback: (records: readonly IdentityMutationRecord[]) => void): {
		disconnect(): void;
		observe(target: IdentityRewriteNode, options?: unknown): void;
	};
	getGameActivity(): unknown;
	/** The subtree to watch. document.body in the renderer. */
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
		// Handed back as a callable rather than the raw property so it is still invoked as a method
		// on window, the way Krunker's own code calls it.
		// A typeof check is the whole test. Requiring an own property as well was the bug that kept
		// detection from ever firing: the diagnostic probe read the name through typeof alone,
		// while this guard rejected the same function, so the feature silently fell back to the
		// name the user typed in by hand.
		getGameActivity: () => (typeof window.getGameActivity === 'function'
			? () => window.getGameActivity()
			: undefined),
		...(diagnosticSink ? { onDiagnostic: diagnosticSink } : {}),
		// body may not exist in every document this runs in; documentElement always does, and the
		// engine only needs a subtree root to observe.
		root: () => (document.body ?? document.documentElement) as unknown as IdentityRewriteNode,
		// One frame of batching. Replacements land before the next paint, so nothing is ever seen
		// with the real name on it, and a burst of mutations still costs a single walk.
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
/** Set only while the identity probe is enabled, so normal sessions carry no diagnostic cost. */
let diagnosticSink: ((message: string) => void) | undefined;

export function setCustomIdentityDiagnostic(sink: (message: string) => void): void {
	diagnosticSink = sink;
}

let discoveredName = '';
let discoveredClan = '';
let currentLabel = '';
let engineSignature = '';

/** The custom identity currently being displayed. '' on either half means "use the real one". */
export function getCustomIdentity(): Readonly<CustomIdentity> {
	return currentIdentity;
}

/** What the client is searching the UI for, so the overlay can say whether it found anything. */
export function getRealIdentityForDisplay(): Readonly<CustomIdentity> {
	return {
		clan: configuredReal.clan || discoveredClan,
		name: configuredReal.name || discoveredName
	};
}

/**
 * Two diagnostic lines for the performance overlay, so the feature can be verified in-game
 * without a debugger: what is being shown, what is being searched for, and how many nodes are
 * currently carrying a replacement. Empty when the feature is off.
 */
export function getCustomIdentityOverlayLines(): string[] {
	if (currentLabel === '') return [];
	const real = formatCustomIdentityLabel(getRealIdentityForDisplay());
	const matching = real === '' ? 'real name not detected yet' : `matching ${real}`;
	return [
		`local name    ${currentLabel}`,
		`local swap    ${engine ? `${engine.rewrittenNodeCount} live` : 'idle'} - ${matching}`
	];
}

function stopEngine(): void {
	if (!engine) return;
	engine.restoreAll();
	engine.stop();
	engine = undefined;
	engineSignature = '';
}

/**
 * Rebuild the engine when, and only when, the rules it was built from have changed. The settings
 * UI live-applies on every keystroke, so an unchanged signature has to be free.
 */
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
	/*
	 * Krunker reports the name but never the clan tag. So when a custom clan is set and the real
	 * one is still unknown, the engine also watches: every text node that mentions the real name
	 * is checked for a '[TAG] Name' rendering. One sighting is enough, and the engine is rebuilt
	 * with a real clan rule as soon as it happens.
	 */
	const learningClan = currentIdentity.clan !== ''
		&& candidates.clans.length === 0
		&& candidates.names.length > 0;
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
		? text => {
			// Already found, waiting on the deferred rebuild: stop looking.
			if (discoveredClan !== '') return rewriter?.(text);
			for (const name of names) {
				const tag = extractClanTag(text, name);
				if (tag === '') continue;
				discoveredClan = tag;
				// Rebuilding from inside the walk would pull the engine out from under the
				// flush, so defer it to the next frame.
				env.schedule(() => { reconcile(); });
				break;
			}
			return rewriter?.(text);
		}
		: rewriter;
	if (!rewrite) return;

	engineSignature = signature;
	engine = startIdentityRewriteEngine({
		createObserver: callback => env.createObserver(callback),
		rewrite,
		root,
		schedule: callback => env.schedule(callback),
		unschedule: handle => { env.unschedule(handle); }
	});
}

function ensureDiscovery(): void {
	const env = environment;
	if (stopDiscovery || !env) return;
	// Nothing to search for and nothing to show: do not start polling at all.
	if (currentIdentity.name === '' && currentIdentity.clan === '') return;

	env.onDiagnostic?.(`discovery starting; custom name=${JSON.stringify(currentIdentity.name)} clan=${JSON.stringify(currentIdentity.clan)}`);
	stopDiscovery = startRealIdentityDiscovery({
		clearTimer: handle => { env.clearTimer(handle); },
		getGameActivity: () => {
			const activity = env.getGameActivity();
			env.onDiagnostic?.(`poll: getGameActivity resolved to ${typeof activity}`);
			return activity;
		},
		onName: name => {
			env.onDiagnostic?.(`discovered real name ${JSON.stringify(name)}`);
			if (name === discoveredName) return;
			discoveredName = name;
			reconcile();
		},
		setTimer: (callback, delayMs) => env.setTimer(callback, delayMs)
	});
}

/**
 * Apply a preferences object. Cheap enough for every keystroke in the settings UI: identical
 * values reconcile to the same signature and leave the running engine alone, and a client that
 * has no custom identity set never starts an observer or a timer at all.
 */
export function applyCustomIdentity(
	prefs: Readonly<Partial<UserPrefs>> | undefined,
	nextEnvironment?: CustomIdentityEnvironment
): Readonly<CustomIdentity> {
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

/**
 * Read something out of the game's DOM with the real name back in place.
 *
 * Everything this client copies out - the match-results button, Discord presence - goes through
 * here. A pasted scoreboard or a Discord status carrying a name nobody else can see would mislead
 * other people, which is exactly the line this feature stays on the right side of. Free when
 * nothing is currently replaced, and synchronous, so no frame is ever painted mid-restore.
 */
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

/** Tear everything down and hand the game's own text back. */
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
