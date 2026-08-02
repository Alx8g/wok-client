import assert from 'node:assert/strict';
import {
	mkdir,
	mkdtemp,
	readFile,
	stat,
	writeFile
} from 'node:fs/promises';
import {
	basename,
	join
} from 'node:path';
import test from 'node:test';
import type {
	RuntimeCandidateManifest
} from '../src/candidate/manifest.ts';
import {
	prepareRuntimeTournamentDryRun,
	resolveRuntimeTournamentDryRunReport,
	writeRuntimeTournamentDryRunReport,
	type RuntimeTournamentDryRunOptions,
	type RuntimeTournamentDryRunReport
} from '../src/controller/tournament-dry-run.ts';
import {
	getRuntimeControllerAttestationIdentity,
	RUNTIME_CONTROLLER_SOURCE_INVENTORY,
	RUNTIME_CONTROLLER_SOURCE_INVENTORY_VERSION
} from '../src/controller/source-attestation.ts';
import type {
	RuntimeTournamentNoiseFloorReport
} from '../src/controller/tournament-noise-floor.ts';
import {
	canonicalJson,
	sha256Hex
} from '../src/shared/hash.ts';
import {
	createAttestedNoiseFloorFixture
} from './attested-noise-floor-fixture.ts';

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
await mkdir(testOutputRoot, { recursive: true });

const rawPolicyPath = join(
	repositoryRoot,
	'lab',
	'offline-runtime',
	'policies',
	'same-build-noise-capture-v1.json'
);
const scenarioManifestPath = join(
	repositoryRoot,
	'lab',
	'offline-runtime',
	'scenarios',
	'tier1-calibration-v1.json'
);
const productionElectronHostDirectory = join(
	repositoryRoot,
	'lab',
	'offline-runtime',
	'hosts',
	'electron'
);

interface DryRunFixture {
	candidateManifestPaths: string[];
	directory: string;
	electronHostDirectory: string;
	etlRecorderPath: string;
	etlRecorderSha256: string;
	outputRootDirectory: string;
	presentMonPath: string;
	presentMonSha256: string;
}

async function createCandidate(options: {
	directory: string;
	executableContent: string;
	executableName: string;
	id: string;
}): Promise<string> {
	await mkdir(options.directory, { recursive: true });
	const executablePath = join(
		options.directory,
		options.executableName
	);
	await writeFile(
		executablePath,
		options.executableContent
	);
	const manifest: RuntimeCandidateManifest = {
		adapterVersion: 1,
		build: {
			distribution: 'WOK dry-run fixture',
			version: '1.0.0'
		},
		capabilities: {
			devToolsProtocol: false,
			presentMon: true
		},
		executable: {
			path: `./${options.executableName}`,
			sha256: sha256Hex(options.executableContent)
		},
		graphics: {
			requestedBackend: 'd3d11'
		},
		id: options.id,
		label: options.id,
		launch: {
			additionalArguments: []
		},
		protocolVersion: 1,
		runtimeKind: 'electron'
	};
	const manifestPath = join(
		options.directory,
		`${options.id}.json`
	);
	await writeFile(
		manifestPath,
		JSON.stringify(manifest)
	);
	return manifestPath;
}

