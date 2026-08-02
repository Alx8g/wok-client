import {
	readFile,
	realpath,
	stat,
	writeFile
} from 'node:fs/promises';
import {
	extname,
	isAbsolute,
	join,
	relative,
	resolve
} from 'node:path';
import {
	sha256FileHex,
	sha256Hex
} from '../shared/hash.ts';

export const RUNTIME_CONTROLLER_SOURCE_INVENTORY_VERSION = 8;

export const RUNTIME_CONTROLLER_SOURCE_INVENTORY = Object.freeze({
	files: Object.freeze({
		calibration: 'src/calibration.ts',
		'calibration-benchmark': 'src/calibration-benchmark.ts',
		'calibration-parity': 'lab/offline-runtime/src/page/calibration-parity.ts',
		'calibration-window': 'src/calibration-window.ts',
		'calibration-workload': 'src/calibration-workload.ts',
		'candidate-manifest': 'lab/offline-runtime/src/candidate/manifest.ts',
		'chromium-devtools': 'lab/offline-runtime/src/adapter/chromium-devtools.ts',
		'electron-host-main': 'lab/offline-runtime/hosts/electron/main.cjs',
		'electron-host-package': 'lab/offline-runtime/hosts/electron/package.json',
		'failure-classification': 'lab/offline-runtime/src/host/failure-classification.ts',
		'etl-process-lifetimes': 'lab/offline-runtime/src/host/etl-process-lifetimes.ts',
		'graphics-profile': 'src/graphics-profile.ts',
		'launch-plan': 'lab/offline-runtime/src/adapter/launch-plan.ts',
		'loopback-server': 'lab/offline-runtime/src/host/loopback-server.ts',
		'native-etl-recorder': 'lab/offline-runtime/hosts/windows/WokEtlRecorder.cpp',
		'native-etl-recorder-presentmon-patch': 'lab/offline-runtime/hosts/windows/presentmon-v2.5.1-wok-recorder.patch',
		'native-etl-recorder-project': 'lab/offline-runtime/hosts/windows/WokEtlRecorder.vcxproj',
		'noise-floor-cli': 'lab/offline-runtime/scripts/noise-floor.mjs',
		'presentmon-csv': 'lab/offline-runtime/src/host/presentmon-csv.ts',
		'presentmon-etl': 'lab/offline-runtime/src/host/presentmon-etl.ts',
		'process-resources': 'lab/offline-runtime/src/host/process-resources.ts',
		'run-cli': 'lab/offline-runtime/scripts/run.mjs',
		'runtime-protocol': 'lab/offline-runtime/src/shared/protocol.ts',
		'scenario-manifest': 'lab/offline-runtime/src/scenario/manifest.ts',
		'shared-hash': 'lab/offline-runtime/src/shared/hash.ts',
		'single-run': 'lab/offline-runtime/src/controller/single-run.ts',
		'source-attestation': 'lab/offline-runtime/src/controller/source-attestation.ts',
		'tournament-analysis': 'lab/offline-runtime/src/controller/tournament-analysis.ts',
		'tournament-cli': 'lab/offline-runtime/scripts/tournament.mjs',
		'tournament-controller': 'lab/offline-runtime/src/controller/tournament-controller.ts',
		'tournament-dry-run': 'lab/offline-runtime/src/controller/tournament-dry-run.ts',
		'tournament-dry-run-cli': 'lab/offline-runtime/scripts/tournament-dry-run.mjs',
		'tournament-noise-floor': 'lab/offline-runtime/src/controller/tournament-noise-floor.ts',
		'tournament-plan': 'lab/offline-runtime/src/controller/tournament-plan.ts',
		'tournament-policy': 'lab/offline-runtime/src/controller/tournament-policy.ts',
		'tournament-result-evidence': 'lab/offline-runtime/src/controller/tournament-result-evidence.ts',
		'tournament-schedule': 'lab/offline-runtime/src/controller/tournament-schedule.ts',
		'windows-firewall': 'lab/offline-runtime/src/controller/windows-firewall.ts',
		'windows-job': 'lab/offline-runtime/src/controller/windows-job.ts',
		'windows-process-control': 'lab/offline-runtime/src/controller/windows-process-control.ts',
		'windows-process-monitor': 'lab/offline-runtime/src/controller/windows-process-monitor.ts',
		'windows-tool-process': 'lab/offline-runtime/src/controller/windows-tool-process.ts',
		'wok-mark': 'assets/wok-mark.svg'
	}),
	version: RUNTIME_CONTROLLER_SOURCE_INVENTORY_VERSION
});

export type RuntimeControllerSourceName =
	keyof typeof RUNTIME_CONTROLLER_SOURCE_INVENTORY.files;

