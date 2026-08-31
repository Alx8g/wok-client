import type { FramePolicy } from './calibration.ts';
import type { AppliedGraphicsBackend } from './graphics-profile.ts';
export interface CommandLineSwitch {
	name: string;
	value?: string;
}
export function computeCommandLineSwitches(userPrefs: UserPrefs, graphicsBackend: AppliedGraphicsBackend, framePolicy?: FramePolicy, platform: NodeJS.Platform = process.platform): CommandLineSwitch[] {
	const switches: CommandLineSwitch[] = [{ name: 'autoplay-policy', value: 'no-user-gesture-required' }];
	if (userPrefs.safeFlags_disableBackgrounding) {
		switches.push({ name: 'disable-background-timer-throttling' }, { name: 'disable-renderer-backgrounding' }, { name: 'disable-backgrounding-occluded-windows' });
	}
	if (graphicsBackend !== 'default') {
		switches.push({ name: 'use-angle', value: graphicsBackend });
		if (graphicsBackend === 'vulkan') switches.push({ name: 'enable-features', value: 'Vulkan' });
	}
	if (userPrefs.safeFlags_highPerformanceGpu) {
		switches.push({ name: 'force-high-performance-gpu' });
	}
	if (userPrefs.experimentalFlags_experimental && platform === 'linux') {
		switches.push({ name: 'enable-native-gpu-memory-buffers' });
	}
	if (userPrefs.safeFlags_gpuRasterizing) {
		switches.push({ name: 'enable-gpu-rasterization' });
	}
	const uncapFrames = framePolicy ? framePolicy === 'uncapped' : Boolean(userPrefs.fpsUncap);
	if (uncapFrames) {
		switches.push({ name: 'disable-frame-rate-limit' }, { name: 'disable-gpu-vsync' });
	}
	return switches;
}