async function createFixture(options: {
	sameBuild: boolean;
	sameExecutableName?: boolean;
}): Promise<DryRunFixture> {
	const directory = await mkdtemp(
		join(testOutputRoot, 'tournament-dry-run-')
	);
	const electronHostDirectory = join(
		directory,
		'electron-host'
	);
	await mkdir(electronHostDirectory);
	await Promise.all([
		writeFile(
			join(electronHostDirectory, 'main.cjs'),
			await readFile(
				join(
					productionElectronHostDirectory,
					'main.cjs'
				)
			)
		),
		writeFile(
			join(electronHostDirectory, 'package.json'),
			await readFile(
				join(
					productionElectronHostDirectory,
					'package.json'
				)
			)
		)
	]);
	const etlRecorderContent = 'etl-recorder-fixture';
	const etlRecorderPath = join(
		directory,
		'EtlRecorder.exe'
	);
	await writeFile(etlRecorderPath, etlRecorderContent);
	const presentMonContent = 'presentmon-fixture';
	const presentMonPath = join(
		directory,
		'PresentMon.exe'
	);
	await writeFile(presentMonPath, presentMonContent);
	const candidateManifestPaths = await Promise.all([
		createCandidate({
			directory: join(directory, 'candidate-a'),
			executableContent: 'runtime-a',
			executableName: 'runtime-a.exe',
			id: 'candidate-a'
		}),
		createCandidate({
			directory: join(directory, 'candidate-b'),
			executableContent: options.sameBuild
				? 'runtime-a'
				: 'runtime-b',
			executableName: options.sameExecutableName
				? 'runtime-a.exe'
				: 'runtime-b.exe',
			id: 'candidate-b'
		})
	]);
	return {
		candidateManifestPaths,
		directory,
		electronHostDirectory,
		etlRecorderPath,
		etlRecorderSha256: sha256Hex(etlRecorderContent),
		outputRootDirectory: join(directory, 'tournaments'),
		presentMonPath,
		presentMonSha256: sha256Hex(presentMonContent)
	};
}

function dryRunOptions(
	fixture: DryRunFixture,
	overrides: Partial<RuntimeTournamentDryRunOptions> = {}
): RuntimeTournamentDryRunOptions {
	return {
		candidateManifestPaths:
			fixture.candidateManifestPaths,
		electronHostDirectory:
			fixture.electronHostDirectory,
		etlRecorderPath: fixture.etlRecorderPath,
		etlRecorderSha256: fixture.etlRecorderSha256,
		metricPolicyPath: rawPolicyPath,
		outputRootDirectory:
			fixture.outputRootDirectory,
		presentMonPath: fixture.presentMonPath,
		presentMonSha256: fixture.presentMonSha256,
		requestedBlockCount: 7,
		scenarioManifestPath,
		seed: 'dry-run-seed',
		tournamentId: 'dry-run-tournament',
		warmupRunsPerCandidate: 1,
		...overrides
	};
}

async function writeNoiseReport(options: {
	directory: string;
	executableSha256: string;
}): Promise<string> {
	const fixture = await createAttestedNoiseFloorFixture(
		options.directory
	);
	if (fixture.executableSha256 === options.executableSha256) {
		return fixture.noiseFloorReportPath;
	}
	const {
		reportSha256: _oldReportSha256,
		...withoutHash
	} = fixture.noiseFloorReport;
	const changedWithoutHash = {
		...withoutHash,
		executableSha256: options.executableSha256
	};
	await writeFile(
		fixture.noiseFloorReportPath,
		JSON.stringify({
			...changedWithoutHash,
			reportSha256: sha256Hex(
				canonicalJson(changedWithoutHash)
			)
		})
	);
	return fixture.noiseFloorReportPath;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (
			error !== null
			&& typeof error === 'object'
			&& 'code' in error
			&& error.code === 'ENOENT'
		) {
			return false;
		}
		throw error;
	}
}

async function writeReaddressedReport(
	directory: string,
	report: RuntimeTournamentDryRunReport
): Promise<string> {
	const {
		reportSha256: _oldReportSha256,
		...withoutHash
	} = report;
	const readdressed: RuntimeTournamentDryRunReport = {
		...report,
		reportSha256: sha256Hex(canonicalJson(withoutHash))
	};
	await mkdir(directory, { recursive: true });
	const path = join(
		directory,
		`${readdressed.reportSha256}.json`
	);
	await writeFile(
		path,
		`${JSON.stringify(readdressed, null, '\t')}\n`
	);
	return path;
}

