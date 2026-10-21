import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runBriefPass } from '../src/briefs/schedule.js';
import type { Config } from '../src/config.js';
import { withPrincipal } from '../src/db/client.js';
import type { Subscriber } from '../src/matrix/subscribers.js';
import { holdMention } from '../src/mentions/repository.js';
import { CHAT_SOURCE } from '../src/sources/sources.js';
import { UNREAD_MENTION_EVENT_TYPE } from '../src/wakeups/event-types.js';
import { lastUser, turnCalls, until } from './helpers/activity.js';
import { makeSettableClock } from './helpers/clock.js';
import { call, startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import { grantConsent } from './helpers/consents.js';
import {
	MEETING_CATALOG,
	toolsOf,
	type ChatRequest,
	type ScriptedReply
} from './helpers/fake-apisix.js';
import { startFakeSpace, type FakeSpace } from './helpers/space.js';
import type { MatrixUser } from './helpers/synapse.js';

const ALICE = 'alice@test.local';
const BOB = 'bob@test.local';
// The one visible user that reads the channels it is invited to
const LISTENER = '@twake-assistant:test.local';

// The data an event's turn is handed
const FENCED = /^<<<event-data ([0-9a-f]{12})\n(.+)\nevent-data \1>>>$/m;

// What the harness says once Alice had her assistant listen to the Chat, in each language: the
// listener under the name its members see it under, in the deployment's language
const LISTENING_EN =
	'I am listening to Twake Chat: I will let you know of a mention of you that you leave unread for ten minutes, in the unencrypted rooms Twake Assistant is in and in the conversations I listen to. With private read receipts, I cannot see what you read, and I will remind you of every mention.';
const LISTENING_FR =
	"J'écoute Twake Chat : je te préviens d'une mention de toi que tu laisses non lue dix minutes, dans les salons non chiffrés où se trouve Twake Assistant et dans les conversations que j'écoute. Avec des accusés de lecture privés, je ne vois pas ce que tu lis, et je te rappelle chaque mention.";
// And once she stopped it
const NOT_LISTENING_EN =
	'I am no longer listening to Twake Chat: I will no longer let you know of the mentions of you that you leave unread.';
const NOT_LISTENING_FR =
	"Je n'écoute plus Twake Chat : je ne te préviens plus des mentions de toi que tu laisses non lues.";

// What Alice asks her assistant when she wants to hear her listening journal
const ASKED = 'What did you see today?';
const JOURNAL = 'listening_journal';

// What Alice asks her assistant, and the call a literal model makes for each
const ASKS: Readonly<Record<string, { readonly tool: string; readonly args: unknown }>> = {
	'Listen to my chat': { tool: 'listen_to_source', args: { source: 'chat' } },
	'Stop listening to my chat': { tool: 'stop_listening_to_source', args: { source: 'chat' } },
	'Écoute le chat': { tool: 'listen_to_source', args: { source: 'chat' } },
	'Arrête d’écouter le chat': { tool: 'stop_listening_to_source', args: { source: 'chat' } },
	[ASKED]: { tool: JOURNAL, args: {} }
};

// The words of Bob's that a suggestion makes a proposal of
const PROPOSING = 'Alice, can we meet on Monday at 10?';

// A literal model: it makes the call each of Alice's asks needs and says what the call answered,
// names the event its turn was told of, proposes a meeting from Bob's words, and repeats anything
// else it hears
function mentionModel(request: ChatRequest): ScriptedReply {
	const last = request.messages.at(-1);
	if (last?.role === 'tool' && last.name === JOURNAL) return { content: `Saw: ${last.content}` };
	if (last?.role === 'tool') return { content: `Told: ${last.content ?? ''}` };
	const told = lastUser(request);
	const id = /\(id ([^)]+)\)/.exec(told)?.[1];
	if (id !== undefined) return { content: `Told of ${id}` };
	if (toolsOf(request).includes('create_meeting') && told.includes(PROPOSING)) {
		return {
			toolCalls: call('create_meeting', {
				body: {
					title: 'Budget review',
					start: '2026-10-26T10:00:00+01:00',
					end: '2026-10-26T10:30:00+01:00',
					attendees: [BOB]
				}
			})
		};
	}
	const ask = ASKS[told];
	return ask === undefined
		? { content: `Heard: ${told}` }
		: { toolCalls: call(ask.tool, ask.args) };
}

