export type SettingsRefreshRequirement = 0 | 1 | 2;
export class SettingsRefreshTracker {
	private readonly requirements = new Map<string, SettingsRefreshRequirement>();
	public reset(): void {
		this.requirements.clear();
	}
	public update(key: string, changed: boolean, requirement: SettingsRefreshRequirement): SettingsRefreshRequirement {
		if (!changed || requirement === 0) this.requirements.delete(key);
		else this.requirements.set(key, requirement);
		return this.current();
	}
	public current(): SettingsRefreshRequirement {
		let requirement: SettingsRefreshRequirement = 0;
		for (const value of this.requirements.values()) {
			if (value > requirement) requirement = value;
			if (requirement === 2) break;
		}
		return requirement;
	}
}
