import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { sha256FileHex, sha256Hex } from '../shared/hash.ts';

export const RUNTIME_CANDIDATE_MANIFEST_VERSION = 1;

export type RuntimeKind = 'chromium' | 'electron';
export type RequestedGraphicsBackend = 'd3d11' | 'd3d11on12' | 'default' | 'opengl' | 'swiftshader' | 'vulkan';

interface RuntimeCandidateManifestBase {
	adapterVersion: 1;
	build: {
		distribution: string;
		sourceRevision?: string;
		version: string;
	};
	executable: {
		path: string;
		sha256: string;
	};
	graphics: {
		requestedBackend: RequestedGraphicsBackend;
	};
	id: string;
	label: string;
	launch: {
		additionalArguments: string[];
	};
	protocolVersion: 1;
}

export type RuntimeCandidateManifest = RuntimeCandidateManifestBase & (
	| {
		capabilities: {
			devToolsProtocol: true;
			presentMon: true;
		};
		runtimeKind: 'chromium';
	}
	| {
		capabilities: {
			devToolsProtocol: false;
			presentMon: true;
		};
		runtimeKind: 'electron';
	}
);

export interface ResolvedRuntimeCandidate {
	executablePath: string;
	executableSha256: string;
	executableSizeBytes: number;
	manifest: RuntimeCandidateManifest;
	manifestPath: string;
	manifestSha256: string;
}

const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RUNTIME_KINDS = new Set<RuntimeKind>(['chromium', 'electron']);
const GRAPHICS_BACKENDS = new Set<RequestedGraphicsBackend>([
	'd3d11',
	'd3d11on12',
	'default',
	'opengl',
	'swiftshader',
	'vulkan'
]);
const RESERVED_ARGUMENT_PREFIXES = [
	'--allow-file-access-from-files',
	'--app',
	'--disable-web-security',
	'--disk-cache-dir',
	'--force-device-scale-factor',
	'--host-resolver-rules',
	'--ignore-certificate-errors',
	'--no-sandbox',
	'--proxy-',
	'--remote-debugging-',
	'--use-angle',
	'--use-gl',
	'--user-data-dir',
	'--window-position',
	'--window-size'
];

function expectObject(value: unknown, field: string): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError(`${field} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function expectExactKeys(value: Record<string, unknown>, allowedKeys: readonly string[], field: string): void {
	const allowed = new Set(allowedKeys);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new TypeError(`${field}.${key} is not supported.`);
	}
}

function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint < 32 || codePoint === 127) return true;
	}
	return false;
}

function expectString(value: unknown, field: string, maximumLength: number): string {
	if (typeof value !== 'string' || value.length < 1 || value.length > maximumLength || hasControlCharacter(value)) {
		throw new TypeError(`${field} must be a non-empty string no longer than ${maximumLength} characters.`);
	}
	return value;
}
function expectBoolean(value: unknown, field: string): boolean {
	if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean.`);
	return value;
}

function expectLiteralOne(value: unknown, field: string): 1 {
	if (value !== 1) throw new TypeError(`${field} must be 1.`);
	return 1;
}

function validateAdditionalArguments(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 128) {
		throw new TypeError('launch.additionalArguments must be an array with no more than 128 entries.');
	}
	const argumentsList = value.map((argument, index) => expectString(argument, `launch.additionalArguments[${index}]`, 2_048));
	const seen = new Set<string>();
	for (const argument of argumentsList) {
		if (seen.has(argument)) throw new TypeError(`launch.additionalArguments contains duplicate argument ${argument}.`);
		seen.add(argument);
		const normalized = argument.toLowerCase();
		if (!/^--[a-z0-9][a-z0-9-]*(?:=.*)?$/iu.test(argument)) {
			throw new TypeError('launch.additionalArguments must contain switches only; positional arguments are not allowed.');
		}
		if (RESERVED_ARGUMENT_PREFIXES.some(prefix => normalized === prefix || normalized.startsWith(`${prefix}=`))) {
			throw new TypeError(`launch.additionalArguments cannot override controller-owned argument ${argument}.`);
		}
		if (/(?:https?|file|data|javascript):/iu.test(argument)) {
			throw new TypeError('launch.additionalArguments cannot contain a URL.');
		}
	}
	return argumentsList;
}

