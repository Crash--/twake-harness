import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { BRIEF_DOMAINS } from '../src/briefs/questions.js';
import { runBriefPass } from '../src/briefs/schedule.js';
import { withPrincipal } from '../src/db/client.js';
import { findChoices, listListened, saveListening } from '../src/sources/repository.js';
import { sourceRegistryOf, type Source } from '../src/sources/sources.js';
import { lastUser, until } from './helpers/activity.js';
import {
	BRIEF_CATALOG,
	LIST_EMAILS,
	LIST_EVENTS,
	LIST_MAILBOXES,
	LIST_TASKS,
	MAILBOXES,
	seenEveryDay
} from './helpers/brief.js';
import { makeSettableClock } from './helpers/clock.js';
import {
	call,
	QUESTION_CONTENT_KEY,
	startConsentRoom,
	type ConsentRoom
} from './helpers/consent-room.js';
import { grantConsent } from './helpers/consents.js';
import type { DecryptedMessage } from './helpers/e2ee-client.js';
import type { ChatRequest, ScriptedReply } from './helpers/fake-apisix.js';

const ALICE = 'alice@test.local';
// Where the content of a brief tells Alice's client that it is one, and of which day
const BRIEF_CONTENT_KEY = 'app.twake.assistant.brief';
// What the model writes as the brief
const WRITTEN = 'Ce matin : rien de prévu, ta journée est libre.';

// The source offer of the Chat a brief makes Alice after it, in her language: where her assistant
// would hear the mentions of her, the rooms the listener is in under the name the deployment gives
// it, the ten minutes, and what private read receipts would do
const CHAT_SOURCE_OFFER_FR =
	"Veux-tu que j'écoute Twake Chat ? Je te préviendrais d'une mention de toi que tu laisses non lue dix minutes, dans les salons non chiffrés où se trouve Assistant Twake et dans les conversations que j'écoute. Avec des accusés de lecture privés, je ne verrais pas ce que tu lis, et je te rappellerais chaque mention. Réponds par oui ou non dans ton prochain message.";
const CHAT_SOURCE_OFFER_EN =
	'Shall I listen to Twake Chat? I would let you know of a mention of you that you leave unread for ten minutes, in the unencrypted rooms Assistant Twake is in and in the conversations I listen to. With private read receipts, I would not see what you read, and I would remind you of every mention. Answer yes or no in your next message.';
// What the harness says once Alice had her assistant listen to the Chat, and once she said no to
// one of its questions
const LISTENING_FR =
	"J'écoute Twake Chat : je te préviens d'une mention de toi que tu laisses non lue dix minutes, dans les salons non chiffrés où se trouve Assistant Twake et dans les conversations que j'écoute. Avec des accusés de lecture privés, je ne vois pas ce que tu lis, et je te rappelle chaque mention.";
const LISTENING_EN =
	'I am listening to Twake Chat: I will let you know of a mention of you that you leave unread for ten minutes, in the unencrypted rooms Assistant Twake is in and in the conversations I listen to. With private read receipts, I cannot see what you read, and I will remind you of every mention.';
const REFUSED = "D'accord, je ne le fais pas.";

// What Alice asks her assistant, and the call a literal model makes for it
const ASKS: Readonly<Record<string, { readonly tool: string; readonly args: unknown }>> = {
	'Listen to my chat': { tool: 'listen_to_source', args: { source: 'chat' } }
};

// A literal model: it writes the brief, makes the call Alice's ask needs and says what the call
// answered, and repeats anything else it hears
function offeringModel(request: ChatRequest): ScriptedReply {
	const last = request.messages.at(-1);
	if (last?.role === 'tool') return { content: `Told: ${last.content ?? ''}` };
	const told = lastUser(request);
	if (told.startsWith('[brief]')) return { content: WRITTEN };
	const ask = ASKS[told];
	return ask === undefined ? { content: `echo: ${told}` } : { toolCalls: call(ask.tool, ask.args) };
}

const isBrief = (m: DecryptedMessage): boolean => m.content[BRIEF_CONTENT_KEY] !== undefined;
const isQuestion = (m: DecryptedMessage): boolean => m.content[QUESTION_CONTENT_KEY] !== undefined;

