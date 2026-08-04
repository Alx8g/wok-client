export interface InstallerArtSize {
	readonly width: number;
	readonly height: number;
}

/** Absolute path of the directory holding the committed installer bitmaps. */
export declare const INSTALLER_ART_DIR: string;

/** File names the MUI2 branding defines point at. */
export declare const INSTALLER_ART_FILES: {
	readonly header: string;
	readonly side: string;
};

/** Dimensions the Modern UI requires for each bitmap. */
export declare const INSTALLER_ART_SIZES: {
	readonly header: InstallerArtSize;
	readonly side: InstallerArtSize;
};

/** Renders both bitmaps in memory, keyed by file name. Deterministic. */
export declare function renderInstallerArt(): Map<string, Buffer>;

/** Renders and writes the bitmaps into INSTALLER_ART_DIR, returning their paths. */
export declare function writeInstallerArt(): string[];
