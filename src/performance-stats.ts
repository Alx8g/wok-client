export const PERFORMANCE_WINDOW_MS = 10_000;
export const CURRENT_FPS_WINDOW_MS = 1_000;
export const MAX_VALID_FRAME_MS = 1_000;

// Samples are grouped by time so storage stays constant even at uncapped frame rates.
// A cutoff-straddling bucket can remain for less than TIME_BUCKET_MS beyond a window.
export const PERFORMANCE_TIME_BUCKET_MS = 100;

// Percentiles use fixed-width frame-time bins instead of sorting every sample. Values
// are rounded to the nearest bin, with at most half a bin (0.125 ms) of error.
export const FRAME_TIME_BIN_WIDTH_MS = 0.25;

const TIME_BUCKET_COUNT = Math.ceil(PERFORMANCE_WINDOW_MS / PERFORMANCE_TIME_BUCKET_MS) + 1;
const FRAME_TIME_BIN_COUNT = Math.round(MAX_VALID_FRAME_MS / FRAME_TIME_BIN_WIDTH_MS) + 1;

function fpsFromTotals(sampleCount: number, totalFrameTime: number): number {
	return sampleCount > 0 && totalFrameTime > 0 ? 1000 / (totalFrameTime / sampleCount) : 0;
}

function rounded(value: number, decimalPlaces = 1): number {
	const scale = 10 ** decimalPlaces;
	return Math.round(value * scale) / scale;
}

function frameTimeForBin(binIndex: number): number {
	// The first range is narrower because valid frame times are greater than zero.
	return binIndex === 0 ? FRAME_TIME_BIN_WIDTH_MS / 4 : binIndex * FRAME_TIME_BIN_WIDTH_MS;
}

export class RollingPerformanceStats {
	private readonly bucketEpochs = new Float64Array(TIME_BUCKET_COUNT);
	private readonly bucketFirstSampleTimes = new Float64Array(TIME_BUCKET_COUNT);
	private readonly bucketSampleCounts = new Uint32Array(TIME_BUCKET_COUNT);
	private readonly bucketTotalFrameTimes = new Float64Array(TIME_BUCKET_COUNT);
	private readonly bucketWorstFrameTimes = new Float64Array(TIME_BUCKET_COUNT);
	private readonly bucketHistogram = new Uint32Array(TIME_BUCKET_COUNT * FRAME_TIME_BIN_COUNT);
	private readonly bucketTouchedBins = new Uint16Array(TIME_BUCKET_COUNT * FRAME_TIME_BIN_COUNT);
	private readonly bucketTouchedBinCounts = new Uint16Array(TIME_BUCKET_COUNT);
	private readonly windowHistogram = new Uint32Array(FRAME_TIME_BIN_COUNT);
	private windowSampleCount = 0;
	private windowTotalFrameTime = 0;

	constructor() {
		this.bucketEpochs.fill(-1);
	}

	recordFrame(timestamp: number, frameTime: number): void {
		if (!Number.isFinite(timestamp) || !Number.isFinite(frameTime) || timestamp < 0 || frameTime <= 0 || frameTime > MAX_VALID_FRAME_MS) return;

		const bucketEpoch = Math.floor(timestamp / PERFORMANCE_TIME_BUCKET_MS);
		const bucketIndex = bucketEpoch % TIME_BUCKET_COUNT;
		if (this.bucketEpochs[bucketIndex] !== bucketEpoch) this.initializeBucket(bucketIndex, bucketEpoch, timestamp);

		const histogramBin = Math.min(FRAME_TIME_BIN_COUNT - 1, Math.round(frameTime / FRAME_TIME_BIN_WIDTH_MS));
		const histogramOffset = bucketIndex * FRAME_TIME_BIN_COUNT + histogramBin;
		if (this.bucketHistogram[histogramOffset] === 0) {
			const touchedBinOffset = bucketIndex * FRAME_TIME_BIN_COUNT + this.bucketTouchedBinCounts[bucketIndex];
			this.bucketTouchedBins[touchedBinOffset] = histogramBin;
			this.bucketTouchedBinCounts[bucketIndex]++;
		}

		this.bucketHistogram[histogramOffset]++;
		this.windowHistogram[histogramBin]++;
		this.bucketSampleCounts[bucketIndex]++;
		this.bucketTotalFrameTimes[bucketIndex] += frameTime;
		this.bucketWorstFrameTimes[bucketIndex] = Math.max(this.bucketWorstFrameTimes[bucketIndex], frameTime);
		this.windowSampleCount++;
		this.windowTotalFrameTime += frameTime;
	}

