export type MatrixOpenIdResult =
	| { readonly ok: true; readonly userId: string }
	| { readonly ok: false; readonly reason: 'missing' | 'invalid' }
	// status: what the homeserver answered, absent when it did not answer at all
	| { readonly ok: false; readonly reason: 'unavailable'; readonly status?: number };

// Checks the Matrix OpenID token a client sends with the name of the homeserver that issued it
export type MatrixOpenIdVerifier = (
	authorization: string | undefined,
	serverName: string
) => Promise<MatrixOpenIdResult>;

export interface MatrixOpenIdOptions {
	// The homeserver as it serves its federation API, where /openid/userinfo lives
	readonly federationUrl: URL;
	readonly serverName: string;
	readonly timeoutMs: number;
}

const BEARER_PREFIX = /^Bearer\s+(\S+)$/i;

// A token is checked by the homeserver of the assistants only: one another homeserver issued
// names nobody this harness serves
export function makeMatrixOpenIdVerifier(options: MatrixOpenIdOptions): MatrixOpenIdVerifier {
	const userinfo = new URL(
		'_matrix/federation/v1/openid/userinfo',
		withSlash(options.federationUrl)
	);
	return async (authorization, serverName) => {
		const match = authorization === undefined ? null : BEARER_PREFIX.exec(authorization);
		if (match === null || match[1] === undefined) return { ok: false, reason: 'missing' };
		if (serverName !== options.serverName) return { ok: false, reason: 'invalid' };
		const url = new URL(userinfo);
		url.searchParams.set('access_token', match[1]);
		let res: Response;
		try {
			res = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs) });
		} catch {
			return { ok: false, reason: 'unavailable' };
		}
		// Synapse answers 401 M_UNKNOWN_TOKEN for a token it does not know or that expired
		if (!res.ok) {
			// An unread body holds its connection until it is collected
			await res.body?.cancel();
			return res.status === 401 || res.status === 403
				? { ok: false, reason: 'invalid' }
				: { ok: false, reason: 'unavailable', status: res.status };
		}
		const body = (await res.json().catch(() => null)) as { sub?: unknown } | null;
		const sub = body?.sub;
		if (typeof sub !== 'string' || !sub.endsWith(`:${options.serverName}`)) {
			return { ok: false, reason: 'invalid' };
		}
		return { ok: true, userId: sub };
	};
}

function withSlash(url: URL): string {
	return url.href.endsWith('/') ? url.href : `${url.href}/`;
}
