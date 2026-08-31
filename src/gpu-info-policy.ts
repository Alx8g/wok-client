export type GpuInfoType = 'basic' | 'complete';
export type GpuInfoProvider = (infoType: GpuInfoType) => Promise<unknown>;
export function fetchRuntimeGraphicsInfo(provider: GpuInfoProvider): Promise<unknown> {
	return provider('basic');
}
export function fetchCalibrationGraphicsInfo(provider: GpuInfoProvider): Promise<unknown> {
	return provider('complete');
}