	snapshot(now: number): PerformanceSnapshot {
		this.expireWindow(now);

		let currentSampleCount = 0;
		let currentTotalFrameTime = 0;
		let earliestSampleTime = Number.POSITIVE_INFINITY;
		let worstFrameTime = 0;
		const currentCutoff = now - CURRENT_FPS_WINDOW_MS;

		for (let bucketIndex = 0; bucketIndex < TIME_BUCKET_COUNT; bucketIndex++) {
			const sampleCount = this.bucketSampleCounts[bucketIndex];
			if (sampleCount === 0) continue;

			earliestSampleTime = Math.min(earliestSampleTime, this.bucketFirstSampleTimes[bucketIndex]);
			worstFrameTime = Math.max(worstFrameTime, this.bucketWorstFrameTimes[bucketIndex]);

			const bucketEnd = (this.bucketEpochs[bucketIndex] + 1) * PERFORMANCE_TIME_BUCKET_MS;
			if (bucketEnd > currentCutoff) {
				currentSampleCount += sampleCount;
				currentTotalFrameTime += this.bucketTotalFrameTimes[bucketIndex];
			}
		}

		const windowSeconds = this.windowSampleCount > 0
			? Math.min(PERFORMANCE_WINDOW_MS, Math.max(0, now - earliestSampleTime)) / 1000
			: 0;

		return {
			averageFps: rounded(fpsFromTotals(this.windowSampleCount, this.windowTotalFrameTime)),
			currentFps: rounded(fpsFromTotals(currentSampleCount, currentTotalFrameTime)),
			onePercentLowFps: this.windowSampleCount >= 100 ? rounded(this.calculateOnePercentLowFps()) : 0,
			p95FrameTimeMs: this.windowSampleCount > 0 ? rounded(this.calculatePercentileFrameTime(0.95), 2) : 0,
			sampleCount: this.windowSampleCount,
			worstFrameTimeMs: rounded(worstFrameTime, 2),
			windowSeconds: rounded(windowSeconds, 1)
		};
	}

	reset(): void {
		// Clear incrementally instead of zero-filling the ~2.4 MB histogram storage: reset runs
		// inside the gameplay rAF on every 10 s segment rollover, and removeBucket already
		// erases exactly the histogram bins a bucket touched. Cost scales with recorded data.
		for (let bucketIndex = 0; bucketIndex < TIME_BUCKET_COUNT; bucketIndex++) this.removeBucket(bucketIndex);
		this.windowSampleCount = 0;
		this.windowTotalFrameTime = 0;
	}

	private initializeBucket(bucketIndex: number, bucketEpoch: number, firstSampleTime: number): void {
		this.removeBucket(bucketIndex);
		this.bucketEpochs[bucketIndex] = bucketEpoch;
		this.bucketFirstSampleTimes[bucketIndex] = firstSampleTime;
	}

	private expireWindow(now: number): void {
		const cutoff = now - PERFORMANCE_WINDOW_MS;
		for (let bucketIndex = 0; bucketIndex < TIME_BUCKET_COUNT; bucketIndex++) {
			const bucketEpoch = this.bucketEpochs[bucketIndex];
			if (bucketEpoch >= 0 && (bucketEpoch + 1) * PERFORMANCE_TIME_BUCKET_MS <= cutoff) this.removeBucket(bucketIndex);
		}
	}

	private removeBucket(bucketIndex: number): void {
		const sampleCount = this.bucketSampleCounts[bucketIndex];
		if (sampleCount === 0) {
			this.bucketEpochs[bucketIndex] = -1;
			this.bucketFirstSampleTimes[bucketIndex] = 0;
			this.bucketTouchedBinCounts[bucketIndex] = 0;
			return;
		}

		const histogramBaseOffset = bucketIndex * FRAME_TIME_BIN_COUNT;
		const touchedBinCount = this.bucketTouchedBinCounts[bucketIndex];
		for (let touchedBinIndex = 0; touchedBinIndex < touchedBinCount; touchedBinIndex++) {
			const histogramBin = this.bucketTouchedBins[histogramBaseOffset + touchedBinIndex];
			const histogramOffset = histogramBaseOffset + histogramBin;
			this.windowHistogram[histogramBin] -= this.bucketHistogram[histogramOffset];
			this.bucketHistogram[histogramOffset] = 0;
		}

		this.windowSampleCount -= sampleCount;
		this.windowTotalFrameTime -= this.bucketTotalFrameTimes[bucketIndex];
		if (this.windowSampleCount === 0) this.windowTotalFrameTime = 0;
		this.bucketEpochs[bucketIndex] = -1;
		this.bucketFirstSampleTimes[bucketIndex] = 0;
		this.bucketSampleCounts[bucketIndex] = 0;
		this.bucketTotalFrameTimes[bucketIndex] = 0;
		this.bucketWorstFrameTimes[bucketIndex] = 0;
		this.bucketTouchedBinCounts[bucketIndex] = 0;
	}

	private calculatePercentileFrameTime(percentile: number): number {
		const targetSample = Math.ceil(this.windowSampleCount * percentile);
		let samplesSeen = 0;
		for (let histogramBin = 0; histogramBin < FRAME_TIME_BIN_COUNT; histogramBin++) {
			samplesSeen += this.windowHistogram[histogramBin];
			if (samplesSeen >= targetSample) return frameTimeForBin(histogramBin);
		}
		return 0;
	}

	private calculateOnePercentLowFps(): number {
		let samplesRemaining = Math.ceil(this.windowSampleCount * 0.01);
		const slowSampleCount = samplesRemaining;
		let slowFrameTimeTotal = 0;

		for (let histogramBin = FRAME_TIME_BIN_COUNT - 1; histogramBin >= 0 && samplesRemaining > 0; histogramBin--) {
			const samplesInBin = this.windowHistogram[histogramBin];
			if (samplesInBin === 0) continue;
			const samplesToUse = Math.min(samplesRemaining, samplesInBin);
			slowFrameTimeTotal += samplesToUse * frameTimeForBin(histogramBin);
			samplesRemaining -= samplesToUse;
		}

		return fpsFromTotals(slowSampleCount, slowFrameTimeTotal);
	}
}
