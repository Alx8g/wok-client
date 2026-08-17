export interface IdentityDiagnosticSnapshot {
	enabled: boolean;
	needle: string;
}

/** Capture Node-backed preload configuration before the page can remove its `process` global. */
export function captureIdentityDiagnostic(
	environment: Readonly<Record<string, string | undefined>>
): IdentityDiagnosticSnapshot {
	const needle = environment.WOK_FIND_IDENTITY ?? '';
	return {
		enabled: needle.length > 0,
		needle
	};
}