export interface VerifiedRuntimeControllerSource {
	readonly path: string;
	readonly sha256: string;
	readonly sizeBytes: number;
}

export interface PersistedRuntimeControllerSource
	extends VerifiedRuntimeControllerSource {
	readonly evidencePath: string;
}

export interface RuntimeControllerSourceInventory<
	Source extends VerifiedRuntimeControllerSource
> {
	readonly sources: Record<RuntimeControllerSourceName, Source>;
	readonly version: typeof RUNTIME_CONTROLLER_SOURCE_INVENTORY_VERSION;
}

export interface VerifiedRuntimeControllerElectronHost {
	readonly directory: string;
	readonly main: VerifiedRuntimeControllerSource;
	readonly package: VerifiedRuntimeControllerSource;
}

export interface PersistedRuntimeControllerElectronHost {
	readonly launchDirectory: string;
	readonly main: PersistedRuntimeControllerSource;
	readonly package: PersistedRuntimeControllerSource;
}

declare const runtimeControllerSourceAttestationBrand: unique symbol;

export interface RuntimeControllerSourceAttestation {
	readonly [runtimeControllerSourceAttestationBrand]: true;
	readonly electronHost: VerifiedRuntimeControllerElectronHost;
	readonly inventory: RuntimeControllerSourceInventory<
		VerifiedRuntimeControllerSource
	>;
}

interface AttestedRuntimeControllerSource
	extends VerifiedRuntimeControllerSource {
	readonly content: Buffer;
}

interface RetainedRuntimeControllerAttestation {
	readonly electronHost: {
		readonly directory: string;
		readonly main: AttestedRuntimeControllerSource;
		readonly package: AttestedRuntimeControllerSource;
	};
	readonly sources: Record<
		RuntimeControllerSourceName,
		AttestedRuntimeControllerSource
	>;
}

const retainedAttestations = new WeakMap<
	RuntimeControllerSourceAttestation,
	RetainedRuntimeControllerAttestation
>();

function repositoryRoot(): string {
	return resolve(
		import.meta.dirname,
		'..',
		'..',
		'..',
		'..'
	);
}

function defaultElectronHostDirectory(): string {
	return join(
		repositoryRoot(),
		'lab',
		'offline-runtime',
		'hosts',
		'electron'
	);
}

function samePath(left: string, right: string): boolean {
	return process.platform === 'win32'
		? left.toLowerCase() === right.toLowerCase()
		: left === right;
}

function publicSource(
	source: VerifiedRuntimeControllerSource
): VerifiedRuntimeControllerSource {
	return Object.freeze({
		path: source.path,
		sha256: source.sha256,
		sizeBytes: source.sizeBytes
	});
}

function publicInventory(
	sources: Record<
		RuntimeControllerSourceName,
		AttestedRuntimeControllerSource
	>
): RuntimeControllerSourceInventory<VerifiedRuntimeControllerSource> {
	const publicSources = Object.fromEntries(
		Object.entries(sources).map(([name, source]) => [
			name,
			publicSource(source)
		])
	) as Record<
		RuntimeControllerSourceName,
		VerifiedRuntimeControllerSource
	>;
	Object.freeze(publicSources);
	return Object.freeze({
		sources: publicSources,
		version: RUNTIME_CONTROLLER_SOURCE_INVENTORY_VERSION
	});
}

function publicElectronHost(host: {
	readonly directory: string;
	readonly main: VerifiedRuntimeControllerSource;
	readonly package: VerifiedRuntimeControllerSource;
}): VerifiedRuntimeControllerElectronHost {
	return Object.freeze({
		directory: host.directory,
		main: publicSource(host.main),
		package: publicSource(host.package)
	});
}

async function attestRuntimeControllerSource(
	name: RuntimeControllerSourceName,
	configuredPath: string
): Promise<AttestedRuntimeControllerSource> {
	const root = repositoryRoot();
	const sourcePath = await realpath(resolve(root, configuredPath));
	const repositoryRelativePath = relative(root, sourcePath);
	if (
		repositoryRelativePath.startsWith(
			`..${process.platform === 'win32' ? '\\' : '/'}`
		)
		|| repositoryRelativePath === '..'
		|| isAbsolute(repositoryRelativePath)
	) {
		throw new TypeError(
			`Controller source ${name} resolves outside the repository.`
		);
	}
	const metadata = await stat(sourcePath);
	if (!metadata.isFile()) {
		throw new TypeError(
			`Controller source ${name} is not a regular file.`
		);
	}
	const content = await readFile(sourcePath);
	return Object.freeze({
		content,
		path: sourcePath,
		sha256: sha256Hex(content),
		sizeBytes: content.byteLength
	});
}

