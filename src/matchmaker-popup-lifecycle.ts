export type MatchmakerPopupState = 'closed' | 'error' | 'game' | 'no-games' | 'searching';

type ActiveMatchmakerPopupState = Exclude<MatchmakerPopupState, 'closed'>;

export interface MatchmakerPopupDismissal {
	abortSearch: boolean;
	dismissed: boolean;
	joinGame: boolean;
	openServerWindow: boolean;
	playSelect: boolean;
}

const NO_DISMISSAL: MatchmakerPopupDismissal = {
	abortSearch: false,
	dismissed: false,
	joinGame: false,
	openServerWindow: false,
	playSelect: false
};

export class MatchmakerPopupLifecycle {
	private state: MatchmakerPopupState = 'closed';

	public show(state: ActiveMatchmakerPopupState): void {
		this.state = state;
	}

	public decide(accept: boolean, openServerWindow: boolean): MatchmakerPopupDismissal {
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

	private takeState(): MatchmakerPopupState {
		const state = this.state;
		this.state = 'closed';
		return state;
	}
}
