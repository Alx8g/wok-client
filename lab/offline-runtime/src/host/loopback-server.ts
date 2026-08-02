import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { canonicalJson } from '../shared/hash.ts';
import {
	assertRuntimeLabIdentifier,
	RUNTIME_LAB_MAX_RESULT_BYTES,
	RUNTIME_LAB_PROTOCOL_VERSION,
	type RuntimeLabInputMode,
	type RuntimeLabResultEnvelope,
	validateRuntimeLabResult
} from '../shared/protocol.ts';
import type { CalibrationParityPage } from '../page/calibration-parity.ts';

const LOOPBACK_HOST = '127.0.0.1';
const RESULT_CONTENT_TYPE = 'application/json';
const PAGE_CONTENT_SECURITY_POLICY = [
	"default-src 'none'",
	"base-uri 'none'",
	"connect-src 'self'",
	"font-src 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
	"frame-src 'none'",
	"img-src data:",
	"media-src 'none'",
	"object-src 'none'",
	"script-src 'unsafe-inline'",
	"style-src 'unsafe-inline'",
	"worker-src 'none'"
].join('; ');

export type RuntimeLabResultState =
	| 'committing'
	| 'completed'
	| 'idle'
	| 'receiving';

export interface RuntimeLabServerOptions {
	benchmarkMs: number;
	candidateId: string;
	inputMode: RuntimeLabInputMode;
	minSamples: number;
	onResultStateChange?: (
		state: RuntimeLabResultState
	) => void;
	outputDirectory: string;
	page: CalibrationParityPage;
	port?: number;
	runId: string;
	startMode?: 'controller' | 'immediate';
	timeoutMs: number;
	token?: string;
}

export interface RuntimeLabRequestRecord {
	method: string;
	pathname: string;
	remoteAddress: string;
	status: number;
	timestamp: string;
}

export interface RuntimeLabCompletedRun {
	outputDirectory: string;
	requests: RuntimeLabRequestRecord[];
	result: RuntimeLabResultEnvelope;
	valid: boolean;
	violations: string[];
}

export interface RuntimeLabServer {
	close(): Promise<void>;
	completed: Promise<RuntimeLabCompletedRun>;
	outputDirectory: string;
	pageUrl: string;
	port: number;
	releaseBenchmark(): Promise<void>;
	token: string;
}

interface RunManifest {
	benchmarkMs: number;
	benchmarkReleasedAt?: string;
	candidateId: string;
	completedAt?: string;
	inputMode: RuntimeLabInputMode;
	minSamples: number;
	page: {
		calibrationSourceSha256: string;
		id: string;
		sha256: string;
		workloadVersion: number;
	};
	protocolVersion: number;
	runId: string;
	startedAt: string;
	startMode: 'controller' | 'immediate';
	status: 'running' | 'complete' | 'failed';
	valid: boolean;
	violations: string[];
}

function jsonResponse(response: ServerResponse, status: number, value: unknown): void {
	const body = JSON.stringify(value);
	response.writeHead(status, {
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(body),
		'content-type': `${RESULT_CONTENT_TYPE}; charset=utf-8`,
		'cross-origin-resource-policy': 'same-origin',
		'x-content-type-options': 'nosniff'
	});
	response.end(body);
}

function getRemoteAddress(request: IncomingMessage): string {
	return request.socket.remoteAddress ?? '';
}

