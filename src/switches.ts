import { app } from 'electron';
import type { FramePolicy } from './calibration.ts';
import { computeCommandLineSwitches } from './command-line-switches.ts';
import type { AppliedGraphicsBackend } from './graphics-profile.ts';

/** applies command line switches to the app based on the passed userprefs */
export function applyCommandLineSwitches(userPrefs: UserPrefs, graphicsBackend: AppliedGraphicsBackend, framePolicy?: FramePolicy) {

	// works as a cli flag, but not w/ appendSwitch. why.
	// app.commandLine.appendSwitch("ozone-platform", "x11")

	for (const commandLineSwitch of computeCommandLineSwitches(userPrefs, graphicsBackend, framePolicy)) {
		if (commandLineSwitch.value === undefined) app.commandLine.appendSwitch(commandLineSwitch.name);
		else app.commandLine.appendSwitch(commandLineSwitch.name, commandLineSwitch.value);
	}

	if (userPrefs.safeFlags_disableBackgrounding) console.log('Applied flags to disable background throttling');
	console.log(`Using graphics backend: ${graphicsBackend}`);
	if (userPrefs.safeFlags_highPerformanceGpu) console.log('Requested the high-performance GPU on dual-GPU systems');
	if (userPrefs.experimentalFlags_experimental && process.platform === 'linux') console.log('Enabled experimental Linux GPU memory buffers');
	if (userPrefs.safeFlags_gpuRasterizing) console.log('Forcing GPU rasterization past the driver blocklist');

	const uncapFrames = framePolicy ? framePolicy === 'uncapped' : Boolean(userPrefs.fpsUncap);
	if (uncapFrames) console.log('Removed FPS Cap');

}
