// Adapter: the failures a checkpoint read can produce.
//
// Every one of them halts the run. A checkpoint that cannot be trusted is never
// partially applied, and a lock held by another process is never forced: the
// operator gets a message they can act on instead.

/** The inventory/config drift a mismatch error reports. */
interface MismatchCounts {
	readonly added: number;
	readonly removed: number;
	readonly modified: number;
}

/** A checkpoint that exists but cannot be trusted. Halts the run. */
export class CheckpointError extends Error {
	readonly code: string = "CHECKPOINT_INVALID";
	constructor(message: string) {
		super(message);
		this.name = "CheckpointError";
	}
}

/** Another process already owns this checkpoint. */
export class CheckpointLockError extends CheckpointError {
	override readonly code: string = "CHECKPOINT_LOCKED";
	constructor(message: string) {
		super(message);
		this.name = "CheckpointLockError";
	}
}

/**
 * A record the run cannot trust: a malformed field, an unknown record type, or
 * a header from another schema version. Replaying it would turn a partial audit
 * into a completed one, so it halts the run instead.
 */
export class CheckpointSchemaError extends CheckpointError {
	override readonly code: string = "CHECKPOINT_SCHEMA";
	readonly where: string;

	constructor(where: string, why: string) {
		super(`invalid checkpoint record at ${where}: ${why}`);
		this.name = "CheckpointSchemaError";
		this.where = where;
	}
}

/** The checkpoint describes a different audit than the one about to run. */
export class CheckpointMismatchError extends CheckpointError {
	override readonly code: string = "CHECKPOINT_MISMATCH";
	readonly kind: "inventory" | "config";
	readonly added: number;
	readonly removed: number;
	readonly modified: number;

	constructor(kind: "inventory" | "config", counts: MismatchCounts) {
		const detail =
			kind === "inventory"
				? `inventory changed: added ${counts.added}, removed ${counts.removed}, modified ${counts.modified}`
				: "model configuration or criteria changed";
		super(
			`checkpoint does not describe this run (${detail}); rerun with --restart to archive it and judge every test again`,
		);
		this.name = "CheckpointMismatchError";
		this.kind = kind;
		this.added = counts.added;
		this.removed = counts.removed;
		this.modified = counts.modified;
	}
}
