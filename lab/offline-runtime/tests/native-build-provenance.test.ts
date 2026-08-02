import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const repositoryRoot = join(
	import.meta.dirname,
	'..',
	'..',
	'..'
);
const recorderProjectPath = join(
	repositoryRoot,
	'lab',
	'offline-runtime',
	'hosts',
	'windows',
	'WokEtlRecorder.vcxproj'
);

test('native recorder build excludes per-user property sheets', async () => {
	const project = await readFile(recorderProjectPath, 'utf8');

	assert.doesNotMatch(project, /\$\(UserRootDir\)/u);
	assert.doesNotMatch(project, /\.user\.props/iu);
	assert.doesNotMatch(
		project,
		/<ImportGroup\s+Label="PropertySheets"/u
	);
	assert.match(
		project,
		/<Import Project="\$\(VCTargetsPath\)\\Microsoft\.Cpp\.Default\.props" \/>/u
	);
	assert.match(
		project,
		/<Import Project="\$\(VCTargetsPath\)\\Microsoft\.Cpp\.props" \/>/u
	);
	assert.match(
		project,
		/<Import Project="\$\(VCTargetsPath\)\\Microsoft\.Cpp\.targets" \/>/u
	);
});
