import assert from 'node:assert/strict';
import test from 'node:test';
import { renameClientSettingsTabs, SETTINGS_TAB_SELECTOR } from '../src/settings-tab-label.ts';

class FakeTab {
	public textContent: string | null;

	public constructor(textContent: string | null) {
		this.textContent = textContent;
	}
}

test('renames Client to WOK when Settings first opens', () => {
	const tabs = [new FakeTab('General'), new FakeTab(' Client '), new FakeTab('Sound')];
	let selector = '';

	const renamed = renameClientSettingsTabs({
		querySelectorAll(value: string) {
			selector = value;
			return tabs;
		}
	});

	assert.equal(selector, SETTINGS_TAB_SELECTOR);
	assert.equal(renamed, 1);
	assert.deepEqual(tabs.map(tab => tab.textContent), ['General', 'WOK', 'Sound']);
});

test('leaves an already renamed tab and unrelated labels unchanged', () => {
	const tabs = [new FakeTab('WOK'), new FakeTab('Client Settings'), new FakeTab(null)];

	assert.equal(renameClientSettingsTabs({ querySelectorAll: () => tabs }), 0);
	assert.deepEqual(tabs.map(tab => tab.textContent), ['WOK', 'Client Settings', null]);
});
