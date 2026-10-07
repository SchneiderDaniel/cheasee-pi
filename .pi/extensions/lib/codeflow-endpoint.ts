/**
 * CodeFlow service endpoint — compose-internal address of the codeflow shim.
 *
 * The pi agent runs in its own container and reaches the CodeFlow sidecar over
 * the compose default network by service DNS name, NOT through the host's
 * published loopback port. This is why the host-port derivation in
 * `context-info/codeflow.ts` (`codeflowHostPort`) is deliberately NOT reused:
 * it resolves the HOST-side published port, which is unreachable and wrong
 * from inside the pi container.
 *
 * Port 8470 is the fixed container port from
 * `cmd/cheasee-pi/embedded/docker/codeflow/config.json`; it is the same on
 * every host because the host only maps a derived port TO it.
 */

/** Compose service DNS name of the codeflow container (default network). */
const CODEFLOW_SERVICE_HOST = "codeflow";
/** In-container listen port from codeflow/config.json. */
export const CODEFLOW_SERVICE_PORT = 8470;

// Hostnames and IPv4 literals: letters, digits, dot, hyphen, underscore.
// Anything else (scheme, path, port, whitespace, control chars) is rejected —
// the value is interpolated into a URL verbatim, so a malformed host could
// redirect the request or inject a control character.
const HOST_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Build the compose-internal CodeFlow base URL from CODEFLOW_SERVICE_HOST
 * (default `codeflow`) and the fixed container port. Throws on any host that
 * is not a bare hostname/IPv4 literal.
 */
export function codeflowServiceUrl(
	rawHost: string | undefined = process.env.CODEFLOW_SERVICE_HOST,
): string {
	let host = (rawHost ?? CODEFLOW_SERVICE_HOST).trim().replace(/\/+$/, "");
	if (host === "") {
		throw new Error(
			"CodeFlow service host is empty — set CODEFLOW_SERVICE_HOST to a hostname or IP.",
		);
	}
	if (!HOST_PATTERN.test(host)) {
		throw new Error(
			`Invalid CodeFlow service host ${JSON.stringify(rawHost)} — expected a bare hostname or IP (no scheme, path, port, or whitespace).`,
		);
	}
	return `http://${host}:${CODEFLOW_SERVICE_PORT}`;
}
