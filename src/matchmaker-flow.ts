import { MATCHMAKER_REGIONS } from './matchmaker-data.ts';
const KNOWN_MATCHMAKER_REGIONS = new Set<string>(MATCHMAKER_REGIONS);
export function matchmakerCandidateRegions(candidates: readonly IMatchmakerGame[]): string[] {
	return [...new Set(candidates.map((candidate) => candidate.region).filter((region) => KNOWN_MATCHMAKER_REGIONS.has(region)))];
}
function matchmakerAbortError(): DOMException {
	return new DOMException('Matchmaker request was aborted.', 'AbortError');
}
export function waitForMatchmakerOperation<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
	if (signal.aborted) return Promise.reject(matchmakerAbortError());
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const settle = (callback: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener('abort', onAbort);
			callback();
		};
		const onAbort = () => settle(() => reject(matchmakerAbortError()));
		signal.addEventListener('abort', onAbort, { once: true });
		Promise.resolve()
			.then(operation)
			.then(
				(value) => settle(() => resolve(value)),
				(error) => settle(() => reject(error))
			);
	});
}
