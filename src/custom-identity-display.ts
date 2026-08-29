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

/** The cadence used by Krunker's old full-fragment RGB name treatment. */
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

/** Align a newly inserted fragment with one process-wide RGB timeline. */
export function identityRgbAnimationDelayMs(nowMs = Date.now()): number {
	if (!Number.isFinite(nowMs)) return 0;
	const phase = ((Math.floor(nowMs) % IDENTITY_RGB_CYCLE_DURATION_MS) + IDENTITY_RGB_CYCLE_DURATION_MS)
		% IDENTITY_RGB_CYCLE_DURATION_MS;
	return phase === 0 ? 0 : -phase;
}

export interface RealIdentityDiscoveryOptions {
	clearTimer(handle: number): void;
	/** Hands back Krunker's own getGameActivity, or undefined while the game has not defined it. */
	getGameActivity(): unknown;
	/** Reads the currently rendered local alias/clan, including a Premium display name. */
	getRenderedIdentity?(): Readonly<Partial<CustomIdentity>> | undefined;
	/** Menu-safe account-name fallback used when no rendered alias is available yet. */
	getSavedIdentityName?(): unknown;
	intervalMs?: number;
	maxAttempts?: number;
	onClan?(clan: string): void;
	onName(name: string): void;
	/** Keep polling after finding a name until a clan is found (or the watch is cancelled). */
	requireClan?: boolean;
	setTimer(callback: () => void, delayMs: number): number;
}

/**
 * Poll Krunker's rendered menu identity and game-activity object until the displayed player name
 * is known. The rendered value wins because Premium replaces the account username with an alias.
 *
 * Polling rather than hooking: these values appear during the game's own start-up and WOK has no
 * stable event for them. The cadence eases off after launch and stops once the requested identity
 * pieces are authoritative.
 */
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
		// A Premium account renders an alias instead of krunker_username. A rendered value equal to
		// the saved username is therefore only the ordinary account card, not a Premium alias. Keep
		// that value provisional so an alias such as Goat can still win later; the order remains
		// Premium alias > activity identity > saved account username.
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
	/** Watches the stable document root so a replacement body can be rebound automatically. */
	observeRoot?(callback: () => void): IdentityRewriteObserver;
	getGameActivity(): unknown;
	/** Reads the current local alias/clan from Krunker's own menu identity elements. */
	getRenderedIdentity?(): Readonly<Partial<CustomIdentity>> | undefined;
	/** Reads the same saved account username Krunker's menu/profile components use. */
	getSavedIdentityName?(): unknown;
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
		observeRoot: callback => {
			const observer = new MutationObserver(() => { callback(); });
			if (document.documentElement) observer.observe(document.documentElement, { childList: true });
			return observer;
		},
		// Handed back as a callable rather than the raw property so it is still invoked as a method
		// on window, the way Krunker's own code calls it.
		// A typeof check is the whole test. Requiring an own property as well was the bug that kept
		// detection from ever firing: the diagnostic probe read the name through typeof alone,
		// while this guard rejected the same function, so the feature silently fell back to the
		// name the user typed in by hand.
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
let currentRgbCycle = false;
/** Set only while the identity probe is enabled, so normal sessions carry no diagnostic cost. */
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
/** Saved username retained as a search candidate after a Premium alias becomes authoritative. */
let savedNameCandidate = '';
let currentLabel = '';
let engineSignature = '';
let engineRoot: IdentityRewriteNode | undefined;
let rootObserver: IdentityRewriteObserver | undefined;

/**
 * The text the renderer should display and decorate. With RGB enabled, blank custom fields mean
 * "keep the real value" rather than "render nothing", so the toggle works by itself while custom
 * aliases still override whichever halves the user configured.
 */
function effectiveDisplayIdentity(): CustomIdentity {
	return {
		clan: currentIdentity.clan || (currentRgbCycle ? configuredReal.clan || discoveredClan : ''),
		name: currentIdentity.name || (currentRgbCycle ? configuredReal.name || discoveredName : '')
	};
}

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

	// Keep the source node as the engine's record key. It is detached only after its data carries the
	// applied value, which lets restoreAll use the same echo check as the text-only path.
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
	/*
	 * Krunker reports the name but never the clan tag. So when a custom clan is set and the real
	 * one is still unknown, the engine also watches: every text node that mentions the real name
	 * is checked for a '[TAG] Name' rendering. One sighting is enough, and the engine is rebuilt
	 * with a real clan rule as soon as it happens.
	 */
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
			// Already found, waiting on the deferred rebuild: stop looking.
			if (discoveredClan !== '') return detailedRewriter?.(text);
			for (const name of names) {
				const tag = extractClanTag(text, name);
				if (tag === '') continue;
				discoveredClan = tag;
				// Rebuilding from inside the walk would pull the engine out from under the
				// flush, so defer it to the next frame.
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
	// Nothing to search for and nothing to show: do not start polling at all. RGB is itself a
	// display request, even with blank aliases, because it decorates the real local identity.
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
		active.flush();
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
	currentRgbCycle = false;
	syncRgbStyles(false);
	discoveredName = '';
	discoveredClan = '';
	savedNameCandidate = '';
	currentLabel = '';
}