test('dry-run seals a complete same-build plan without launching or reserving the tournament directory', async () => {
	const fixture = await createFixture({ sameBuild: true });
	const report = await prepareRuntimeTournamentDryRun(
		dryRunOptions(fixture)
	);
	assert.equal(report.ready, true);
	assert.equal(report.version, 3);
	assert.equal(report.mode, 'same-build-noise-capture');
	assert.equal(report.schedule.schedule.design, 'abba-baab');
	assert.equal(report.plannedRuns.length, 30);
	assert.equal(
		'preflightSeconds' in report.executionControls,
		false
	);
	assert.equal(
		report.plannedRunsSha256,
		sha256Hex(canonicalJson(report.plannedRuns))
	);
	assert.deepEqual(report.operationsPerformed, {
		candidateLaunched: false,
		etlRecorderLaunched: false,
		firewallRuleInstalled: false,
		presentMonLaunched: false
	});
	assert.equal(report.etlRecorder.path, fixture.etlRecorderPath);
	assert.equal(
		report.etlRecorder.sha256,
		fixture.etlRecorderSha256
	);
	assert.equal(
		report.controllerSourceInventoryVersion,
		RUNTIME_CONTROLLER_SOURCE_INVENTORY_VERSION
	);
	assert.deepEqual(
		Object.keys(report.controllerSources),
		Object.keys(RUNTIME_CONTROLLER_SOURCE_INVENTORY.files)
	);
	for (const sourceName of [
		'calibration',
		'calibration-benchmark',
		'calibration-window',
		'calibration-workload',
		'electron-host-main',
		'electron-host-package',
		'wok-mark'
	] as const) {
		assert.ok(report.controllerSources[sourceName]);
	}
	assert.equal(
		report.electronHost.main.sha256,
		report.controllerSources['electron-host-main'].sha256
	);
	assert.equal(
		report.electronHost.package.sha256,
		report.controllerSources['electron-host-package'].sha256
	);
	assert.equal(
		basename(report.controllerSources['windows-job'].path),
		'windows-job.ts'
	);
	assert.match(
		report.controllerSources['windows-job'].sha256,
		/^[a-f0-9]{64}$/u
	);
	assert.equal(
		basename(
			report.controllerSources['presentmon-etl'].path
		),
		'presentmon-etl.ts'
	);
	assert.match(
		report.controllerSources['presentmon-etl'].sha256,
		/^[a-f0-9]{64}$/u
	);
	assert.equal(
		basename(
			report.controllerSources['presentmon-csv'].path
		),
		'presentmon-csv.ts'
	);
	assert.match(
		report.controllerSources['presentmon-csv'].sha256,
		/^[a-f0-9]{64}$/u
	);
	const {
		reportSha256,
		...withoutHash
	} = report;
	assert.equal(
		reportSha256,
		sha256Hex(canonicalJson(withoutHash))
	);
	assert.equal(
		await pathExists(
			report.output.tournamentDirectory
		),
		false
	);
	const reportDirectory = join(
		fixture.directory,
		'preparations'
	);
	const reportPath =
		await writeRuntimeTournamentDryRunReport(
			report,
			reportDirectory
		);
	assert.equal(
		basename(reportPath),
		`${report.reportSha256}.json`
	);
	assert.deepEqual(
		JSON.parse(await readFile(reportPath, 'utf8')),
		report
	);
	await assert.rejects(
		writeRuntimeTournamentDryRunReport(
			report,
			reportDirectory
		),
		/exists|EEXIST/u
	);
	await assert.rejects(
		writeRuntimeTournamentDryRunReport(
			report,
			report.output.tournamentDirectory
		),
		/cannot reserve or write inside/iu
	);
	assert.equal(
		await pathExists(
			report.output.tournamentDirectory
		),
		false
	);
});

