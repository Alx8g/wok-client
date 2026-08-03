const SPLASH_FLAVORS = [
	"He's Doing It Sideways!",
	'Get That Nuke!',
	'Pretty Slick, NGL.',
	'Slidehopping Into Your DMs.',
	'Farming Wallbangs.',
	'Spawning Players...',
	'Finding a Lobby...',
	'Setting Slide Control To 5...',
	'Writing New Shaders...',
	'Lobbyhopping!',
	'BOOM HEADSHOT!',
	'Everyone Runs Faster With a Knife!',
	'Visit client.wok.social!',
	'Use the Custom Matchmaker!',
	'Fragging Out!',
	'Posture Check.',
	'Remember to Drink Water!',
	'ALL SYSTEMS NOMINAL.',
	'Open Source!',
	'Did You See That?'
] as const;

export function selectSplashFlavor(
	random: () => number = Math.random
): string {
	const index = Math.floor(random() * SPLASH_FLAVORS.length);
	return SPLASH_FLAVORS[
		Math.max(0, Math.min(SPLASH_FLAVORS.length - 1, index))
	];
}
