import assert from 'node:assert/strict';
import {
	mkdir,
	mkdtemp,
	readFile,
	unlink
} from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { buildCalibrationParityPage } from '../src/page/calibration-parity.ts';
import {
	startLoopbackServer,
	type RuntimeLabResultState
} from '../src/host/loopback-server.ts';
import { createTestResult } from './test-result.ts';

const repositoryRoot = join(import.meta.dirname, '..', '..', '..');
const markSvg = await readFile(join(repositoryRoot, 'assets', 'wok-mark.svg'), 'utf8');
const testOutputRoot = join(repositoryRoot, '.working', 'runtime-lab', 'tests');
await mkdir(testOutputRoot, { recursive: true });

async function createServer(
	runId: string,
	startMode: 'controller' | 'immediate' = 'immediate',
	options: {
		onResultStateChange?: (
			state: RuntimeLabResultState
		) => void;
		timeoutMs?: number;
	} = {}
) {
	const outputDirectory = await mkdtemp(join(testOutputRoot, `${runId}-`));
	const page = buildCalibrationParityPage(markSvg);
	const server = await startLoopbackServer({
		benchmarkMs: 1_000,
		candidateId: 'candidate-a',
		inputMode: 'off',
		minSamples: 10,
		...(options.onResultStateChange === undefined
			? {}
			: {
				onResultStateChange:
					options.onResultStateChange
			}),
		outputDirectory,
		page,
		runId,
		startMode,
		timeoutMs: options.timeoutMs ?? 10_000,
		token: 'test-token'
	});
	return { outputDirectory, page, server };
}

test('loopback server serves only the content-addressed page and accepts one validated result', async () => {
	const { outputDirectory, page, server } = await createServer('server-success');
	try {
		const pageResponse = await fetch(server.pageUrl);
		assert.equal(pageResponse.status, 200);
		assert.equal(await pageResponse.text(), page.html);
		assert.match(pageResponse.headers.get('content-security-policy') ?? '', /connect-src 'self'/u);
		assert.match(pageResponse.headers.get('content-security-policy') ?? '', /worker-src 'none'/u);

		const origin = new URL(server.pageUrl).origin;
		const healthResponse = await fetch(`${origin}/v1/health/${server.token}`);
		assert.equal(healthResponse.status, 200);

		const result = createTestResult({ pageSha256: page.sha256, runId: 'server-success' });
		const resultResponse = await fetch(`${origin}/v1/results/${server.token}`, {
			body: JSON.stringify(result),
			headers: { 'content-type': 'application/json' },
			method: 'POST'
		});
		assert.equal(resultResponse.status, 202);

		const completed = await server.completed;
		assert.equal(completed.valid, true);
		assert.deepEqual(completed.violations, []);
		assert.equal(completed.requests.length, 3);
		assert.equal(completed.result.benchmark.averageFps, 240);

		const persistedResult = JSON.parse(await readFile(join(outputDirectory, 'page-result.json'), 'utf8'));
		const persistedManifest = JSON.parse(await readFile(join(outputDirectory, 'run-manifest.json'), 'utf8'));
		const requestLines = (await readFile(join(outputDirectory, 'requests.jsonl'), 'utf8')).trim().split('\n');
		assert.equal(persistedResult.pageSha256, page.sha256);
		assert.equal(persistedManifest.valid, true);
		assert.equal(requestLines.length, 3);
	} finally {
		await server.close();
	}
});

