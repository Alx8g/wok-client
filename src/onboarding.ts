/**
 * First-run setup: which steps run, what the user picked, and the marker that keeps it to once.
 *
 * Pure and Electron-free. main.ts owns the window, the marker file, and applying the outcome; this
 * module owns every decision, so the flow can be tested without a renderer.
 *
 * Two rules shape it:
 *
 * 1. Nothing here can block first play. The performance step schedules calibration for the *next*
 *    launch rather than relaunching into it, matching the fresh-install rule in main.ts (design
 *    §4.1) that startup only ever detours through calibration to resume a flow already consented to.
 * 2. Nothing here writes a preference it did not validate. Choices arrive from a renderer, so every
 *    patch leaves through parseUserPreferencePatch and unknown or malformed values are dropped.
 *
 * The marker is versioned rather than boolean (the settings-baseline.ts pattern): bumping
 * ONBOARDING_VERSION deliberately re-triggers setup for installs that already ran an older one.
 */

import { IMPORT_CLIENT_IDS, type ImportClientId } from './onboarding-import.ts';
import { parseUserPreferencePatch } from './user-preferences.ts';

export const ONBOARDING_VERSION = 1;

export interface OnboardingMarker {
	completedAt: number;
	version: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseOnboardingMarker(value: unknown): OnboardingMarker | undefined {
	if (!isRecord(value) || !Number.isInteger(value.version) || Number(value.version) < 1) return undefined;
	return {
		completedAt: typeof value.completedAt === 'number' && Number.isFinite(value.completedAt) ? value.completedAt : 0,
		version: Number(value.version)
	};
}

export function createOnboardingMarker(now: number = Date.now()): OnboardingMarker {
	return { completedAt: now, version: ONBOARDING_VERSION };
}

/**
 * A marker that exists but cannot be parsed leaves setup alone: an unreadable file is ambiguous
 * evidence, and re-running a wizard someone already completed is worse than never showing it again.
 * Settings always offers it manually.
 */
export function shouldRunOnboarding(marker: OnboardingMarker | undefined, markerUnreadable = false): boolean {
	if (markerUnreadable) return false;
	return (marker?.version ?? 0) < ONBOARDING_VERSION;
}

export const ONBOARDING_STEPS = ['welcome', 'performance', 'import', 'settings', 'done'] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number];

/** Window modes offered on day one. Borderless stays in Settings; three options is already plenty. */
export const ONBOARDING_WINDOW_MODES = ['windowed', 'maximized', 'fullscreen'] as const;

export interface OnboardingChoices {
	competitiveMode?: boolean;
	discordRPC?: boolean;
	fullscreen?: string;
	importFrom?: ImportClientId;
	/** Queue calibration for the next launch; never runs during this session. */
	measurePc?: boolean;
	performanceOverlay?: boolean;
}

export type OnboardingAction =
	| { choices: OnboardingChoices; kind: 'next' }
	| { kind: 'back' }
	| { kind: 'quit' };

function parseBooleanChoice(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
}

/** Renderer input. Anything unrecognised is dropped rather than carried into a preference patch. */
export function parseOnboardingChoices(value: unknown): OnboardingChoices {
	if (!isRecord(value)) return {};
	const choices: OnboardingChoices = {};
	const competitiveMode = parseBooleanChoice(value.competitiveMode);
	if (competitiveMode !== undefined) choices.competitiveMode = competitiveMode;
	const discordRPC = parseBooleanChoice(value.discordRPC);
	if (discordRPC !== undefined) choices.discordRPC = discordRPC;
	const performanceOverlay = parseBooleanChoice(value.performanceOverlay);
	if (performanceOverlay !== undefined) choices.performanceOverlay = performanceOverlay;
	const measurePc = parseBooleanChoice(value.measurePc);
	if (measurePc !== undefined) choices.measurePc = measurePc;
	if (typeof value.fullscreen === 'string' && (ONBOARDING_WINDOW_MODES as readonly string[]).includes(value.fullscreen)) {
		choices.fullscreen = value.fullscreen;
	}
	if (typeof value.importFrom === 'string' && (IMPORT_CLIENT_IDS as readonly string[]).includes(value.importFrom)) {
		choices.importFrom = value.importFrom as ImportClientId;
	}
	return choices;
}

