import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { buildRuntimeLaunchPlan, buildSanitizedEnvironment } from '../src/adapter/launch-plan.ts';
import type {
	ResolvedRuntimeCandidate,
	RuntimeCandidateManifest,
	RuntimeKind
} from '../src/candidate/manifest.ts';
import type { RuntimeLabScenario } from '../src/scenario/manifest.ts';

const repositoryRoot = join(import.meta.dirname, '..', '..', '..');
const runDirectory = join(repositoryRoot, '.working', 'runtime-lab', 'runs', 'test-run');
const electronHostDirectory = join(repositoryRoot, 'lab', 'offline-runtime', 'hosts', 'electron');

const scenario: RuntimeLabScenario = {
	benchmarkMs: 30_000,
	claimBoundary: 'Test claim boundary.',
	id: 'tier1-calibration-v1',
	inputMode: 'off',
	minSamples: 120,
	networkPolicy: 'loopback-only',
	profilePolicy: 'fresh',
	protocolVersion: 1,
	tier: 1,
	tracePolicy: 'disabled-for-headline-runs',
	viewport: {
		cssHeight: 720,
		cssWidth: 1_280,
		deviceScaleFactor: 1
	}
};

function createCandidate(runtimeKind: RuntimeKind): ResolvedRuntimeCandidate {
	const commonManifest = {
		adapterVersion: 1 as const,
		build: { distribution: 'Test', version: '1' },
		executable: { path: 'candidate.exe', sha256: 'a'.repeat(64) },
		graphics: { requestedBackend: 'd3d11' as const },
		id: 'candidate-a',
		label: 'Candidate A',
		launch: { additionalArguments: ['--enable-gpu-rasterization'] },
		protocolVersion: 1 as const
	};
	const manifest: RuntimeCandidateManifest = runtimeKind === 'chromium'
		? {
			...commonManifest,
			capabilities: {
				devToolsProtocol: true,
				presentMon: true
			},
			runtimeKind
		}
		: {
			...commonManifest,
			capabilities: {
				devToolsProtocol: false,
				presentMon: true
			},
			runtimeKind
		};
	return {
		executablePath: 'C:\\runtimes\\candidate.exe',
		executableSha256: 'a'.repeat(64),
		executableSizeBytes: 1,
		manifest,
		manifestPath: 'C:\\runtimes\\candidate.json',
		manifestSha256: 'b'.repeat(64)
	};
}

test('Electron launch plan isolates profile, environment, network and host app', () => {
	const plan = buildRuntimeLaunchPlan({
		candidate: createCandidate('electron'),
		electronHostDirectory,
		pageUrl: 'http://127.0.0.1:45123/v1/pages/page/hash.html?run=test',
		runDirectory,
		scenario,
		sourceEnvironment: {
			GITHUB_TOKEN: 'must-not-leak',
			PATH: 'C:\\Windows\\System32',
			TEMP: 'C:\\Temp'
		}
	});

	assert.equal(plan.kind, 'electron');
	assert.equal(plan.command, 'C:\\runtimes\\candidate.exe');
	assert.equal(plan.arguments.at(-1), electronHostDirectory);
	assert.ok(plan.arguments.includes(`--user-data-dir=${join(runDirectory, 'profile')}`));
	assert.ok(plan.arguments.includes('--proxy-server=http=127.0.0.1:9;https=127.0.0.1:9'));
	assert.ok(plan.arguments.includes('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'));
	assert.ok(plan.arguments.includes('--use-angle=d3d11'));
	assert.equal(plan.environment.GITHUB_TOKEN, undefined);
	assert.equal(plan.environment.PATH, 'C:\\Windows\\System32');
	assert.equal(plan.environment.WOK_RUNTIME_LAB_CANDIDATE_ID, 'candidate-a');
	assert.match(plan.environment.WOK_RUNTIME_LAB_PAGE_URL ?? '', /^http:\/\/127\.0\.0\.1:/u);
});

test('Chromium launch plan uses the same isolated policy and app URL', () => {
	const plan = buildRuntimeLaunchPlan({
		candidate: createCandidate('chromium'),
		electronHostDirectory,
		pageUrl: 'http://127.0.0.1:45123/v1/pages/page/hash.html?run=test',
		runDirectory,
		scenario
	});
	assert.equal(plan.kind, 'chromium');
	assert.ok(plan.arguments.includes('--remote-debugging-port=0'));
	assert.match(plan.arguments.at(-1) ?? '', /^--app=http:\/\/127\.0\.0\.1:/u);
	assert.equal(plan.environment.WOK_RUNTIME_LAB_PAGE_URL, undefined);
});

test('launch planning rejects external origins and relative run roots', () => {
	assert.throws(
		() =>
			buildRuntimeLaunchPlan({
				candidate: createCandidate('chromium'),
				electronHostDirectory,
				pageUrl: 'https://example.com/',
				runDirectory,
				scenario
			}),
		/127\.0\.0\.1/u
	);
	assert.throws(
		() =>
			buildRuntimeLaunchPlan({
				candidate: createCandidate('chromium'),
				electronHostDirectory,
				pageUrl: 'http://127.0.0.1:45123/',
				runDirectory: 'relative-run',
				scenario
			}),
		/runDirectory must be absolute/u
	);
});

test('sanitized launch environment does not inherit credential-bearing variables', () => {
	const environment = buildSanitizedEnvironment({
		AWS_SECRET_ACCESS_KEY: 'secret',
		GITHUB_TOKEN: 'secret',
		Path: 'C:\\Windows',
		USERPROFILE: 'C:\\Users\\test'
	});
	assert.deepEqual(environment, {
		Path: 'C:\\Windows',
		USERPROFILE: 'C:\\Users\\test'
	});
});

test('dedicated Electron host is renderer-isolated and has no production preload', async () => {
	const source = await readFile(join(electronHostDirectory, 'main.cjs'), 'utf8');
	assert.match(source, /nodeIntegration: false/u);
	assert.match(source, /contextIsolation: true/u);
	assert.match(source, /sandbox: true/u);
	assert.match(source, /setPermissionRequestHandler/u);
	assert.match(source, /onBeforeRequest/u);
	assert.match(source, /emitWindowState\('window-blur'/u);
	assert.match(source, /emitWindowState\('window-focus'/u);
	assert.match(source, /emitWindowState\('web-contents-blur'/u);
	assert.match(source, /emitWindowState\('web-contents-focus'/u);
	assert.doesNotMatch(source, /preload\s*:/u);
	assert.doesNotMatch(source, /krunker|websocket/iu);
});
