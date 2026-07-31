import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, statSync, type Dirent } from 'node:fs';
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
	/** Sources that still hold directory trees for migrateLegacyConfigsPhaseTwo to copy. */
	deferredSources: LegacyConfigSource[];
}

/** Bounded filesystem concurrency for the phase-2 bulk copy. */
export const CONFIG_MIGRATION_PHASE_TWO_CONCURRENCY = 6;

const MIGRATION_MARKER = '.wok-client-migration-v1.json';
const LEGACY_MARKER_FILES = new Set(['settings moved.txt']);

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

function listLegacySources(destination: string, sources: LegacyConfigSource[]): LegacyConfigSource[] {
	const destinationPath = resolve(destination);
	return sources.filter(source =>
		existsSync(source.path)
		&& statSync(source.path).isDirectory()
		&& resolve(source.path) !== destinationPath);
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

/**
 * Phase 1 of the legacy migration: synchronously copy only the small top-level files
 * (settings.json, filters.txt, ...) that startup may read before command-line switches
 * are applied and before any window exists. This is tiny and bounded: no recursion.
 * Directory trees (swapper/, css/, scripts/) are deferred to migrateLegacyConfigsPhaseTwo.
 * No completion marker is written here — the marker belongs to phase 2, so an interrupted
 * bulk copy resumes on the next launch (conflict skips make both phases idempotent).
 */
export function migrateLegacyConfigsPhaseOne(destination: string, sources: LegacyConfigSource[]): ConfigMigrationPhaseOneResult {
	const result: ConfigMigrationPhaseOneResult = { ...createResult(), deferredSources: [] };
	if (existsSync(join(destination, MIGRATION_MARKER))) return { ...result, completed: true };

	for (const source of listLegacySources(destination, sources)) {
		result.foundSources.push(source.label);
		result.deferredSources.push(source);
		mkdirSync(destination, { recursive: true });

		for (const entry of readdirSync(source.path, { withFileTypes: true })) {
			if (LEGACY_MARKER_FILES.has(entry.name)) continue;
			if (entry.isSymbolicLink()) {
				result.skippedLinks++;
				continue;
			}

			// Directory trees wait for phase 2.
			if (!entry.isFile()) continue;
			copyMissingFileSync(join(source.path, entry.name), join(destination, entry.name), result);
		}
	}
	return result;
}

type OperationLimiter = <T>(operation: () => Promise<T>) => Promise<T>;

function createOperationLimiter(limit: number): OperationLimiter {
	let active = 0;
	const waiting: Array<() => void> = [];
	return async operation => {
		if (active >= limit) await new Promise<void>(releaseSlot => { waiting.push(releaseSlot); });
		active++;
		try {
			return await operation();
		} finally {
			active--;
			waiting.shift()?.();
		}
	};
}

async function copyMissingFile(sourcePath: string, destinationPath: string, result: ConfigMigrationResult): Promise<void> {
	try {
		await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
		result.copiedFiles++;
	} catch (error) {
		// Existing WOK Client files always win conflicts.
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
			result.skippedConflicts++;
			return;
		}
		result.errors++;
		console.error(`Failed to migrate legacy file ${sourcePath}`, error);
	}
}

async function copyMissingTree(source: string, destination: string, result: ConfigMigrationResult, limitOperation: OperationLimiter): Promise<void> {
	let entries: Dirent[];
	try {
		await limitOperation(() => mkdir(destination, { recursive: true }));
		entries = await limitOperation(() => readdir(source, { withFileTypes: true }));
	} catch (error) {
		result.errors++;
		console.error(`Failed to enumerate legacy directory ${source}`, error);
		return;
	}

	const pending: Promise<void>[] = [];
	for (const entry of entries) {
		if (LEGACY_MARKER_FILES.has(entry.name)) continue;
		const sourcePath = join(source, entry.name);
		const destinationPath = join(destination, entry.name);

		if (entry.isSymbolicLink()) {
			result.skippedLinks++;
			continue;
		}
		if (entry.isDirectory()) {
			pending.push(copyMissingTree(sourcePath, destinationPath, result, limitOperation));
			continue;
		}
		if (!entry.isFile()) continue;
		pending.push(limitOperation(() => copyMissingFile(sourcePath, destinationPath, result)));
	}
	await Promise.all(pending);
}

/**
 * Phase 2 of the legacy migration: asynchronously copy the bulky directory trees
 * (swapper/, css/, scripts/) after the main window exists, with bounded filesystem
 * concurrency. Per-file errors are logged and counted, never thrown, and the completion
 * marker is only written after an error-free pass, so an interrupted or failed phase 2
 * resumes on the next launch. Legacy sources are never modified.
 *
 * Note for callers: the resource swapper (and the CSS swapper dropdown) index their
 * directories independently; files migrated here are only picked up by their next
 * indexing pass, typically the next launch.
 */
export async function migrateLegacyConfigsPhaseTwo(
	destination: string,
	sources: LegacyConfigSource[],
	concurrency = CONFIG_MIGRATION_PHASE_TWO_CONCURRENCY
): Promise<ConfigMigrationResult> {
	const result = createResult();
	const markerPath = join(destination, MIGRATION_MARKER);
	if (existsSync(markerPath)) return { ...result, completed: true };

	const limitOperation = createOperationLimiter(Math.min(Math.max(Math.trunc(concurrency) || 1, 1), 8));
	for (const source of listLegacySources(destination, sources)) {
		result.foundSources.push(source.label);

		let entries: Dirent[];
		try {
			entries = await limitOperation(() => readdir(source.path, { withFileTypes: true }));
		} catch (error) {
			result.errors++;
			console.error(`Failed to enumerate legacy source ${source.path}`, error);
			continue;
		}

		const pending: Promise<void>[] = [];
		for (const entry of entries) {
			if (LEGACY_MARKER_FILES.has(entry.name)) continue;
			// Top-level files and symbolic links were phase 1's job.
			if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
			pending.push(copyMissingTree(join(source.path, entry.name), join(destination, entry.name), result, limitOperation));
		}
		await Promise.all(pending);
	}

	if (result.foundSources.length === 0) return result;
	// A failed copy leaves the marker unwritten so the next launch retries the remainder.
	if (result.errors > 0) return result;

	try {
		await mkdir(destination, { recursive: true });
		await writeFile(markerPath, JSON.stringify({
			completedAt: new Date().toISOString(),
			copiedFiles: result.copiedFiles,
			sources: result.foundSources,
			skippedConflicts: result.skippedConflicts,
			skippedLinks: result.skippedLinks
		}, null, 2));
		result.completed = true;
	} catch (error) {
		result.errors++;
		console.error('Failed to write the legacy migration completion marker', error);
	}
	return result;
}
