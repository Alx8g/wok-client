export interface IdentityDiagnosticSnapshot {
	enabled: boolean;
	needle: string;
}
export function captureIdentityDiagnostic(environment: Readonly<Record<string, string | undefined>>): IdentityDiagnosticSnapshot {
	const needle = environment.WOK_FIND_IDENTITY ?? '';
	return {
		enabled: needle.length > 0,
		needle
	};
}
