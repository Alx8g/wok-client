import type { FramePolicy } from './calibration.ts';
import type { AppliedGraphicsBackend } from './graphics-profile.ts';

export interface CommandLineSwitch {
	name: string;
	value?: string;
}

/**
 * Pure mapping from user preferences to Chromium command-line switches. Kept free of Electron
 * imports so the full preference matrix stays testable under node --test; switches.ts applies
 * the computed list to the Electron app at startup.
 */
export function computeCommandLineSwitches(
	userPrefs: UserPrefs,
	graphicsBackend: AppliedGraphicsBackend,
	framePolicy?: FramePolicy,
	platform: NodeJS.Platform = process.platform
): CommandLineSwitch[] {
	const switches: CommandLineSwitch[] = [
		// Don't require user gesture for autoplay (thanks Commander)
		{ name: 'autoplay-policy', value: 'no-user-gesture-required' }
	];

	if (userPrefs.safeFlags_disableBackgrounding) {
		switches.push(
			{ name: 'disable-background-timer-throttling' },
			{ name: 'disable-renderer-backgrounding' },
			{ name: 'disable-backgrounding-occluded-windows' }
		);
	}
	if (graphicsBackend !== 'default') {
		switches.push({ name: 'use-angle', value: graphicsBackend });
		if (graphicsBackend === 'vulkan') switches.push({ name: 'enable-features', value: 'Vulkan' });
	}
	if (userPrefs.safeFlags_highPerformanceGpu) {
		// A preference hint for dual-GPU systems: ask Chromium for the discrete adapter. Harmless
		// on single-GPU machines; on hybrid laptops the integrated-versus-discrete difference is
		// the largest single frame-rate lever the client controls.
		switches.push({ name: 'force-high-performance-gpu' });
	}
	if (userPrefs.experimentalFlags_experimental && platform === 'linux') {
		// The only remaining experiment. The former companions were removed as verified placebo
		// or mislabeled: renderer-process-limit raises a ceiling a one-origin app never reaches,
		// disable-best-effort-tasks defers Chromium housekeeping until shutdown rather than
		// reducing hiccups, and raise-timer-frequency only touches the browser process.
		switches.push({ name: 'enable-native-gpu-memory-buffers' });
	}
	if (userPrefs.safeFlags_gpuRasterizing) {
		// Modern Chromium enables GPU rasterization by default everywhere this app runs; the only
		// remaining effect of the switch is forcing it past the driver blocklist, so it is off by
		// default and framed as an override, not a performance feature.
		switches.push({ name: 'enable-gpu-rasterization' });
	}

	const uncapFrames = framePolicy ? framePolicy === 'uncapped' : Boolean(userPrefs.fpsUncap);
	if (uncapFrames) {
		switches.push(
			{ name: 'disable-frame-rate-limit' },
			{ name: 'disable-gpu-vsync' }
		);
	}

	return switches;
}
