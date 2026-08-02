import { isAbsolute, join, resolve } from 'node:path';
import type { RequestedGraphicsBackend, ResolvedRuntimeCandidate } from '../candidate/manifest.ts';
import type { RuntimeLabScenario } from '../scenario/manifest.ts';

export const RUNTIME_ADAPTER_CONTRACT_VERSION = 1;

export interface RuntimeLaunchPlan {
	adapterContractVersion: typeof RUNTIME_ADAPTER_CONTRACT_VERSION;
	arguments: string[];
	command: string;
	environment: NodeJS.ProcessEnv;
	kind: 'chromium' | 'electron';
	profileDirectory: string;
	sessionDirectory: string;
}

export interface BuildRuntimeLaunchPlanOptions {
	candidate: ResolvedRuntimeCandidate;
	electronHostDirectory: string;
	pageUrl: string;
	runDirectory: string;
	scenario: RuntimeLabScenario;
	sourceEnvironment?: NodeJS.ProcessEnv;
}

const INHERITED_ENVIRONMENT_KEYS = new Set([
	'ALLUSERSPROFILE',
	'APPDATA',
	'COMMONPROGRAMFILES',
	'COMMONPROGRAMFILES(X86)',
	'COMMONPROGRAMW6432',
	'COMSPEC',
	'HOMEDRIVE',
	'HOMEPATH',
	'LANG',
	'LOCALAPPDATA',
	'NUMBER_OF_PROCESSORS',
	'OS',
	'PATH',
	'PATHEXT',
	'PROCESSOR_ARCHITECTURE',
	'PROCESSOR_IDENTIFIER',
	'PROCESSOR_LEVEL',
	'PROCESSOR_REVISION',
	'PROGRAMDATA',
	'PROGRAMFILES',
	'PROGRAMFILES(X86)',
	'PROGRAMW6432',
	'PUBLIC',
	'SYSTEMDRIVE',
	'SYSTEMROOT',
	'TEMP',
	'TMP',
	'USERDOMAIN',
	'USERNAME',
	'USERPROFILE',
	'WINDIR'
]);

export function buildSanitizedEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(source)) {
		if (value !== undefined && INHERITED_ENVIRONMENT_KEYS.has(key.toUpperCase())) environment[key] = value;
	}
	return environment;
}

function validateLoopbackPageUrl(pageUrl: string): URL {
	const parsed = new URL(pageUrl);
	if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password) {
		throw new TypeError('Runtime Lab page URL must use unauthenticated HTTP on 127.0.0.1.');
	}
	if (!parsed.port) throw new TypeError('Runtime Lab page URL must use an explicit loopback port.');
	return parsed;
}

function graphicsArguments(backend: RequestedGraphicsBackend): string[] {
	switch (backend) {
		case 'default':
			return [];
		case 'd3d11':
			return ['--use-angle=d3d11'];
		case 'd3d11on12':
			return ['--use-angle=d3d11on12'];
		case 'opengl':
			return ['--use-angle=gl'];
		case 'swiftshader':
			return ['--use-angle=swiftshader'];
		case 'vulkan':
			return ['--use-angle=vulkan'];
	}
}

function commonChromiumArguments(
	profileDirectory: string,
	sessionDirectory: string,
	scenario: RuntimeLabScenario,
	backend: RequestedGraphicsBackend
): string[] {
	return [
		'--disable-background-networking',
		'--disable-background-timer-throttling',
		'--disable-backgrounding-occluded-windows',
		'--disable-breakpad',
		'--disable-client-side-phishing-detection',
		'--disable-component-update',
		'--disable-default-apps',
		'--disable-domain-reliability',
		'--disable-extensions',
		'--disable-quic',
		'--disable-renderer-backgrounding',
		'--disable-sync',
		'--no-default-browser-check',
		'--no-first-run',
		'--password-store=basic',
		`--user-data-dir=${profileDirectory}`,
		`--disk-cache-dir=${join(sessionDirectory, 'cache')}`,
		`--force-device-scale-factor=${scenario.viewport.deviceScaleFactor}`,
		`--window-size=${scenario.viewport.cssWidth},${scenario.viewport.cssHeight}`,
		'--proxy-server=http=127.0.0.1:9;https=127.0.0.1:9',
		'--proxy-bypass-list=127.0.0.1;localhost',
		'--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
		...graphicsArguments(backend)
	];
}

export function buildRuntimeLaunchPlan(options: BuildRuntimeLaunchPlanOptions): RuntimeLaunchPlan {
	const { candidate, scenario } = options;
	if (!isAbsolute(options.runDirectory)) throw new TypeError('runDirectory must be absolute.');
	const pageUrl = validateLoopbackPageUrl(options.pageUrl).href;
	const profileDirectory = join(options.runDirectory, 'profile');
	const sessionDirectory = join(options.runDirectory, 'session');
	const commonArguments = commonChromiumArguments(
		profileDirectory,
		sessionDirectory,
		scenario,
		candidate.manifest.graphics.requestedBackend
	);
	const environment = buildSanitizedEnvironment(options.sourceEnvironment);

	if (candidate.manifest.runtimeKind === 'electron') {
		const electronHostDirectory = resolve(options.electronHostDirectory);
		return {
			adapterContractVersion: RUNTIME_ADAPTER_CONTRACT_VERSION,
			arguments: [
				...commonArguments,
				...candidate.manifest.launch.additionalArguments,
				electronHostDirectory
			],
			command: candidate.executablePath,
			environment: {
				...environment,
				WOK_RUNTIME_LAB_CANDIDATE_ID: candidate.manifest.id,
				WOK_RUNTIME_LAB_HEIGHT: String(scenario.viewport.cssHeight),
				WOK_RUNTIME_LAB_PAGE_URL: pageUrl,
				WOK_RUNTIME_LAB_PROFILE_DIR: profileDirectory,
				WOK_RUNTIME_LAB_SESSION_DIR: sessionDirectory,
				WOK_RUNTIME_LAB_WIDTH: String(scenario.viewport.cssWidth)
			},
			kind: 'electron',
			profileDirectory,
			sessionDirectory
		};
	}

	return {
		adapterContractVersion: RUNTIME_ADAPTER_CONTRACT_VERSION,
		arguments: [
			...commonArguments,
			'--remote-debugging-port=0',
			...candidate.manifest.launch.additionalArguments,
			`--app=${pageUrl}`
		],
		command: candidate.executablePath,
		environment,
		kind: 'chromium',
		profileDirectory,
		sessionDirectory
	};
}
