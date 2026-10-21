import { describe, expect, it } from 'vitest';

import { LlmError, makeLlmClient, type LlmClient } from '../src/llm/client.js';

// A client of a gateway that answers as the test says, with the time its calls have to answer in
function clientOf(fetchImpl: typeof fetch, timeoutMs = 1_000): LlmClient {
	return makeLlmClient({
		baseUrl: new URL('http://gateway.test/'),
		consumerKey: 'key',
		model: 'a-model',
		maxTokens: 16,
		timeoutMs,
		fetchImpl
	});
}

const ask = (client: LlmClient): ReturnType<LlmClient['complete']> =>
	client.complete([{ role: 'user', content: 'Hello' }], []);

describe('the client of a model', () => {
	it('reads what the model answered', async () => {
		const client = clientOf(async () =>
			Response.json({ choices: [{ message: { content: 'Hi there' }, finish_reason: 'stop' }] })
		);
		expect((await ask(client)).content).toBe('Hi there');
	});

	// A gateway, or a proxy in front of it, may answer a page for people where the model's JSON was
	// due: that is a model that failed, which callers go on without, and not a bug that fails them
	it('fails as a model that failed when what it answered is not JSON', async () => {
		const client = clientOf(
			async () =>
				new Response('<html><body>502 Bad Gateway</body></html>', {
					status: 200,
					headers: { 'content-type': 'text/html' }
				})
		);
		await expect(ask(client)).rejects.toBeInstanceOf(LlmError);
	});

	// The call has its time limit until its answer is read: a model that sends its headers and then
	// stalls is one that did not answer in time
	it('fails as a model that failed when its answer stops coming once it began', async () => {
		const client = clientOf(
			async (_input, init) =>
				new Response(
					new ReadableStream({
						start(controller) {
							// As fetch does when the signal of the call fires while the body is read
							init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
						}
					}),
					{ status: 200 }
				),
			50
		);
		await expect(ask(client)).rejects.toBeInstanceOf(LlmError);
	});
});
