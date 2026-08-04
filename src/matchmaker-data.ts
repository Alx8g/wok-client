export const MATCHMAKER_GAMEMODES = ['Free for All', 'Team Deathmatch', 'Hardpoint', 'Capture the Flag', 'Parkour', 'Hide & Seek', 'Infected', 'Race', 'Last Man Standing', 'Simon Says', 'Gun Game', 'Prop Hunt', 'Boss Hunt', 'Classic FFA', 'Deposit', 'Stalker', 'King of the Hill', 'One in the Chamber', 'Trade', 'Kill Confirmed', 'Defuse', 'Sharp Shooter', 'Traitor', 'Raid', 'Blitz', 'Domination', 'Squad Deathmatch', 'Kranked FFA', 'Team Defender', 'Deposit FFA', 'Chaos Snipers', 'Bighead FFA'];
export const MATCHMAKER_REGIONS = ['MBI', 'NY', 'FRA', 'SIN', 'DAL', 'SYD', 'MIA', 'BHN', 'TOK', 'BRZ', 'AFR', 'LON', 'CHI', 'SV', 'STL', 'MX'];
export const MATCHMAKER_REGION_NAMES = { MBI: 'Mumbai', NY: 'New York', FRA: 'Frankfurt', SIN: 'Singapore', DAL: 'Dallas', SYD: 'Sydney', MIA: 'Miami', BHN: 'Middle East', TOK: 'Tokyo', BRZ: 'Brazil', AFR: 'South Africa', LON: 'London', CHI: 'China', SV: 'Silicon Valley', STL: 'Seattle', MX: 'Mexico', SSS: 'Super Secret Servers' };

// Reviewed against the Krunker Wiki official-rotation table on 2026-08-03.
export const MATCHMAKER_OFFICIAL_MAPS = [
	'Burg',
	'Littletown',
	'Sandstorm',
	'Subzero',
	'Undergrowth',
	'Freight',
	'Lostworld',
	'Citadel',
	'Oasis',
	'Kanji',
	'Industry',
	'Evacuation',
	'Site',
	'SkyTemple',
	'Lagoon',
	'Tortuga',
	'Lumber',
	'Tropicano',
	'Habitat',
	'Atomic',
	'Clockwork',
	'HQ',
	'Erupt'
];
export const MATCHMAKER_MAP_SCOPES: MatchmakerMapScope[] = ['official', 'selected', 'all'];
export const MATCHMAKER_MAP_ICON_INDICES = ['Burg', 'Littletown', 'Sandstorm', 'Subzero', 'Undergrowth', 'Shipment', 'Freight', 'Lostworld', 'Citadel', 'Oasis', 'Kanji', 'Industry', 'Lumber', 'Evacuation', 'Site', 'SkyTemple', 'Lagoon', 'Bureau', 'Tortuga', 'Tropicano', 'Krunk_Plaza', 'Arena', 'Habitat', 'Atomic', 'Old_Burg', 'Throwback', 'Stockade', 'Facility', 'Clockwork', 'Laboratory', 'Shipyard', 'Soul Sanctum', 'Bazaar', 'Erupt', 'HQ', 'Khepri', 'Lush', 'Vivo', 'Slide Moonlight', 'Eterno Sim'];

export function normalizeMatchmakerMapIdentifier(value: string): string {
	return value.normalize('NFKC').toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, '');
}
