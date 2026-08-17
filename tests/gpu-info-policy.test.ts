import assert from 'node:assert/strict';
import test from 'node:test';
import {
	fetchCalibrationGraphicsInfo,
	fetchRuntimeGraphicsInfo,
	type GpuInfoType
} from '../src/gpu-info-policy.ts';

test('ordinary gameplay requests only basic GPU information', async () => {
	const requests: GpuInfoType[] = [];
	const value = await fetchRuntimeGraphicsInfo(async infoType => {
		requests.push(infoType);
		return { gpuDevice: [] };
	});

	assert.deepEqual(requests, ['basic']);
	assert.deepEqual(value, { gpuDevice: [] });
});

test('explicit calibration requests complete GPU information', async () => {
	const requests: GpuInfoType[] = [];
	await fetchCalibrationGraphicsInfo(async infoType => {
		requests.push(infoType);
		return {};
	});

	assert.deepEqual(requests, ['complete']);
});
