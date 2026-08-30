export type MatchmakerPopupState = 'cancelled' | 'closed' | 'error' | 'game' | 'no-games' | 'searching';

type ActiveMatchmakerPopupState = Exclude<MatchmakerPopupState, 'closed'>;

export interface MatchmakerPopupDismissal {
	abortSearch: boolean;
	dismissed: boolean;
	joinGame: boolean;
	openServerWindow: boolean;
	playSelect: boolean;
}

/** Return whether a pointerdown target is outside the popup, including a missing target. */
export function matchmakerPointerDownIsOutside(
	popup: { contains(target: Node | null): boolean },
	target: Node | null
): boolean {
	return !popup.contains(target);
}

const NO_DISMISSAL: MatchmakerPopupDismissal = {
	abortSearch: false,
	dismissed: false,
	joinGame: false,
	openServerWindow: false,
	playSelect: false
};

export class MatchmakerPopupLifecycle {
	private session = 0;
	private state: MatchmakerPopupState = 'closed';

	/** Opens a new popup session. Input begun on an older rendered view cannot act on this one. */
	public show(state: ActiveMatchmakerPopupState): number {
		this.session++;
		this.state = state;
		return this.session;
	}

	public isCurrent(session: number): boolean {
		return this.state !== 'closed' && session === this.session;
	}

	public decide(
		session: number,
		accept: boolean,
		openServerWindow: boolean
	): MatchmakerPopupDismissal {
		if (!this.isCurrent(session)) return NO_DISMISSAL;
		if (accept && this.state === 'searching') return NO_DISMISSAL;

		const state = this.takeState();
		if (state === 'closed') return NO_DISMISSAL;

		return {
			abortSearch: state === 'searching',
			dismissed: true,
			joinGame: accept && state === 'game',
			openServerWindow: (state === 'error' || state === 'no-games') && openServerWindow,
			playSelect: true
		};
	}

	public replace(): MatchmakerPopupDismissal {
		const state = this.takeState();
		if (state === 'closed') return NO_DISMISSAL;

		return {
			abortSearch: false,
			dismissed: true,
			joinGame: false,
			openServerWindow: false,
			playSelect: false
		};
	}

	/** Close without user feedback; repeated teardown calls have no effect. */
	public teardown(): MatchmakerPopupDismissal {
		const state = this.takeState();
		if (state === 'closed') return NO_DISMISSAL;

		return {
			abortSearch: state === 'searching',
			dismissed: true,
			joinGame: false,
			openServerWindow: false,
			playSelect: false
		};
	}

	private takeState(): MatchmakerPopupState {
		const state = this.state;
		this.state = 'closed';
		return state;
	}
}
