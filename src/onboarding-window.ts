/**
 * The first-run setup page. Generated here rather than shipped as an asset for the same reason the
 * calibration pages are: the window is sandboxed and context-isolated with no preload and no IPC
 * surface, so the only things it receives are this HTML and the step views main.ts passes to
 * `window.wokRenderOnboarding`.
 *
 * Every word the user reads lives in this file, so the copy is reviewable and testable in one
 * place. The page script itself is deliberately generic: it shows one section, applies the defaults
 * it was handed, collects `data-pref` controls, and resolves with the button's `data-choices`.
 * Which step comes next, and what any of it means, is decided in src/onboarding.ts.
 */

import type { ImportCandidate } from './onboarding-import.ts';
import { ONBOARDING_WINDOW_MODES } from './onboarding.ts';

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function embedJson(value: unknown): string {
	return JSON.stringify(value).replaceAll('<', '\\u003c');
}

function styles(): string {
	return `
			:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
			* { box-sizing: border-box; }
			html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #0A0A0A; color: #FFFFFF; }
			body { display: grid; place-items: center; padding: 24px; }
			[hidden] { display: none !important; }
			.shell { width: min(620px, 100%); border: 1px solid #343434; background: #111111; }
			.accent { height: 4px; background: #FBC02D; }
			.content { padding: 28px; }
			.brand { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 26px; }
			.brand svg { width: 104px; height: auto; }
			.pill { padding: 6px 9px; border: 1px solid #383838; background: #181818; color: #A6A6A6; font: 600 11px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: .08em; }
			h1 { margin: 0 0 10px; font-size: 26px; line-height: 1.15; }
			p { margin: 0 0 10px; color: #C4C4C4; font-size: 15px; line-height: 1.55; }
			p.small { color: #8B8B8B; font-size: 13px; line-height: 1.5; }
			.fields { display: grid; gap: 2px; margin: 20px 0 4px; }
			.field { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 14px; padding: 14px 0; border-top: 1px solid #262626; }
			.field:last-child { border-bottom: 1px solid #262626; }
			.field-name { font-size: 15px; font-weight: 600; }
			.field-desc { grid-column: 1; color: #8B8B8B; font-size: 12px; line-height: 1.45; }
			.field input[type="checkbox"], .field select { grid-row: 1 / 3; grid-column: 2; }
			.field input[type="checkbox"] { width: 20px; height: 20px; accent-color: #FBC02D; cursor: pointer; }
			.field select { min-width: 150px; border: 1px solid #444444; background: #191919; color: #FFFFFF; padding: 9px 10px; font: 600 14px/1.2 inherit; cursor: pointer; }
			.sources { display: grid; gap: 8px; margin: 18px 0 14px; }
			.note { margin-top: 16px; border-left: 2px solid #FBC02D; padding: 2px 0 2px 12px; color: #E6D083; font-size: 13px; line-height: 1.5; }
			.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 24px; }
			.actions .spacer { flex: 1; }
			button { min-width: 130px; border: 1px solid #444444; background: #191919; color: #FFFFFF; padding: 12px 16px; font: 700 14px/1.2 inherit; cursor: pointer; }
			button:hover { border-color: #FBC02D; }
			button:focus-visible { outline: 2px solid #FBC02D; outline-offset: 2px; }
			button.primary { border-color: #FBC02D; background: #FBC02D; color: #0A0A0A; }
			button.quiet { min-width: 0; border-color: transparent; background: transparent; color: #8B8B8B; padding: 12px 8px; font-weight: 600; }
			button.quiet:hover { border-color: transparent; color: #FFFFFF; }
			button.source { min-width: 0; width: 100%; text-align: left; }
		`;
}

interface ActionButton {
	choices?: Record<string, unknown>;
	/** Adds every data-pref control in the step to the reported choices. */
	collectPreferences?: boolean;
	kind: 'back' | 'next' | 'quit';
	label: string;
	style?: 'primary' | 'quiet' | 'source';
}

