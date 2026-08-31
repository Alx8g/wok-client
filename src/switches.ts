import { app } from 'electron';
import type { FramePolicy } from './calibration.ts';
import { computeCommandLineSwitches } from './command-line-switches.ts';
import type { AppliedGraphicsBackend } from './graphics-profile.ts';
import { describeLinuxDisplaySession } from './linux-session.ts';
export function applyCommandLineSwitches(userPrefs: UserPrefs, graphicsBackend: AppliedGraphicsBackend, framePolicy?: FramePolicy) {
	const displaySession = describeLinuxDisplaySession(process.platform, process.argv, process.env);
	if (displaySession) console.log(displaySession);
	for (const commandLineSwitch of computeCommandLineSwitches(userPrefs, graphicsBackend, framePolicy)) {
		if (commandLineSwitch.value === undefined) app.commandLine.appendSwitch(commandLineSwitch.name);
		else app.commandLine.appendSwitch(commandLineSwitch.name, commandLineSwitch.value);
	}
	if (userPrefs.safeFlags_disableBackgrounding) console.log('Applied flags to disable background throttling');
	console.log(`Using graphics backend: ${graphicsBackend}`);
	if (userPrefs.experimentalFlags_experimental && process.platform === 'linux') console.log('Enabled experimental Linux GPU memory buffers');
	if (userPrefs.safeFlags_gpuRasterizing) console.log('Forcing GPU rasterization past the driver blocklist');
	const uncapFrames = framePolicy ? framePolicy === 'uncapped' : Boolean(userPrefs.fpsUncap);
	if (uncapFrames) console.log('Removed FPS Cap');
}
