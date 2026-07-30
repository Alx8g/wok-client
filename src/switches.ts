import { app } from 'electron';
import type { FramePolicy } from './calibration.ts';
import type { AppliedGraphicsBackend } from './graphics-profile.ts';

/** applies command line switches to the app based on the passed userprefs */
export function applyCommandLineSwitches(userPrefs: UserPrefs, graphicsBackend: AppliedGraphicsBackend, framePolicy?: FramePolicy) {

	// works as a cli flag, but not w/ appendSwitch. why.
	// app.commandLine.appendSwitch("ozone-platform", "x11")

	// Don't require user gesture for autoplay (thanks Commander)
	app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

	if (userPrefs.safeFlags_disableBackgrounding) {
		app.commandLine.appendSwitch('disable-background-timer-throttling');
		app.commandLine.appendSwitch('disable-renderer-backgrounding');
		app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

		console.log('Applied flags to disable background throttling');
	}
	if (userPrefs.experimentalFlags_increaseLimits) {
		app.commandLine.appendSwitch('renderer-process-limit', '100');
		console.log('Applied flags to increase limits');
	}
	if (graphicsBackend !== 'default') {
		app.commandLine.appendSwitch('use-angle', graphicsBackend);
		if (graphicsBackend === 'vulkan') app.commandLine.appendSwitch('enable-features', 'Vulkan');
	}
	console.log(`Using graphics backend: ${graphicsBackend}`);

	if (userPrefs.experimentalFlags_experimental) {
		if (process.platform === 'linux') app.commandLine.appendSwitch('enable-native-gpu-memory-buffers');

		app.commandLine.appendSwitch('disable-best-effort-tasks');
		app.commandLine.appendSwitch('raise-timer-frequency');
		app.commandLine.appendSwitch('force-high-performance-gpu');
		console.log('Enabled Experiments');
	}
	if (userPrefs.safeFlags_gpuRasterizing) {
		// Force the normal hardware path without bypassing Intel/AMD/NVIDIA driver safety workarounds.
		app.commandLine.appendSwitch('enable-gpu-rasterization');
		console.log('GPU rasterization active');
	}

	const uncapFrames = framePolicy ? framePolicy === 'uncapped' : Boolean(userPrefs.fpsUncap);
	if (uncapFrames) {
		app.commandLine.appendSwitch('disable-frame-rate-limit');
		app.commandLine.appendSwitch('disable-gpu-vsync');
		console.log('Removed FPS Cap');
	}

}
