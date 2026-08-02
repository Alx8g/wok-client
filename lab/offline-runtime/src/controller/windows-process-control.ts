import { isAbsolute } from 'node:path';
import type { WindowsProcessIdentity } from './windows-process-monitor.ts';

function assertProcessId(value: number): void {
	if (!Number.isInteger(value) || value < 1 || value > 0xffff_ffff) {
		throw new TypeError(
			'processId must be a positive 32-bit process ID.'
		);
	}
}

function normalizeWindowsPath(value: string): string {
	return value
		.replaceAll('/', '\\')
		.replace(/\\+$/u, '')
		.toLowerCase();
}

function normalizeCommandLine(value: string): string {
	return value.replaceAll('/', '\\').toLowerCase();
}

export function findWindowsProcessImageMismatches(
	processes: readonly WindowsProcessIdentity[],
	expectedExecutablePath: string
): WindowsProcessIdentity[] {
	if (!isAbsolute(expectedExecutablePath)) {
		throw new TypeError('expectedExecutablePath must be absolute.');
	}
	const expected = normalizeWindowsPath(expectedExecutablePath);
	const mismatches = new Map<number, WindowsProcessIdentity>();
	for (const processIdentity of processes) {
		assertProcessId(processIdentity.processId);
		if (
			!processIdentity.executablePath
			|| normalizeWindowsPath(processIdentity.executablePath)
				!== expected
		) {
			mismatches.set(
				processIdentity.processId,
				processIdentity
			);
		}
	}
	return [...mismatches.values()].sort(
		(left, right) => left.processId - right.processId
	);
}

export function sameWindowsProcessIdentity(
	expected: WindowsProcessIdentity,
	current: WindowsProcessIdentity
): boolean {
	if (expected.processId !== current.processId) return false;
	if (
		expected.creationTimeUtcTicks
		!== current.creationTimeUtcTicks
	) {
		return false;
	}
	if (
		expected.executableName.toLowerCase()
		!== current.executableName.toLowerCase()
	) {
		return false;
	}
	if (!expected.executablePath || !current.executablePath) {
		return false;
	}
	if (
		normalizeWindowsPath(expected.executablePath)
		!== normalizeWindowsPath(current.executablePath)
	) {
		return false;
	}
	if (expected.commandLine && current.commandLine) {
		return normalizeCommandLine(expected.commandLine)
			=== normalizeCommandLine(current.commandLine);
	}
	return true;
}