/** A closed window, a dead renderer, or anything unrecognised means the user is done: quit. */
export function parseOnboardingAction(value: unknown): OnboardingAction {
	if (!isRecord(value)) return { kind: 'quit' };
	if (value.kind === 'back') return { kind: 'back' };
	if (value.kind !== 'next') return { kind: 'quit' };
	return { choices: parseOnboardingChoices(value.choices), kind: 'next' };
}

export interface OnboardingFlow {
	choices: OnboardingChoices;
	finished: boolean;
	index: number;
	steps: OnboardingStepId[];
}

/**
 * The import step only exists when there is something to import from, so an install with no other
 * client never sees a step that can only say "nothing found".
 */
export function createOnboardingFlow(options: { includeImport: boolean }): OnboardingFlow {
	return {
		choices: {},
		finished: false,
		index: 0,
		steps: ONBOARDING_STEPS.filter(step => step !== 'import' || options.includeImport)
	};
}

export function currentOnboardingStep(flow: OnboardingFlow): OnboardingStepId | undefined {
	if (flow.finished) return undefined;
	return flow.steps[flow.index];
}

export function advanceOnboardingFlow(flow: OnboardingFlow, action: OnboardingAction): OnboardingFlow {
	if (flow.finished) return flow;
	if (action.kind === 'quit') return { ...flow, finished: true };
	if (action.kind === 'back') return { ...flow, index: Math.max(0, flow.index - 1) };

	const index = flow.index + 1;
	return {
		// A step revisited through Back overwrites what it recorded the first time; a skipped step
		// sends no choices and therefore changes nothing.
		choices: { ...flow.choices, ...action.choices },
		finished: index >= flow.steps.length,
		index: Math.min(index, flow.steps.length - 1),
		steps: flow.steps
	};
}

export interface OnboardingOutcome {
	importFrom?: ImportClientId;
	/** Validated, already diffed against current preferences: empty means nothing to write. */
	preferences: Partial<UserPrefs>;
	scheduleCalibration: boolean;
}

/**
 * Turns collected choices into the preference patch to persist. Values are validated exactly as a
 * settings-UI update is, then reduced to the ones that actually differ, so skipping a step or
 * leaving a control alone never rewrites settings.json.
 */
export function planOnboardingOutcome(
	choices: OnboardingChoices,
	current: Readonly<Partial<UserPrefs>> = {}
): OnboardingOutcome {
	const requested: Record<string, unknown> = {};
	if (choices.competitiveMode !== undefined) requested.competitiveMode = choices.competitiveMode;
	if (choices.performanceOverlay !== undefined) requested.performanceOverlay = choices.performanceOverlay;
	if (choices.discordRPC !== undefined) requested.discordRPC = choices.discordRPC;
	if (choices.fullscreen !== undefined) requested.fullscreen = choices.fullscreen;

	const validated = parseUserPreferencePatch(requested);
	const preferences: Partial<UserPrefs> = {};
	for (const [key, value] of Object.entries(validated)) {
		if (current[key] !== value) preferences[key] = value;
	}

	return {
		...(choices.importFrom ? { importFrom: choices.importFrom } : {}),
		preferences,
		// Competitive mode without a measurement still runs on the heuristic recommendation, so
		// declining the measurement is a complete, working answer rather than a half-configured one.
		scheduleCalibration: choices.measurePc === true
	};
}

/**
 * The single closing line, or nothing when the run changed nothing. Window mode, the FPS overlay
 * and the graphics profile are all read at launch, so this says so instead of implying they are
 * already live.
 */
export function describeOnboardingFollowUp(outcome: OnboardingOutcome, importedPreferences = false): string | undefined {
	if (outcome.scheduleCalibration) return 'Your PC gets measured the next time you launch WOK.';
	if (importedPreferences || Object.keys(outcome.preferences).length > 0) return 'These apply the next time you launch WOK.';
	return undefined;
}
