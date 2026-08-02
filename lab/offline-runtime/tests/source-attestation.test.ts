import assert from 'node:assert/strict';
import {
	mkdir,
	mkdtemp,
	readFile,
	writeFile
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
	attestRuntimeControllerSources,
	getAttestedWokMarkSvg,
	getRuntimeControllerAttestationIdentity,
	persistAttestedRuntimeControllerElectronHost,
	persistAttestedRuntimeControllerSources,
	RUNTIME_CONTROLLER_SOURCE_INVENTORY,
	RUNTIME_CONTROLLER_SOURCE_INVENTORY_VERSION,
	type RuntimeControllerSourceAttestation,
	verifyRuntimeControllerElectronHost,
	verifyRuntimeControllerSourceInventory
} from '../src/controller/source-attestation.ts';
import { sha256Hex } from '../src/shared/hash.ts';

const repositoryRoot = join(
	import.meta.dirname,
	'..',
	'..',
	'..'
);
const testOutputRoot = join(
	repositoryRoot,
	'.working',
	'runtime-lab',
	'tests'
);
const electronHostSourceDirectory = join(
	repositoryRoot,
	'lab',
	'offline-runtime',
	'hosts',
	'electron'
);
await mkdir(testOutputRoot, { recursive: true });

const EXPECTED_SOURCE_NAMES = [
	'calibration',
	'calibration-benchmark',
	'calibration-parity',
	'calibration-window',
	'calibration-workload',
	'candidate-manifest',
	'chromium-devtools',
	'electron-host-main',
	'electron-host-package',
	'failure-classification',
	'etl-process-lifetimes',
	'graphics-profile',
	'launch-plan',
	'loopback-server',
	'native-etl-recorder',
	'native-etl-recorder-presentmon-patch',
	'native-etl-recorder-project',
	'noise-floor-cli',
	'presentmon-csv',
	'presentmon-etl',
	'process-resources',
	'run-cli',
	'runtime-protocol',
	'scenario-manifest',
	'shared-hash',
	'single-run',
	'source-attestation',
	'tournament-analysis',
	'tournament-cli',
	'tournament-controller',
	'tournament-dry-run',
	'tournament-dry-run-cli',
	'tournament-noise-floor',
	'tournament-plan',
	'tournament-policy',
	'tournament-result-evidence',
	'tournament-schedule',
	'windows-firewall',
	'windows-job',
	'windows-process-control',
	'windows-process-monitor',
	'windows-tool-process',
	'wok-mark'
] as const;

test('runtime controller source inventory is complete and explicitly versioned', async () => {
	assert.equal(
		RUNTIME_CONTROLLER_SOURCE_INVENTORY_VERSION,
		8
	);
	assert.equal(
		RUNTIME_CONTROLLER_SOURCE_INVENTORY.version,
		RUNTIME_CONTROLLER_SOURCE_INVENTORY_VERSION
	);
	assert.deepEqual(
		Object.keys(RUNTIME_CONTROLLER_SOURCE_INVENTORY.files),
		EXPECTED_SOURCE_NAMES
	);
	assert.equal(
		RUNTIME_CONTROLLER_SOURCE_INVENTORY.files.calibration,
		'src/calibration.ts'
	);
	assert.equal(
		RUNTIME_CONTROLLER_SOURCE_INVENTORY.files['calibration-window'],
		'src/calibration-window.ts'
	);
	assert.equal(
		RUNTIME_CONTROLLER_SOURCE_INVENTORY.files['calibration-workload'],
		'src/calibration-workload.ts'
	);
	assert.equal(
		RUNTIME_CONTROLLER_SOURCE_INVENTORY.files['calibration-benchmark'],
		'src/calibration-benchmark.ts'
	);
	assert.equal(
		RUNTIME_CONTROLLER_SOURCE_INVENTORY.files['wok-mark'],
		'assets/wok-mark.svg'
	);
	assert.equal(
		RUNTIME_CONTROLLER_SOURCE_INVENTORY.files['electron-host-main'],
		'lab/offline-runtime/hosts/electron/main.cjs'
	);
	assert.equal(
		RUNTIME_CONTROLLER_SOURCE_INVENTORY.files['electron-host-package'],
		'lab/offline-runtime/hosts/electron/package.json'
	);
	assert.equal(
		RUNTIME_CONTROLLER_SOURCE_INVENTORY.files[
			'native-etl-recorder-presentmon-patch'
		],
		'lab/offline-runtime/hosts/windows/presentmon-v2.5.1-wok-recorder.patch'
	);

	const verified = await verifyRuntimeControllerSourceInventory();
	assert.equal(
		verified.version,
		RUNTIME_CONTROLLER_SOURCE_INVENTORY_VERSION
	);
	assert.deepEqual(
		Object.keys(verified.sources),
		EXPECTED_SOURCE_NAMES
	);
	for (const source of Object.values(verified.sources)) {
		assert.match(source.sha256, /^[a-f0-9]{64}$/u);
		assert.ok(source.sizeBytes > 0);
	}
});