describe('my brief offers me once, after it, to listen to the Chat, where the deployment opened it', () => {
	let r: ConsentRoom;
	// The room of the assistant I have
	let room: string;
	const clock = makeSettableClock('2026-10-12T06:00:00Z');

	// Everything Alice's client received from her assistant in her room, oldest first
	const said = (): DecryptedMessage[] =>
		r.client.messages.filter((m) => m.roomId === room && m.sender === r.assistantId);

	// The first message her assistant sent after the first `seen` that is what is waited for, once
	// it came: a status message of a turn may come before it
	async function nextOf(
		seen: number,
		what: string,
		is: (m: DecryptedMessage) => boolean
	): Promise<DecryptedMessage> {
		await until(what, () => said().slice(seen).some(is));
		const message = said().slice(seen).find(is);
		if (message === undefined) throw new Error(`no ${what}`);
		return message;
	}

	// The brief of a morning, as Alice's client received it from the worker role's pass at that time
	async function briefOf(at: string): Promise<DecryptedMessage> {
		const seen = said().length;
		clock.set(at);
		const app = r.h.apps[0];
		if (app === undefined) throw new Error('no api role');
		await runBriefPass({ config: r.h.config, db: r.h.db, log: app.log, clock });
		const brief = await nextOf(seen, `the brief of ${at}`, isBrief);
		expect(brief.content[BRIEF_CONTENT_KEY]).toEqual({ date: at.slice(0, 10) });
		return brief;
	}

	// What her assistant says after something she did, once it said it
	async function told(act: () => Promise<unknown>, text: string): Promise<void> {
		const seen = said().length;
		await act();
		await nextOf(seen, `« ${text} »`, (m) => m.body === text);
	}

	// What Alice chose for an application, as if she had told her assistant
	const choose = (source: Source, listening: boolean): Promise<void> =>
		withPrincipal(r.h.db, { id: ALICE }, (tx) => saveListening(tx, ALICE, source, listening));

	// What she chose for the Chat: to listen there, to stop it, or nothing yet
	const chosen = async (): Promise<string> =>
		(await withPrincipal(r.h.db, { id: ALICE }, (tx) => findChoices(tx, ALICE))).chat;

	// The applications her assistant listens to
	const listened = (): Promise<string[]> =>
		withPrincipal(r.h.db, { id: ALICE }, (tx) =>
			listListened(tx, ALICE, sourceRegistryOf(r.h.config))
		);

	// What she allowed her assistant to do, as she reads it through the API
	async function allowed(): Promise<string[]> {
		const listed = await r.h.api.get<{ consents: { domain: string; level: string }[] }>(
			ALICE,
			'/v1/consents'
		);
		return listed.body.consents.map((c) => `${c.domain} ${c.level}`).sort();
	}

	// Her open request about the Chat, as if a day and a minute had gone by since it was asked: past
	// its lifetime, the suite's day, though nothing closed it yet
	const pastLifetime = (): Promise<unknown> =>
		withPrincipal(
			r.h.db,
			{ id: ALICE },
			(tx) => tx.sql`update pending_calls set created_at = created_at - interval '1 day 1 minute'
				where owner = ${ALICE} and domain = 'chat' and status = 'open'`
		);

	// Whether the harness logged a line with these fields
	const logged = (fields: Readonly<Record<string, unknown>>): boolean =>
		r.h
			.logLines()
			.some((line) => Object.entries(fields).every(([key, value]) => line[key] === value));

	beforeAll(async () => {
		r = await startConsentRoom(
			{
				ASSISTANT_LOCALE: 'fr',
				ASSISTANT_TIMEZONE: 'Europe/Paris',
				BRIEF_ENABLED: 'true',
				SUGGESTIONS_ENABLED: 'true',
				CHAT_MENTIONS_ENABLED: 'true',
				ADMISSION_USER_PER_MINUTE: '120'
			},
			{ clock }
		);
		room = r.room;
		r.h.apisix.contracts.spec = BRIEF_CATALOG;
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBeGreaterThan(0);
		// A free day, no invitation, an empty inbox and no task
		r.h.apisix.contracts.handler = (c) => {
			if (c.path === LIST_MAILBOXES) return { status: 200, body: MAILBOXES };
			if (c.path === LIST_EMAILS) return { status: 200, body: { emails: [], next_cursor: null } };
			if (c.path === LIST_TASKS) return { status: 200, body: { tasks: [], truncated: false } };
			if (c.path === LIST_EVENTS) {
				return { status: 200, body: { time_zone: 'Europe/Paris', events: [], truncated: false } };
			}
			return { status: 404, body: {} };
		};
		r.h.apisix.llm.script = offeringModel;
	}, 240_000);

	// Each case starts with her brief's reads allowed, no choice made for any application, no source
	// offer made, and no question waiting for her answer nor yes waiting to run
	beforeEach(async () => {
		await seenEveryDay(r.h.db, ALICE);
		for (const domain of BRIEF_DOMAINS) await grantConsent(r.h.db, ALICE, domain, 'read');
		await withPrincipal(r.h.db, { id: ALICE }, async (tx) => {
			await tx.sql`delete from listened_sources where owner = ${ALICE}`;
			await tx.sql`delete from source_offers where owner = ${ALICE}`;
			await tx.sql`update pending_calls set status = 'expired' where owner = ${ALICE}
				and (status = 'open' or (status = 'approved' and replayed_at is null))`;
		});
	});

	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	it('offers me the Chat after my next brief, saying where my assistant would hear the mentions of me, and on my yes has it listen there, allowing nothing more', async () => {
		const before = await allowed();
		// Monday 12 October at eight in Paris: her brief, then the source offer, marked as a question
		const monday = await briefOf('2026-10-12T06:00:00Z');
		expect(monday.body).toBe(`${WRITTEN}\n\n${CHAT_SOURCE_OFFER_FR}`);
		const offered = await r.requestAskedIn(monday.eventId, 'chat');
		expect(
			logged({ msg: 'brief offered a source', pendingCallId: offered.id, source: 'chat' })
		).toBe(true);
		// She says yes at nine, which the harness answers itself, starting no turn
		clock.set('2026-10-12T07:00:00Z');
		const turns = r.h.apisix.llm.calls.length;
		await told(() => r.client.sendText(room, 'oui'), LISTENING_FR);
		expect(r.h.apisix.llm.calls.slice(turns)).toEqual([]);
		expect(await listened()).toEqual(['calendar', 'tasks', 'chat']);
		expect(await chosen()).toBe('listening');
		expect(await allowed()).toEqual(before);
		// Tuesday, her brief offers nothing more
		const tuesday = await briefOf('2026-10-13T06:00:00Z');
		expect(tuesday.body).toBe(WRITTEN);
		expect(isQuestion(tuesday)).toBe(false);
	});

	it('keeps my no as my choice not to listen to the Chat, and offers it no more', async () => {
		// Wednesday 14 October
		const wednesday = await briefOf('2026-10-14T06:00:00Z');
		expect(wednesday.body).toBe(`${WRITTEN}\n\n${CHAT_SOURCE_OFFER_FR}`);
		await r.requestAskedIn(wednesday.eventId, 'chat');
		await told(() => r.client.sendText(room, 'non'), REFUSED);
		expect(await chosen()).toBe('stopped');
		expect(await listened()).toEqual(['calendar', 'tasks']);
		// Thursday, nothing
		const thursday = await briefOf('2026-10-15T06:00:00Z');
		expect(thursday.body).toBe(WRITTEN);
		expect(isQuestion(thursday)).toBe(false);
	});

	it('offers me the Chat once in my language though I leave it unanswered, and listens there when I ask all the same', async () => {
		await r.h.api.tool(ALICE, 'set_language', { language: 'en' });
		try {
			// Friday 16 October
			const friday = await briefOf('2026-10-16T06:00:00Z');
			expect(friday.body).toBe(`${WRITTEN}\n\n${CHAT_SOURCE_OFFER_EN}`);
			await r.requestAskedIn(friday.eventId, 'chat');
			// She leaves it unanswered past its lifetime: Monday, her brief offers nothing
			await pastLifetime();
			const monday = await briefOf('2026-10-19T06:00:00Z');
			expect(monday.body).toBe(WRITTEN);
			expect(isQuestion(monday)).toBe(false);
			expect(await chosen()).toBe('none');
			// At nine, she asks her assistant to listen to the Chat, which asks her nothing first
			clock.set('2026-10-19T07:00:00Z');
			await told(() => r.client.sendText(room, 'Listen to my chat'), LISTENING_EN);
			expect(await chosen()).toBe('listening');
		} finally {
			await r.h.api.tool(ALICE, 'set_language', { language: 'fr' });
		}
	});

	it('offers nothing to an owner whose assistant listens to the Chat already, nor to one who stopped it', async () => {
		await choose('chat', true);
		// Tuesday 20 October
		const tuesday = await briefOf('2026-10-20T06:00:00Z');
		expect(tuesday.body).toBe(WRITTEN);
		expect(isQuestion(tuesday)).toBe(false);
		await choose('chat', false);
		// Wednesday 21 October
		const wednesday = await briefOf('2026-10-21T06:00:00Z');
		expect(wednesday.body).toBe(WRITTEN);
		expect(isQuestion(wednesday)).toBe(false);
	});
});
