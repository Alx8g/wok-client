

import { matchmakerRegionLatency } from './matchmaker-selection.ts';
import { mutationRecordsTouchSelector } from './mutation-relevance.ts';
import {
	formatPublicServerPingLabel,
	resolvePublicServerRegionCode,
	sortPublicServerRegions
} from './public-server-region-ping.ts';

export const PUBLIC_SERVER_PING_SORT_PREFERENCE_KEY = 'wokPublicServerPingSort';
export const PUBLIC_SERVER_PING_LABEL_CLASS = 'wok-public-region-ping';
export const PUBLIC_SERVER_PING_STYLE_ID = 'wokPublicServerPingSortStyle';
export const PUBLIC_SERVER_PING_REFRESH_MS = 60_000;

const TEXT_NODE = 3;
const PUBLIC_SERVER_SURFACE_SELECTOR = '#serverHolder';

export interface PublicServerRegionBlock<T = HTMLElement> {
	heading: T;
	label: string;
	nodes: readonly T[];
	regionCode?: string;
}

export type MeasurePublicServerRegionLatency = (
	regions: readonly string[]
) => Promise<unknown>;

interface OriginalPublicServerOrder {
	blocks: readonly (readonly HTMLElement[])[];
	headings: ReadonlySet<HTMLElement>;
}

export function readPublicServerRegionHeadingLabel(
	heading: Pick<HTMLElement, 'childNodes'>
): string {
	return [...heading.childNodes]
		.filter(node => node.nodeType === TEXT_NODE)
		.map(node => node.textContent?.replace(/\s+/gu, ' ').trim() ?? '')
		.filter(Boolean)
		.join(' ');
}

export function sortPublicServerRegionBlocks<T>(
	blocks: readonly PublicServerRegionBlock<T>[],
	latencies: Readonly<Record<string, unknown>>
): PublicServerRegionBlock<T>[] {
	return sortPublicServerRegions(blocks.map(block => ({
		...block,
		pingMs: block.regionCode
			? matchmakerRegionLatency(latencies, block.regionCode)
			: undefined,
		region: block.label
	})));
}

function collectPublicServerRegionBlocks(holder: HTMLElement): PublicServerRegionBlock[] {
	const blocks: PublicServerRegionBlock[] = [];
	let current: { heading: HTMLElement; label: string; nodes: HTMLElement[]; regionCode?: string } | undefined;

	for (const child of [...holder.children]) {
		if (!(child instanceof HTMLElement)) continue;
		if (child.matches('.setHed')) {
			const label = readPublicServerRegionHeadingLabel(child);
			const regionCode = resolvePublicServerRegionCode(label);
			current = {
				heading: child,
				label,
				nodes: [child],
				...(regionCode ? { regionCode } : {})
			};
			blocks.push(current);
		} else if (current) {
			current.nodes.push(child);
		}
	}

	return blocks;
}