function actionMarkup(button: ActionButton): string {
	const classes = button.style ? ` class="${button.style}"` : '';
	const choices = button.choices ? ` data-choices="${escapeHtml(JSON.stringify(button.choices))}"` : '';
	const collect = button.collectPreferences ? ' data-collect="prefs"' : '';
	return `<button type="button"${classes} data-action="${button.kind}"${choices}${collect}>${escapeHtml(button.label)}</button>`;
}

function stepMarkup(id: string, body: string, actions: ActionButton[], leadingActions: ActionButton[] = []): string {
	const leading = leadingActions.map(actionMarkup).join('');
	return `<section data-step="${id}" hidden>
				${body}
				<div class="actions">${leading}<span class="spacer"></span>${actions.map(actionMarkup).join('')}</div>
			</section>`;
}

const BACK_ACTION: ActionButton = { kind: 'back', label: 'Back', style: 'quiet' };

function welcomeStep(): string {
	return stepMarkup(
		'welcome',
		`<h1>Welcome to WOK</h1>
				<p>A Krunker client that measures your PC and sets the game up to run as fast as it can.</p>
				<p class="small">A few questions. Skip any of them.</p>`,
		[
			{ kind: 'quit', label: 'Skip setup', style: 'quiet' },
			{ kind: 'next', label: 'Get started', style: 'primary' }
		]
	);
}

function performanceStep(): string {
	return stepMarkup(
		'performance',
		`<h1>Make it fast</h1>
				<p>WOK can measure your PC and apply the graphics setup that runs fastest on it.</p>
				<p class="small">It also lowers in-game visuals for more frames. The measurement runs on your next launch, so you can play now either way.</p>`,
		[
			{ kind: 'next', label: 'Not now', style: 'quiet' },
			{ choices: { competitiveMode: true, measurePc: true }, kind: 'next', label: 'Measure my PC', style: 'primary' }
		],
		[BACK_ACTION]
	);
}

function importStep(candidates: readonly ImportCandidate[]): string {
	const importable = candidates.filter(candidate => candidate.kind === 'importable');
	const alreadyImported = candidates.filter(candidate => candidate.kind === 'already-imported');
	const sources = importable
		.map(candidate => actionMarkup({
			choices: { importFrom: candidate.id },
			kind: 'next',
			label: `Import from ${candidate.label}`,
			style: 'source'
		}))
		.join('');
	const alreadyLine = alreadyImported.length > 0
		? `<p class="small">Your ${escapeHtml(alreadyImported.map(candidate => candidate.label).join(' and '))} settings came across already.</p>`
		: '';

	return stepMarkup(
		'import',
		`<h1>Bring your settings</h1>
				<p>${importable.length > 0 ? 'Found another Krunker client on this PC.' : 'Nothing left to bring across.'}</p>
				${alreadyLine}
				<div class="sources">${sources}</div>
				<p class="small">Only settings WOK understands are copied. Features WOK ships switched off stay off.</p>`,
		[{ kind: 'next', label: importable.length > 0 ? 'Start fresh' : 'Continue', style: importable.length > 0 ? 'quiet' : 'primary' }],
		[BACK_ACTION]
	);
}

function settingsStep(): string {
	const modes = ONBOARDING_WINDOW_MODES
		.map(mode => `<option value="${escapeHtml(mode)}">${escapeHtml(mode)}</option>`)
		.join('');
	return stepMarkup(
		'settings',
		`<h1>A few basics</h1>
				<p>The rest are already set sensibly.</p>
				<div class="fields">
					<div class="field">
						<span class="field-name">FPS overlay</span>
						<input type="checkbox" data-pref="performanceOverlay" aria-label="FPS overlay">
						<span class="field-desc">FPS, frame times and ping in the corner.</span>
					</div>
					<div class="field">
						<span class="field-name">Window mode</span>
						<select data-pref="fullscreen" aria-label="Window mode">${modes}</select>
						<span class="field-desc">Fullscreen gives the smoothest frames.</span>
					</div>
					<div class="field">
						<span class="field-name">Discord status</span>
						<input type="checkbox" data-pref="discordRPC" aria-label="Discord status">
						<span class="field-desc">Shows what you are playing on your Discord profile.</span>
					</div>
				</div>`,
		[
			{ kind: 'next', label: 'Skip', style: 'quiet' },
			{ collectPreferences: true, kind: 'next', label: 'Save', style: 'primary' }
		],
		[BACK_ACTION]
	);
}