async function readBoundedJson(request: IncomingMessage): Promise<unknown> {
	const contentType = String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
	if (contentType !== RESULT_CONTENT_TYPE) throw new TypeError('Result content type must be application/json.');

	const contentLength = Number(request.headers['content-length']);
	if (Number.isFinite(contentLength) && contentLength > RUNTIME_LAB_MAX_RESULT_BYTES) {
		throw new RangeError('Result body exceeds the configured byte limit.');
	}

	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.byteLength;
		if (bytes > RUNTIME_LAB_MAX_RESULT_BYTES) throw new RangeError('Result body exceeds the configured byte limit.');
		chunks.push(buffer);
	}
	if (bytes === 0) throw new TypeError('Result body is empty.');
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function startLoopbackServer(options: RuntimeLabServerOptions): Promise<RuntimeLabServer> {
	assertRuntimeLabIdentifier(options.runId, 'runId');
	assertRuntimeLabIdentifier(options.candidateId, 'candidateId');
	if (options.inputMode !== 'off' && options.inputMode !== 'synthetic') throw new TypeError('inputMode is invalid.');
	if (!Number.isInteger(options.benchmarkMs) || options.benchmarkMs < 1_000 || options.benchmarkMs > 300_000) throw new TypeError('benchmarkMs is out of range.');
	if (!Number.isInteger(options.minSamples) || options.minSamples < 10 || options.minSamples > 100_000) throw new TypeError('minSamples is out of range.');
	if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= options.benchmarkMs || options.timeoutMs > 600_000) throw new TypeError('timeoutMs is out of range.');
	if (
		options.onResultStateChange !== undefined
		&& typeof options.onResultStateChange !== 'function'
	) {
		throw new TypeError('onResultStateChange must be a function when provided.');
	}
	const startMode = options.startMode ?? 'immediate';
	if (startMode !== 'controller' && startMode !== 'immediate') throw new TypeError('startMode is invalid.');

	const token = options.token ?? randomBytes(16).toString('hex');
	assertRuntimeLabIdentifier(token, 'token');
	const outputDirectory = options.outputDirectory;
	const requestsPath = join(outputDirectory, 'requests.jsonl');
	const manifestPath = join(outputDirectory, 'run-manifest.json');
	const resultPath = join(outputDirectory, 'page-result.json');
	const pagePathname = `/v1/pages/${options.page.pageId}/${options.page.sha256}.html`;
	const resultPathname = `/v1/results/${token}`;
	const healthPathname = `/v1/health/${token}`;
	const startPathname = `/v1/start/${token}`;
	const startedAt = new Date().toISOString();
	const requests: RuntimeLabRequestRecord[] = [];
	const violations: string[] = [];
	let resultState: RuntimeLabResultState = 'idle';
	const updateResultState = (state: RuntimeLabResultState): void => {
		resultState = state;
		options.onResultStateChange?.(state);
	};
	let resultProcessing: Promise<void> | undefined;
	let resolveResultProcessing: (() => void) | undefined;
	const activeRequestProcessing = new Set<Promise<void>>();
	let benchmarkReleased = startMode === 'immediate';
	let resolveBenchmarkRelease = (): void => undefined;
	const benchmarkRelease = benchmarkReleased
		? Promise.resolve()
		: new Promise<void>(resolveRelease => {
			resolveBenchmarkRelease = resolveRelease;
		});
	let closed = false;
	let settled = false;
	let shutdownCompletionError: Error | undefined;

	const manifest: RunManifest = {
		benchmarkMs: options.benchmarkMs,
		...(benchmarkReleased ? { benchmarkReleasedAt: startedAt } : {}),
		candidateId: options.candidateId,
		inputMode: options.inputMode,
		minSamples: options.minSamples,
		page: {
			calibrationSourceSha256: options.page.calibrationSourceSha256,
			id: options.page.pageId,
			sha256: options.page.sha256,
			workloadVersion: options.page.workloadVersion
		},
		protocolVersion: RUNTIME_LAB_PROTOCOL_VERSION,
		runId: options.runId,
		startedAt,
		startMode,
		status: 'running',
		valid: false,
		violations
	};

	await mkdir(outputDirectory, { recursive: true });
	await Promise.all([
		writeFile(join(outputDirectory, 'page.html'), options.page.html),
		writeFile(join(outputDirectory, 'calibration-source.html'), options.page.calibrationSourceHtml),
		writeFile(join(outputDirectory, 'integrity.json'), `${JSON.stringify(manifest.page, null, '\t')}\n`),
		writeFile(manifestPath, `${JSON.stringify(manifest, null, '\t')}\n`),
		writeFile(requestsPath, '')
	]);

	let resolveCompleted: (run: RuntimeLabCompletedRun) => void;
	let rejectCompleted: (error: Error) => void;
	const completed = new Promise<RuntimeLabCompletedRun>((resolve, reject) => {
		resolveCompleted = resolve;
		rejectCompleted = reject;
	});

	const writeManifest = async () => {
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, '\t')}\n`);
	};

	const server = createServer(async (request, response) => {
		let resolveRequestProcessing = (): void => undefined;
		const requestProcessing = new Promise<void>(resolveProcessing => {
			resolveRequestProcessing = resolveProcessing;
		});
		activeRequestProcessing.add(requestProcessing);
		let status = 500;
		let pathname = '/';
		let completedRun: RuntimeLabCompletedRun | undefined;
		let ownsResultSlot = false;
		let terminalError: Error | undefined;
		try {
			const host = String(request.headers.host ?? '');
			const expectedHost = `${LOOPBACK_HOST}:${(server.address() as AddressInfo).port}`;
			const requestUrl = new URL(request.url ?? '/', `http://${expectedHost}`);
			pathname = requestUrl.pathname;
			const remoteAddress = getRemoteAddress(request);
			if (remoteAddress !== LOOPBACK_HOST && remoteAddress !== '::ffff:127.0.0.1') {
				violations.push(`non-loopback-client:${remoteAddress || 'unknown'}`);
				status = 403;
				jsonResponse(response, status, { error: 'Loopback clients only.' });
				return;
			}
			if (host !== expectedHost) {
				violations.push(`unexpected-host:${host || 'missing'}`);
				status = 421;
				jsonResponse(response, status, { error: 'Unexpected Host header.' });
				return;
			}

			if (request.method === 'GET' && pathname === pagePathname) {
				status = 200;
				response.writeHead(status, {
					'cache-control': 'no-store, max-age=0',
					'content-length': Buffer.byteLength(options.page.html),
					'content-security-policy': PAGE_CONTENT_SECURITY_POLICY,
					'content-type': 'text/html; charset=utf-8',
					'cross-origin-embedder-policy': 'require-corp',
					'cross-origin-opener-policy': 'same-origin',
					'cross-origin-resource-policy': 'same-origin',
					'permissions-policy': 'camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()',
					'referrer-policy': 'no-referrer',
					'x-content-type-options': 'nosniff',
					'x-frame-options': 'DENY'
				});
				response.end(options.page.html);
				return;
			}

			if (request.method === 'GET' && pathname === healthPathname) {
				status = 200;
				jsonResponse(response, status, { protocolVersion: RUNTIME_LAB_PROTOCOL_VERSION, runId: options.runId, status: 'ready' });
				return;
			}

			if (request.method === 'GET' && pathname === startPathname) {
				await benchmarkRelease;
				status = benchmarkReleased ? 200 : 503;
				jsonResponse(response, status, {
					released: benchmarkReleased,
					runId: options.runId
				});
				return;
			}

			if (request.method === 'POST' && pathname === resultPathname) {
				if (resultState !== 'idle') {
					violations.push('duplicate-result');
					status = 409;
					jsonResponse(response, status, { error: 'A result is already being processed or has been accepted.' });
					return;
				}
				updateResultState('receiving');
				ownsResultSlot = true;
				resultProcessing = new Promise<void>(resolveProcessing => {
					resolveResultProcessing = resolveProcessing;
				});
				const body = await readBoundedJson(request);
				const result = validateRuntimeLabResult(body, {
					candidateId: options.candidateId,
					inputMode: options.inputMode,
					pageSha256: options.page.sha256,
					runId: options.runId,
					workloadVersion: options.page.workloadVersion
				});
				if (closed || settled) throw new Error('The server closed before the result could be committed.');
				updateResultState('committing');
				await writeFile(resultPath, `${JSON.stringify(result, null, '\t')}\n`);
				manifest.completedAt = new Date().toISOString();
				manifest.status = 'complete';
				manifest.valid = violations.length === 0 && result.benchmark.success && !result.benchmark.rejected;
				await writeManifest();
				updateResultState('completed');
				status = 202;
				jsonResponse(response, status, { accepted: true });
				completedRun = { outputDirectory, requests, result, valid: manifest.valid, violations: [...violations] };
				void stopListening().catch(error => {
					violations.push(`listener-close-failure:${error instanceof Error ? error.message : String(error)}`);
				});
				return;
			}

			violations.push(`unknown-route:${request.method ?? 'UNKNOWN'}:${pathname}`);
			status = 404;
			jsonResponse(response, status, { error: 'Unknown runtime-lab route.' });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			terminalError = error instanceof Error ? error : new Error(message);
			violations.push(`request-failure:${message}`);
			status = error instanceof RangeError ? 413 : 400;
			try {
				if (!response.headersSent) jsonResponse(response, status, { error: message });
				else response.end();
			} catch (responseError) {
				violations.push(`response-failure:${responseError instanceof Error ? responseError.message : String(responseError)}`);
			}
			manifest.completedAt = new Date().toISOString();
			manifest.status = 'failed';
			manifest.valid = false;
			try {
				await writeManifest();
			} catch (persistenceError) {
				const persistenceMessage = persistenceError instanceof Error ? persistenceError.message : String(persistenceError);
				violations.push(`manifest-write-failure:${persistenceMessage}`);
				terminalError = new Error(`${message}; manifest persistence failed: ${persistenceMessage}`);
			}
		} finally {
			const record: RuntimeLabRequestRecord = {
				method: request.method ?? 'UNKNOWN',
				pathname,
				remoteAddress: getRemoteAddress(request),
				status,
				timestamp: new Date().toISOString()
			};
			requests.push(record);
			try {
				await appendFile(requestsPath, `${canonicalJson(record)}\n`);
			} catch (persistenceError) {
				const persistenceMessage = persistenceError instanceof Error ? persistenceError.message : String(persistenceError);
				violations.push(`request-record-write-failure:${persistenceMessage}`);
				manifest.completedAt = new Date().toISOString();
				manifest.status = 'failed';
				manifest.valid = false;
				terminalError ??= new Error(`Request-record persistence failed: ${persistenceMessage}`);
				try {
					await writeManifest();
				} catch (manifestError) {
					violations.push(`manifest-write-failure:${manifestError instanceof Error ? manifestError.message : String(manifestError)}`);
				}
			}
			if (terminalError && !settled) {
				settled = true;
				rejectCompleted(shutdownCompletionError ?? terminalError);
				void stopListening().catch(closeError => {
					violations.push(`listener-close-failure:${closeError instanceof Error ? closeError.message : String(closeError)}`);
				});
			} else if (completedRun && !settled) {
				settled = true;
				resolveCompleted(completedRun);
			}
			if (ownsResultSlot) {
				resolveResultProcessing?.();
				resolveResultProcessing = undefined;
			}
			resolveRequestProcessing();
			activeRequestProcessing.delete(requestProcessing);
		}
	});

	let listenerClosePromise: Promise<void> | undefined;
	function stopListening(): Promise<void> {
		if (listenerClosePromise) return listenerClosePromise;
		listenerClosePromise = new Promise<void>((resolveClose, rejectClose) => {
			server.close(error => error ? rejectClose(error) : resolveClose());
		});
		return listenerClosePromise;
	}

	async function waitForActiveRequestProcessing(): Promise<void> {
		while (activeRequestProcessing.size > 0) {
			await Promise.all([...activeRequestProcessing]);
		}
	}

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(options.port ?? 0, LOOPBACK_HOST, () => {
			server.removeListener('error', reject);
			resolve();
		});
	});
	const port = (server.address() as AddressInfo).port;
	const query = new URLSearchParams({
		benchmarkMs: String(options.benchmarkMs),
		candidate: options.candidateId,
		input: options.inputMode,
		minSamples: String(options.minSamples),
		page: options.page.sha256,
		run: options.runId,
		start: startMode,
		token
	});
	const pageUrl = `http://${LOOPBACK_HOST}:${port}${pagePathname}?${query}`;

	let timeout: NodeJS.Timeout | undefined;
	let shutdownPromise: Promise<void> | undefined;
	const initiateShutdown = (reason: 'close' | 'timeout'): Promise<void> => {
		if (shutdownPromise) return shutdownPromise;
		if (
			reason === 'timeout'
			&& (
				settled
				|| resultState === 'committing'
				|| resultState === 'completed'
			)
		) {
			return Promise.resolve();
		}
		closed = true;
		shutdownCompletionError = reason === 'timeout'
			? new Error(`Runtime lab timed out after ${options.timeoutMs} ms.`)
			: new Error('Runtime lab server closed before receiving a result.');
		if (reason === 'timeout') violations.push('run-timeout');
		if (reason === 'close' && resultState === 'receiving') {
			violations.push('server-closed-before-result');
		}
		if (!benchmarkReleased) resolveBenchmarkRelease();
		if (timeout) clearTimeout(timeout);
		shutdownPromise = (async () => {
			const listenerShutdown = stopListening();
			if (resultState === 'receiving') server.closeAllConnections();
			if (resultProcessing) await resultProcessing;
			server.closeIdleConnections();
			let listenerError: Error | undefined;
			try {
				await listenerShutdown;
			} catch (error) {
				listenerError = error instanceof Error ? error : new Error(String(error));
				violations.push(`listener-close-failure:${listenerError.message}`);
			}
			await waitForActiveRequestProcessing();
			let persistenceError: Error | undefined;
			if (!settled) {
				settled = true;
				if (
					reason === 'close'
					&& !violations.includes('server-closed-before-result')
				) {
					violations.push('server-closed-before-result');
				}
				manifest.completedAt = new Date().toISOString();
				manifest.status = 'failed';
				manifest.valid = false;
				try {
					await writeManifest();
				} catch (error) {
					persistenceError = error instanceof Error ? error : new Error(String(error));
					violations.push(`manifest-write-failure:${persistenceError.message}`);
					shutdownCompletionError = new Error(
						`${shutdownCompletionError.message} Manifest persistence failed: ${persistenceError.message}`
					);
				}
				rejectCompleted(shutdownCompletionError);
			}
			if (persistenceError && listenerError) {
				throw new Error(`${persistenceError.message}; listener close failed: ${listenerError.message}`);
			}
			if (persistenceError) throw persistenceError;
			if (listenerError) throw listenerError;
		})();
		return shutdownPromise;
	};

	timeout = setTimeout(() => {
		void initiateShutdown('timeout').catch((): void => undefined);
	}, options.timeoutMs);

	let benchmarkReleaseAttempt: Promise<void> | undefined;
	const releaseBenchmark = (): Promise<void> => {
		if (benchmarkReleased) return Promise.resolve();
		if (benchmarkReleaseAttempt !== undefined) {
			return benchmarkReleaseAttempt;
		}
		if (closed || settled) {
			return Promise.reject(
				new Error(
					'Cannot release a benchmark after the server has settled.'
				)
			);
		}
		manifest.benchmarkReleasedAt = new Date().toISOString();
		benchmarkReleaseAttempt = (async () => {
			try {
				await writeManifest();
			} catch (error) {
				delete manifest.benchmarkReleasedAt;
				throw error;
			}
			benchmarkReleased = true;
			resolveBenchmarkRelease();
		})().finally(() => {
			if (!benchmarkReleased) benchmarkReleaseAttempt = undefined;
		});
		return benchmarkReleaseAttempt;
	};

	const close = () => initiateShutdown('close');

	return { close, completed, outputDirectory, pageUrl, port, releaseBenchmark, token };
}
