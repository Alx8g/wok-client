export interface ReleaseSmokePixelAnalysis {
	sampleCount: number;
	luminanceMin: number;
	luminanceMax: number;
	luminanceRange: number;
	luminanceVariance: number;
	nonUniform: boolean;
}

const MAX_PIXEL_SAMPLES = 16_384;
const MIN_LUMINANCE_RANGE = 12;
const MIN_LUMINANCE_VARIANCE = 20;

export function analyzeReleaseSmokeBitmap(bitmap: Uint8Array): ReleaseSmokePixelAnalysis {
	const pixelCount = Math.floor(bitmap.length / 4);
	if (pixelCount === 0) return { sampleCount: 0, luminanceMin: 0, luminanceMax: 0, luminanceRange: 0, luminanceVariance: 0, nonUniform: false };
	const pixelStride = Math.max(1, Math.floor(pixelCount / MAX_PIXEL_SAMPLES));
	let sampleCount = 0;
	let luminanceMin = 255;
	let luminanceMax = 0;
	let sum = 0;
	let sumSquares = 0;
	for (let pixel = 0; pixel < pixelCount; pixel += pixelStride) {
		const offset = pixel * 4;
		const blue = bitmap[offset];
		const green = bitmap[offset + 1];
		const red = bitmap[offset + 2];
		const luminance = (red * 54 + green * 183 + blue * 19) / 256;
		luminanceMin = Math.min(luminanceMin, luminance);
		luminanceMax = Math.max(luminanceMax, luminance);
		sum += luminance;
		sumSquares += luminance * luminance;
		sampleCount++;
	}
	const mean = sum / sampleCount;
	const luminanceVariance = Math.max(0, sumSquares / sampleCount - mean * mean);
	const luminanceRange = luminanceMax - luminanceMin;
	return {
		sampleCount,
		luminanceMin,
		luminanceMax,
		luminanceRange,
		luminanceVariance,
		nonUniform: luminanceRange >= MIN_LUMINANCE_RANGE && luminanceVariance >= MIN_LUMINANCE_VARIANCE
	};
}