export function validateRuntimeCandidateManifest(value: unknown): RuntimeCandidateManifest {
	const root = expectObject(value, 'candidate');
	expectExactKeys(
		root,
		['adapterVersion', 'build', 'capabilities', 'executable', 'graphics', 'id', 'label', 'launch', 'protocolVersion', 'runtimeKind'],
		'candidate'
	);

	const id = expectString(root.id, 'id', 64);
	if (!IDENTIFIER_PATTERN.test(id)) throw new TypeError('id must be a lowercase filesystem-safe identifier.');
	const label = expectString(root.label, 'label', 160);

	const runtimeKind = expectString(root.runtimeKind, 'runtimeKind', 32) as RuntimeKind;
	if (!RUNTIME_KINDS.has(runtimeKind)) throw new TypeError('runtimeKind is not supported.');

	const executable = expectObject(root.executable, 'executable');
	expectExactKeys(executable, ['path', 'sha256'], 'executable');
	const executablePath = expectString(executable.path, 'executable.path', 1_024);
	const executableSha256 = expectString(executable.sha256, 'executable.sha256', 64);
	if (!SHA256_PATTERN.test(executableSha256)) throw new TypeError('executable.sha256 must be a lowercase SHA-256 digest.');

	const build = expectObject(root.build, 'build');
	expectExactKeys(build, ['distribution', 'sourceRevision', 'version'], 'build');
	const distribution = expectString(build.distribution, 'build.distribution', 160);
	const version = expectString(build.version, 'build.version', 160);
	const sourceRevision =
		build.sourceRevision === undefined ? undefined : expectString(build.sourceRevision, 'build.sourceRevision', 160);

	const graphics = expectObject(root.graphics, 'graphics');
	expectExactKeys(graphics, ['requestedBackend'], 'graphics');
	const requestedBackend = expectString(graphics.requestedBackend, 'graphics.requestedBackend', 32) as RequestedGraphicsBackend;
	if (!GRAPHICS_BACKENDS.has(requestedBackend)) throw new TypeError('graphics.requestedBackend is not supported.');

	const capabilities = expectObject(root.capabilities, 'capabilities');
	expectExactKeys(capabilities, ['devToolsProtocol', 'presentMon'], 'capabilities');
	const devToolsProtocol = expectBoolean(
		capabilities.devToolsProtocol,
		'capabilities.devToolsProtocol'
	);
	const presentMon = expectBoolean(capabilities.presentMon, 'capabilities.presentMon');
	if (!presentMon) {
		throw new TypeError('capabilities.presentMon must be true for every controlled runtime-lab candidate.');
	}
	if (runtimeKind === 'chromium' && !devToolsProtocol) {
		throw new TypeError('capabilities.devToolsProtocol must be true for chromium candidates.');
	}
	if (runtimeKind === 'electron' && devToolsProtocol) {
		throw new TypeError('capabilities.devToolsProtocol must be false for electron candidates.');
	}

	const launch = expectObject(root.launch, 'launch');
	expectExactKeys(launch, ['additionalArguments'], 'launch');

	const commonManifest = {
		adapterVersion: expectLiteralOne(root.adapterVersion, 'adapterVersion'),
		build: {
			distribution,
			...(sourceRevision === undefined ? {} : { sourceRevision }),
			version
		},
		executable: {
			path: executablePath,
			sha256: executableSha256
		},
		graphics: { requestedBackend },
		id,
		label,
		launch: { additionalArguments: validateAdditionalArguments(launch.additionalArguments) },
		protocolVersion: expectLiteralOne(root.protocolVersion, 'protocolVersion')
	};
	return runtimeKind === 'chromium'
		? {
			...commonManifest,
			capabilities: {
				devToolsProtocol: true,
				presentMon: true
			},
			runtimeKind: 'chromium'
		}
		: {
			...commonManifest,
			capabilities: {
				devToolsProtocol: false,
				presentMon: true
			},
			runtimeKind: 'electron'
		};
}

export async function resolveRuntimeCandidateManifest(manifestPath: string): Promise<ResolvedRuntimeCandidate> {
	const absoluteManifestPath = resolve(manifestPath);
	const manifestBytes = await readFile(absoluteManifestPath);
	const manifestText = manifestBytes.toString('utf8');
	let parsed: unknown;
	try {
		parsed = JSON.parse(manifestText);
	} catch (error) {
		throw new TypeError(`Candidate manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const manifest = validateRuntimeCandidateManifest(parsed);
	const configuredExecutablePath = isAbsolute(manifest.executable.path)
		? manifest.executable.path
		: resolve(dirname(absoluteManifestPath), manifest.executable.path);
	const executablePath = await realpath(configuredExecutablePath);
	const executableStat = await stat(executablePath);
	if (!executableStat.isFile()) throw new TypeError('Candidate executable path must resolve to a regular file.');
	const executableSha256 = await sha256FileHex(executablePath);
	if (executableSha256 !== manifest.executable.sha256) {
		throw new TypeError(
			`Candidate executable SHA-256 mismatch: expected ${manifest.executable.sha256}, received ${executableSha256}.`
		);
	}
	return {
		executablePath,
		executableSha256,
		executableSizeBytes: executableStat.size,
		manifest,
		manifestPath: await realpath(absoluteManifestPath),
		manifestSha256: sha256Hex(manifestBytes)
	};
}
