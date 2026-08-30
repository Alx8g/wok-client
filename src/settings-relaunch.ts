const REOPEN_SETTINGS_PREFIX = '--wok-reopen-settings=';

export function parseReopenSettingsCategory(args: readonly string[], categoryCount = 6): number | undefined {
	for (const argument of args) {
		if (!argument.startsWith(REOPEN_SETTINGS_PREFIX)) continue;
		const serializedValue = argument.slice(REOPEN_SETTINGS_PREFIX.length);
		if (!/^\d+$/u.test(serializedValue)) continue;
		const value = Number(serializedValue);
		if (Number.isInteger(value) && value >= 0 && value < categoryCount) return value;
	}
	return undefined;
}

export function buildRelaunchArguments(
	args: readonly string[],
	reopenSettingsCategory?: number,
	categoryCount = 6
): string[] {
	const result = args.filter(argument => argument !== '--safe-graphics' && !argument.startsWith(REOPEN_SETTINGS_PREFIX));
	if (
		reopenSettingsCategory !== undefined
		&& Number.isInteger(reopenSettingsCategory)
		&& reopenSettingsCategory >= 0
		&& reopenSettingsCategory < categoryCount
	) {
		result.push(`${REOPEN_SETTINGS_PREFIX}${reopenSettingsCategory}`);
	}
	return result;
}
