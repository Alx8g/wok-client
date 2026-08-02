import assert from 'node:assert/strict';
import test from 'node:test';
import {
	buildWindowsFirewallRule,
	closeWindowsEgressGuardWithRetry,
	createWindowsEgressGuard
} from '../src/controller/windows-firewall.ts';
import {
	findWindowsProcessImageMismatches,
	sameWindowsProcessIdentity
} from '../src/controller/windows-process-control.ts';
import { parseWindowsProcessTreeSample } from '../src/controller/windows-process-monitor.ts';
import { aggregateProcessTreeResourceSample } from '../src/host/process-resources.ts';

test('Windows process samples preserve exact identity and aggregate resources', () => {
	const sample = parseWindowsProcessTreeSample(
		JSON.stringify({
			capturedAtMs: 1_700_000_000_000,
			foregroundOwnedByCandidateTree: true,
			foregroundProcessId: 200,
			processes: [
				{
					commandLine: '',
					creationTimeUtcTicks: '638900000000000000',
					cpuPercent: 25,
					executableName: 'candidate.exe',
					executablePath: 'C:\\runtime\\candidate.exe',
					parentProcessId: 0,
					performanceCountersPresent: true,
					privateBytes: 1_000,
					processId: 200,
					workingSetBytes: 2_000
				},
				{
					commandLine: '',
					creationTimeUtcTicks: '638900000000010000',
					cpuPercent: 50,
					executableName: 'candidate.exe',
					executablePath: 'C:\\runtime\\candidate.exe',
					parentProcessId: 0,
					performanceCountersPresent: true,
					privateBytes: 3_000,
					processId: 201,
					workingSetBytes: 4_000
				}
			],
			rootProcessId: 200
		})
	);
	assert.equal(sample.foregroundOwnedByCandidateTree, true);
	assert.equal(sample.foregroundProcessId, 200);
	assert.equal(
		sample.processes[1].creationTimeUtcTicks,
		'638900000000010000'
	);
	assert.equal(
		sample.processes[1].executablePath,
		'C:\\runtime\\candidate.exe'
	);
	assert.deepEqual(aggregateProcessTreeResourceSample(sample), {
		capturedAtMs: 1_700_000_000_000,
		processCount: 2,
		rootPresent: true,
		rootProcessId: 200,
		totalCpuPercent: 75,
		totalPrivateBytes: 4_000,
		totalWorkingSetBytes: 6_000
	});
});

test('Windows process samples reject non-canonical or out-of-range creation ticks', () => {
	for (const creationTimeUtcTicks of [
		'0',
		'01',
		'638900000000000001',
		'3155378976000000000'
	]) {
		assert.throws(
			() => parseWindowsProcessTreeSample(
				JSON.stringify({
					capturedAtMs: 1_700_000_000_000,
					foregroundOwnedByCandidateTree: true,
					foregroundProcessId: 200,
					processes: [{
						commandLine: '',
						creationTimeUtcTicks,
						cpuPercent: 0,
						executableName: 'candidate.exe',
						executablePath: 'C:\\runtime\\candidate.exe',
						parentProcessId: 0,
						performanceCountersPresent: true,
						privateBytes: 0,
						processId: 200,
						workingSetBytes: 0
					}],
					rootProcessId: 200
				})
			),
			/canonical 10-tick UTC DateTime/u
		);
	}
});

test('spawned-process identity matching rejects PID reuse and executable mismatches', () => {
	const expected = {
		commandLine: '',
		creationTimeUtcTicks: '638900000000000000',
		executableName: 'candidate.exe',
		executablePath: 'C:\\runtime\\candidate.exe',
		parentProcessId: 0,
		processId: 200
	};
	assert.equal(sameWindowsProcessIdentity(expected, { ...expected }), true);
	assert.equal(
		sameWindowsProcessIdentity(expected, {
			...expected,
			executablePath: 'C:\\other\\candidate.exe'
		}),
		false
	);
	assert.equal(
		sameWindowsProcessIdentity(expected, {
			...expected,
			creationTimeUtcTicks: '638900000000020000'
		}),
		false
	);
	assert.equal(
		sameWindowsProcessIdentity(expected, {
			...expected,
			processId: 201
		}),
		false
	);
});