test('cross-build dry-run requires and verifies a noise report measured from a tournament candidate', async () => {
	const fixture = await createFixture({ sameBuild: false });
	const firstManifest = JSON.parse(
		await readFile(
			fixture.candidateManifestPaths[0],
			'utf8'
		)
	) as RuntimeCandidateManifest;
	const metricPolicyPath = await writeNoiseReport({
		directory: fixture.directory,
		executableSha256: firstManifest.executable.sha256
	});
	const report = await prepareRuntimeTournamentDryRun(
		dryRunOptions(fixture, { metricPolicyPath })
	);
	assert.equal(report.mode, 'comparison');
	assert.equal(
		report.metricPolicy.kind,
		'noise-floor-report'
	);
	assert.equal(
		typeof report.metricPolicy.reportSha256,
		'string'
	);
});

test('cross-build dry-run rejects rehashed noise metrics that do not reproduce from source evidence', async () => {
	const fixture = await createFixture({ sameBuild: false });
	const firstManifest = JSON.parse(
		await readFile(
			fixture.candidateManifestPaths[0],
			'utf8'
		)
	) as RuntimeCandidateManifest;
	const metricPolicyPath = await writeNoiseReport({
		directory: fixture.directory,
		executableSha256: firstManifest.executable.sha256
	});
	const report = JSON.parse(
		await readFile(metricPolicyPath, 'utf8')
	) as RuntimeTournamentNoiseFloorReport;
	const changedMetric = report.metrics[0];
	assert.ok(changedMetric);
	const changedNoiseFloor = changedMetric.noiseFloor + 1;
	const {
		reportSha256: _oldReportSha256,
		...withoutHash
	} = report;
	const changedWithoutHash = {
		...withoutHash,
		metricPolicies: report.metricPolicies.map(policy =>
			policy.metricId === changedMetric.metricId
				? {
					...policy,
					noiseFloor: changedNoiseFloor
				}
				: policy
		),
		metrics: report.metrics.map(metric =>
			metric.metricId === changedMetric.metricId
				? {
					...metric,
					noiseFloor: changedNoiseFloor
				}
				: metric
		)
	};
	await writeFile(
		metricPolicyPath,
		JSON.stringify({
			...changedWithoutHash,
			reportSha256: sha256Hex(
				canonicalJson(changedWithoutHash)
			)
		})
	);
	await assert.rejects(
		prepareRuntimeTournamentDryRun(
			dryRunOptions(fixture, { metricPolicyPath })
		),
		/does not reproduce from its attested tournament result/iu
	);
});

test('dry-run rejects raw comparison policy, ambiguous executable names and unrelated noise reports', async () => {
	const comparisonFixture = await createFixture({
		sameBuild: false
	});
	await assert.rejects(
		prepareRuntimeTournamentDryRun(
			dryRunOptions(comparisonFixture)
		),
		/cross-build comparison requires a verified/iu
	);

	const collisionFixture = await createFixture({
		sameBuild: false,
		sameExecutableName: true
	});
	await assert.rejects(
		prepareRuntimeTournamentDryRun(
			dryRunOptions(collisionFixture)
		),
		/distinct candidate binaries cannot share/iu
	);

	const metricPolicyPath = await writeNoiseReport({
		directory: comparisonFixture.directory,
		executableSha256: 'f'.repeat(64)
	});
	await assert.rejects(
		prepareRuntimeTournamentDryRun(
			dryRunOptions(comparisonFixture, {
				metricPolicyPath
			})
		),
		/not measured from any candidate executable/iu
	);
});

