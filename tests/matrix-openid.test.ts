import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeMatrixOpenIdVerifier } from '../src/auth/matrix-openid.js';

describe('the Matrix OpenID verifier', () => {
	let server: Server;
	let status = 200;
	let federationUrl: URL;

	beforeAll(async () => {
		server = createServer((_request, response) => {
			response.writeHead(status, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ sub: '@carol:test.local' }));
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		federationUrl = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
	});
	afterAll(async () => {
		await new Promise((resolve) => server.close(resolve));
	});

	function verifier(url = federationUrl) {
		return makeMatrixOpenIdVerifier({
			federationUrl: url,
			serverName: 'test.local',
			timeoutMs: 1_000
		});
	}

	it('names the user the homeserver vouches for', async () => {
		status = 200;
		expect(await verifier()('Bearer t', 'test.local')).toEqual({
			ok: true,
			userId: '@carol:test.local'
		});
	});

	it('tells a refused token from a homeserver that fails or does not answer', async () => {
		status = 401;
		expect(await verifier()('Bearer t', 'test.local')).toEqual({ ok: false, reason: 'invalid' });
		status = 500;
		expect(await verifier()('Bearer t', 'test.local')).toEqual({
			ok: false,
			reason: 'unavailable',
			status: 500
		});
		expect(await verifier(new URL('http://127.0.0.1:1'))('Bearer t', 'test.local')).toEqual({
			ok: false,
			reason: 'unavailable'
		});
	});
});
