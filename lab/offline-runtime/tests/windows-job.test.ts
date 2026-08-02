import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import {
	access,
	copyFile,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
	startWindowsJobProcess,
	type VerifiedWindowsExecutable,
	type WindowsJobProcess,
	type WindowsJobProcessStart
} from '../src/controller/windows-job.ts';
import { sameWindowsProcessIdentity } from '../src/controller/windows-process-control.ts';
import {
	listWindowsProcessesById,
	type WindowsProcessIdentity
} from '../src/controller/windows-process-monitor.ts';
import { sha256Hex } from '../src/shared/hash.ts';

const execFileAsync = promisify(execFile);
const WINDOWS_TEST_TIMEOUT_MS = 60_000;
const fixtureSource = String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;

public static class WokWindowsJobFixture
{
	private static void AppendMarker(string path, string value)
	{
		for (int attempt = 0; attempt < 200; attempt++)
		{
			try
			{
				using (var stream = new FileStream(
					path,
					FileMode.Append,
					FileAccess.Write,
					FileShare.ReadWrite
				))
				using (var writer = new StreamWriter(stream, Encoding.UTF8))
				{
					writer.WriteLine(value);
					writer.Flush();
					return;
				}
			}
			catch (IOException)
			{
				Thread.Sleep(5);
			}
		}
		throw new IOException("Could not write fixture marker.");
	}

	private static Process StartChild(string mode, string markerPath)
	{
		string executablePath = Assembly.GetExecutingAssembly().Location;
		var startInfo = new ProcessStartInfo();
		startInfo.FileName = executablePath;
		startInfo.Arguments = mode + " \"" + markerPath.Replace("\"", "\\\"") + "\"";
		startInfo.CreateNoWindow = true;
		startInfo.UseShellExecute = false;
		return Process.Start(startInfo);
	}

