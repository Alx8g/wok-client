export interface VerifyPackagedApplicationOptions {
	buildPath: string;
	platform: string;
	repositoryRoot: string;
}

export interface VerifiedPackagedApplication {
	asarPath: string;
	assetCount: number;
	bundleOutputCount: number;
	entryCount: number;
}

export function verifyPackagedApplication(
	options: VerifyPackagedApplicationOptions
): VerifiedPackagedApplication;
