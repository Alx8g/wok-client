export const REPORTED_PING_WINDOW_MS = 120000;
export const MAX_REPORTED_PING_SAMPLES = 64;
export const MAX_REPORTED_PING_MS = 5000;
export interface ReportedPingSnapshot {
	available: boolean;
	currentMs: number;
	minimumMs: number;
	medianMs: number;
	p95Ms: number;
	variationMs: number;
	sampleAgeMs: number;
	sampleCount: number;
	windowSeconds: number;
}
function rounded(value: number, decimalPlaces = 1): number {
	const scale = 10 ** decimalPlaces;
	return Math.round(value * scale) / scale;
}
function percentile(sortedValues: readonly number[], fraction: number): number {
	if (sortedValues.length === 0) return 0;
	const index = Math.max(0, Math.ceil(sortedValues.length * fraction) - 1);
	return sortedValues[index];
}
export class RollingReportedPingStats {
	private readonly timestamps = new Float64Array(MAX_REPORTED_PING_SAMPLES);
	private readonly values = new Float64Array(MAX_REPORTED_PING_SAMPLES);
	private sampleCount = 0;
	private nextSampleIndex = 0;
	record(timestamp: number, reportedPingMs: number): void {
		if (!Number.isFinite(timestamp) || timestamp < 0 || !Number.isFinite(reportedPingMs) || reportedPingMs <= 0 || reportedPingMs > MAX_REPORTED_PING_MS) return;
		this.timestamps[this.nextSampleIndex] = timestamp;
		this.values[this.nextSampleIndex] = reportedPingMs;
		this.nextSampleIndex = (this.nextSampleIndex + 1) % MAX_REPORTED_PING_SAMPLES;
		this.sampleCount = Math.min(this.sampleCount + 1, MAX_REPORTED_PING_SAMPLES);
	}
	snapshot(now: number): ReportedPingSnapshot {
		if (!Number.isFinite(now) || now < 0) return this.emptySnapshot();
		const cutoff = now - REPORTED_PING_WINDOW_MS;
		const chronologicalValues: number[] = [];
		let earliestTimestamp = Number.POSITIVE_INFINITY;
		let latestTimestamp = Number.NEGATIVE_INFINITY;
		let currentMs = 0;
		const firstSampleIndex = (this.nextSampleIndex - this.sampleCount + MAX_REPORTED_PING_SAMPLES) % MAX_REPORTED_PING_SAMPLES;
		for (let offset = 0; offset < this.sampleCount; offset++) {
			const sampleIndex = (firstSampleIndex + offset) % MAX_REPORTED_PING_SAMPLES;
			const timestamp = this.timestamps[sampleIndex];
			if (timestamp < cutoff || timestamp > now) continue;
			chronologicalValues.push(this.values[sampleIndex]);
			earliestTimestamp = Math.min(earliestTimestamp, timestamp);
			if (timestamp >= latestTimestamp) {
				latestTimestamp = timestamp;
				currentMs = this.values[sampleIndex];
			}
		}
		if (chronologicalValues.length === 0) return this.emptySnapshot();
		let totalVariation = 0;
		for (let index = 1; index < chronologicalValues.length; index++) {
			totalVariation += Math.abs(chronologicalValues[index] - chronologicalValues[index - 1]);
		}
		const sortedValues = [...chronologicalValues].sort((left, right) => left - right);
		return {
			available: true,
			currentMs: rounded(currentMs),
			minimumMs: rounded(sortedValues[0]),
			medianMs: rounded(percentile(sortedValues, 0.5)),
			p95Ms: rounded(percentile(sortedValues, 0.95)),
			variationMs: chronologicalValues.length > 1 ? rounded(totalVariation / (chronologicalValues.length - 1)) : 0,
			sampleAgeMs: rounded(now - latestTimestamp),
			sampleCount: chronologicalValues.length,
			windowSeconds: rounded(Math.min(REPORTED_PING_WINDOW_MS, now - earliestTimestamp) / 1000)
		};
	}
	reset(): void {
		this.sampleCount = 0;
		this.nextSampleIndex = 0;
	}
	private emptySnapshot(): ReportedPingSnapshot {
		return {
			available: false,
			currentMs: 0,
			minimumMs: 0,
			medianMs: 0,
			p95Ms: 0,
			variationMs: 0,
			sampleAgeMs: 0,
			sampleCount: 0,
			windowSeconds: 0
		};
	}
}
export function parseKrunkerReportedPing(value: string | null | undefined): number | undefined {
	if (!value) return undefined;
	const match = /^\s*(\d+(?:\.\d+)?)\b/u.exec(value);
	if (!match) return undefined;
	const reportedPingMs = Number(match[1]);
	if (!Number.isFinite(reportedPingMs) || reportedPingMs <= 0 || reportedPingMs > MAX_REPORTED_PING_MS) return undefined;
	return reportedPingMs;
}
export function parseKrunkerReportedTps(value: string | null | undefined): number | undefined {
	if (!value) return undefined;
	const match = /^\s*(\d+(?:\.\d+)?)\s+TPS\b/iu.exec(value);
	if (!match) return undefined;
	const reportedTps = Number(match[1]);
	return Number.isFinite(reportedTps) && reportedTps >= 0 && reportedTps <= 1000 ? reportedTps : undefined;
}
export function parseKrunkerRegionCode(gameId: unknown): string | undefined {
	if (typeof gameId !== 'string') return undefined;
	const match = /^([A-Z0-9]{2,8}):[A-Za-z0-9_-]{1,64}$/u.exec(gameId.trim().toUpperCase());
	return match?.[1];
}