test('dry-run rejects altered tools and an already-reserved tournament directory', async () => {
	const fixture = await createFixture({ sameBuild: true });
	await assert.rejects(
		prepareRuntimeTournamentDryRun(
			dryRunOptions(fixture, {
				presentMonSha256: '0'.repeat(64)
			})
		),
		/PresentMon SHA-256 mismatch/u
	);
	await assert.rejects(
		prepareRuntimeTournamentDryRun(
			dryRunOptions(fixture, {
				etlRecorderSha256: '0'.repeat(64)
			})
		),
		/ETL recorder SHA-256 mismatch/u
	);
	await writeFile(
		join(fixture.electronHostDirectory, 'main.cjs'),
		'void 0;\n'
	);
	await assert.rejects(
		prepareRuntimeTournamentDryRun(
			dryRunOptions(fixture)
		),
		/does not match runtime controller source inventory evidence/iu
	);
	await writeFile(
		join(fixture.electronHostDirectory, 'main.cjs'),
		await readFile(
			join(productionElectronHostDirectory, 'main.cjs')
		)
	);
	await mkdir(
		join(
			fixture.outputRootDirectory,
			'dry-run-tournament'
		),
		{ recursive: true }
	);
	await assert.rejects(
		prepareRuntimeTournamentDryRun(
			dryRunOptions(fixture)
		),
		/future tournament directory already exists/iu
	);
});

test('dry-run resolver accepts exact evidence and rejects byte tampering or the wrong address', async () => {
	const fixture = await createFixture({ sameBuild: true });
	const report = await prepareRuntimeTournamentDryRun(
		dryRunOptions(fixture)
	);
	const reportPath =
		await writeRuntimeTournamentDryRunReport(
			report,
			join(fixture.directory, 'preparations')
		);
	const resolved = await resolveRuntimeTournamentDryRunReport(
		reportPath
	);
	assert.deepEqual(resolved.report, report);
	assert.deepEqual(
		resolved.reportBytes,
		await readFile(reportPath)
	);
	const runtimeControllerIdentity =
		getRuntimeControllerAttestationIdentity(
			resolved.runtimeControllerAttestation
		);
	assert.deepEqual(
		runtimeControllerIdentity.inventory,
		{
			sources: report.controllerSources,
			version: report.controllerSourceInventoryVersion
		}
	);
	assert.deepEqual(
		runtimeControllerIdentity.electronHost,
		report.electronHost
	);

	const wrongAddressDirectory = join(
		fixture.directory,
		'wrong-address'
	);
	await mkdir(wrongAddressDirectory);
	const wrongAddressPath = join(
		wrongAddressDirectory,
		'wrong-address.json'
	);
	await writeFile(
		wrongAddressPath,
		await readFile(reportPath)
	);
	await assert.rejects(
		resolveRuntimeTournamentDryRunReport(
			wrongAddressPath
		),
		/filename must match its content address/iu
	);

	const tamperedDirectory = join(
		fixture.directory,
		'tampered-body'
	);
	await mkdir(tamperedDirectory);
	const tamperedPath = join(
		tamperedDirectory,
		`${report.reportSha256}.json`
	);
	await writeFile(
		tamperedPath,
		JSON.stringify({
			...report,
			seed: 'tampered-seed'
		})
	);
	await assert.rejects(
		resolveRuntimeTournamentDryRunReport(tamperedPath),
		/SHA-256 does not match its canonical contents/iu
	);
});

test('dry-run resolver rejects schedule and plan changes hidden behind a new outer address', async () => {
	const fixture = await createFixture({ sameBuild: true });
	const report = await prepareRuntimeTournamentDryRun(
		dryRunOptions(fixture)
	);
	const schedulePath = await writeReaddressedReport(
		join(fixture.directory, 'changed-schedule'),
		{
			...report,
			schedule: {
				...report.schedule,
				schedule: {
					...report.schedule.schedule,
					requestedBlockCount:
						report.schedule.schedule.requestedBlockCount
						+ 1
				}
			}
		}
	);
	await assert.rejects(
		resolveRuntimeTournamentDryRunReport(schedulePath),
		/schedule SHA-256 does not match/iu
	);

	const originalCandidateId = report.plannedRuns[0]?.candidateId;
	assert.ok(originalCandidateId);
	const replacementCandidateId = report.candidateIds.find(
		candidateId => candidateId !== originalCandidateId
	);
	assert.ok(replacementCandidateId);
	const planPath = await writeReaddressedReport(
		join(fixture.directory, 'changed-plan'),
		{
			...report,
			plannedRuns: report.plannedRuns.map(
				(run, index) => index === 0
					? {
						...run,
						candidateId: replacementCandidateId
					}
					: run
			)
		}
	);
	await assert.rejects(
		resolveRuntimeTournamentDryRunReport(planPath),
		/plan SHA-256 does not match/iu
	);
});