test('result acceptance reserves the single slot before awaiting a slow request body', async () => {
	const { page, server } = await createServer('server-result-race');
	try {
		const origin = new URL(server.pageUrl).origin;
		const resultUrl = `${origin}/v1/results/${server.token}`;
		const body = JSON.stringify(createTestResult({ pageSha256: page.sha256, runId: 'server-result-race' }));
		const slowResponse = new Promise<number>((resolveResponse, rejectResponse) => {
			const upload = request(resultUrl, {
				headers: {
					'content-length': Buffer.byteLength(body),
					'content-type': 'application/json'
				},
				method: 'POST'
			}, response => {
				response.resume();
				response.once('end', () => resolveResponse(response.statusCode ?? 0));
			});
			upload.once('error', rejectResponse);
			upload.write(body.slice(0, 16));
			setTimeout(() => upload.end(body.slice(16)), 100);
		});
		await new Promise(resolve => setTimeout(resolve, 50));
		const duplicateResponse = await fetch(resultUrl, {
			body,
			headers: { 'content-type': 'application/json' },
			method: 'POST'
		});
		assert.equal(duplicateResponse.status, 409);
		assert.equal(await slowResponse, 202);
		const completed = await server.completed;
		assert.equal(completed.valid, false);
		assert.ok(completed.violations.includes('duplicate-result'));
	} finally {
		await server.close();
	}
});

test('close aborts a receiving result and waits for its request journal persistence', async () => {
	const { outputDirectory, page, server } = await createServer(
		'server-close-receiving'
	);
	const completionRejection = assert.rejects(
		server.completed,
		/closed before receiving a result/u
	);
	const origin = new URL(server.pageUrl).origin;
	const resultUrl = `${origin}/v1/results/${server.token}`;
	const body = JSON.stringify(
		createTestResult({
			pageSha256: page.sha256,
			runId: 'server-close-receiving'
		})
	);
	const uploadSettled = new Promise<void>(resolveUpload => {
		const upload = request(
			resultUrl,
			{
				headers: {
					'content-length':
						Buffer.byteLength(body),
					'content-type':
						'application/json'
				},
				method: 'POST'
			},
			response => {
				response.resume();
				response.once('end', resolveUpload);
			}
		);
		upload.once('error', () => resolveUpload());
		upload.write(body.slice(0, 16));
	});
	await new Promise(resolve => setTimeout(resolve, 50));
	await server.close();
	await completionRejection;
	await uploadSettled;
	const manifest = JSON.parse(
		await readFile(
			join(outputDirectory, 'run-manifest.json'),
			'utf8'
		)
	);
	assert.equal(manifest.status, 'failed');
	assert.ok(
		manifest.violations.includes(
			'server-closed-before-result'
		)
	);
});

test('close allows a result already committing to finish atomically', async () => {
	let closeDuringCommit: Promise<void> | undefined;
	let serverReference:
		| Awaited<ReturnType<typeof createServer>>['server']
		| undefined;
	let resolveCommitting: () => void;
	const committing = new Promise<void>(resolveState => {
		resolveCommitting = resolveState;
	});
	const created = await createServer(
		'server-close-committing',
		'immediate',
		{
			onResultStateChange(state) {
				if (state !== 'committing') return;
				resolveCommitting();
				closeDuringCommit =
					serverReference?.close();
			}
		}
	);
	serverReference = created.server;
	const { page, server } = created;
	try {
		const response = await fetch(
			`${new URL(server.pageUrl).origin}`
				+ `/v1/results/${server.token}`,
			{
				body: JSON.stringify(
					createTestResult({
						pageSha256: page.sha256,
						runId:
							'server-close-committing'
					})
				),
				headers: {
					'content-type':
						'application/json'
				},
				method: 'POST'
			}
		);
		assert.equal(response.status, 202);
		await committing;
		assert.ok(closeDuringCommit);
		await closeDuringCommit;
		const completed = await server.completed;
		assert.equal(completed.valid, true);
		assert.deepEqual(completed.violations, []);
	} finally {
		await server.close();
	}
});

