import assert from 'node:assert/strict';
import {
	copyFile,
	mkdir,
	mkdtemp,
	rename,
	stat,
	writeFile
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
	startVerifiedWindowsToolProcess,
	type VerifiedWindowsExecutable
} from '../src/controller/windows-tool-process.ts';
import { sha256FileHex } from '../src/shared/hash.ts';

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

const WINDOWS_TEST_TIMEOUT_MS = 30_000;

async function copyVerifiedNodeExecutable(
	prefix: string
): Promise<{
	directory: string;
	executable: VerifiedWindowsExecutable;
}> {
	const directory = await mkdtemp(join(testOutputRoot, prefix));
	const path = join(directory, 'verified-tool.exe');
	await copyFile(process.execPath, path);
	const metadata = await stat(path);
	return {
		directory,
		executable: {
			path,
			sha256: await sha256FileHex(path),
			sizeBytes: metadata.size
		}
	};
}

function completedProcess(process: ReturnType<
	typeof startVerifiedWindowsToolProcess
>): Promise<{
	exitCode: number | null;
	stderr: Buffer;
	stdout: Buffer;
}> {
	const { child } = process;
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)));
	child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
	return new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('close', exitCode => resolve({
			exitCode,
			stderr: Buffer.concat(stderr),
			stdout: Buffer.concat(stdout)
		}));
	});
}

function controlPath(directory: string, protocolToken: string): string {
	return join(
		directory,
		`wok-verified-tool-${protocolToken}.start`
	);
}

function controlAcceptPath(
	directory: string,
	protocolToken: string
): string {
	return join(
		directory,
		`wok-verified-tool-${protocolToken}.accept`
	);
}

function fakeControlRecord(options: {
	executable: VerifiedWindowsExecutable;
	protocolToken: string;
	sha256?: string;
	sizeBytes?: number;
}): Buffer {
	const encodedPath = Buffer.from(
		options.executable.path,
		'utf8'
	).toString('base64');
	return Buffer.from(`${[
		'WOK_VERIFIED_TOOL_START',
		options.protocolToken,
		'123',
		'638900000000000000',
		encodedPath,
		encodedPath,
		'0'.repeat(16),
		options.sha256 ?? options.executable.sha256,
		String(options.sizeBytes ?? options.executable.sizeBytes),
		'0'.repeat(8)
	].join('|')}\r\n`, 'utf8');
}

async function markerExists(path: string): Promise<boolean> {
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

function errorTreeIncludes(error: unknown, pattern: RegExp): boolean {
	if (error instanceof Error && pattern.test(error.message)) return true;
	return error instanceof AggregateError
		&& error.errors.some(nested => errorTreeIncludes(nested, pattern));
}

function waitForStdout(
	process: ReturnType<typeof startVerifiedWindowsToolProcess>,
	expected: Buffer
): Promise<void> {
	const { child } = process;
	return new Promise((resolve, reject) => {
		let observed = Buffer.alloc(0);
		const onData = (chunk: Buffer): void => {
			observed = Buffer.concat([observed, Buffer.from(chunk)]);
			if (observed.includes(expected)) {
				child.stdout?.off('data', onData);
				resolve();
			}
		};
		child.stdout?.on('data', onData);
		child.once('error', reject);
		child.once('close', exitCode => {
			reject(new Error(
				`Verified tool exited before its readiness bytes (code=${exitCode ?? 'null'}).`
			));
		});
	});
}

test(
	'verified Windows tool host preserves exact child stdout bytes and exit code',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const { directory, executable } = await copyVerifiedNodeExecutable(
			'windows-tool-output-'
		);
		const expected = Buffer.from([0x41, 0x00, 0xff, 0x0a, 0x42]);
		const protocolToken = '1'.repeat(32);
		const process = startVerifiedWindowsToolProcess({
			arguments: [
				'-e',
				`process.stdout.write(Buffer.from([${[...expected].join(',')}]))`
			],
			controlDirectory: directory,
			executable,
			testOnlyProtocolToken: protocolToken
		});
		const completion = completedProcess(process);
		const started = await process.started;
		assert.equal(started.executable.sha256, executable.sha256);
		assert.equal(started.executable.sizeBytes, executable.sizeBytes);
		assert.ok(started.processId > 0);
		await assert.rejects(
			stat(join(
				directory,
				`wok-verified-tool-${protocolToken}.accept`
			)),
			(error: unknown) => error !== null
				&& typeof error === 'object'
				&& 'code' in error
				&& error.code === 'ENOENT'
		);
		const completed = await completion;
		assert.equal(completed.exitCode, 0);
		assert.deepEqual(completed.stdout, expected);
		assert.deepEqual(completed.stderr, Buffer.alloc(0));
	}
);