test('dry-run resolver reverifies ETL, candidate and host identities and rejects in-output reports', async () => {
	const toolFixture = await createFixture({ sameBuild: true });
	const toolReport = await prepareRuntimeTournamentDryRun(
		dryRunOptions(toolFixture)
	);
	const toolReportPath =
		await writeRuntimeTournamentDryRunReport(
			toolReport,
			join(toolFixture.directory, 'preparations')
		);
	await writeFile(
		toolFixture.etlRecorderPath,
		'changed-etl-recorder'
	);
	await assert.rejects(
		resolveRuntimeTournamentDryRunReport(toolReportPath),
		/ETL recorder SHA-256 mismatch/u
	);

	const candidateFixture = await createFixture({ sameBuild: true });
	const candidateReport = await prepareRuntimeTournamentDryRun(
		dryRunOptions(candidateFixture)
	);
	const candidateReportPath =
		await writeRuntimeTournamentDryRunReport(
			candidateReport,
			join(candidateFixture.directory, 'preparations')
		);
	const candidateManifestPath =
		candidateFixture.candidateManifestPaths[0];
	assert.ok(candidateManifestPath);
	const changedCandidateManifest = JSON.parse(
		await readFile(candidateManifestPath, 'utf8')
	) as RuntimeCandidateManifest;
	changedCandidateManifest.label = 'changed-candidate-label';
	await writeFile(
		candidateManifestPath,
		JSON.stringify(changedCandidateManifest)
	);
	await assert.rejects(
		resolveRuntimeTournamentDryRunReport(
			candidateReportPath
		),
		/does not match the current attested tournament preparation/iu
	);

	const hostFixture = await createFixture({ sameBuild: true });
	const hostReport = await prepareRuntimeTournamentDryRun(
		dryRunOptions(hostFixture)
	);
	const hostReportPath =
		await writeRuntimeTournamentDryRunReport(
			hostReport,
			join(hostFixture.directory, 'preparations')
		);
	await writeFile(
		join(hostFixture.electronHostDirectory, 'main.cjs'),
		'void 0;\n'
	);
	await assert.rejects(
		resolveRuntimeTournamentDryRunReport(hostReportPath),
		/does not match runtime controller source inventory evidence/iu
	);

	const outputFixture = await createFixture({ sameBuild: true });
	const outputReport = await prepareRuntimeTournamentDryRun(
		dryRunOptions(outputFixture)
	);
	await mkdir(
		outputReport.output.tournamentDirectory,
		{ recursive: true }
	);
	const inOutputReportPath = join(
		outputReport.output.tournamentDirectory,
		`${outputReport.reportSha256}.json`
	);
	await writeFile(
		inOutputReportPath,
		`${JSON.stringify(outputReport, null, '\t')}\n`
	);
	await assert.rejects(
		resolveRuntimeTournamentDryRunReport(
			inOutputReportPath
		),
		/cannot be stored inside the future tournament directory/iu
	);
});

test('dry-run implementation has no runtime, monitor, PresentMon or firewall launch path', async () => {
	const source = await readFile(
		join(
			repositoryRoot,
			'lab',
			'offline-runtime',
			'src',
			'controller',
			'tournament-dry-run.ts'
		),
		'utf8'
	);
	for (const forbidden of [
		"from 'node:child_process'",
		'installWindowsEgressGuard(',
		'runRuntimeLabSingleRun(',
		'runRuntimeTournament(',
		'startWindowsProcessMonitor('
	]) {
		assert.equal(
			source.includes(forbidden),
			false,
			`dry-run source included forbidden launch path: ${forbidden}`
		);
	}
});
