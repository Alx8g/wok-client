export type MatchmakerPopupState = 'closed' | 'error' | 'game' | 'no-games';

type ActiveMatchmakerPopupState = Exclude<MatchmakerPopupState, 'closed'>;

export interface MatchmakerPopupDismissal {
	dismissed: boolean;
	joinGame: boolean;
	openServerWindow: boolean;
	playSelect: boolean;
}

const NO_DISMISSAL: MatchmakerPopupDismissal = {
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
		const state = this.takeState();
		if (state === 'closed') return NO_DISMISSAL;

		return {
			dismissed: true,
			joinGame: accept && state === 'game',
			openServerWindow: state !== 'game' && openServerWindow,
			playSelect: true
		};
	}

	public replace(): MatchmakerPopupDismissal {
		const state = this.takeState();
		if (state === 'closed') return NO_DISMISSAL;

		return {
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
