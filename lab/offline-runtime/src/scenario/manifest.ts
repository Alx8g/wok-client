import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sha256Hex } from '../shared/hash.ts';
import { RUNTIME_LAB_PROTOCOL_VERSION } from '../shared/protocol.ts';

interface RuntimeLabScenarioBase {
	benchmarkMs: number;
	claimBoundary: string;
	id: string;
	minSamples: number;
	networkPolicy: 'loopback-only';
	profilePolicy: 'fresh';
	protocolVersion: typeof RUNTIME_LAB_PROTOCOL_VERSION;
	tracePolicy: 'disabled-for-headline-runs';
	viewport: {
		cssHeight: number;
		cssWidth: number;
		deviceScaleFactor: number;
	};
}

export type RuntimeLabScenario = RuntimeLabScenarioBase & (
	| {
		inputMode: 'off';
		tier: 1;
	}
	| {
		inputMode: 'synthetic';
		tier: 3;
	}
);

export interface ResolvedRuntimeLabScenario {
	manifestPath: string;
	manifestSha256: string;
	scenario: RuntimeLabScenario;
}

const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;

function expectObject(value: unknown, field: string): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object.`);
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
function expectInteger(value: unknown, field: string, minimum: number, maximum: number): number {
	if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new TypeError(`${field} must be an integer from ${minimum} through ${maximum}.`);
	}
	return value as number;
}

function expectFiniteNumber(value: unknown, field: string, minimum: number, maximum: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw new TypeError(`${field} must be a finite number from ${minimum} through ${maximum}.`);
	}
	return value;
}

export function validateRuntimeLabScenario(value: unknown): RuntimeLabScenario {
	const root = expectObject(value, 'scenario');
	expectExactKeys(
		root,
		[
			'benchmarkMs',
			'claimBoundary',
			'id',
			'inputMode',
			'minSamples',
			'networkPolicy',
			'profilePolicy',
			'protocolVersion',
			'tier',
			'tracePolicy',
			'viewport'
		],
		'scenario'
	);

	const id = expectString(root.id, 'id', 64);
	if (!IDENTIFIER_PATTERN.test(id)) throw new TypeError('id must be a lowercase filesystem-safe identifier.');
	if (root.protocolVersion !== RUNTIME_LAB_PROTOCOL_VERSION) {
		throw new TypeError(`protocolVersion must be ${RUNTIME_LAB_PROTOCOL_VERSION}.`);
	}
	const tier = expectInteger(root.tier, 'tier', 1, 4);
	if (tier !== 1 && tier !== 3) {
		throw new TypeError('tier must be 1 or 3 because no controller workload is implemented for other tiers.');
	}
	const inputMode = expectString(root.inputMode, 'inputMode', 16);
	if (inputMode !== 'off' && inputMode !== 'synthetic') throw new TypeError('inputMode must be off or synthetic.');
	if (tier === 1 && inputMode !== 'off') {
		throw new TypeError('tier 1 scenarios must use inputMode off.');
	}
	if (tier === 3 && inputMode !== 'synthetic') {
		throw new TypeError('tier 3 scenarios must use inputMode synthetic.');
	}
	if (root.profilePolicy !== 'fresh') throw new TypeError('profilePolicy must be fresh.');
	if (root.networkPolicy !== 'loopback-only') throw new TypeError('networkPolicy must be loopback-only.');
	if (root.tracePolicy !== 'disabled-for-headline-runs') {
		throw new TypeError('tracePolicy must be disabled-for-headline-runs.');
	}

	const viewport = expectObject(root.viewport, 'viewport');
	expectExactKeys(viewport, ['cssHeight', 'cssWidth', 'deviceScaleFactor'], 'viewport');

	const commonScenario = {
		benchmarkMs: expectInteger(root.benchmarkMs, 'benchmarkMs', 1_000, 300_000),
		claimBoundary: expectString(root.claimBoundary, 'claimBoundary', 1_000),
		id,
		minSamples: expectInteger(root.minSamples, 'minSamples', 30, 100_000),
		networkPolicy: 'loopback-only' as const,
		profilePolicy: 'fresh' as const,
		protocolVersion: RUNTIME_LAB_PROTOCOL_VERSION as typeof RUNTIME_LAB_PROTOCOL_VERSION,
		tracePolicy: 'disabled-for-headline-runs' as const,
		viewport: {
			cssHeight: expectInteger(viewport.cssHeight, 'viewport.cssHeight', 240, 8_192),
			cssWidth: expectInteger(viewport.cssWidth, 'viewport.cssWidth', 320, 8_192),
			deviceScaleFactor: expectFiniteNumber(viewport.deviceScaleFactor, 'viewport.deviceScaleFactor', 0.5, 4)
		}
	};
	return tier === 1
		? {
			...commonScenario,
			inputMode: 'off',
			tier: 1
		}
		: {
			...commonScenario,
			inputMode: 'synthetic',
			tier: 3
		};
}

export async function resolveRuntimeLabScenario(manifestPath: string): Promise<ResolvedRuntimeLabScenario> {
	const absoluteManifestPath = resolve(manifestPath);
	const manifestBytes = await readFile(absoluteManifestPath);
	const manifestText = manifestBytes.toString('utf8');
	let parsed: unknown;
	try {
		parsed = JSON.parse(manifestText);
	} catch (error) {
		throw new TypeError(`Scenario manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const scenario = validateRuntimeLabScenario(parsed);
	return {
		manifestPath: await realpath(absoluteManifestPath),
		manifestSha256: sha256Hex(manifestBytes),
		scenario
	};
}
