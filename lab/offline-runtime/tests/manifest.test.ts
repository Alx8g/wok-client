import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
	resolveRuntimeCandidateManifest,
	validateRuntimeCandidateManifest,
	type RuntimeCandidateManifest
} from '../src/candidate/manifest.ts';
import { resolveRuntimeLabScenario, validateRuntimeLabScenario } from '../src/scenario/manifest.ts';
import { sha256Hex } from '../src/shared/hash.ts';

const repositoryRoot = join(import.meta.dirname, '..', '..', '..');
const testOutputRoot = join(repositoryRoot, '.working', 'runtime-lab', 'tests');
await mkdir(testOutputRoot, { recursive: true });

type CandidateManifestFixture = Omit<
	Extract<RuntimeCandidateManifest, { runtimeKind: 'electron' }>,
	'capabilities' | 'runtimeKind'
> & {
	capabilities: {
		devToolsProtocol: boolean;
		presentMon: boolean;
	};
	runtimeKind: string;
};

function createCandidateManifest(
	overrides: Partial<CandidateManifestFixture> = {}
): CandidateManifestFixture {
	return {
		adapterVersion: 1,
		build: {
			distribution: 'WOK test runtime',
			sourceRevision: 'abc123',
			version: '1.0.0'
		},
		capabilities: {
			devToolsProtocol: false,
			presentMon: true
		},
		executable: {
			path: './runtime.exe',
			sha256: sha256Hex('runtime-binary')
		},
		graphics: {
			requestedBackend: 'd3d11'
		},
		id: 'candidate-a',
		label: 'Candidate A',
		launch: {
			additionalArguments: ['--disable-features=CalculateNativeWinOcclusion']
		},
		protocolVersion: 1,
		runtimeKind: 'electron',
		...overrides
	};
}

test('candidate manifest verifies a content-addressed executable before resolving it', async () => {
	const directory = await mkdtemp(join(testOutputRoot, 'candidate-manifest-'));
	const manifestPath = join(directory, 'candidate.json');
	await writeFile(join(directory, 'runtime.exe'), 'runtime-binary');
	const manifestBytes = Buffer.from(
		JSON.stringify(createCandidateManifest()),
		'utf8'
	);
	await writeFile(manifestPath, manifestBytes);

	const resolved = await resolveRuntimeCandidateManifest(manifestPath);
	assert.equal(resolved.manifest.id, 'candidate-a');
	assert.equal(resolved.executableSha256, sha256Hex('runtime-binary'));
	assert.equal(resolved.executableSizeBytes, 14);
	assert.equal(resolved.manifestSha256, sha256Hex(manifestBytes));
	assert.equal(resolved.executablePath, join(directory, 'runtime.exe'));
});

test('candidate manifests expose only implemented runtime capability contracts', () => {
	const electron = validateRuntimeCandidateManifest(
		createCandidateManifest()
	);
	assert.equal(electron.runtimeKind, 'electron');
	assert.equal(electron.capabilities.devToolsProtocol, false);
	assert.equal(electron.capabilities.presentMon, true);

	const chromium = validateRuntimeCandidateManifest(
		createCandidateManifest({
			capabilities: {
				devToolsProtocol: true,
				presentMon: true
			},
			runtimeKind: 'chromium'
		})
	);
	assert.equal(chromium.runtimeKind, 'chromium');
	assert.equal(chromium.capabilities.devToolsProtocol, true);
	assert.equal(chromium.capabilities.presentMon, true);

	for (const runtimeKind of ['cef', 'webview2']) {
		assert.throws(
			() => validateRuntimeCandidateManifest(
				createCandidateManifest({ runtimeKind })
			),
			/runtimeKind is not supported/u
		);
	}
	assert.throws(
		() => validateRuntimeCandidateManifest(
			createCandidateManifest({
				capabilities: {
					devToolsProtocol: false,
					presentMon: false
				}
			})
		),
		/presentMon must be true/u
	);
	assert.throws(
		() => validateRuntimeCandidateManifest(
			createCandidateManifest({
				capabilities: {
					devToolsProtocol: false,
					presentMon: true
				},
				runtimeKind: 'chromium'
			})
		),
		/devToolsProtocol must be true for chromium/u
	);
	assert.throws(
		() => validateRuntimeCandidateManifest(
			createCandidateManifest({
				capabilities: {
					devToolsProtocol: true,
					presentMon: true
				}
			})
		),
		/devToolsProtocol must be false for electron/u
	);
});

