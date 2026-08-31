import assert from 'node:assert/strict';
import test from 'node:test';
import { captureIdentityDiagnostic } from '../src/preload-diagnostics.ts';
test('identity diagnostics snapshot their preload environment value', () => {
	const environment: Record<string, string | undefined> = {
		WOK_FIND_IDENTITY: 'Lambo'
	};
	const snapshot = captureIdentityDiagnostic(environment);
	delete environment.WOK_FIND_IDENTITY;
	assert.deepEqual(snapshot, {
		enabled: true,
		needle: 'Lambo'
	});
});
test('identity diagnostics stay disabled without a search needle', () => {
	assert.deepEqual(captureIdentityDiagnostic({}), {
		enabled: false,
		needle: ''
	});
});
