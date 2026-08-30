import assert from 'node:assert/strict';
import test from 'node:test';
import {
	GAMEPLAY_BRANDING_CSS,
	GAMEPLAY_BRANDING_ID,
	GAMEPLAY_BRANDING_STYLE_ID,
	mountGameplayBranding
} from '../src/gameplay-branding.ts';

class FakeElement {
	public className = '';
	public readonly children: FakeElement[] = [];
	public id = '';
	public textContent: string | null = null;

	public append(...nodes: FakeElement[]): void {
		this.children.push(...nodes);
	}

	public insertBefore(node: FakeElement, child: FakeElement | null): void {
		if (child === null) {
			this.children.push(node);
			return;
		}
		const index = this.children.indexOf(child);
		if (index < 0) this.children.push(node);
		else this.children.splice(index, 0, node);
	}
}

class FakeDocument {
	public readonly body = new FakeElement();
	public readonly documentElement = new FakeElement();
	public readonly head = new FakeElement();

	public createElement(): FakeElement {
		return new FakeElement();
	}

	public getElementById(id: string): FakeElement | null {
		const visit = (element: FakeElement): FakeElement | null => {
			if (element.id === id) return element;
			for (const child of element.children) {
				const match = visit(child);
				if (match) return match;
			}
			return null;
		};
		return visit(this.head) ?? visit(this.body) ?? visit(this.documentElement);
	}
}

function createHudDocument(): { document: FakeDocument; holder: FakeElement; matchInfo: FakeElement; timer: FakeElement } {
	const document = new FakeDocument();
	const holder = new FakeElement();
	holder.id = 'topLeftMatchData';
	const timer = new FakeElement();
	timer.id = 'timerHolder';
	const matchInfo = new FakeElement();
	matchInfo.id = 'matchInfo';
	holder.append(timer, matchInfo);
	document.body.append(holder);
	return { document, holder, matchInfo, timer };
}

test('mounts WOK.SOCIAL between the timer and match details exactly once', () => {
	const fixture = createHudDocument();

	assert.equal(mountGameplayBranding(fixture.document as unknown as Document), true);
	const branding = fixture.document.getElementById(GAMEPLAY_BRANDING_ID);
	assert.ok(branding);
	assert.deepEqual(fixture.holder.children, [fixture.timer, branding, fixture.matchInfo]);
	assert.equal(branding.children.length, 1);
	assert.equal(branding.children[0].textContent, 'WOK.SOCIAL');
	assert.equal(branding.children[0].className, 'wok-gameplay-brand-url');
	assert.equal(fixture.document.getElementById(GAMEPLAY_BRANDING_STYLE_ID)?.textContent, GAMEPLAY_BRANDING_CSS);

	assert.equal(mountGameplayBranding(fixture.document as unknown as Document), true);
	assert.equal(fixture.holder.children.filter(child => child.id === GAMEPLAY_BRANDING_ID).length, 1);
	assert.equal(fixture.document.head.children.filter(child => child.id === GAMEPLAY_BRANDING_STYLE_ID).length, 1);
});

test('waits until Krunker creates the top-left HUD shell', () => {
	const document = new FakeDocument();
	assert.equal(mountGameplayBranding(document as unknown as Document), false);
	assert.equal(document.getElementById(GAMEPLAY_BRANDING_ID), null);
	assert.equal(document.getElementById(GAMEPLAY_BRANDING_STYLE_ID), null);
});

test('branding is static, click-through, and free of per-frame animation', () => {
	assert.match(GAMEPLAY_BRANDING_CSS, /pointer-events:\s*none/u);
	assert.match(GAMEPLAY_BRANDING_CSS, /contain:\s*layout style paint/u);
	assert.doesNotMatch(GAMEPLAY_BRANDING_CSS, /animation|transition/u);
});