test(
	'verified Windows tool host publishes identity before a fast child exits',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const { directory, executable } = await copyVerifiedNodeExecutable(
			'windows-tool-fast-exit-'
		);
		const process = startVerifiedWindowsToolProcess({
			arguments: ['-e', 'process.exit(7)'],
			controlDirectory: directory,
			executable
		});
		const completion = completedProcess(process);
		const started = await process.started;
		assert.equal(started.executable.sha256, executable.sha256);
		assert.equal((await completion).exitCode, 7);
	}
);

test(
	'verified Windows tool host rejects a precreated unleased identity record',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const { directory, executable } = await copyVerifiedNodeExecutable(
			'windows-tool-precreated-'
		);
		const protocolToken = '1'.repeat(32);
		const markerPath = join(directory, 'must-not-run.marker');
		await writeFile(
			controlPath(directory, protocolToken),
			fakeControlRecord({ executable, protocolToken }),
			{ flag: 'wx' }
		);
		const process = startVerifiedWindowsToolProcess({
			arguments: [
				'-e',
				`require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`
			],
			controlDirectory: directory,
			executable,
			testOnlyProtocolToken: protocolToken
		});
		const completion = completedProcess(process);
		await assert.rejects(
			process.started,
			/not held by the native producer/u
		);
		await completion;
		assert.equal(await markerExists(markerPath), false);
	}
);

test(
	'verified Windows tool host rejects a precreated controller decision before launch',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const { directory, executable } = await copyVerifiedNodeExecutable(
			'windows-tool-precreated-decision-'
		);
		const protocolToken = '4'.repeat(32);
		const markerPath = join(directory, 'must-not-run.marker');
		await writeFile(
			controlAcceptPath(directory, protocolToken),
			`WOK_VERIFIED_TOOL_ACCEPT|${protocolToken}\r\n`,
			{ flag: 'wx' }
		);
		assert.throws(
			() => startVerifiedWindowsToolProcess({
				arguments: [
					'-e',
					`require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`
				],
				controlDirectory: directory,
				executable,
				testOnlyProtocolToken: protocolToken
			}),
			(error: unknown) => error !== null
				&& typeof error === 'object'
				&& 'code' in error
				&& error.code === 'EEXIST'
		);
		assert.equal(await markerExists(markerPath), false);
	}
);

test(
	'verified Windows tool host rejects malformed and mismatched startup evidence',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async t => {
		for (const fixture of [
			{
				name: 'wrong-token',
				record: (executable: VerifiedWindowsExecutable) =>
					fakeControlRecord({
						executable,
						protocolToken: '3'.repeat(32)
					}),
				violation: /invalid protocol record/u
			},
			{
				name: 'wrong-digest',
				record: (executable: VerifiedWindowsExecutable) =>
					fakeControlRecord({
						executable,
						protocolToken: '2'.repeat(32),
						sha256: '0'.repeat(64)
					}),
				violation: /bytes do not match/u
			},
			{
				name: 'invalid-utf8',
				record: () => Buffer.from([0xff, 0x0d, 0x0a]),
				violation: /canonical UTF-8/u
			},
			{
				name: 'oversized',
				record: () => Buffer.alloc(16 * 1024 + 1, 0x41),
				violation: /bounded regular file/u
			}
		] as const) {
			await t.test(fixture.name, async () => {
				const { directory, executable } =
					await copyVerifiedNodeExecutable(
						`windows-tool-${fixture.name}-`
					);
				const protocolToken = '2'.repeat(32);
				const markerPath = join(directory, 'must-not-run.marker');
				await writeFile(
					controlPath(directory, protocolToken),
					fixture.record(executable),
					{ flag: 'wx' }
				);
				const process = startVerifiedWindowsToolProcess({
					arguments: [
						'-e',
						`require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`
					],
					controlDirectory: directory,
					executable,
					testOnlyProtocolToken: protocolToken
				});
				const completion = completedProcess(process);
				await assert.rejects(process.started, fixture.violation);
				await completion;
				assert.equal(await markerExists(markerPath), false);
			});
		}
	}
);

