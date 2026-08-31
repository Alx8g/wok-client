import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
const smokeScript = readFileSync('scripts/smoke-packaged-windows.ps1', 'utf8');

test('Windows smoke runs after packaging and before artifact publication', () => {
	const buildIndex = workflow.indexOf('- name: Build platform package');
	const smokeIndex = workflow.indexOf('- name: Smoke installed Windows package');
	const uploadIndex = workflow.indexOf('- name: Upload platform package');
	assert.ok(buildIndex >= 0 && buildIndex < smokeIndex && smokeIndex < uploadIndex);
	assert.match(workflow, /pattern: wok-client-\*/u);
	assert.match(workflow, /name: wok-smoke-windows/u);
});

test('smoke script installs, launches, bounds runtime, and validates visual output', () => {
	assert.match(smokeScript, /'\/S', '\/NODESKTOP', '\/NOSTARTMENU', "\/D=\$installDirectory"/u);
	assert.match(smokeScript, /WOK_RELEASE_SMOKE_REPORT/u);
	assert.match(smokeScript, /WaitForExit\(90000\)/u);
	assert.match(smokeScript, /forceHighPerformanceGpu/u);
	assert.match(smokeScript, /pixels\.nonUniform/u);
	assert.match(smokeScript, /https:\/\/krunker\.io/u);
});
