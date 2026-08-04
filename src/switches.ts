import { app } from 'electron';
import type { FramePolicy } from './calibration.ts';
import { computeCommandLineSwitches } from './command-line-switches.ts';
import type { AppliedGraphicsBackend } from './graphics-profile.ts';
import { describeLinuxDisplaySession } from './linux-session.ts';

/** applies command line switches to the app based on the passed userprefs */
export function applyCommandLineSwitches(userPrefs: UserPrefs, graphicsBackend: AppliedGraphicsBackend, framePolicy?: FramePolicy) {

	// The ozone platform is deliberately absent here. Chromium resolves it in
	// PreEarlyInitialization, before this file is even loaded, which is why appendSwitch never
	// worked for it. The launcher (the packaged wok-client wrapper, or scripts/start-electron.mjs)
	// passes it as argv; see src/linux-session.ts.
	const displaySession = describeLinuxDisplaySession(process.platform, process.argv, process.env);
	if (displaySession) console.log(displaySession);

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