test('candidate manifest rejects a changed executable and controller-owned arguments', async () => {
	const directory = await mkdtemp(join(testOutputRoot, 'candidate-mismatch-'));
	const manifestPath = join(directory, 'candidate.json');
	await writeFile(join(directory, 'runtime.exe'), 'changed-runtime-binary');
	await writeFile(manifestPath, JSON.stringify(createCandidateManifest()));
	await assert.rejects(resolveRuntimeCandidateManifest(manifestPath), /SHA-256 mismatch/u);

	assert.throws(
		() =>
			validateRuntimeCandidateManifest(
				createCandidateManifest({ launch: { additionalArguments: ['--user-data-dir=shared-profile'] } })
			),
		/controller-owned argument/u
	);
	assert.throws(
		() =>
			validateRuntimeCandidateManifest(
				createCandidateManifest({ launch: { additionalArguments: ['C:\\other-host'] } })
			),
		/positional arguments/u
	);
	assert.throws(
		() =>
			validateRuntimeCandidateManifest(
				createCandidateManifest({ launch: { additionalArguments: ['--trace-upload-url=https://example.com'] } })
			),
		/cannot contain a URL/u
	);
	assert.throws(
		() => validateRuntimeCandidateManifest(createCandidateManifest({ id: '../escape' })),
		/filesystem-safe identifier/u
	);
});

test('scenario manifests expose only implemented tier and input contracts', async () => {
	const scenarioDirectory = join(
		repositoryRoot,
		'lab',
		'offline-runtime',
		'scenarios'
	);
	const tier1 = await resolveRuntimeLabScenario(
		join(scenarioDirectory, 'tier1-calibration-v1.json')
	);
	assert.equal(tier1.scenario.id, 'tier1-calibration-v1');
	assert.equal(tier1.scenario.tier, 1);
	assert.equal(tier1.scenario.inputMode, 'off');
	assert.equal(tier1.scenario.networkPolicy, 'loopback-only');
	assert.equal(tier1.scenario.profilePolicy, 'fresh');
	assert.equal(
		tier1.manifestSha256,
		sha256Hex(await readFile(tier1.manifestPath))
	);

	const tier3 = await resolveRuntimeLabScenario(
		join(scenarioDirectory, 'tier3-synthetic-input-v1.json')
	);
	assert.equal(tier3.scenario.id, 'tier3-synthetic-input-v1');
	assert.equal(tier3.scenario.tier, 3);
	assert.equal(tier3.scenario.inputMode, 'synthetic');
	assert.equal(
		tier3.manifestSha256,
		sha256Hex(await readFile(tier3.manifestPath))
	);

	assert.equal(
		validateRuntimeLabScenario({
			...tier1.scenario,
			benchmarkMs: 300_000
		}).benchmarkMs,
		300_000
	);
	assert.throws(
		() => validateRuntimeLabScenario({
			...tier1.scenario,
			benchmarkMs: 300_001
		}),
		/benchmarkMs must be an integer from 1000 through 300000/u
	);

	for (const tier of [2, 4]) {
		assert.throws(
			() => validateRuntimeLabScenario({
				...tier1.scenario,
				tier
			}),
			/tier must be 1 or 3/u
		);
	}
	assert.throws(
		() => validateRuntimeLabScenario({
			...tier1.scenario,
			inputMode: 'synthetic'
		}),
		/tier 1 scenarios must use inputMode off/u
	);
	assert.throws(
		() => validateRuntimeLabScenario({
			...tier3.scenario,
			inputMode: 'off'
		}),
		/tier 3 scenarios must use inputMode synthetic/u
	);
	assert.throws(
		() => validateRuntimeLabScenario({
			...tier1.scenario,
			networkPolicy: 'internet-enabled'
		}),
		/loopback-only/u
	);
	assert.throws(
		() => validateRuntimeLabScenario({
			...tier1.scenario,
			unexpected: true
		}),
		/not supported/u
	);
});