	public static int Main(string[] arguments)
	{
		if (arguments.Length < 2) return 64;
		string mode = arguments[0];
		string markerPath = arguments[1];
		int processId = Process.GetCurrentProcess().Id;
		AppendMarker(
			markerPath,
			"START|" + processId + "|" + mode
		);

		if (mode == "arguments")
		{
			for (int index = 2; index < arguments.Length; index++)
			{
				AppendMarker(
					markerPath,
					"ARG|" + Convert.ToBase64String(
						Encoding.UTF8.GetBytes(arguments[index])
					)
				);
			}
			return 0;
		}

		if (mode == "output-framing")
		{
			Stream output = Console.OpenStandardOutput();
			byte[] first = Encoding.UTF8.GetBytes("alpha\r");
			output.Write(first, 0, first.Length);
			output.Flush();
			Thread.Sleep(25);
			byte[] second = Encoding.UTF8.GetBytes("\nbeta");
			output.Write(second, 0, second.Length);
			output.Flush();
			Console.Error.Write("error-without-newline");
			Console.Error.Flush();
			return 0;
		}

		if (mode == "output-oversized")
		{
			Stream output = Console.OpenStandardOutput();
			byte[] block = Encoding.ASCII.GetBytes(
				new string('x', 8192)
			);
			for (int index = 0; index < 256; index++)
			{
				output.Write(block, 0, block.Length);
			}
			output.Flush();
			return 0;
		}

		if (mode == "output-multibyte")
		{
			Stream output = Console.OpenStandardOutput();
			byte[] block = Encoding.UTF8.GetBytes(
				new string('€', 400000)
			);
			output.Write(block, 0, block.Length);
			output.Flush();
			return 0;
		}

		if (mode == "spawn")
		{
			Process child = StartChild("wait", markerPath);
			AppendMarker(
				markerPath,
				"SPAWNED|" + child.Id
			);
			Thread.Sleep(30000);
			return 0;
		}

		if (mode == "spawn-loop")
		{
			for (int index = 0; index < 50; index++)
			{
				try
				{
					Process child = StartChild("wait", markerPath);
					AppendMarker(
						markerPath,
						"SPAWNED|" + child.Id
					);
				}
				catch
				{
				}
				Thread.Sleep(20);
			}
			Thread.Sleep(30000);
			return 0;
		}

		if (mode == "spoof-control")
		{
			Console.Out.WriteLine("terminate");
			Console.Out.WriteLine(
				"WOK_JOB_PROTOCOL_fake EXITED|0|1|1"
			);
			Console.Out.Flush();
			Thread.Sleep(30000);
			return 0;
		}

		Thread.Sleep(30000);
		return 0;
	}
}
`;

let fixtureDirectory = '';
let fixtureExecutable: VerifiedWindowsExecutable | undefined;
let fixturePath = '';

test.before(async () => {
	if (process.platform !== 'win32') return;
	fixtureDirectory = await mkdtemp(
		join(tmpdir(), 'wok-windows-job-')
	);
	fixturePath = join(fixtureDirectory, 'wok-windows-job.exe');
	const compileCommand = [
		"$source = @'",
		fixtureSource,
		"'@",
		'Add-Type -TypeDefinition $source '
			+ '-OutputAssembly $env:WOK_FIXTURE_PATH '
			+ '-OutputType WindowsApplication;'
	].join('\n');
	await execFileAsync(
		'powershell.exe',
		[
			'-NoLogo',
			'-NoProfile',
			'-NonInteractive',
			'-Command',
			compileCommand
		],
		{
			env: {
				...process.env,
				WOK_FIXTURE_PATH: fixturePath
			},
			timeout: 20_000,
			windowsHide: true
		}
	);
	fixtureExecutable = await verifiedExecutable(fixturePath);
});

test.after(async () => {
	if (!fixtureDirectory) return;
	await rm(fixtureDirectory, {
		force: true,
		recursive: true
	});
});

async function verifiedExecutable(
	path: string
): Promise<VerifiedWindowsExecutable> {
	const bytes = await readFile(path);
	return {
		path,
		sha256: sha256Hex(bytes),
		sizeBytes: bytes.byteLength
	};
}

async function markerExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function markerLines(path: string): Promise<string[]> {
	try {
		return (await readFile(path, 'utf8'))
			.replace(/^﻿/u, '')
			.split(/\r?\n/u)
			.filter(Boolean);
	} catch (error) {
		if (
			error instanceof Error
			&& 'code' in error
			&& error.code === 'ENOENT'
		) {
			return [];
		}
		throw error;
	}
}

async function waitFor<T>(
	operation: () => Promise<T | undefined>,
	timeoutMs = 10_000
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	do {
		const result = await operation();
		if (result !== undefined) return result;
		await new Promise(resolve => setTimeout(resolve, 25));
	} while (Date.now() < deadline);
	throw new Error('Timed out waiting for Windows job fixture evidence.');
}

function launchFixture(
	mode: string,
	markerPath: string,
	extraArguments: readonly string[] = [],
	options: {
		executable?: VerifiedWindowsExecutable;
		testOnlyFailAssignmentBeforeResume?: boolean;
		testOnlyProtocolFailure?:
			| 'delayed-process-ids'
			| 'delayed-start-evidence'
			| 'dropped-process-ids'
			| 'invalid-base64'
			| 'invalid-output-state'
			| 'invalid-process-ids'
			| 'oversized-line';
	} = {}
): WindowsJobProcess {
	const {
		executable = fixtureExecutable,
		...launchOptions
	} = options;
	if (executable === undefined) {
		throw new Error('Windows job fixture executable is unavailable.');
	}
	return startWindowsJobProcess({
		arguments: [mode, markerPath, ...extraArguments],
		cwd: fixtureDirectory,
		environment: { ...process.env },
		executable,
		intervalMs: 100,
		...launchOptions
	});
}

async function stopJob(job: WindowsJobProcess): Promise<void> {
	const exit = await Promise.race([
		job.terminate(),
		new Promise<never>((_resolve, reject) =>
			setTimeout(
				() => reject(new Error('Timed out stopping test Windows job.')),
				10_000
			)
		)
	]).catch(async error => {
		job.child.kill();
		await job.completed;
		throw error;
	});
	assert.equal(exit.jobClean, true);
}

function startIdentity(
	started: WindowsJobProcessStart
): WindowsProcessIdentity {
	return {
		commandLine: '',
		creationTimeUtcTicks: started.creationTimeUtcTicks,
		executableName: basename(started.executablePath),
		executablePath: started.executablePath,
		parentProcessId: 0,
		processId: started.processId
	};
}

async function exactIdentityIsActive(
	identity: WindowsProcessIdentity
): Promise<boolean> {
	const current = await listWindowsProcessesById([
		identity.processId
	]);
	return current.some(processIdentity =>
		sameWindowsProcessIdentity(identity, processIdentity)
	);
}

async function waitForExactIdentitiesToExit(
	identities: readonly WindowsProcessIdentity[]
): Promise<void> {
	await waitFor(async () => {
		const processIds = [
			...new Set(identities.map(identity => identity.processId))
		];
		const current = await listWindowsProcessesById(processIds);
		const active = identities.filter(identity =>
			current.some(processIdentity =>
				sameWindowsProcessIdentity(identity, processIdentity)
			)
		);
		return active.length === 0 ? true : undefined;
	});
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolve, reject) => {
		child.once('exit', () => resolve());
		child.once('error', reject);
	});
}

test(
	'Windows job keeps the candidate suspended until exact membership is sampled',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const markerPath = join(fixtureDirectory, 'suspended.marker');
		const job = launchFixture('wait', markerPath);
		try {
			assert.equal(job.state, 'suspended');
			const started = await job.started;
			assert.ok(fixtureExecutable !== undefined);
			assert.equal(
				started.executable.sha256,
				fixtureExecutable.sha256
			);
			assert.equal(
				started.executable.sizeBytes,
				fixtureExecutable.sizeBytes
			);
			assert.match(started.executable.fileIdHex, /^[0-9a-f]{16}$/u);
			assert.match(
				started.executable.volumeSerialNumberHex,
				/^[0-9a-f]{8}$/u
			);
			assert.match(
				started.executable.finalPath,
				/^\\\\\?\\Volume\{[0-9a-f-]+\}\\/iu
			);
			const firstSuspendedSnapshot =
				await job.snapshotProcessIds();
			const secondSuspendedSnapshot =
				await job.snapshotProcessIds();
			assert.deepEqual(
				[...firstSuspendedSnapshot].sort((left, right) => left - right),
				[started.processId]
			);
			assert.deepEqual(
				[...secondSuspendedSnapshot].sort((left, right) => left - right),
				[started.processId]
			);
			const firstSample = await job.firstSample;
			assert.equal(
				firstSample.processes.some(
					processIdentity =>
						processIdentity.processId === started.processId
						&& processIdentity.creationTimeUtcTicks
							=== started.creationTimeUtcTicks
				),
				true
			);
			await new Promise(resolve => setTimeout(resolve, 250));
			assert.equal(await markerExists(markerPath), false);

			const resume = job.resume();
			assert.equal(job.state, 'resume-requested');
			await resume;
			assert.equal(job.state, 'running');
			await waitFor(async () =>
				(await markerExists(markerPath)) ? true : undefined
			);
			assert.equal(
				await exactIdentityIsActive(startIdentity(started)),
				true
			);
			const termination = job.terminate();
			assert.equal(job.state, 'termination-requested');
			const exit = await termination;
			assert.equal(job.state, 'closed');
			assert.equal(exit.jobClean, true);
			assert.deepEqual(exit.membership, {
				processIds: [],
				status: 'reconciled'
			});
			await waitForExactIdentitiesToExit([startIdentity(started)]);
		} finally {
			if (job.child.exitCode === null) await stopJob(job);
		}
	}
);

test(
	'Windows job rejects executable bytes that differ from the requested identity before execution',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		assert.ok(fixtureExecutable !== undefined);
		const markerPath = join(fixtureDirectory, 'identity-mismatch.marker');
		const job = launchFixture('wait', markerPath, [], {
			executable: {
				...fixtureExecutable,
				sha256: '0'.repeat(64)
			}
		});
		await assert.rejects(
			job.started,
			/bytes changed or did not match/u
		);
		const exit = await job.completed;
		assert.equal(exit.jobClean, false);
		assert.match(
			exit.launchError ?? '',
			/bytes changed or did not match/u
		);
		assert.equal(await markerExists(markerPath), false);
	}
);

test(
	'Windows job retains a deny-write-delete executable lease until cleanup',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const retainedPath = join(fixtureDirectory, 'retained-fixture.exe');
		const movedPath = join(fixtureDirectory, 'retained-fixture-moved.exe');
		const markerPath = join(fixtureDirectory, 'retained-fixture.marker');
		await copyFile(fixturePath, retainedPath);
		const executable = await verifiedExecutable(retainedPath);
		const job = launchFixture('wait', markerPath, [], { executable });
		try {
			await job.started;
			await assert.rejects(
				rename(retainedPath, movedPath),
				/error|access|busy|permission/iu
			);
			await assert.rejects(
				writeFile(retainedPath, Buffer.from('replacement', 'utf8')),
				/error|access|busy|permission/iu
			);
			const exit = await job.terminate();
			assert.equal(exit.jobClean, true);
			await rename(retainedPath, movedPath);
		} finally {
			if (job.child.exitCode === null) await stopJob(job);
		}
	}
);

test(
	'Windows job assignment failure terminates the still-suspended candidate before execution',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const markerPath = join(fixtureDirectory, 'assignment-failure.marker');
		const job = launchFixture('wait', markerPath, [], {
			testOnlyFailAssignmentBeforeResume: true
		});
		await assert.rejects(job.started, /Access is denied/u);
		const exit = await job.completed;
		assert.equal(exit.jobClean, false);
		assert.match(exit.launchError ?? '', /Access is denied/u);
		assert.equal(await markerExists(markerPath), false);
	}
);

test(
	'Windows job preserves Windows command-line arguments exactly',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const markerPath = join(fixtureDirectory, 'arguments.marker');
		const expected = [
			'',
			'plain',
			'two words',
			'quote"inside',
			'trailing\\',
			'backslashes\\\\before"quote'
		];
		const job = launchFixture('arguments', markerPath, expected);
		await job.started;
		await job.firstSample;
		await job.resume();
		const exit = await job.completed;
		assert.equal(exit.jobClean, true);
		assert.equal(exit.exitCode, 0);
		const actual = (await markerLines(markerPath))
			.filter(line => line.startsWith('ARG|'))
			.map(line => Buffer.from(line.slice(4), 'base64').toString('utf8'));
		assert.deepEqual(actual, expected);
	}
);

test(
	'Windows job captures candidate output on channels isolated from owner protocol',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const markerPath = join(fixtureDirectory, 'output-framing.marker');
		const job = launchFixture('output-framing', markerPath);
		await job.started;
		await job.firstSample;
		await job.resume();
		const exit = await job.completed;
		assert.equal(exit.jobClean, true);
		assert.equal(exit.exitCode, 0);
		assert.equal(exit.stdout, 'alpha\r\nbeta');
		assert.equal(exit.stdoutTruncated, false);
		assert.equal(exit.stderr, 'error-without-newline');
		assert.equal(exit.stderrTruncated, false);
	}
);

test(
	'Windows job drains and bounds oversized candidate output without a newline',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const markerPath = join(fixtureDirectory, 'output-oversized.marker');
		const job = launchFixture('output-oversized', markerPath);
		await job.started;
		await job.firstSample;
		await job.resume();
		const exit = await job.completed;
		assert.equal(exit.jobClean, true);
		assert.equal(exit.exitCode, 0);
		assert.equal(Buffer.byteLength(exit.stdout), 1024 * 1024);
		assert.match(exit.stdout, /^x+$/u);
		assert.equal(exit.stdoutTruncated, true);
	}
);

test(
	'Windows job keeps truncated multibyte output within its exact byte cap',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const markerPath = join(fixtureDirectory, 'output-multibyte.marker');
		const job = launchFixture('output-multibyte', markerPath);
		await job.started;
		await job.firstSample;
		await job.resume();
		const exit = await job.completed;
		assert.equal(exit.jobClean, true);
		assert.equal(exit.exitCode, 0);
		assert.equal(Buffer.byteLength(exit.stdout), 1_048_575);
		assert.equal(exit.stdout.endsWith('€'), true);
		assert.equal(exit.stdout.includes('�'), false);
		assert.equal(exit.stdoutTruncated, true);
	}
);

test(
	'Windows job kills its sole owner on malformed exact-token protocol',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		for (const failure of [
			{
				expected: /canonical base64/u,
				mode: 'invalid-base64' as const
			},
			{
				expected: /must be 0 or 1/u,
				mode: 'invalid-output-state' as const
			},
			{
				expected: /exceeded its byte limit/u,
				mode: 'oversized-line' as const
			}
		]) {
			const markerPath = join(
				fixtureDirectory,
				`protocol-${failure.mode}.marker`
			);
			const job = launchFixture('wait', markerPath, [], {
				testOnlyProtocolFailure: failure.mode
			});
			await job.started;
			const exit = await Promise.race([
				job.completed,
				new Promise<never>((_resolve, reject) =>
					setTimeout(
						() => reject(new Error(
							'Malformed protocol did not terminate its owner.'
						)),
						10_000
					)
				)
			]);
			assert.equal(exit.jobClean, false);
			assert.match(exit.launchError ?? '', failure.expected);
			assert.equal(await markerExists(markerPath), false);
		}
	}
);

test(
	'Windows job rejects a malformed correlated process-ID response',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const markerPath = join(
			fixtureDirectory,
			'protocol-invalid-process-ids.marker'
		);
		const job = launchFixture('wait', markerPath, [], {
			testOnlyProtocolFailure: 'invalid-process-ids'
		});
		await job.started;
		await assert.rejects(
			job.snapshotProcessIds(),
			/job process ID 1 must be a positive integer/u
		);
		const exit = await job.completed;
		assert.equal(exit.jobClean, false);
		assert.match(
			exit.launchError ?? '',
			/job process ID 1 must be a positive integer/u
		);
		assert.equal(await markerExists(markerPath), false);
	}
);

test(
	'Windows job snapshots reject pre-aborted requests without disturbing the host',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const markerPath = join(
			fixtureDirectory,
			'process-ids-pre-aborted.marker'
		);
		const job = launchFixture('wait', markerPath);
		try {
			const started = await job.started;
			const abortController = new AbortController();
			abortController.abort(new Error('test pre-abort'));
			await assert.rejects(
				job.snapshotProcessIds({
					signal: abortController.signal,
					timeoutMs: 1_000
				}),
				/was aborted.*test pre-abort/u
			);
			assert.equal(job.state, 'suspended');
			assert.deepEqual(
				await job.snapshotProcessIds({ timeoutMs: 1_000 }),
				[started.processId]
			);
			await stopJob(job);
		} finally {
			if (job.child.exitCode === null) await stopJob(job);
		}
	}
);

test(
	'Windows job removes a snapshot aborted while candidate startup is pending',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const markerPath = join(
			fixtureDirectory,
			'process-ids-abort-before-write.marker'
		);
		const job = launchFixture('wait', markerPath, [], {
			testOnlyProtocolFailure: 'delayed-start-evidence'
		});
		try {
			const abortController = new AbortController();
			const pending = job.snapshotProcessIds({
				signal: abortController.signal,
				timeoutMs: 2_000
			});
			const abortedAtMs = Date.now();
			abortController.abort(new Error('test startup abort'));
			await assert.rejects(
				pending,
				/was aborted.*test startup abort/u
			);
			assert.equal(Date.now() - abortedAtMs < 500, true);
			const started = await job.started;
			assert.deepEqual(
				await job.snapshotProcessIds({ timeoutMs: 1_000 }),
				[started.processId]
			);
			await stopJob(job);
		} finally {
			if (job.child.exitCode === null) await stopJob(job);
		}
	}
);

test(
	'Windows job keeps an aborted written snapshot as a correlated tombstone',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const markerPath = join(
			fixtureDirectory,
			'process-ids-aborted-written.marker'
		);
		const job = launchFixture('wait', markerPath, [], {
			testOnlyProtocolFailure: 'delayed-process-ids'
		});
		try {
			const started = await job.started;
			const abortController = new AbortController();
			const pending = job.snapshotProcessIds({
				signal: abortController.signal,
				timeoutMs: 2_000
			});
			setTimeout(() => {
				abortController.abort(new Error('test post-write abort'));
			}, 25);
			await assert.rejects(
				pending,
				/was aborted.*test post-write abort/u
			);
			await new Promise(resolve => setTimeout(resolve, 350));
			assert.deepEqual(
				await job.snapshotProcessIds({ timeoutMs: 2_000 }),
				[started.processId]
			);
			await stopJob(job);
		} finally {
			if (job.child.exitCode === null) await stopJob(job);
		}
	}
);

test(
	'Windows job snapshot timeout includes pending candidate startup evidence',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const markerPath = join(
			fixtureDirectory,
			'process-ids-startup-timeout.marker'
		);
		const job = launchFixture('wait', markerPath, [], {
			testOnlyProtocolFailure: 'delayed-start-evidence'
		});
		await assert.rejects(
			job.snapshotProcessIds({ timeoutMs: 100 }),
			/timed out after 100 ms.*membership trust is lost/iu
		);
		const exit = await job.completed;
		assert.equal(exit.jobClean, false);
		assert.equal(exit.membership.status, 'unreconciled');
		assert.match(
			exit.membership.status === 'unreconciled'
				? exit.membership.reason
				: '',
			/membership trust is lost/iu
		);
		assert.equal(await markerExists(markerPath), false);
	}
);

test(
	'Windows job snapshot timeout fails the protocol and preserves unreconciled membership',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const markerPath = join(
			fixtureDirectory,
			'process-ids-timeout.marker'
		);
		const job = launchFixture('wait', markerPath, [], {
			testOnlyProtocolFailure: 'dropped-process-ids'
		});
		await job.started;
		await assert.rejects(
			job.snapshotProcessIds({ timeoutMs: 50 }),
			/timed out after 50 ms.*membership trust is lost/iu
		);
		const exit = await job.completed;
		assert.equal(exit.jobClean, false);
		assert.equal(exit.membership.status, 'unreconciled');
		assert.match(
			exit.membership.status === 'unreconciled'
				? exit.membership.reason
				: '',
			/membership trust is lost/iu
		);
		assert.equal(await markerExists(markerPath), false);
	}
);

test(
	'Windows job resume write failures fail closed before candidate execution',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const markerPath = join(
			fixtureDirectory,
			'resume-write-failure.marker'
		);
		const job = launchFixture('wait', markerPath);
		await job.started;
		Object.defineProperty(job.child.stdin, 'write', {
			configurable: true,
			value: () => {
				throw new Error('test resume write failure');
			}
		});
		await assert.rejects(
			job.resume(),
			/test resume write failure/u
		);
		const exit = await job.completed;
		assert.equal(exit.jobClean, false);
		assert.equal(exit.membership.status, 'unreconciled');
		assert.match(exit.launchError ?? '', /test resume write failure/u);
		assert.equal(await markerExists(markerPath), false);
	}
);

test(
	'Windows job termination write failures fail closed without claiming membership',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const markerPath = join(
			fixtureDirectory,
			'termination-write-failure.marker'
		);
		const job = launchFixture('wait', markerPath);
		await job.started;
		Object.defineProperty(job.child.stdin, 'write', {
			configurable: true,
			value: () => {
				throw new Error('test termination write failure');
			}
		});
		const exit = await job.terminate();
		assert.equal(exit.jobClean, false);
		assert.equal(exit.membership.status, 'unreconciled');
		assert.match(
			exit.launchError ?? '',
			/test termination write failure/u
		);
		assert.equal(await markerExists(markerPath), false);
	}
);

test(
	'Windows job control-pipe errors force owner closure and unreconciled cleanup',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const markerPath = join(
			fixtureDirectory,
			'control-pipe-error.marker'
		);
		const job = launchFixture('wait', markerPath);
		await job.started;
		job.child.stdin.destroy(new Error('test control pipe failure'));
		const exit = await job.completed;
		assert.equal(exit.jobClean, false);
		assert.equal(exit.membership.status, 'unreconciled');
		assert.match(exit.launchError ?? '', /test control pipe failure/u);
		assert.equal(await markerExists(markerPath), false);
	}
);

test(
	'Windows job termination empties a root-and-descendant job before reporting clean',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const markerPath = join(fixtureDirectory, 'descendants.marker');
		const job = launchFixture('spawn', markerPath);
		try {
			await job.started;
			await job.firstSample;
			await job.resume();
			const identities = await waitFor(async () => {
				const latest = job.samples.at(-1);
				return latest && latest.processes.length >= 2
					? latest.processes
					: undefined;
			});
			const expectedProcessIds = identities
				.map(identity => identity.processId)
				.sort((left, right) => left - right);
			const repeatedSnapshot = await job.snapshotProcessIds();
			const concurrentSnapshots = await Promise.all([
				job.snapshotProcessIds(),
				job.snapshotProcessIds()
			]);
			for (const snapshot of [
				repeatedSnapshot,
				...concurrentSnapshots
			]) {
				assert.deepEqual(
					[...snapshot].sort((left, right) => left - right),
					expectedProcessIds
				);
			}
			const exit = await job.terminate();
			assert.equal(exit.terminationRequested, true);
			assert.equal(exit.jobClean, true);
			await waitForExactIdentitiesToExit(identities);
		} finally {
			if (job.child.exitCode === null) await stopJob(job);
		}
	}
);

test(
	'Windows job kills continuously-created descendants during cleanup',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const markerPath = join(fixtureDirectory, 'spawn-loop.marker');
		const job = launchFixture('spawn-loop', markerPath);
		try {
			await job.started;
			await job.firstSample;
			await job.resume();
			const identities = await waitFor(async () => {
				const latest = job.samples.at(-1);
				return latest && latest.processes.length >= 3
					? latest.processes
					: undefined;
			});
			const exit = await job.terminate();
			assert.equal(exit.jobClean, true);
			await waitForExactIdentitiesToExit(identities);
		} finally {
			if (job.child.exitCode === null) await stopJob(job);
		}
	}
);

test(
	'closing the sole Job Object owner kills the contained candidate',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const markerPath = join(fixtureDirectory, 'owner-death.marker');
		const job = launchFixture('wait', markerPath);
		const started = await job.started;
		await job.firstSample;
		await job.resume();
		await waitFor(async () =>
			(await markerExists(markerPath)) ? true : undefined
		);
		job.child.kill();
		const exit = await job.completed;
		assert.equal(exit.jobClean, false);
		assert.equal(exit.membership.status, 'unreconciled');
		assert.match(
			exit.membership.status === 'unreconciled'
				? exit.membership.reason
				: '',
			/without a terminal record/u
		);
		assert.match(
			exit.launchError ?? '',
			/without a terminal record/u
		);
		await waitForExactIdentitiesToExit([startIdentity(started)]);
	}
);

test(
	'Windows job cleanup does not touch an unrelated process using the same image',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const unrelatedMarker = join(fixtureDirectory, 'unrelated.marker');
		const unrelated = spawn(
			fixturePath,
			['wait', unrelatedMarker],
			{
				cwd: dirname(fixturePath),
				stdio: 'ignore',
				windowsHide: true
			}
		);
		try {
			await waitFor(async () =>
				(await markerExists(unrelatedMarker)) ? true : undefined
			);
			const candidateMarker = join(fixtureDirectory, 'isolated.marker');
			const job = launchFixture('wait', candidateMarker);
			try {
				await job.started;
				await job.firstSample;
				await job.resume();
				await waitFor(async () =>
					(await markerExists(candidateMarker)) ? true : undefined
				);
				await stopJob(job);
				assert.equal(unrelated.exitCode, null);
				assert.equal(unrelated.signalCode, null);
			} finally {
				if (job.child.exitCode === null) await stopJob(job);
			}
		} finally {
			unrelated.kill();
			await waitForChildExit(unrelated);
		}
	}
);

test(
	'candidate stdout cannot issue the private Job Object cleanup command',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const markerPath = join(fixtureDirectory, 'spoof-control.marker');
		const job = launchFixture('spoof-control', markerPath);
		try {
			await job.started;
			await job.firstSample;
			await job.resume();
			await waitFor(async () =>
				(await markerExists(markerPath)) ? true : undefined
			);
			let completed = false;
			void job.completed.then(() => {
				completed = true;
			});
			await new Promise(resolve => setTimeout(resolve, 300));
			assert.equal(completed, false);
			const exit = await job.terminate();
			assert.equal(exit.jobClean, true);
			assert.match(exit.stdout, /WOK_JOB_PROTOCOL_fake/u);
		} finally {
			if (job.child.exitCode === null) await stopJob(job);
		}
	}
);