test(
	'verified Windows tool host retains a deny-write-delete lease for the launched image',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const { directory, executable } = await copyVerifiedNodeExecutable(
			'windows-tool-lease-'
		);
		const movedPath = join(directory, 'moved-tool.exe');
		const movedControlPath = join(directory, 'moved-control.start');
		const process = startVerifiedWindowsToolProcess({
			arguments: [
				'-e',
				"process.stdout.write('READY'); setTimeout(() => process.exit(0), 1500)"
			],
			controlDirectory: directory,
			executable
		});
		const completed = completedProcess(process);
		await process.started;
		await waitForStdout(process, Buffer.from('READY'));
		await assert.rejects(
			rename(executable.path, movedPath),
			(error: unknown) => error !== null
				&& typeof error === 'object'
				&& 'code' in error
				&& ['EACCES', 'EBUSY', 'EPERM'].includes(String(error.code))
		);
		await assert.rejects(
			writeFile(executable.path, Buffer.from('replacement')),
			(error: unknown) => error !== null
				&& typeof error === 'object'
				&& 'code' in error
				&& ['EACCES', 'EBUSY', 'EPERM'].includes(String(error.code))
		);
		await assert.rejects(
			rename(process.controlPath, movedControlPath),
			(error: unknown) => error !== null
				&& typeof error === 'object'
				&& 'code' in error
				&& ['EACCES', 'EBUSY', 'EPERM'].includes(String(error.code))
		);
		assert.equal((await completed).exitCode, 0);
		await rename(executable.path, movedPath);
		await rename(process.controlPath, movedControlPath);
	}
);

test(
	'verified Windows tool host terminates an unassigned suspended process before execution',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const { directory, executable } = await copyVerifiedNodeExecutable(
			'windows-tool-assignment-'
		);
		const markerPath = join(directory, 'must-not-run.marker');
		const process = startVerifiedWindowsToolProcess({
			arguments: [
				'-e',
				`require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`
			],
			controlDirectory: directory,
			executable,
			testOnlyFailAssignmentBeforeResume: true
		});
		const completion = completedProcess(process);
		await assert.rejects(
			process.started,
			/exited before publishing process identity/u
		);
		const completed = await completion;
		assert.equal(completed.exitCode, 240);
		assert.deepEqual(completed.stdout, Buffer.alloc(0));
		assert.match(
			completed.stderr.toString('utf8'),
			/failure at assign-job/u
		);
		await assert.rejects(
			stat(markerPath),
			(error: unknown) => error !== null
				&& typeof error === 'object'
				&& 'code' in error
				&& error.code === 'ENOENT'
		);
	}
);

test(
	'verified Windows tool host empties its Job after a post-assignment failure',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const { directory, executable } = await copyVerifiedNodeExecutable(
			'windows-tool-post-assignment-'
		);
		const markerPath = join(directory, 'must-not-run.marker');
		const process = startVerifiedWindowsToolProcess({
			arguments: [
				'-e',
				`require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`
			],
			controlDirectory: directory,
			executable,
			testOnlyFailAfterAssignmentBeforeResume: true
		});
		const completion = completedProcess(process);
		await assert.rejects(
			process.started,
			/exited before publishing process identity/u
		);
		const completed = await completion;
		assert.equal(completed.exitCode, 240);
		assert.deepEqual(completed.stdout, Buffer.alloc(0));
		assert.match(
			completed.stderr.toString('utf8'),
			/failure at test-after-assignment/u
		);
		assert.doesNotMatch(
			completed.stderr.toString('utf8'),
			/cleanup did not confirm/iu
		);
		assert.equal(await markerExists(markerPath), false);
	}
);

test(
	'verified Windows tool controller terminates an unresponsive rejected-start host without claiming exact cleanup',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const { directory, executable } = await copyVerifiedNodeExecutable(
			'windows-tool-rejected-start-timeout-'
		);
		const markerPath = join(directory, 'must-not-run.marker');
		const process = startVerifiedWindowsToolProcess({
			arguments: [
				'-e',
				`require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`
			],
			controlDirectory: directory,
			executable,
			testOnlyHangBeforeFailureCleanup: true,
			testOnlyProtocolToken: '5'.repeat(32),
			testOnlyRejectedStartCleanupTimeoutMs: 100
		});
		const completion = completedProcess(process);
		await assert.rejects(
			process.started,
			(error: unknown) => errorTreeIncludes(
				error,
				/native Job cleanup remains unconfirmed/iu
			)
		);
		await completion;
		assert.equal(await markerExists(markerPath), false);
	}
);

test(
	'verified Windows tool host rejects a digest mismatch before child execution',
	{ skip: process.platform !== 'win32', timeout: WINDOWS_TEST_TIMEOUT_MS },
	async () => {
		const { directory, executable } = await copyVerifiedNodeExecutable(
			'windows-tool-mismatch-'
		);
		const process = startVerifiedWindowsToolProcess({
			arguments: ['-e', "process.stdout.write('MUST-NOT-RUN')"],
			controlDirectory: directory,
			executable: {
				...executable,
				sha256: '0'.repeat(64)
			}
		});
		const completion = completedProcess(process);
		await assert.rejects(
			process.started,
			/exited before publishing process identity/u
		);
		const completed = await completion;
		assert.equal(completed.exitCode, 240);
		assert.deepEqual(completed.stdout, Buffer.alloc(0));
		assert.match(
			completed.stderr.toString('utf8'),
			/Executable bytes changed or did not match/u
		);
	}
);