async function attestRuntimeControllerSourceInventory(): Promise<
	Record<RuntimeControllerSourceName, AttestedRuntimeControllerSource>
> {
	const entries = await Promise.all(
		Object.entries(
			RUNTIME_CONTROLLER_SOURCE_INVENTORY.files
		).map(async ([name, configuredPath]) => [
			name as RuntimeControllerSourceName,
			await attestRuntimeControllerSource(
				name as RuntimeControllerSourceName,
				configuredPath
			)
		] as const)
	);
	return Object.freeze(Object.fromEntries(entries)) as Record<
		RuntimeControllerSourceName,
		AttestedRuntimeControllerSource
	>;
}

async function attestElectronHostFile(
	path: string,
	label: string,
	expected: VerifiedRuntimeControllerSource,
	retainedExpected?: AttestedRuntimeControllerSource
): Promise<AttestedRuntimeControllerSource> {
	const resolvedPath = await realpath(path);
	const metadata = await stat(resolvedPath);
	if (!metadata.isFile()) {
		throw new TypeError(
			`${label} must resolve to a regular file.`
		);
	}
	const content = retainedExpected !== undefined
		&& samePath(resolvedPath, retainedExpected.path)
		? retainedExpected.content
		: await readFile(resolvedPath);
	const actual = Object.freeze({
		content,
		path: resolvedPath,
		sha256: sha256Hex(content),
		sizeBytes: content.byteLength
	});
	if (
		actual.sha256 !== expected.sha256
		|| actual.sizeBytes !== expected.sizeBytes
	) {
		throw new Error(
			`${label} does not match runtime controller source `
				+ 'inventory evidence.'
		);
	}
	return actual;
}

function parseElectronHostPackage(
	packageFile: AttestedRuntimeControllerSource
): Record<string, unknown> {
	let packageValue: unknown;
	try {
		packageValue = JSON.parse(packageFile.content.toString('utf8'));
	} catch (error) {
		throw new TypeError(
			'Electron host package.json is not valid JSON: '
				+ (
					error instanceof Error
						? error.message
						: String(error)
				)
		);
	}
	if (
		packageValue === null
		|| typeof packageValue !== 'object'
		|| Array.isArray(packageValue)
	) {
		throw new TypeError(
			'Electron host package.json must contain an object.'
		);
	}
	return packageValue as Record<string, unknown>;
}

async function attestRuntimeControllerElectronHost(
	configuredDirectory: string,
	inventory: RuntimeControllerSourceInventory<
		VerifiedRuntimeControllerSource
	>,
	retainedSources?: Record<
		RuntimeControllerSourceName,
		AttestedRuntimeControllerSource
	>
): Promise<RetainedRuntimeControllerAttestation['electronHost']> {
	const directory = await realpath(resolve(configuredDirectory));
	const directoryMetadata = await stat(directory);
	if (!directoryMetadata.isDirectory()) {
		throw new TypeError(
			'Electron host path must resolve to a directory.'
		);
	}
	const [main, packageFile] = await Promise.all([
		attestElectronHostFile(
			join(directory, 'main.cjs'),
			'Electron host main.cjs',
			inventory.sources['electron-host-main'],
			retainedSources?.['electron-host-main']
		),
		attestElectronHostFile(
			join(directory, 'package.json'),
			'Electron host package.json',
			inventory.sources['electron-host-package'],
			retainedSources?.['electron-host-package']
		)
	]);
	const declaredMain = parseElectronHostPackage(packageFile).main;
	if (
		typeof declaredMain !== 'string'
		|| declaredMain.length < 1
		|| declaredMain.length > 1_024
		|| declaredMain.includes('\0')
	) {
		throw new TypeError(
			'Electron host package.json must declare a bounded main entry.'
		);
	}
	const declaredMainPath = await realpath(
		resolve(directory, declaredMain)
	);
	if (!samePath(declaredMainPath, main.path)) {
		throw new Error(
			'Electron host package.json main does not resolve '
				+ 'to the inventoried main.cjs entry.'
		);
	}
	return Object.freeze({
		directory,
		main,
		package: packageFile
	});
}

function retainedAttestation(
	attestation: RuntimeControllerSourceAttestation
): RetainedRuntimeControllerAttestation {
	if (
		attestation === null
		|| typeof attestation !== 'object'
	) {
		throw new TypeError(
			'Runtime controller source attestation must be an opaque attestation token.'
		);
	}
	const retained = retainedAttestations.get(attestation);
	if (retained === undefined) {
		throw new Error(
			'Runtime controller source attestation token was not created by this process.'
		);
	}
	return retained;
}

