import assert from 'node:assert/strict';
import test from 'node:test';
import type { ImportCandidate } from '../src/onboarding-import.ts';
import { buildOnboardingPage, onboardingPageUrl, onboardingRenderCall } from '../src/onboarding-window.ts';
import { ONBOARDING_STEPS } from '../src/onboarding.ts';

const LOGO = '<svg id="wok-lockup"></svg>';

function page(candidates: ImportCandidate[] = []): string {
	return buildOnboardingPage({ candidates, logoSvg: LOGO });
}

test('every step in the flow has a section on the page', () => {
	const html = page();
	for (const step of ONBOARDING_STEPS) assert.match(html, new RegExp(`data-step="${step}"`));
});

test('every step except the last offers a way out of it', () => {
	const html = page();
	const sections = html.split('<section data-step="').slice(1);
	assert.equal(sections.length, ONBOARDING_STEPS.length);
	for (const section of sections) {
		const step = section.slice(0, section.indexOf('"'));
		if (step === 'done') continue;
		const skips = /data-action="quit"/.test(section) || /data-action="next"[^>]*>(Not now|Skip|Start fresh|Continue)</.test(section);
		assert.ok(skips, `step ${step} has no skip`);
	}
});

test('the welcome step can abandon setup outright', () => {
	assert.match(page(), /data-action="quit"/);
});

test('the performance step asks for the measurement without promising it now', () => {
	const html = page();
	assert.match(html, /Measure my PC/);
	assert.match(html, /runs on your next launch, so you can play now either way/);
	assert.match(html, /data-choices="\{&quot;competitiveMode&quot;:true,&quot;measurePc&quot;:true\}"/);
});

test('the settings step asks only about the handful worth asking on day one', () => {
	const html = page();
	const prefs = [...html.matchAll(/data-pref="([^"]+)"/g)].map(match => match[1]);
	assert.deepEqual(prefs, ['performanceOverlay', 'fullscreen', 'discordRPC']);
});

test('the window mode control offers the three day-one modes', () => {
	const html = page();
	const options = [...html.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]);
	assert.deepEqual(options, ['windowed', 'maximized', 'fullscreen']);
});

test('the done step points at Settings and leaves room for the follow-up line', () => {
	const html = page();
	assert.match(html, /Change any of this in Settings &rarr; WOK\./);
	assert.match(html, /data-note hidden/);
});

test('a detected client becomes a labelled import button carrying its id', () => {
	const html = page([{ id: 'kcc', kind: 'importable', label: 'Krunker Civilian Client', path: '/kcc.json' }]);
	assert.match(html, /Import from Krunker Civilian Client/);
	assert.match(html, /data-choices="\{&quot;importFrom&quot;:&quot;kcc&quot;\}"/);
	assert.match(html, /Start fresh/);
});

test('an already-migrated Crankshaft profile is stated, never offered as a button', () => {
	const html = page([{ id: 'crankshaft', kind: 'already-imported', label: 'Crankshaft', path: '' }]);
	assert.match(html, /Your Crankshaft settings came across already\./);
	assert.doesNotMatch(html, /Import from Crankshaft/);
	assert.match(html, /Nothing left to bring across\./);
});

test('the inlined logo is the only thing the page loads', () => {
	const html = page();
	assert.ok(html.includes(LOGO));
	assert.doesNotMatch(html, /<img|<link|src="http|@import/);
});

test('a client label cannot inject markup into the page', () => {
	const html = page([{
		id: 'kcc',
		kind: 'importable',
		label: '<script>alert(1)</script>',
		path: '/kcc.json'
	}]);
	assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
	assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('a step view is handed to the page as an escaped literal call', () => {
	const call = onboardingRenderCall({ index: 0, stepId: 'welcome', total: 4 });
	assert.equal(call, 'window.wokRenderOnboarding({"index":0,"stepId":"welcome","total":4})');
	assert.doesNotMatch(onboardingRenderCall({ index: 1, note: '</script>', stepId: 'done', total: 4 }), /<\/script>/);
});

test('the page is loaded as an encoded data URL', () => {
	const url = onboardingPageUrl('<html>a b</html>');
	assert.equal(url, 'data:text/html;charset=utf-8,%3Chtml%3Ea%20b%3C%2Fhtml%3E');
});
