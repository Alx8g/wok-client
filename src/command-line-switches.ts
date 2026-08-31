import type { FramePolicy } from './calibration.ts';
import type { AppliedGraphicsBackend } from './graphics-profile.ts';

export interface CommandLineSwitch {
	name: string;
	value?: string;
}

export const WOK_WINDOWS_RUNTIME_FEATURES = [
	'WebSocketStarvationEscape:min_wait/0ms',
	'PostedMessageStarvationEscape:min_wait/0ms',
	'WokNetworkServiceHighPriority'
] as const;

export function computeCommandLineSwitches(userPrefs: UserPrefs, graphicsBackend: AppliedGraphicsBackend, framePolicy?: FramePolicy, platform: NodeJS.Platform = process.platform): CommandLineSwitch[] {
	const switches: CommandLineSwitch[] = [{ name: 'autoplay-policy', value: 'no-user-gesture-required' }];
	const enabledFeatures: string[] = platform === 'win32' ? [...WOK_WINDOWS_RUNTIME_FEATURES] : [];
	if (userPrefs.safeFlags_disableBackgrounding) {
		switches.push({ name: 'disable-background-timer-throttling' }, { name: 'disable-renderer-backgrounding' }, { name: 'disable-backgrounding-occluded-windows' });
	}
	if (graphicsBackend !== 'default') {
		switches.push({ name: 'use-angle', value: graphicsBackend });
		if (graphicsBackend === 'vulkan') enabledFeatures.push('Vulkan');
	}
	if (enabledFeatures.length > 0) switches.push({ name: 'enable-features', value: enabledFeatures.join(',') });
	if (userPrefs.experimentalFlags_experimental && platform === 'linux') switches.push({ name: 'enable-native-gpu-memory-buffers' });
	if (userPrefs.safeFlags_gpuRasterizing) switches.push({ name: 'enable-gpu-rasterization' });
	const uncapFrames = framePolicy ? framePolicy === 'uncapped' : Boolean(userPrefs.fpsUncap);
	if (uncapFrames) switches.push({ name: 'disable-frame-rate-limit' }, { name: 'disable-gpu-vsync' });
	return switches;
}