test('persisted source evidence preserves every attested byte', async () => {
	const directory = await mkdtemp(
		join(testOutputRoot, 'source-attestation-')
	);
	const evidenceDirectory = join(directory, 'controller-sources');
	await mkdir(evidenceDirectory);
	const attestation = await attestRuntimeControllerSources();
	const persisted = await persistAttestedRuntimeControllerSources(
		attestation,
		evidenceDirectory
	);

	assert.equal(
		persisted.version,
		RUNTIME_CONTROLLER_SOURCE_INVENTORY_VERSION
	);
	assert.deepEqual(
		Object.keys(persisted.sources),
		EXPECTED_SOURCE_NAMES
	);
	for (const source of Object.values(persisted.sources)) {
		const evidence = await readFile(source.evidencePath);
		assert.equal(source.sizeBytes, evidence.byteLength);
		assert.equal(source.sha256, sha256Hex(evidence));
	}
	const markBytes = Buffer.from(
		getAttestedWokMarkSvg(attestation),
		'utf8'
	);
	assert.equal(
		sha256Hex(markBytes),
		attestation.inventory.sources['wok-mark'].sha256
	);
	assert.equal(
		markBytes.byteLength,
		attestation.inventory.sources['wok-mark'].sizeBytes
	);
});

test('Electron host launch evidence uses the exact retained attested bytes', async () => {
	const inventory = await verifyRuntimeControllerSourceInventory();
	const originalMain = await readFile(
		inventory.sources['electron-host-main'].path
	);
	const originalPackage = await readFile(
		inventory.sources['electron-host-package'].path
	);
	const packageManifest = JSON.parse(
		originalPackage.toString('utf8')
	) as { main?: unknown };
	assert.equal(packageManifest.main, 'main.cjs');
	assert.equal(
		join(
			electronHostSourceDirectory,
			packageManifest.main
		),
		inventory.sources['electron-host-main'].path
	);

	const directory = await mkdtemp(
		join(testOutputRoot, 'electron-host-attestation-')
	);
	const copiedHostDirectory = join(directory, 'host-copy');
	await mkdir(copiedHostDirectory);
	await Promise.all([
		writeFile(
			join(copiedHostDirectory, 'main.cjs'),
			originalMain
		),
		writeFile(
			join(copiedHostDirectory, 'package.json'),
			originalPackage
		)
	]);
	const attestation = await attestRuntimeControllerSources(
		copiedHostDirectory
	);
	const identity = getRuntimeControllerAttestationIdentity(
		attestation
	);
	assert.equal(
		identity.electronHost.main.sha256,
		inventory.sources['electron-host-main'].sha256
	);
	assert.equal(
		identity.electronHost.package.sha256,
		inventory.sources['electron-host-package'].sha256
	);
	assert.deepEqual(
		Object.keys(attestation).sort(),
		['electronHost', 'inventory']
	);

	await Promise.all([
		writeFile(
			join(copiedHostDirectory, 'main.cjs'),
			'void 0;\n'
		),
		writeFile(
			join(copiedHostDirectory, 'package.json'),
			'{"main":"changed.cjs"}\n'
		)
	]);
	const launchDirectory = join(directory, 'launch-host');
	await mkdir(launchDirectory);
	const persistedHost =
		await persistAttestedRuntimeControllerElectronHost(
			attestation,
			launchDirectory
		);
	assert.deepEqual(
		await readFile(persistedHost.main.evidencePath),
		originalMain
	);
	assert.deepEqual(
		await readFile(persistedHost.package.evidencePath),
		originalPackage
	);

	await assert.rejects(
		attestRuntimeControllerSources(copiedHostDirectory),
		/does not match runtime controller source inventory evidence/u
	);
	await assert.rejects(
		verifyRuntimeControllerElectronHost(
			copiedHostDirectory,
			inventory
		),
		/does not match runtime controller source inventory evidence/u
	);
	assert.throws(
		() => getRuntimeControllerAttestationIdentity(
			{
				electronHost: identity.electronHost,
				inventory: identity.inventory
			} as RuntimeControllerSourceAttestation
		),
		/not created by this process/u
	);
});