test('timeout aborts a slow receiving body and completes shutdown persistence', async () => {
	const timeoutMs = 1_050;
	const { outputDirectory, page, server } =
		await createServer(
			'server-timeout-receiving',
			'immediate',
			{ timeoutMs }
		);
	const completionRejection = assert.rejects(
		server.completed,
		new RegExp(
			`timed out after ${timeoutMs} ms`,
			'u'
		)
	);
	const origin = new URL(server.pageUrl).origin;
	const body = JSON.stringify(
		createTestResult({
			pageSha256: page.sha256,
			runId: 'server-timeout-receiving'
		})
	);
	const uploadSettled = new Promise<void>(resolveUpload => {
		const upload = request(
			`${origin}/v1/results/${server.token}`,
			{
				headers: {
					'content-length':
						Buffer.byteLength(body),
					'content-type':
						'application/json'
				},
				method: 'POST'
			}
		);
		upload.once('error', () => resolveUpload());
		upload.write(body.slice(0, 16));
	});
	await completionRejection;
	await server.close();
	await uploadSettled;
	const manifest = JSON.parse(
		await readFile(
			join(outputDirectory, 'run-manifest.json'),
			'utf8'
		)
	);
	assert.equal(manifest.status, 'failed');
	assert.ok(manifest.violations.includes('run-timeout'));
});

test('controller start barrier does not release the benchmark before measurement is ready', async () => {
	const { server } = await createServer('server-start-barrier', 'controller');
	const completion = server.completed;
	try {
		const pageUrl = new URL(server.pageUrl);
		assert.equal(pageUrl.searchParams.get('start'), 'controller');
		const startUrl = `${pageUrl.origin}/v1/start/${server.token}`;
		let startRequestSettled = false;
		const waitingResponse = fetch(startUrl).then(response => {
			startRequestSettled = true;
			return response;
		});
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.equal(startRequestSettled, false);
		await server.releaseBenchmark();
		const releasedResponse = await waitingResponse;
		assert.equal(releasedResponse.status, 200);
		assert.equal((await releasedResponse.json()).released, true);
	} finally {
		await server.close();
		await assert.rejects(completion, /closed before receiving a result/u);
	}
});

test('controller start barrier stays closed when release evidence cannot be persisted', async () => {
	const { outputDirectory, server } = await createServer(
		'server-start-persistence-failure',
		'controller'
	);
	const completionRejection = assert.rejects(
		server.completed,
		/closed before receiving a result/u
	);
	const abortController = new AbortController();
	const startUrl = `${new URL(server.pageUrl).origin}/v1/start/${server.token}`;
	let startRequestSettled = false;
	const waitingResponse = fetch(startUrl, {
		signal: abortController.signal
	}).finally(() => {
		startRequestSettled = true;
	});
	await new Promise(resolve => setTimeout(resolve, 50));
	assert.equal(startRequestSettled, false);

	const manifestPath = join(
		outputDirectory,
		'run-manifest.json'
	);
	await unlink(manifestPath);
	await mkdir(manifestPath);
	await assert.rejects(
		server.releaseBenchmark(),
		/EISDIR|EPERM|directory|illegal operation/iu
	);
	await new Promise(resolve => setTimeout(resolve, 50));
	assert.equal(startRequestSettled, false);

	abortController.abort();
	await assert.rejects(waitingResponse, /abort/iu);
	await assert.rejects(
		server.close(),
		/EISDIR|EPERM|directory|illegal operation/iu
	);
	await completionRejection;
});

test('unknown routes are rejected and retained as integrity violations', async () => {
	const { server } = await createServer('server-unknown-route');
	const completion = server.completed;
	const response = await fetch(`${new URL(server.pageUrl).origin}/not-manifested`);
	assert.equal(response.status, 404);
	await server.close();
	await assert.rejects(completion, /closed before receiving a result/u);
});

test('mismatched result identity fails the run instead of being accepted', async () => {
	const { page, server } = await createServer('server-bad-result');
	try {
		const origin = new URL(server.pageUrl).origin;
		const result = createTestResult({ pageSha256: page.sha256, runId: 'wrong-run' });
		const response = await fetch(`${origin}/v1/results/${server.token}`, {
			body: JSON.stringify(result),
			headers: { 'content-type': 'application/json' },
			method: 'POST'
		});
		assert.equal(response.status, 400);
		await assert.rejects(server.completed, /does not match this run/u);
	} finally {
		await server.close();
	}
});
