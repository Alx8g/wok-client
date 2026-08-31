import assert from 'node:assert/strict';
import test from 'node:test';
import { installRawPointerLock } from '../src/raw-pointer-lock.ts';
interface PointerLockCall {
	optionsProvided: boolean;
	options: PointerLockOptions | undefined;
	thisValue: TestPointerLockTarget;
}
interface TestPointerLockTarget {
	calls: PointerLockCall[];
	results: unknown[];
	requestPointerLock: (this: TestPointerLockTarget, options?: PointerLockOptions) => unknown;
}
function createTarget(...results: unknown[]): TestPointerLockTarget {
	return {
		calls: [],
		results: [...results],
		requestPointerLock(this: TestPointerLockTarget, ...requestArguments: [options?: PointerLockOptions]) {
			const options = requestArguments[0];
			this.calls.push({
				options,
				optionsProvided: requestArguments.length > 0,
				thisValue: this
			});
			return this.results.shift();
		}
	};
}
test('requests unadjusted movement without mutating caller options', async () => {
	const target = createTarget(Promise.resolve());
	const options = Object.freeze({ unadjustedMovement: false });
	installRawPointerLock(target);
	await target.requestPointerLock(options);
	assert.equal(target.calls.length, 1);
	assert.equal(target.calls[0].thisValue, target);
	assert.deepEqual(target.calls[0].options, { unadjustedMovement: true });
	assert.equal(options.unadjustedMovement, false);
});
test('adds raw movement to a no-options request', async () => {
	const target = createTarget(Promise.resolve());
	installRawPointerLock(target);
	await target.requestPointerLock();
	assert.deepEqual(
		target.calls.map((call) => call.options),
		[{ unadjustedMovement: true }]
	);
});
test('falls back once to the caller original request on NotSupportedError', async () => {
	const unsupported = Object.assign(new Error('raw input unavailable'), { name: 'NotSupportedError' });
	const target = createTarget(Promise.reject(unsupported), Promise.resolve());
	installRawPointerLock(target);
	await target.requestPointerLock({ unadjustedMovement: false });
	assert.equal(target.calls.length, 2);
	assert.deepEqual(target.calls[0].options, { unadjustedMovement: true });
	assert.deepEqual(target.calls[1].options, { unadjustedMovement: false });
	assert.equal(target.calls[1].optionsProvided, true);
});
test('preserves a no-argument call shape during fallback', async () => {
	const unsupported = Object.assign(new Error('raw input unavailable'), { name: 'NotSupportedError' });
	const target = createTarget(Promise.reject(unsupported), Promise.resolve());
	installRawPointerLock(target);
	await target.requestPointerLock();
	assert.equal(target.calls.length, 2);
	assert.equal(target.calls[0].optionsProvided, true);
	assert.deepEqual(target.calls[0].options, { unadjustedMovement: true });
	assert.equal(target.calls[1].optionsProvided, false);
	assert.equal(target.calls[1].options, undefined);
});
test('does not hide non-support errors', async () => {
	const denied = Object.assign(new Error('activation required'), { name: 'NotAllowedError' });
	const target = createTarget(Promise.reject(denied));
	installRawPointerLock(target);
	await assert.rejects(Promise.resolve(target.requestPointerLock()), denied);
	assert.equal(target.calls.length, 1);
});
test('never double-calls a legacy non-Promise implementation', () => {
	const target = createTarget(undefined);
	installRawPointerLock(target);
	const result = target.requestPointerLock();
	assert.equal(result, undefined);
	assert.equal(target.calls.length, 1);
	assert.deepEqual(target.calls[0].options, { unadjustedMovement: true });
});
test('can be disabled without changing request options', () => {
	const target = createTarget(undefined);
	const controller = installRawPointerLock(target, false);
	target.requestPointerLock();
	target.requestPointerLock({ unadjustedMovement: false });
	assert.equal(target.calls[0].optionsProvided, false);
	assert.equal(target.calls[1].optionsProvided, true);
	assert.deepEqual(target.calls[1].options, { unadjustedMovement: false });
	controller.setEnabled(true);
	target.requestPointerLock();
	assert.deepEqual(target.calls[2].options, { unadjustedMovement: true });
});
test('leaves an already-raw request and its failure semantics untouched', async () => {
	const unsupported = Object.assign(new Error('raw input unavailable'), { name: 'NotSupportedError' });
	const target = createTarget(Promise.reject(unsupported));
	installRawPointerLock(target);
	await assert.rejects(Promise.resolve(target.requestPointerLock({ unadjustedMovement: true })), unsupported);
	assert.equal(target.calls.length, 1);
	assert.deepEqual(target.calls[0].options, { unadjustedMovement: true });
});
test('does not recursively wrap and uninstall restores the original method', () => {
	const target = createTarget(undefined);
	const original = target.requestPointerLock;
	const first = installRawPointerLock(target);
	const wrapped = target.requestPointerLock;
	const second = installRawPointerLock(target);
	assert.equal(target.requestPointerLock, wrapped);
	target.requestPointerLock();
	assert.equal(target.calls.length, 1);
	second.uninstall();
	assert.equal(target.requestPointerLock, wrapped);
	first.uninstall();
	assert.equal(target.requestPointerLock, original);
});