// A Tuesday morning in Paris, out of the quiet hours, and ten minutes later
const MORNING = '2026-10-20T08:00:00Z';
const TEN_MINUTES_ON = '2026-10-20T08:10:00Z';

describe('a mention of me I leave unread for ten minutes, in an unencrypted room, wakes my assistant', () => {
	let r: ConsentRoom;
	let space: FakeSpace;
	// The present both the matrix role and the worker role's pass read
	const clock = makeSettableClock(MORNING);
	let bob: MatrixUser;
	let rooms = 0;
	// The messages the matrix role handed its subscribers, by their id: the last of them, this one,
	// gets a message once the mentions are done with it
	const handedOver = new Set<string>();
	const recorder: Subscriber = {
		name: 'recorder',
		message: async (message) => {
			handedOver.add(message.eventId);
		}
	};

	// A message as a client writes it, with whatever its content holds
	async function send(user: MatrixUser, room: string, content: Record<string, unknown>) {
		const txn = `${Date.now()}-${Math.random()}`;
		const sent = await r.h.synapse.request(
			user,
			'PUT',
			`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${txn}`,
			content
		);
		expect(sent.status).toBe(200);
		return sent.body['event_id'] as string;
	}

	// A mention of a user by the pill of their name, in the room's main timeline
	function mentionOf(user: MatrixUser, body: string): Record<string, unknown> {
		return { msgtype: 'm.text', body, 'm.mentions': { user_ids: [user.userId] } };
	}

	// A clear channel of Bob's, named, which Alice joined and where the listener was invited, a new
	// one for each test, so that what waits in one is no other's
	async function channel(name = `general-${(rooms += 1)}`): Promise<string> {
		const created = await r.h.synapse.request(bob, 'POST', '/_matrix/client/v3/createRoom', {
			preset: 'public_chat',
			name
		});
		const room = created.body['room_id'] as string;
		await r.h.synapse.joinRoom(r.alice, room);
		await r.h.synapse.request(
			bob,
			'POST',
			`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/invite`,
			{ user_id: LISTENER }
		);
		await until('the listener joined the channel', async () =>
			(await r.h.synapse.joinedMembers(bob, room)).includes(LISTENER)
		);
		return room;
	}

	// The lines either role wrote about mentions, or about those of one message
	function mentionLines(eventId?: string): Record<string, unknown>[] {
		return r.h
			.logLines()
			.filter(
				(line) =>
					(line['msg'] === 'mention pending' || line['msg'] === 'mention settled') &&
					(eventId === undefined || line['eventId'] === eventId)
			);
	}

	// Why the mentions a message made were settled, each time one was
	function settledAs(eventId: string): unknown[] {
		return mentionLines(eventId)
			.filter((line) => line['msg'] === 'mention settled')
			.map((line) => line['reason']);
	}

	// The mention waits for its owner, once the matrix role took it
	async function waits(eventId: string, owner = ALICE): Promise<void> {
		await until('the mention waits', () =>
			mentionLines(eventId).some(
				(line) => line['msg'] === 'mention pending' && line['owner'] === owner
			)
		);
	}

	// The matrix role read the message and handed it to its subscribers, whatever came of it
	async function handled(eventId: string): Promise<void> {
		await until('the message was handed over', () => handedOver.has(eventId));
	}

	// A mention of Alice by Bob that the matrix role received at the time given, once it waits: the
	// role reads that time on the clock the test moves, so that the mentions of a room arrive in
	// the order they were sent
	async function mentionAt(at: string, room: string, body: string): Promise<string> {
		clock.set(at);
		const eventId = await send(bob, room, mentionOf(r.alice, body));
		await waits(eventId);
		return eventId;
	}

	// The worker role's pass, as it passes every minute, at the time given, with the deployment's
	// settings unless a test changes them
	async function pass(at: string, config: Config = r.h.config): Promise<void> {
		clock.set(at);
		const app = r.h.apps[0];
		if (app === undefined) throw new Error('no api role');
		await runBriefPass({ config, db: r.h.db, log: app.log, clock });
	}

	// What the turn a wake-up of this id started was told, once it came and its answer reached
	// Alice's room
	async function toldOf(id: string): Promise<string> {
		await until(
			'a turn was told of the mention',
			() => turnCalls(r.h.apisix.llm.calls, id).length > 0
		);
		await r.client.waitForMessage(r.room, r.assistantId, (text) => text === `Told of ${id}`);
		return lastUser(turnCalls(r.h.apisix.llm.calls, id)[0]?.request);
	}

	function dataOf(told: string): Record<string, unknown> {
		const line = FENCED.exec(told)?.[2];
		if (line === undefined) throw new Error(`no event data in ${told}`);
		return JSON.parse(line) as Record<string, unknown>;
	}

	// The link that opens a message in Twake Chat
	function linkOf(room: string, eventId: string): string {
		return `https://matrix.to/#/${encodeURIComponent(room)}/${encodeURIComponent(eventId)}?via=test.local`;
	}

	// What Alice's assistant says next in her room after her words
	async function answer(words: string): Promise<string> {
		const seen = r.saying('').length;
		await r.client.sendText(r.room, words);
		return r.nextSaying('', seen);
	}

	// What Alice's journal keeps today of the activities of a room, as her assistant reads it to her
	async function journaled(room: string): Promise<Record<string, unknown>[]> {
		const said = r.saying('Saw: ').length;
		await r.client.sendText(r.room, ASKED);
		const saw = await r.nextSaying('Saw: ', said);
		const { activities } = JSON.parse(saw.slice('Saw: '.length)) as {
			readonly activities: readonly Record<string, unknown>[];
		};
		return activities.filter((activity) => activity['room'] === room);
	}

	beforeAll(async () => {
		space = await startFakeSpace();
		r = await startConsentRoom(
			{
				SUGGESTIONS_ENABLED: 'true',
				SPACE_API_URL: space.url,
				SPACE_API_TOKEN: 'tws_secret',
				CHAT_MENTIONS_ENABLED: 'true',
				ASSISTANT_TIMEZONE: 'Europe/Paris',
				QUIET_HOURS_DEFAULT: '20:00-08:00 saturday sunday',
				// Many turns of one owner in a row: admission is the subject of its own suite
				ADMISSION_USER_PER_MINUTE: '100',
				WAKEUPS_PER_HOUR: '1000'
			},
			{ clock, subscribers: [recorder] }
		);
		r.h.apisix.llm.script = mentionModel;
		bob = await r.h.synapse.registerUser('bob');
		expect(await answer('Listen to my chat')).toBe(LISTENING_EN);
	}, 300_000);

	afterAll(async () => {
		if (r !== undefined) await r.close();
		if (space !== undefined) await space.close();
	});

	it('listens to my chat when I ask, asking no yes first, and stops when I ask, in my language', async () => {
		expect(await answer('Stop listening to my chat')).toBe(NOT_LISTENING_EN);
		await r.h.api.tool(ALICE, 'set_language', { language: 'fr' });
		try {
			expect(await answer('Écoute le chat')).toBe(LISTENING_FR);
			expect(await answer('Arrête d’écouter le chat')).toBe(NOT_LISTENING_FR);
		} finally {
			await r.h.api.tool(ALICE, 'set_language', { language: 'en' });
		}
		// Nothing waited for her answer: listening to the Chat reads nothing through a contract
		expect(r.questions()).toEqual([]);
		expect(await answer('Listen to my chat')).toBe(LISTENING_EN);
	});

	it('wakes my assistant ten minutes on, with the room, the link, the author and the time computed and the words as untrusted, my journal keeping the author and the room alone', async () => {
		const room = await channel('general');
		const mention = await mentionAt(MORNING, room, 'Alice, can you check the figures?');
		// Nine minutes on, it still waits
		await pass('2026-10-20T08:09:00Z');
		expect(turnCalls(r.h.apisix.llm.calls, mention)).toEqual([]);
		expect(settledAs(mention)).toEqual([]);
		await pass(TEN_MINUTES_ON);
		const data = dataOf(await toldOf(mention));
		expect(data).toMatchObject({
			type: UNREAD_MENTION_EVENT_TYPE,
			source: CHAT_SOURCE,
			id: mention,
			room,
			mentions: [
				{
					number: 1,
					author: BOB,
					received_at: '2026-10-20T10:00:00+02:00',
					link: linkOf(room, mention)
				}
			],
			untrusted: {
				room_name: 'general',
				messages: [{ number: 1, text: 'Alice, can you check the figures?' }]
			}
		});
		expect(data).not.toHaveProperty('more');
		expect(settledAs(mention)).toEqual(['woken']);
		// Settled by its wake-up: a later pass finds nothing of it
		await pass('2026-10-20T08:20:00Z');
		expect(settledAs(mention)).toEqual(['woken']);
		expect(turnCalls(r.h.apisix.llm.calls, mention)).toHaveLength(1);
		// The turn it woke answered: her journal keeps its author and its room, never the words
		const kept = await journaled(room);
		expect(kept).toEqual([
			expect.objectContaining({
				source: CHAT_SOURCE,
				type: UNREAD_MENTION_EVENT_TYPE,
				outcome: 'suggested',
				room,
				authors: [BOB],
				untrusted: { room_name: 'general' }
			})
		]);
		expect(JSON.stringify(kept)).not.toContain('figures');
		// The lines name the owner, the room and the message, never the author nor the words
		expect(
			mentionLines(mention).map(({ msg, owner, roomId, reason }) => ({
				msg,
				owner,
				roomId,
				reason
			}))
		).toEqual([
			{ msg: 'mention pending', owner: ALICE, roomId: room, reason: undefined },
			{ msg: 'mention settled', owner: ALICE, roomId: room, reason: 'woken' }
		]);
		const logged = JSON.stringify(
			r.h.logLines().filter((line) => JSON.stringify(line).includes(mention))
		);
		expect(logged).not.toContain('figures');
		expect(JSON.stringify(mentionLines())).not.toContain(bob.userId);
	});

	it('wakes my assistant once for the mentions of a room, ten at most with the number of the others', async () => {
		const room = await channel();
		const first = await mentionAt(MORNING, room, 'Alice, the budget');
		// Nine minutes old at the pass, it goes with the first all the same
		const second = await mentionAt('2026-10-20T08:01:00Z', room, 'Alice, the agenda too');
		await pass(TEN_MINUTES_ON);
		const data = dataOf(await toldOf(first));
		expect(data).toMatchObject({
			id: first,
			mentions: [
				{ number: 1, link: linkOf(room, first) },
				{ number: 2, link: linkOf(room, second) }
			],
			untrusted: {
				messages: [
					{ number: 1, text: 'Alice, the budget' },
					{ number: 2, text: 'Alice, the agenda too' }
				]
			}
		});
		expect(turnCalls(r.h.apisix.llm.calls, second)).toEqual([]);
		expect([...settledAs(first), ...settledAs(second)]).toEqual(['woken', 'woken']);

		// Twelve mentions in another room, a second apart: ten told, two counted
		const busy = await channel();
		const sent: string[] = [];
		for (let i = 0; i < 12; i += 1) {
			const at = new Date(Date.parse(MORNING) + i * 1000).toISOString();
			sent.push(await mentionAt(at, busy, `Alice, point ${i + 1}`));
		}
		await pass(TEN_MINUTES_ON);
		const many = dataOf(await toldOf(sent[0] ?? ''));
		expect(many['mentions']).toHaveLength(10);
		expect(many['more']).toBe(2);
		expect((many['untrusted'] as Record<string, unknown>)['messages']).toHaveLength(10);
		// The two counted go with the ten told
		expect(sent.flatMap(settledAs)).toEqual(sent.map(() => 'woken'));
	});

	it('takes no mention by a bot, of the whole room or by my name written out, nor of an owner who does not listen to the Chat, nor mine of myself', async () => {
		const room = await channel();
		const dave = await r.h.synapse.registerUser('dave');
		expect((await r.h.api.post('dave@test.local', '/v1/assistants', { name: 'Iris' })).status).toBe(
			201
		);
		await r.h.synapse.joinRoom(dave, room);
		const bot = await r.h.synapse.registerUser('bot_reminders');
		await r.h.synapse.joinRoom(bot, room);
		clock.set(MORNING);
		const ignored = [
			await send(bot, room, mentionOf(r.alice, 'Alice, your weekly reminder')),
			await send(bob, room, {
				msgtype: 'm.text',
				body: '@room the minutes are up',
				'm.mentions': { room: true }
			}),
			await send(bob, room, { msgtype: 'm.text', body: 'Alice, are you there?' }),
			await send(bob, room, mentionOf(dave, 'Dave, the slides')),
			await send(r.alice, room, mentionOf(r.alice, 'Note to self: Alice, call back'))
		];
		for (const eventId of ignored) await handled(eventId);
		expect(ignored.flatMap((eventId) => mentionLines(eventId))).toEqual([]);
		// A mention that counts, sent last, which the pass wakes for alone
		const counted = await send(bob, room, mentionOf(r.alice, 'Alice, the figures'));
		await waits(counted);
		await pass(TEN_MINUTES_ON);
		const data = dataOf(await toldOf(counted));
		expect(data['mentions']).toHaveLength(1);
		expect(settledAs(counted)).toEqual(['woken']);
	});

	it('takes no mention of an owner who has not joined the room, whom its words would reach outside it', async () => {
		const room = await channel();
		const erin = await r.h.synapse.registerUser('erin');
		const ERIN = 'erin@test.local';
		expect((await r.h.api.post(ERIN, '/v1/assistants', { name: 'Nova' })).status).toBe(201);
		await r.h.api.tool(ERIN, 'listen_to_source', { source: 'chat' });
		// Invited, she has not joined yet
		await r.h.synapse.request(
			bob,
			'POST',
			`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/invite`,
			{ user_id: erin.userId }
		);
		clock.set(MORNING);
		const invited = await send(bob, room, mentionOf(erin, 'Erin, the figures'));
		await handled(invited);
		expect(mentionLines(invited)).toEqual([]);
		// Once she joined, the same mention waits for her
		await r.h.synapse.joinRoom(erin, room);
		const joined = await send(bob, room, mentionOf(erin, 'Erin, the figures again'));
		await waits(joined, ERIN);
	});

	it('takes no edit of a message, whose mentions are those of the message it edits', async () => {
		const room = await channel();
		const original = await mentionAt(MORNING, room, 'Alice, the figures');
		// An edit as Twake on Matrix writes it: the message's content again, its mentions included,
		// beside the new one
		const edit = await send(bob, room, {
			...mentionOf(r.alice, '* Alice, the figures of October'),
			'm.new_content': mentionOf(r.alice, 'Alice, the figures of October'),
			'm.relates_to': { rel_type: 'm.replace', event_id: original }
		});
		await handled(edit);
		expect(mentionLines(edit)).toEqual([]);
		await pass(TEN_MINUTES_ON);
		const data = dataOf(await toldOf(original));
		expect(data['mentions']).toHaveLength(1);
		expect(settledAs(original)).toEqual(['woken']);
	});

	it('names an author of another homeserver by the Matrix id people wrote, as they have no address', async () => {
		const room = await channel('lobby');
		const local = await mentionAt(MORNING, room, 'Alice, the figures');
		// Another homeserver is out of this suite's reach: its mention waits as the matrix role
		// would have taken it, a second after Bob's
		const FOREIGN = '@carol:elsewhere.example';
		const foreign = '$mention-from-elsewhere';
		await withPrincipal(r.h.db, { id: ALICE }, (tx) =>
			holdMention(tx, {
				owner: ALICE,
				roomId: room,
				eventId: foreign,
				thread: 'main',
				sender: FOREIGN,
				receivedAt: new Date('2026-10-20T08:00:01Z'),
				text: 'Alice, from afar',
				roomName: 'lobby'
			})
		);
		await pass(TEN_MINUTES_ON);
		const data = dataOf(await toldOf(local));
		expect(data).toMatchObject({
			mentions: [
				{ number: 1, author: BOB, link: linkOf(room, local) },
				{ number: 2, author: null, link: linkOf(room, foreign) }
			],
			untrusted: {
				messages: [
					{ number: 1, text: 'Alice, the figures' },
					{ number: 2, author: FOREIGN, text: 'Alice, from afar' }
				]
			}
		});
		expect((data['untrusted'] as { messages: unknown[] }).messages[0]).not.toHaveProperty('author');
		expect(await journaled(room)).toEqual([
			expect.objectContaining({
				room,
				authors: [BOB],
				untrusted: { room_name: 'lobby', authors: [FOREIGN] }
			})
		]);
	});

	it('wakes my assistant for a room I muted for suggestions, and with my suggestions off, all the same', async () => {
		const room = await channel();
		expect(
			(await r.h.api.put(ALICE, '/v1/suggestions/settings', { enabled: true, mutedRooms: [room] }))
				.body
		).toEqual({ enabled: true, mutedRooms: [room] });
		try {
			const mention = await mentionAt(MORNING, room, 'Alice, a word on the budget');
			await pass(TEN_MINUTES_ON);
			expect(dataOf(await toldOf(mention))).toMatchObject({ id: mention, room });
			const other = await channel();
			expect(
				(await r.h.api.put(ALICE, '/v1/suggestions/settings', { enabled: false, mutedRooms: [] }))
					.body
			).toEqual({ enabled: false, mutedRooms: [] });
			const off = await mentionAt(MORNING, other, 'Alice, a word on the agenda');
			await pass(TEN_MINUTES_ON);
			expect(dataOf(await toldOf(off))).toMatchObject({ id: off, room: other });
		} finally {
			await r.h.api.put(ALICE, '/v1/suggestions/settings', { enabled: true, mutedRooms: [] });
		}
	});

	it('keeps a mention that reaches me during my quiet hours until they end', async () => {
		const room = await channel();
		// A Tuesday at nine in the evening in Paris
		const mention = await mentionAt('2026-10-20T19:00:00Z', room, 'Alice, before tomorrow');
		await pass('2026-10-20T19:10:00Z');
		await pass('2026-10-21T03:00:00Z');
		expect(turnCalls(r.h.apisix.llm.calls, mention)).toEqual([]);
		expect(settledAs(mention)).toEqual([]);
		// Past eight the next morning
		await pass('2026-10-21T06:05:00Z');
		expect(dataOf(await toldOf(mention))).toMatchObject({ id: mention });
		expect(settledAs(mention)).toEqual(['woken']);
	});

	it('wakes nobody past my hourly cap, my journal noting it as capped', async () => {
		const room = await channel();
		const mention = await mentionAt(MORNING, room, 'Alice, the invoices');
		// A deployment that allows no wake-up in the hour
		await pass(TEN_MINUTES_ON, { ...r.h.config, wakeups: { ...r.h.config.wakeups, perHour: 0 } });
		expect(settledAs(mention)).toEqual(['capped']);
		// Settled all the same: a later pass within the cap wakes nobody for it
		await pass('2026-10-20T08:20:00Z');
		expect(settledAs(mention)).toEqual(['capped']);
		expect(turnCalls(r.h.apisix.llm.calls, mention)).toEqual([]);
		expect(await journaled(room)).toEqual([
			expect.objectContaining({ outcome: 'capped', room, authors: [BOB] })
		]);
	});

	it('lets go of the mentions that waited once I stop listening to the Chat, waking nobody, and takes no more', async () => {
		const room = await channel();
		const waited = await mentionAt(MORNING, room, 'Alice, the agenda');
		expect(await answer('Stop listening to my chat')).toBe(NOT_LISTENING_EN);
		try {
			const later = await send(bob, room, mentionOf(r.alice, 'Alice, one more thing'));
			await handled(later);
			expect(mentionLines(later)).toEqual([]);
			await pass(TEN_MINUTES_ON);
			expect(settledAs(waited)).toEqual(['abandoned']);
			expect(turnCalls(r.h.apisix.llm.calls, waited)).toEqual([]);
			// What she does not listen to reaches neither her room nor her journal
			expect(await journaled(room)).toEqual([]);
		} finally {
			await answer('Listen to my chat');
		}
	});

	it('erases the mentions waiting for an owner with their /delete', async () => {
		const room = await channel();
		const carol = await r.h.synapse.registerUser('carol');
		const CAROL = 'carol@test.local';
		expect((await r.h.api.post(CAROL, '/v1/assistants', { name: 'Ada' })).status).toBe(201);
		await r.h.api.tool(CAROL, 'listen_to_source', { source: 'chat' });
		await r.h.synapse.joinRoom(carol, room);
		clock.set(MORNING);
		const mention = await send(bob, room, mentionOf(carol, 'Carol, the contract'));
		await waits(mention, CAROL);
		expect((await r.h.api.delete(CAROL, '/v1/assistants/me')).status).toBe(204);
		// Her new assistant, listening to the Chat again, is woken for nothing of it
		expect((await r.h.api.post(CAROL, '/v1/assistants', { name: 'Ada' })).status).toBe(201);
		await r.h.api.tool(CAROL, 'listen_to_source', { source: 'chat' });
		await pass(TEN_MINUTES_ON);
		expect(turnCalls(r.h.apisix.llm.calls, mention)).toEqual([]);
		expect(settledAs(mention)).toEqual([]);
	});

	it('takes no mention while the deployment keeps the Chat closed, and lets go of those that waited, waking nobody', async () => {
		const room = await channel();
		const waited = await mentionAt(MORNING, room, 'Alice, the closing date');
		await r.h.restartRole({ env: { CHAT_MENTIONS_ENABLED: 'false' } });
		try {
			const mention = await send(bob, room, mentionOf(r.alice, 'Alice, the opening date'));
			await handled(mention);
			expect(mentionLines(mention)).toEqual([]);
			// The worker role closed it too
			await pass(TEN_MINUTES_ON, { ...r.h.config, chatMentions: { enabled: false } });
			expect(settledAs(waited)).toEqual(['abandoned']);
			expect(turnCalls(r.h.apisix.llm.calls, waited)).toEqual([]);
			expect(
				r.h
					.logLines()
					.filter(
						(line) =>
							line['msg'] === 'activity of an unknown source, listened to by nobody' &&
							line['eventId'] === waited
					)
			).toEqual([expect.objectContaining({ source: CHAT_SOURCE, owner: ALICE })]);
		} finally {
			await r.h.restartRole();
		}
	});

	it('wakes my assistant for a mention all the same once a suggestion proposed a meeting from it', async () => {
		// The calendar Alice lets her assistant read, which a proposal needs
		r.h.apisix.contracts.spec = MEETING_CATALOG;
		for (const app of r.h.apps) await app.agent.contracts.load();
		await grantConsent(r.h.db, ALICE, 'calendar', 'read');
		const room = await channel();
		clock.set(MORNING);
		const seen = r.saying('').length;
		await handled(await send(r.alice, room, { msgtype: 'm.text', body: 'Bob, when can we meet?' }));
		const mention = await mentionAt(MORNING, room, PROPOSING);
		await until('a meeting was proposed to Alice', () =>
			r.h.logLines().some((line) => line['msg'] === 'suggestion made' && line['owner'] === ALICE)
		);
		// The proposal reached her room
		await r.nextSaying('', seen);
		await pass(TEN_MINUTES_ON);
		expect(dataOf(await toldOf(mention))).toMatchObject({ id: mention, room });
		expect(settledAs(mention)).toEqual(['woken']);
	});
});
