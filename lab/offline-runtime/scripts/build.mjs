import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildCalibrationParityPage } from '../src/page/calibration-parity.ts';

const repositoryRoot = join(import.meta.dirname, '..', '..', '..');
const outputDirectory = join(repositoryRoot, '.working', 'runtime-lab', 'site');
const markSvg = await readFile(join(repositoryRoot, 'assets', 'wok-mark.svg'), 'utf8');
const page = buildCalibrationParityPage(markSvg);
const pageFilename = `${page.pageId}-${page.sha256}.html`;
const manifest = {
	builtAt: new Date().toISOString(),
	calibrationSourceSha256: page.calibrationSourceSha256,
	pageFilename,
	pageId: page.pageId,
	pageSha256: page.sha256,
	workloadVersion: page.workloadVersion
};

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
	writeFile(join(outputDirectory, pageFilename), page.html),
	writeFile(join(outputDirectory, 'calibration-source.html'), page.calibrationSourceHtml),
	writeFile(join(outputDirectory, 'current.json'), `${JSON.stringify(manifest, null, '\t')}\n`)
]);

console.log(JSON.stringify({ outputDirectory, ...manifest }));
