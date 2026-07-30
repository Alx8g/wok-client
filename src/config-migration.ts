import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface LegacyConfigSource {
	label: string;
	path: string;
}

export interface ConfigMigrationResult {
	completed: boolean;
	copiedFiles: number;
	foundSources: string[];
	skippedConflicts: number;
	skippedLinks: number;
}

const MIGRATION_MARKER = '.wok-client-migration-v1.json';
const LEGACY_MARKER_FILES = new Set(['settings moved.txt']);

function copyMissingTree(source: string, destination: string, result: ConfigMigrationResult) {
	mkdirSync(destination, { recursive: true });

	for (const entry of readdirSync(source, { withFileTypes: true })) {
		if (LEGACY_MARKER_FILES.has(entry.name)) continue;

		const sourcePath = join(source, entry.name);
		const destinationPath = join(destination, entry.name);

		if (entry.isSymbolicLink()) {
			result.skippedLinks++;
			continue;
		}

		if (entry.isDirectory()) {
			copyMissingTree(sourcePath, destinationPath, result);
			continue;
		}

		if (!entry.isFile()) continue;
		if (existsSync(destinationPath)) {
			result.skippedConflicts++;
			continue;
		}

		mkdirSync(resolve(destinationPath, '..'), { recursive: true });
		try {
			copyFileSync(sourcePath, destinationPath, constants.COPYFILE_EXCL);
			result.copiedFiles++;
		} catch (error) {
			if (existsSync(destinationPath)) {
				result.skippedConflicts++;
				continue;
			}
			throw error;
		}
	}
}

export function migrateLegacyConfigs(destination: string, sources: LegacyConfigSource[]): ConfigMigrationResult {
	const result: ConfigMigrationResult = {
		completed: false,
		copiedFiles: 0,
		foundSources: [],
		skippedConflicts: 0,
		skippedLinks: 0
	};
	const markerPath = join(destination, MIGRATION_MARKER);
	if (existsSync(markerPath)) return { ...result, completed: true };

	const destinationPath = resolve(destination);
	for (const source of sources) {
		if (!existsSync(source.path) || !statSync(source.path).isDirectory()) continue;
		if (resolve(source.path) === destinationPath) continue;

		result.foundSources.push(source.label);
		copyMissingTree(source.path, destination, result);
	}

	if (result.foundSources.length === 0) return result;

	mkdirSync(destination, { recursive: true });
	writeFileSync(markerPath, JSON.stringify({
		completedAt: new Date().toISOString(),
		copiedFiles: result.copiedFiles,
		sources: result.foundSources,
		skippedConflicts: result.skippedConflicts,
		skippedLinks: result.skippedLinks
	}, null, 2));
	result.completed = true;
	return result;
}
