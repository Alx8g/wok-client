type PointerLockRequest<TThis> = (
	this: TThis,
	options?: PointerLockOptions
) => unknown;

interface PointerLockPrototype<TThis> {
	requestPointerLock?: PointerLockRequest<TThis>;
}

export interface RawPointerLockController {
	setEnabled: (enabled: boolean) => void;
	uninstall: () => void;
}

const RAW_POINTER_LOCK_WRAPPER = Symbol('wok.raw-pointer-lock-wrapper');

type MarkedPointerLockRequest<TThis> = PointerLockRequest<TThis> & {
	[RAW_POINTER_LOCK_WRAPPER]?: true;
};

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		(typeof value === 'object' && value !== null) || typeof value === 'function'
	) && typeof (value as PromiseLike<unknown>).then === 'function';
}

function isNotSupportedError(error: unknown): boolean {
	return typeof error === 'object'
		&& error !== null
		&& 'name' in error
		&& error.name === 'NotSupportedError';
}

/**
 * Upgrade Pointer Lock requests to Chromium's unadjusted/raw movement path.
 *
 * On Windows, adjusted Pointer Lock movement can leak Chromium's synthetic cursor-recentering
 * delta into movementX/Y, especially with high-polling mice. The raw path avoids that cursor path
 * as well as OS acceleration. If the platform rejects raw movement, retry the caller's original
 * request exactly once. Legacy implementations that return no Promise are never called twice:
 * there is no trustworthy failure signal on which to base a fallback.
 */
export function installRawPointerLock<TThis>(
	target: PointerLockPrototype<TThis>,
	initiallyEnabled = true
): RawPointerLockController {
	const original = target.requestPointerLock as MarkedPointerLockRequest<TThis> | undefined;
	if (typeof original !== 'function' || original[RAW_POINTER_LOCK_WRAPPER]) {
		return {
			setEnabled: () => {},
			uninstall: () => {}
		};
	}

	let enabled = initiallyEnabled;
	const wrapped: MarkedPointerLockRequest<TThis> = function (
		this: TThis,
		...originalArguments: [options?: PointerLockOptions]
	) {
		const options = originalArguments[0];

		if (!enabled || options?.unadjustedMovement === true) {
			return Reflect.apply(original, this, originalArguments);
		}

		const rawOptions: PointerLockOptions = {
			...options,
			unadjustedMovement: true
		};
		const result = Reflect.apply(original, this, [rawOptions]);
		if (!isPromiseLike(result)) return result;

		return Promise.resolve(result).catch(error => {
			if (!isNotSupportedError(error)) throw error;
			return Reflect.apply(original, this, originalArguments);
		});
	};
	Object.defineProperty(wrapped, RAW_POINTER_LOCK_WRAPPER, { value: true });
	target.requestPointerLock = wrapped;

	return {
		setEnabled(value: boolean) {
			enabled = value;
		},
		uninstall() {
			if (target.requestPointerLock === wrapped) target.requestPointerLock = original;
		}
	};
}
