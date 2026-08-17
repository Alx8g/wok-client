export type GpuInfoType = 'basic' | 'complete';

export type GpuInfoProvider = (infoType: GpuInfoType) => Promise<unknown>;

/**
 * Ordinary gameplay only needs Chromium's cached adapter list. On Windows the complete query
 * enters a separate system-enumeration path that can pause the active renderer.
 */
export function fetchRuntimeGraphicsInfo(provider: GpuInfoProvider): Promise<unknown> {
	return provider('basic');
}

/** Complete driver identity is reserved for the explicit calibration flow that consumes it. */
export function fetchCalibrationGraphicsInfo(provider: GpuInfoProvider): Promise<unknown> {
	return provider('complete');
}
