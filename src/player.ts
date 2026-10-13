/** What every platform backend provides. */

export type PlayerState = "closed" | "stopped" | "playing" | "paused";

export interface Track {
  /** Stable id, used as cache key. */
  id: string;
  name: string;
  artist: string;
  album: string;
  /** Seconds. Missing for radio streams or when the player doesn't report it. */
  duration?: number;
}

export interface Snapshot {
  state: PlayerState;
  /** Seconds into the current track, if known. */
  position?: number;
  track?: Track;
}

export interface Player {
  /** Shown in the log, e.g. "Music" or "Apple Music (Windows)". */
  readonly name: string;
  snapshot(): Promise<Snapshot>;
  /** Writes the current track's artwork to `outPath`. False if there is none. */
  exportArtwork(outPath: string): Promise<boolean>;
  /** Adds a hint to errors the user can fix, like missing permissions. */
  explain(message: string): string;
  close(): void;
}