test('executable-scoped egress rejects alternate or unavailable process images', () => {
	const expected = {
		commandLine: '',
		creationTimeUtcTicks: '638900000000000000',
		executableName: 'candidate.exe',
		executablePath: 'C:\\runtime\\candidate.exe',
		parentProcessId: 0,
		processId: 200
	};
	const mismatches = findWindowsProcessImageMismatches([
		expected,
		{
			...expected,
			executableName: 'helper.exe',
			executablePath: 'C:\\runtime\\helper.exe',
			processId: 201
		},
		{
			...expected,
			executablePath: '',
			processId: 202
		}
	], 'C:\\runtime\\candidate.exe');
	assert.deepEqual(
		mismatches.map(processIdentity => processIdentity.processId),
		[201, 202]
	);
});

test('Windows firewall rule blocks non-loopback egress for every program', () => {
	const rule = buildWindowsFirewallRule('run-a');
	assert.equal(rule.name, 'WOK Runtime Lab run-a');
	assert.equal(rule.scope, 'all-programs');
	assert.ok(rule.addArguments.includes('dir=out'));
	assert.ok(rule.addArguments.includes('action=block'));
	assert.ok(
		!rule.addArguments.some(argument =>
			argument.startsWith('program='))
	);
	assert.ok(
		!rule.deleteArguments.some(argument =>
			argument.startsWith('program='))
	);
	assert.match(
		rule.remoteAddresses,
		/0\.0\.0\.0-126\.255\.255\.255/u
	);
	assert.match(
		rule.remoteAddresses,
		/128\.0\.0\.0-255\.255\.255\.255/u
	);
	assert.match(rule.remoteAddresses, /::2-ffff:/u);
	assert.doesNotMatch(rule.remoteAddresses, /127\.0\.0\.1/u);
	assert.doesNotMatch(
		rule.remoteAddresses,
		/(?:^|,)::1(?:,|$)/u
	);
});

test('failed firewall deletion remains retryable and successful deletion is idempotent', async () => {
	const rule = buildWindowsFirewallRule('retry-close');
	let deletionCount = 0;
	const guard = createWindowsEgressGuard(rule, async () => {
		deletionCount += 1;
		if (deletionCount === 1) {
			throw new Error('temporary netsh failure');
		}
	});

	await assert.rejects(
		guard.close(),
		/temporary netsh failure/u
	);
	await guard.close();
	await guard.close();
	assert.equal(deletionCount, 2);
});

test('concurrent firewall deletion calls share one in-flight operation', async () => {
	const rule = buildWindowsFirewallRule('concurrent-close');
	let deletionCount = 0;
	let releaseDeletion: (() => void) | undefined;
	const guard = createWindowsEgressGuard(rule, async () => {
		deletionCount += 1;
		await new Promise<void>(resolveDeletion => {
			releaseDeletion = resolveDeletion;
		});
	});

	const first = guard.close();
	const second = guard.close();
	assert.equal(deletionCount, 1);
	releaseDeletion?.();
	await Promise.all([first, second]);
	assert.equal(deletionCount, 1);
});

test('firewall cleanup retries with bounded waits and reports exhaustion', async () => {
	const rule = buildWindowsFirewallRule('retry-policy');
	let deletionCount = 0;
	const waits: number[] = [];
	const recoverableGuard = createWindowsEgressGuard(
		rule,
		async () => {
			deletionCount += 1;
			if (deletionCount < 3) {
				throw new Error('retry deletion');
			}
		}
	);
	await closeWindowsEgressGuardWithRetry(
		recoverableGuard,
		{
			attempts: 3,
			delayMs: 5,
			wait: async milliseconds => {
				waits.push(milliseconds);
			}
		}
	);
	assert.equal(deletionCount, 3);
	assert.deepEqual(waits, [5, 5]);

	let exhaustedCount = 0;
	const exhaustedGuard = createWindowsEgressGuard(
		buildWindowsFirewallRule('retry-exhausted'),
		async () => {
			exhaustedCount += 1;
			throw new Error('persistent deletion failure');
		}
	);
	await assert.rejects(
		closeWindowsEgressGuardWithRetry(exhaustedGuard, {
			attempts: 2,
			delayMs: 0
		}),
		/persistent deletion failure/u
	);
	assert.equal(exhaustedCount, 2);
});
