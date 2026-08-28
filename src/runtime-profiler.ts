export const RUNTIME_PROFILE_DURATION_MS = 10_000;
export const RUNTIME_PROFILE_SAMPLE_INTERVAL_US = 1_000;
export const RUNTIME_PROFILE_TRIGGER_ARGUMENT = '--capture-runtime-profile';

export function runtimeProfileRequested(argumentsList: readonly string[]): boolean {
	return argumentsList.includes(RUNTIME_PROFILE_TRIGGER_ARGUMENT);
}

export interface RuntimeProfilePaths {
	cpuProfile: string;
	manifest: string;
	trace?: string;
}

export interface RuntimeProfileRequest {
	durationMs: number;
	metadata: Record<string, unknown>;
	paths: RuntimeProfilePaths;
	sampleIntervalUs: number;
	traceCategories?: string[];
}

export interface RuntimeProfileResult {
	completedAt: string;
	cpuProfilePath: string;
	durationMs: number;
	startedAt: string;
	tracePath?: string;
}

export interface RuntimeProfileDebugger {
	attach: (protocolVersion?: string) => void;
	detach: () => void;
	isAttached: () => boolean;
	sendCommand: (method: string, commandParams?: Record<string, unknown>) => Promise<unknown>;
}

export interface RuntimeProfileEnvironment {
	debugger: RuntimeProfileDebugger;
	now: () => Date;
	startTracing: (categories: string[]) => Promise<void>;
	stopTracing: (resultPath: string) => Promise<string>;
	wait: (durationMs: number) => Promise<void>;
	writeJson: (path: string, value: unknown) => Promise<void>;
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function validateRequest(request: RuntimeProfileRequest): void {
	if (!Number.isInteger(request.durationMs) || request.durationMs < 1_000 || request.durationMs > 60_000) {
		throw new Error('Runtime profile duration must be an integer from 1000 through 60000 milliseconds.');
	}
	if (!Number.isInteger(request.sampleIntervalUs) || request.sampleIntervalUs < 100 || request.sampleIntervalUs > 10_000) {
		throw new Error('Runtime profile sampling interval must be an integer from 100 through 10000 microseconds.');
	}
	if (!nonEmptyString(request.paths.cpuProfile) || !nonEmptyString(request.paths.manifest)) {
		throw new Error('Runtime profile artifact paths must be non-empty.');
	}
	const traceCategories = request.traceCategories ?? [];
	const hasTracePath = request.paths.trace !== undefined;
	if (hasTracePath !== (traceCategories.length > 0)) {
		throw new Error('Runtime profile tracing requires both a trace path and trace categories.');
	}
	if ((hasTracePath && !nonEmptyString(request.paths.trace)) || traceCategories.some(category => !nonEmptyString(category))) {
		throw new Error('Runtime profile trace configuration must contain non-empty values.');
	}
}

function readCpuProfile(response: unknown): Record<string, unknown> {
	if (!response || typeof response !== 'object' || Array.isArray(response)) {
		throw new Error('Chromium returned an invalid CPU profile response.');
	}
	const profile = (response as Record<string, unknown>).profile;
	if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
		throw new Error('Chromium returned no CPU profile.');
	}
	return profile as Record<string, unknown>;
}

export class RuntimeProfiler {
	private readonly environment: RuntimeProfileEnvironment;
	private running = false;

	public constructor(environment: RuntimeProfileEnvironment) {
		this.environment = environment;
	}

	public isRunning(): boolean {
		return this.running;
	}

	public async capture(request: RuntimeProfileRequest): Promise<RuntimeProfileResult> {
		validateRequest(request);
		if (this.running) throw new Error('A runtime profile is already running.');
		if (this.environment.debugger.isAttached()) {
			throw new Error('Close Developer Tools before starting an in-match profile.');
		}

		this.running = true;
		let attached = false;
		let profilerEnabled = false;
		let profilerStarted = false;
		let tracingStarted = false;
		let primaryError: unknown;
		const startedAt = this.environment.now();
		const traceCategories = request.traceCategories ?? [];
		const traceRequested = request.paths.trace !== undefined && traceCategories.length > 0;

		try {
			this.environment.debugger.attach('1.3');
			attached = true;
			await this.environment.debugger.sendCommand('Profiler.enable');
			profilerEnabled = true;
			await this.environment.debugger.sendCommand('Profiler.setSamplingInterval', {
				interval: request.sampleIntervalUs
			});
			if (traceRequested) {
				await this.environment.startTracing(traceCategories);
				tracingStarted = true;
			}
			await this.environment.debugger.sendCommand('Profiler.start');
			profilerStarted = true;

			await this.environment.wait(request.durationMs);

			const response = await this.environment.debugger.sendCommand('Profiler.stop');
			profilerStarted = false;
			const profile = readCpuProfile(response);
			const tracePath = traceRequested
				? await this.environment.stopTracing(request.paths.trace as string)
				: undefined;
			tracingStarted = false;
			const completedAt = this.environment.now();

			await this.environment.writeJson(request.paths.cpuProfile, profile);
			await this.environment.writeJson(request.paths.manifest, {
				completedAt: completedAt.toISOString(),
				cpuProfilePath: request.paths.cpuProfile,
				durationMs: request.durationMs,
				metadata: request.metadata,
				sampleIntervalUs: request.sampleIntervalUs,
				startedAt: startedAt.toISOString(),
				...(tracePath ? { traceCategories, tracePath } : {})
			});

			return {
				completedAt: completedAt.toISOString(),
				cpuProfilePath: request.paths.cpuProfile,
				durationMs: request.durationMs,
				startedAt: startedAt.toISOString(),
				...(tracePath ? { tracePath } : {})
			};
		} catch (error) {
			primaryError = error;
			throw error;
		} finally {
			if (profilerStarted) {
				try {
					await this.environment.debugger.sendCommand('Profiler.stop');
				} catch (cleanupError) {
					if (!primaryError) primaryError = cleanupError;
				}
			}
			if (tracingStarted) {
				try {
					await this.environment.stopTracing(request.paths.trace as string);
				} catch (cleanupError) {
					if (!primaryError) primaryError = cleanupError;
				}
			}
			if (profilerEnabled && attached) {
				try {
					await this.environment.debugger.sendCommand('Profiler.disable');
				} catch (cleanupError) {
					if (!primaryError) primaryError = cleanupError;
				}
			}
			if (attached && this.environment.debugger.isAttached()) {
				try {
					this.environment.debugger.detach();
				} catch (cleanupError) {
					if (!primaryError) primaryError = cleanupError;
				}
			}
			this.running = false;
		}
	}
}