export async function attestRuntimeControllerSources(
	configuredElectronHostDirectory = defaultElectronHostDirectory()
): Promise<RuntimeControllerSourceAttestation> {
	const sources = await attestRuntimeControllerSourceInventory();
	const inventory = publicInventory(sources);
	const electronHost = await attestRuntimeControllerElectronHost(
		configuredElectronHostDirectory,
		inventory,
		sources
	);
	const attestation = Object.freeze({
		electronHost: publicElectronHost(electronHost),
		inventory
	}) as RuntimeControllerSourceAttestation;
	retainedAttestations.set(attestation, {
		electronHost,
		sources
	});
	return attestation;
}

export function getRuntimeControllerAttestationIdentity(
	attestation: RuntimeControllerSourceAttestation
): {
	readonly electronHost: VerifiedRuntimeControllerElectronHost;
	readonly inventory: RuntimeControllerSourceInventory<
		VerifiedRuntimeControllerSource
	>;
} {
	retainedAttestation(attestation);
	return {
		electronHost: attestation.electronHost,
		inventory: attestation.inventory
	};
}

export function getAttestedWokMarkSvg(
	attestation: RuntimeControllerSourceAttestation
): string {
	const retained = retainedAttestation(attestation);
	return new TextDecoder('utf-8', { fatal: true }).decode(
		retained.sources['wok-mark'].content
	);
}

async function persistAttestedSource(
	source: AttestedRuntimeControllerSource,
	evidencePath: string,
	label: string
): Promise<PersistedRuntimeControllerSource> {
	await writeFile(evidencePath, source.content, { flag: 'wx' });
	if (await sha256FileHex(evidencePath) !== source.sha256) {
		throw new Error(
			`${label} evidence did not preserve its attested bytes.`
		);
	}
	return Object.freeze({
		evidencePath,
		path: source.path,
		sha256: source.sha256,
		sizeBytes: source.sizeBytes
	});
}

export async function persistAttestedRuntimeControllerSources(
	attestation: RuntimeControllerSourceAttestation,
	evidenceDirectory: string
): Promise<
	RuntimeControllerSourceInventory<PersistedRuntimeControllerSource>
> {
	const retained = retainedAttestation(attestation);
	const resolvedEvidenceDirectory = await realpath(
		resolve(evidenceDirectory)
	);
	const directoryMetadata = await stat(resolvedEvidenceDirectory);
	if (!directoryMetadata.isDirectory()) {
		throw new TypeError(
			'Controller source evidence path must resolve to a directory.'
		);
	}
	const entries = await Promise.all(
		Object.entries(retained.sources).map(async ([name, source]) => [
			name as RuntimeControllerSourceName,
			await persistAttestedSource(
				source,
				join(
					resolvedEvidenceDirectory,
					`${name}${extname(source.path)}`
				),
				`Controller source ${name}`
			)
		] as const)
	);
	const sources = Object.fromEntries(entries) as Record<
		RuntimeControllerSourceName,
		PersistedRuntimeControllerSource
	>;
	Object.freeze(sources);
	return Object.freeze({
		sources,
		version: RUNTIME_CONTROLLER_SOURCE_INVENTORY_VERSION
	});
}

export async function persistAttestedRuntimeControllerElectronHost(
	attestation: RuntimeControllerSourceAttestation,
	evidenceDirectory: string
): Promise<PersistedRuntimeControllerElectronHost> {
	const retained = retainedAttestation(attestation);
	const launchDirectory = await realpath(resolve(evidenceDirectory));
	const directoryMetadata = await stat(launchDirectory);
	if (!directoryMetadata.isDirectory()) {
		throw new TypeError(
			'Electron host evidence path must resolve to a directory.'
		);
	}
	const [main, packageFile] = await Promise.all([
		persistAttestedSource(
			retained.electronHost.main,
			join(launchDirectory, 'main.cjs'),
			'Electron host main.cjs'
		),
		persistAttestedSource(
			retained.electronHost.package,
			join(launchDirectory, 'package.json'),
			'Electron host package.json'
		)
	]);
	return Object.freeze({
		launchDirectory,
		main,
		package: packageFile
	});
}

export async function verifyRuntimeControllerSourceInventory(): Promise<
	RuntimeControllerSourceInventory<VerifiedRuntimeControllerSource>
> {
	return publicInventory(
		await attestRuntimeControllerSourceInventory()
	);
}

export async function verifyRuntimeControllerElectronHost<
	Source extends VerifiedRuntimeControllerSource
>(
	configuredDirectory: string,
	inventory: RuntimeControllerSourceInventory<Source>
): Promise<VerifiedRuntimeControllerElectronHost> {
	return publicElectronHost(
		await attestRuntimeControllerElectronHost(
			configuredDirectory,
			inventory
		)
	);
}