function doneStep(): string {
	return stepMarkup(
		'done',
		`<h1>You're set</h1>
				<p>Change any of this in Settings &rarr; WOK.</p>
				<p class="note" data-note hidden></p>`,
		[{ kind: 'next', label: 'Play', style: 'primary' }]
	);
}

export interface OnboardingPageOptions {
	candidates: readonly ImportCandidate[];
	/** Horizontal WOK lockup (assets/full_logo.svg), inlined so the page needs no file access. */
	logoSvg: string;
}

export function buildOnboardingPage(options: OnboardingPageOptions): string {
	return `<!doctype html>
	<html lang="en">
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<title>WOK Client setup</title>
		<style>${styles()}</style>
	</head>
	<body>
		<main class="shell">
			<div class="accent"></div>
			<div class="content">
				<div class="brand">${options.logoSvg}<span class="pill" id="progress"></span></div>
				${welcomeStep()}
				${performanceStep()}
				${importStep(options.candidates)}
				${settingsStep()}
				${doneStep()}
			</div>
		</main>
		<script>
			'use strict';
			const STEP_SECTIONS = Array.from(document.querySelectorAll('[data-step]'));
			const PROGRESS = document.getElementById('progress');
			let releaseActiveStep = null;

			// One render, one resolved action. Main drives the sequence, so the page never decides
			// what comes next - it only reports what was clicked.
			window.wokRenderOnboarding = view => new Promise(resolve => {
				if (releaseActiveStep) releaseActiveStep();
				const active = STEP_SECTIONS.find(section => section.dataset.step === view.stepId);
				for (const section of STEP_SECTIONS) section.hidden = section !== active;
				PROGRESS.textContent = 'STEP ' + (view.index + 1) + ' / ' + view.total;
				if (!active) {
					resolve({ kind: 'quit' });
					return;
				}

				const defaults = view.defaults || {};
				for (const input of active.querySelectorAll('[data-pref]')) {
					const key = input.dataset.pref;
					if (!Object.hasOwn(defaults, key)) continue;
					if (input.type === 'checkbox') input.checked = defaults[key] === true;
					else input.value = String(defaults[key]);
				}

				const note = active.querySelector('[data-note]');
				if (note) {
					note.textContent = view.note || '';
					note.hidden = !view.note;
				}

				const onClick = event => {
					const button = event.target.closest('[data-action]');
					if (!button || !active.contains(button)) return;
					const choices = button.dataset.choices ? JSON.parse(button.dataset.choices) : {};
					if (button.dataset.collect === 'prefs') {
						for (const input of active.querySelectorAll('[data-pref]')) {
							choices[input.dataset.pref] = input.type === 'checkbox' ? input.checked : input.value;
						}
					}
					releaseActiveStep();
					resolve({ choices, kind: button.dataset.action });
				};
				releaseActiveStep = () => {
					active.removeEventListener('click', onClick);
					releaseActiveStep = null;
				};
				active.addEventListener('click', onClick);
				const primary = active.querySelector('button.primary');
				if (primary) primary.focus();
			});
		</script>
	</body>
	</html>`;
}

export function onboardingPageUrl(html: string): string {
	return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export interface OnboardingStepView {
	defaults?: Record<string, unknown>;
	index: number;
	note?: string;
	stepId: string;
	total: number;
}

export function onboardingRenderCall(view: OnboardingStepView): string {
	return `window.wokRenderOnboarding(${embedJson(view)})`;
}
