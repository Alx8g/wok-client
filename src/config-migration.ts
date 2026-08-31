import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, statSync, type Dirent, type Stats } from 'node:fs';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
export interface LegacyConfigSource {
	label: string;
	path: string;
}
export interface ConfigMigrationResult {
	completed: boolean;
	copiedFiles: number;
	errors: number;
	foundSources: string[];
	skippedConflicts: number;
	skippedLinks: number;
}
export interface ConfigMigrationPhaseOneResult extends ConfigMigrationResult {
	deferredSources: LegacyConfigSource[];
}
export interface ConfigMigrationPhaseTwoResult extends ConfigMigrationResult {
	peakActiveOperations: number;
	peakQueuedWork: number;
}
export const CONFIG_MIGRATION_PHASE_TWO_CONCURRENCY = 6;
const MIGRATION_MARKER = '.wok-client-migration-v1.json';
const LEGACY_MARKER_FILES = new Set(['settings moved.txt']);
const PHASE_ONE_STARTUP_FILES = new Set(['filters.txt', 'settings.json']);
function createResult(): ConfigMigrationResult {
	return {
		completed: false,
		copiedFiles: 0,
		errors: 0,
		foundSources: [],
		skippedConflicts: 0,
		skippedLinks: 0
	};
}
function createPhaseTwoResult(): ConfigMigrationPhaseTwoResult {
	return {
		...createResult(),
		peakActiveOperations: 0,
		peakQueuedWork: 0
	};
}
function listLegacySources(destination: string, sources: LegacyConfigSource[]): LegacyConfigSource[] {
	const destinationPath = resolve(destination);
	return sources.filter((source) => existsSync(source.path) && statSync(source.path).isDirectory() && resolve(source.path) !== destinationPath);
}
function copyMissingFileSync(sourcePath: string, destinationPath: string, result: ConfigMigrationResult) {
	if (existsSync(destinationPath)) {
		result.skippedConflicts++;
		return;
	}
	try {
		copyFileSync(sourcePath, destinationPath, constants.COPYFILE_EXCL);
		result.copiedFiles++;
	} catch (error) {
		if (existsSync(destinationPath)) {
			result.skippedConflicts++;
			return;
		}
		throw error;
	}
}
export function migrateLegacyConfigsPhaseOne(destination: string, sources: LegacyConfigSource[]): ConfigMigrationPhaseOneResult {
	const result: ConfigMigrationPhaseOneResult = { ...createResult(), deferredSources: [] };
	if (existsSync(join(destination, MIGRATION_MARKER))) return { ...result, completed: true };
	for (const source of listLegacySources(destination, sources)) {
		result.foundSources.push(source.label);
		result.deferredSources.push(source);
		mkdirSync(destination, { recursive: true });
		for (const fileName of PHASE_ONE_STARTUP_FILES) {
			const sourcePath = join(source.path, fileName);
			let sourceStats: Stats;
			try {
				sourceStats = lstatSync(sourcePath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
				throw error;
			}
			if (sourceStats.isSymbolicLink()) {
				result.skippedLinks++;
				continue;
			}
			if (!sourceStats.isFile()) continue;
			copyMissingFileSync(sourcePath, join(destination, fileName), result);
		}
	}
	return result;
}
interface MigrationActivity {
	activeOperations: number;
}
interface MigrationDirectoryWork {
	destination: string;
	source: string;
	sourceRoot: boolean;
	type: 'directory';
}
interface MigrationFileWork {
	destination: string;
	source: string;
	type: 'file';
}
type MigrationWork = MigrationDirectoryWork | MigrationFileWork;
interface MigrationDirectoryFrame extends MigrationDirectoryWork {
	entries: Dirent[];
	nextEntry: number;
}
class BoundedMigrationWorkQueue {
	private readonly capacity: number;
	private closed = false;
	private readonly items: MigrationWork[] = [];
	private pendingWork = 0;
	private readonly result: ConfigMigrationPhaseTwoResult;
	private readonly waitingWorkers: Array<(work: MigrationWork | undefined) => void> = [];
	constructor(capacity: number, result: ConfigMigrationPhaseTwoResult) {
		this.capacity = capacity;
		this.result = result;
	}
	enqueue(work: MigrationWork): boolean {
		if (this.closed) throw new Error('Cannot enqueue migration work after the queue has closed.');
		const waitingWorker = this.waitingWorkers.shift();
		if (waitingWorker) {
			this.pendingWork++;
			waitingWorker(work);
			return true;
		}
		if (this.items.length >= this.capacity) return false;
		this.pendingWork++;
		this.items.push(work);
		this.result.peakQueuedWork = Math.max(this.result.peakQueuedWork, this.items.length);
		return true;
	}
	async take(): Promise<MigrationWork | undefined> {
		const work = this.items.shift();
		if (work) return work;
		if (this.closed) return undefined;
		return new Promise((resolveWorker) => {
			this.waitingWorkers.push(resolveWorker);
		});
	}
	complete(): void {
		if (this.pendingWork <= 0) throw new Error('Migration work completed without a pending queue item.');
		this.pendingWork--;
		if (this.pendingWork > 0) return;
		this.closed = true;
		for (const waitingWorker of this.waitingWorkers.splice(0)) waitingWorker(undefined);
	}
}
async function runTrackedOperation<T>(activity: MigrationActivity, result: ConfigMigrationPhaseTwoResult, operation: () => Promise<T>): Promise<T> {
	activity.activeOperations++;
	result.peakActiveOperations = Math.max(result.peakActiveOperations, activity.activeOperations);
	try {
		return await operation();
	} finally {
		activity.activeOperations--;
	}
}
async function copyMissingFile(work: MigrationFileWork, result: ConfigMigrationPhaseTwoResult, activity: MigrationActivity): Promise<void> {
	try {
		await runTrackedOperation(activity, result, () => copyFile(work.source, work.destination, constants.COPYFILE_EXCL));
		result.copiedFiles++;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
			result.skippedConflicts++;
			return;
		}
		result.errors++;
		console.error(`Failed to migrate legacy file ${work.source}`, error);
	}
}
async function processDirectoryTree(initialDirectory: MigrationDirectoryWork, queue: BoundedMigrationWorkQueue, result: ConfigMigrationPhaseTwoResult, activity: MigrationActivity): Promise<void> {
	const frames: MigrationDirectoryFrame[] = [];
	let nextDirectory: MigrationDirectoryWork | undefined = initialDirectory;
	while (nextDirectory || frames.length > 0) {
		if (nextDirectory) {
			let entries: Dirent[];
			try {
				await runTrackedOperation(activity, result, () => mkdir(nextDirectory.destination, { recursive: true }));
				entries = await runTrackedOperation(activity, result, () => readdir(nextDirectory.source, { withFileTypes: true }));
			} catch (error) {
				result.errors++;
				console.error(`Failed to enumerate legacy directory ${nextDirectory.source}`, error);
				nextDirectory = undefined;
				continue;
			}
			frames.push({ ...nextDirectory, entries, nextEntry: 0 });
			nextDirectory = undefined;
		}
		const frame = frames.at(-1);
		if (!frame) continue;
		if (frame.nextEntry >= frame.entries.length) {
			frames.pop();
			continue;
		}
		const entry = frame.entries[frame.nextEntry++];
		if (LEGACY_MARKER_FILES.has(entry.name)) continue;
		const sourcePath = join(frame.source, entry.name);
		const destinationPath = join(frame.destination, entry.name);
		if (entry.isSymbolicLink()) {
			if (!frame.sourceRoot || !PHASE_ONE_STARTUP_FILES.has(entry.name)) result.skippedLinks++;
			continue;
		}
		if (entry.isDirectory()) {
			const directoryWork: MigrationDirectoryWork = {
				destination: destinationPath,
				source: sourcePath,
				sourceRoot: false,
				type: 'directory'
			};
			if (!queue.enqueue(directoryWork)) nextDirectory = directoryWork;
			continue;
		}
		if (!entry.isFile()) continue;
		if (frame.sourceRoot && PHASE_ONE_STARTUP_FILES.has(entry.name)) continue;
		const fileWork: MigrationFileWork = {
			destination: destinationPath,
			source: sourcePath,
			type: 'file'
		};
		if (!queue.enqueue(fileWork)) await copyMissingFile(fileWork, result, activity);
	}
}
async function copySourceWithWorkers(source: LegacyConfigSource, destination: string, concurrency: number, result: ConfigMigrationPhaseTwoResult, activity: MigrationActivity): Promise<void> {
	const queue = new BoundedMigrationWorkQueue(concurrency, result);
	if (!queue.enqueue({ destination, source: source.path, sourceRoot: true, type: 'directory' })) {
		throw new Error('Failed to enqueue the legacy migration source root.');
	}
	const workers = Array.from({ length: concurrency }, async () => {
		while (true) {
			const work = await queue.take();
			if (!work) return;
			try {
				if (work.type === 'file') await copyMissingFile(work, result, activity);
				else await processDirectoryTree(work, queue, result, activity);
			} finally {
				queue.complete();
			}
		}
	});
	await Promise.all(workers);
}
export async function migrateLegacyConfigsPhaseTwo(destination: string, sources: LegacyConfigSource[], concurrency = CONFIG_MIGRATION_PHASE_TWO_CONCURRENCY): Promise<ConfigMigrationPhaseTwoResult> {
	const result = createPhaseTwoResult();
	const markerPath = join(destination, MIGRATION_MARKER);
	if (existsSync(markerPath)) return { ...result, completed: true };
	const workerCount = Math.min(Math.max(Math.trunc(concurrency) || 1, 1), 8);
	const activity: MigrationActivity = { activeOperations: 0 };
	for (const source of listLegacySources(destination, sources)) {
		result.foundSources.push(source.label);
		await copySourceWithWorkers(source, destination, workerCount, result, activity);
	}
	if (result.foundSources.length === 0) return result;
	if (result.errors > 0) return result;
	try {
		await runTrackedOperation(activity, result, () => mkdir(destination, { recursive: true }));
		await runTrackedOperation(activity, result, () =>
			writeFile(
				markerPath,
				JSON.stringify(
					{
						completedAt: new Date().toISOString(),
						copiedFiles: result.copiedFiles,
						sources: result.foundSources,
						skippedConflicts: result.skippedConflicts,
						skippedLinks: result.skippedLinks
					},
					null,
					2
				)
			)
		);
		result.completed = true;
	} catch (error) {
		result.errors++;
		console.error('Failed to write the legacy migration completion marker', error);
	}
	return result;
}
