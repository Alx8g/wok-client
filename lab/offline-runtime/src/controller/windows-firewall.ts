import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const EXTERNAL_REMOTE_ADDRESSES = [
	'0.0.0.0-126.255.255.255',
	'128.0.0.0-255.255.255.255',
	'::',
	'::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'
].join(',');

export interface WindowsFirewallRule {
	addArguments: string[];
	deleteArguments: string[];
	name: string;
	remoteAddresses: string;
	scope: 'all-programs';
}

export interface WindowsEgressGuard {
	close(): Promise<void>;
	rule: WindowsFirewallRule;
}

export interface WindowsEgressGuardRetryOptions {
	attempts?: number;
	delayMs?: number;
	wait?(milliseconds: number): Promise<void>;
}

export function buildWindowsFirewallRule(
	runId: string
): WindowsFirewallRule {
	if (!/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(runId)) {
		throw new TypeError('runId is not firewall-safe.');
	}
	const name = `WOK Runtime Lab ${runId}`;
	return {
		addArguments: [
			'advfirewall',
			'firewall',
			'add',
			'rule',
			`name=${name}`,
			'dir=out',
			'action=block',
			`remoteip=${EXTERNAL_REMOTE_ADDRESSES}`,
			'protocol=any',
			'profile=any',
			'enable=yes'
		],
		deleteArguments: [
			'advfirewall',
			'firewall',
			'delete',
			'rule',
			`name=${name}`,
			'dir=out'
		],
		name,
		remoteAddresses: EXTERNAL_REMOTE_ADDRESSES,
		scope: 'all-programs'
	};
}

async function assertWindowsFirewallEnabled(): Promise<void> {
	const command = [
		'$disabled = @(Get-NetFirewallProfile | Where-Object { -not $_.Enabled });',
		'if ($disabled.Count -ne 0) {',
		"[Console]::Error.WriteLine(('Disabled firewall profiles: ' + (($disabled | ForEach-Object Name) -join ', ')));",
		'exit 5',
		'}'
	].join(' ');
	try {
		await execFileAsync('powershell.exe', [
			'-NoLogo',
			'-NoProfile',
			'-NonInteractive',
			'-Command',
			command
		], {
			windowsHide: true
		});
	} catch (error) {
		throw new Error(
			'Windows Firewall must be enabled for all profiles '
				+ `before a sealed run: ${error instanceof Error
					? error.message
					: String(error)}`
		);
	}
}

export function createWindowsEgressGuard(
	rule: WindowsFirewallRule,
	deleteRule: () => Promise<void>
): WindowsEgressGuard {
	let closed = false;
	let closing: Promise<void> | undefined;
	return {
		async close() {
			if (closed) return;
			if (closing) return closing;
			closing = (async () => {
				try {
					await deleteRule();
					closed = true;
				} catch (error) {
					throw new Error(
						'Could not remove run-scoped egress guard '
							+ `${rule.name}: ${error instanceof Error
								? error.message
								: String(error)}`
					);
				} finally {
					closing = undefined;
				}
			})();
			return closing;
		},
		rule
	};
}

export async function closeWindowsEgressGuardWithRetry(
	guard: WindowsEgressGuard,
	options: WindowsEgressGuardRetryOptions = {}
): Promise<void> {
	const attempts = options.attempts ?? 3;
	const delayMs = options.delayMs ?? 250;
	if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
		throw new RangeError(
			'Firewall cleanup attempts must be an integer from 1 through 10.'
		);
	}
	if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 10_000) {
		throw new RangeError(
			'Firewall cleanup delay must be from 0 through 10000 ms.'
		);
	}
	const wait = options.wait ?? (milliseconds =>
		new Promise(resolveWait => {
			setTimeout(resolveWait, milliseconds);
		}));
	let finalError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			await guard.close();
			return;
		} catch (error) {
			finalError = error;
			if (attempt < attempts && delayMs > 0) {
				await wait(delayMs);
			}
		}
	}
	throw finalError;
}

export async function installWindowsEgressGuard(
	runId: string
): Promise<WindowsEgressGuard> {
	if (process.platform !== 'win32') {
		throw new Error(
			'The run-scoped egress guard is currently implemented only for Windows.'
		);
	}
	await assertWindowsFirewallEnabled();
	const rule = buildWindowsFirewallRule(runId);
	await execFileAsync(
		'netsh.exe',
		rule.deleteArguments,
		{ windowsHide: true }
	).catch((): undefined => undefined);
	try {
		await execFileAsync(
			'netsh.exe',
			rule.addArguments,
			{ windowsHide: true }
		);
	} catch (error) {
		throw new Error(
			'Could not install run-scoped all-program egress guard: '
				+ `${error instanceof Error
					? error.message
					: String(error)}`
		);
	}
	return createWindowsEgressGuard(
		rule,
		async () => {
			await execFileAsync(
				'netsh.exe',
				rule.deleteArguments,
				{ windowsHide: true }
			);
		}
	);
}