function ensureStylesheet(): void {
	if (document.getElementById(PUBLIC_SERVER_PING_STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = PUBLIC_SERVER_PING_STYLE_ID;
	style.textContent = `
		#serverHolder .${PUBLIC_SERVER_PING_LABEL_CLASS} {
			box-sizing: border-box;
			display: inline-flex;
			float: right;
			align-items: center;
			justify-content: center;
			min-width: 58px;
			height: 24px;
			margin: 1px 10px 0 8px;
			padding: 0 8px;
			border: 1px solid var(--wok-border, rgba(255, 255, 255, 0.3));
			border-radius: 999px;
			background: var(--wok-accent-soft, rgba(33, 150, 243, 0.16));
			color: var(--wok-text-muted, rgba(255, 255, 255, 0.72));
			font: 700 12px/1 Consolas, monospace;
			font-variant-numeric: tabular-nums;
			letter-spacing: 0.02em;
			text-align: center;
			white-space: nowrap;
			vertical-align: top;
			pointer-events: none;
		}
	`;
	(document.head ?? document.body ?? document.documentElement)?.append(style);
}

function headingsMatchSnapshot(
	blocks: readonly PublicServerRegionBlock[],
	snapshot: OriginalPublicServerOrder | undefined
): boolean {
	return snapshot !== undefined
		&& blocks.length === snapshot.headings.size
		&& blocks.every(block => snapshot.headings.has(block.heading));
}

function rememberOriginalOrder(holder: HTMLElement, blocks: readonly PublicServerRegionBlock[]): void {
	const headings = new Set(blocks.map(block => block.heading));
	originalOrders.set(holder, {
		blocks: blocks.map(block => [...block.nodes]),
		headings
	});
}

function restoreBlockSourceOrder(
	blocks: readonly PublicServerRegionBlock[],
	snapshot: OriginalPublicServerOrder
): PublicServerRegionBlock[] {
	const sourceIndex = new Map<HTMLElement, number>();
	snapshot.blocks.forEach((nodes, index) => {
		const heading = nodes[0];
		if (heading) sourceIndex.set(heading, index);
	});
	return [...blocks].sort((left, right) =>
		(sourceIndex.get(left.heading) ?? Number.MAX_SAFE_INTEGER)
		- (sourceIndex.get(right.heading) ?? Number.MAX_SAFE_INTEGER)
	);
}

function applySortedOrder(
	holder: HTMLElement,
	current: readonly PublicServerRegionBlock[],
	sorted: readonly PublicServerRegionBlock[]
): void {
	if (current.length !== sorted.length) return;
	if (current.every((block, index) => block.heading === sorted[index]?.heading)) return;
	for (const block of sorted) holder.append(...block.nodes);
}

function updatePingLabel(
	block: PublicServerRegionBlock,
	latencies: Readonly<Record<string, unknown>>
): void {
	const existing = block.heading.querySelector<HTMLElement>(`.${PUBLIC_SERVER_PING_LABEL_CLASS}`);
	if (!block.regionCode) {
		existing?.remove();
		return;
	}

	const ping = matchmakerRegionLatency(latencies, block.regionCode);
	const label = existing ?? document.createElement('span');
	label.className = PUBLIC_SERVER_PING_LABEL_CLASS;
	const text = formatPublicServerPingLabel(ping);
	if (label.textContent !== text) label.textContent = text;
	label.title = ping === undefined ? 'Ping unavailable' : `${block.label}: ${text}`;
	if (!existing) {
		const quickJoin = block.heading.querySelector('.quickJoin');
		block.heading.insertBefore(label, quickJoin ?? null);
	}
}

function sanitizeLatencies(
	value: unknown,
	regions: readonly string[]
): Record<string, number> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	const raw = value as Readonly<Record<string, unknown>>;
	const result: Record<string, number> = {};
	for (const region of regions) {
		const ping = matchmakerRegionLatency(raw, region);
		if (ping !== undefined) result[region] = ping;
	}
	return result;
}

let enabled = false;
let observer: MutationObserver | undefined;
let reconcileScheduled = false;
let measureRegions: MeasurePublicServerRegionLatency | undefined;
let measurementInFlight: Promise<void> | undefined;
let measurementGeneration = 0;
let lastMeasurementKey = '';
let lastMeasuredAt = 0;
let currentLatencies: Record<string, number> = {};
const originalOrders = new Map<HTMLElement, OriginalPublicServerOrder>();

function scheduleReconcile(): void {
	if (!enabled || reconcileScheduled) return;
	reconcileScheduled = true;
	queueMicrotask(() => {
		reconcileScheduled = false;
		if (enabled) reconcile();
	});
}

function maybeMeasure(regions: readonly string[]): void {
	if (!measureRegions || measurementInFlight || regions.length === 0) return;
	const normalized = [...new Set(regions)].sort();
	const key = normalized.join(',');
	const now = Date.now();
	if (key === lastMeasurementKey && now - lastMeasuredAt < PUBLIC_SERVER_PING_REFRESH_MS) return;

	lastMeasurementKey = key;
	lastMeasuredAt = now;
	const generation = ++measurementGeneration;
	const measurement = Promise.resolve(measureRegions(normalized))
		.then(value => {
			if (!enabled || generation !== measurementGeneration) return;
			currentLatencies = sanitizeLatencies(value, normalized);
			scheduleReconcile();
		})
		.catch(() => {
			if (!enabled || generation !== measurementGeneration) return;
			currentLatencies = {};
			scheduleReconcile();
		})
		.finally(() => {
			if (measurementInFlight !== measurement) return;
			measurementInFlight = undefined;

			if (enabled) scheduleReconcile();
		});
	measurementInFlight = measurement;
}

function reconcileHolder(holder: HTMLElement): void {
	const currentBlocks = collectPublicServerRegionBlocks(holder);
	if (currentBlocks.length === 0) return;
	if (!headingsMatchSnapshot(currentBlocks, originalOrders.get(holder))) {
		rememberOriginalOrder(holder, currentBlocks);
	}
	const snapshot = originalOrders.get(holder);
	const sourceBlocks = snapshot
		? restoreBlockSourceOrder(currentBlocks, snapshot)
		: currentBlocks;

	for (const block of sourceBlocks) updatePingLabel(block, currentLatencies);
	const sorted = sortPublicServerRegionBlocks(sourceBlocks, currentLatencies);
	applySortedOrder(holder, currentBlocks, sorted);
	maybeMeasure(sourceBlocks.flatMap(block => block.regionCode ? [block.regionCode] : []));
}

function reconcile(): void {
	if (!enabled || typeof document === 'undefined') return;
	ensureStylesheet();
	for (const holder of originalOrders.keys()) {
		if (!holder.isConnected) originalOrders.delete(holder);
	}
	for (const holder of document.querySelectorAll<HTMLElement>(PUBLIC_SERVER_SURFACE_SELECTOR)) {
		reconcileHolder(holder);
	}
}

function restoreOriginalOrders(): void {
	for (const [holder, snapshot] of originalOrders) {
		if (!holder.isConnected) continue;
		for (const block of snapshot.blocks) {
			for (const node of block) {
				if (node.parentElement === holder) holder.append(node);
			}
		}
	}
	originalOrders.clear();
}

function stopRuntime(): void {
	enabled = false;
	measurementGeneration += 1;
	observer?.disconnect();
	observer = undefined;
	reconcileScheduled = false;
	restoreOriginalOrders();
	if (typeof document !== 'undefined') {
		for (const label of document.querySelectorAll(`.${PUBLIC_SERVER_PING_LABEL_CLASS}`)) label.remove();
		document.getElementById(PUBLIC_SERVER_PING_STYLE_ID)?.remove();
	}
	currentLatencies = {};
	lastMeasurementKey = '';
	lastMeasuredAt = 0;
}

export function applyPublicServerPingSortSettings(
	preferences: Readonly<Partial<UserPrefs>> | undefined,
	measure?: MeasurePublicServerRegionLatency
): void {
	if (measure) measureRegions = measure;
	if (preferences?.[PUBLIC_SERVER_PING_SORT_PREFERENCE_KEY] !== true) {
		stopRuntime();
		return;
	}
	if (typeof document === 'undefined') return;
	enabled = true;
	ensureStylesheet();
	if (!observer && typeof MutationObserver === 'function' && document.documentElement) {
		observer = new MutationObserver(records => {
			if (mutationRecordsTouchSelector(records, PUBLIC_SERVER_SURFACE_SELECTOR)) scheduleReconcile();
		});
		observer.observe(document.documentElement, { childList: true, subtree: true });
	}
	reconcile();
}

export function stopPublicServerPingSort(): void {
	stopRuntime();
	measureRegions = undefined;
}
