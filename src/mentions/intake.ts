import type { FastifyBaseLogger } from 'fastify';

import { findAssistant, isActiveAssistant } from '../assistants/repository.js';
import type { Config } from '../config.js';
import { withPrincipal, type Db, type Tx } from '../db/client.js';
import { cut } from '../llm/data.js';
import { botsOf, isPlatformAccount } from '../matrix/bots.js';
import { sentAtOf, threadReadOf, type RoomEvent } from '../matrix/messages.js';
import type { Subscriber } from '../matrix/subscribers.js';
import { principalOfMatrixUser } from '../principals/identity.js';
import { isListening } from '../sources/repository.js';
import { sourceRegistryOf } from '../sources/sources.js';
import { hasMentionsIn, holdMention, settleRead, settleReplied } from './repository.js';

// What a pending mention keeps of what people wrote, at most: the message's words and the room's
// name
const TEXT_MAX = 1000;
const ROOM_NAME_MAX = 200;

export interface MentionIntakeDeps {
	readonly config: Config;
	readonly db: Db;
	readonly log: FastifyBaseLogger;
	// The state of a channel, as the listener reads it
	readonly roomState: (roomId: string) => Promise<readonly RoomEvent[]>;
	// An event of a channel, as the listener reads it
	readonly roomEvent: (roomId: string, eventId: string) => Promise<RoomEvent>;
}

// The name a room's state gives it, null for a room without one
function roomNameOf(state: readonly RoomEvent[]): string | null {
	const event = state.find(({ type, state_key }) => type === 'm.room.name' && state_key === '');
	const name = event?.content?.['name'];
	return typeof name === 'string' && name.length > 0 ? name : null;
}

// Whether a user joined the room whose state is given: a mention of anyone else would carry the
// room's words to someone outside it
function hasJoined(state: readonly RoomEvent[], userId: string): boolean {
	return state.some(
		({ type, state_key, content }) =>
			type === 'm.room.member' && state_key === userId && content?.['membership'] === 'join'
	);
}

// What takes the mentions of the channels the listener is in, while the deployment opened the
// Chat: a message that names in its m.mentions an owner of our homeserver other than its author,
// who joined its room, has an assistant and listens to the Chat, waits for them until the worker
// role's pass wakes their assistant for it. A mention of the whole room, a name written out, an
// edit, whose mentions are mostly those of the message it edits, a message by a bot or an account
// of the harness, and a mention of someone outside the room count for nothing. A listened
// conversation's mentions are not taken yet. What waits is settled with no wake-up once its owner
// read it, by a public read receipt on a message of its thread sent no earlier, or wrote in its room
// after it, in any thread. Its lines name the owner, the room and the message, never the author nor
// the words.
export function makeMentionIntake(deps: MentionIntakeDeps): Subscriber {
	const { config, db, log } = deps;
	const sources = sourceRegistryOf(config);

	// Settles the mentions that wait for an owner, as `erase` finds them under their principal, for
	// the reason given
	async function settle(
		owner: string,
		roomId: string,
		reason: 'read' | 'replied',
		erase: (tx: Tx) => Promise<string[]>
	): Promise<void> {
		const settled = await withPrincipal(db, { id: owner }, erase);
		for (const eventId of settled) log.info({ owner, roomId, eventId, reason }, 'mention settled');
	}

	// Whether an owner has an assistant that answers them in its room, and has it listen to the Chat
	async function listensToChat(owner: string): Promise<boolean> {
		return withPrincipal(
			db,
			{ id: owner },
			async (tx) =>
				isActiveAssistant(await findAssistant(tx, owner)) && isListening(tx, owner, 'chat', sources)
		);
	}

	return {
		name: 'mentions',
		message: async (message, assistant) => {
			if (!config.chatMentions.enabled || assistant !== null) return;
			const { roomId, eventId, sender } = message;
			if (isPlatformAccount(config, sender)) return;
			// An owner who writes in the room, an edit included, has been there since what waited for
			// them, in whichever thread they write
			const author = principalOfMatrixUser(config, sender);
			if (author !== null) {
				await settle(author, roomId, 'replied', (tx) =>
					settleReplied(tx, author, roomId, message.sentAt)
				);
			}
			if (message.replaces !== null) return;
			const mentioned: { readonly owner: string; readonly userId: string }[] = [];
			for (const userId of message.mentions) {
				if (userId === sender || isPlatformAccount(config, userId)) continue;
				const owner = principalOfMatrixUser(config, userId);
				if (owner !== null && (await listensToChat(owner))) mentioned.push({ owner, userId });
			}
			// The room is read only for a mention someone listens for
			if (mentioned.length === 0) return;
			const state = await deps.roomState(roomId);
			if (botsOf(state, config.matrix.serverName).has(sender)) return;
			const roomName = roomNameOf(state);
			for (const { owner, userId } of mentioned) {
				if (!hasJoined(state, userId)) continue;
				const held = await withPrincipal(db, { id: owner }, (tx) =>
					holdMention(tx, {
						owner,
						roomId,
						eventId,
						thread: message.thread,
						sender,
						sentAt: message.sentAt,
						receivedAt: message.receivedAt,
						text: message.text === null ? null : cut(message.text, TEXT_MAX),
						roomName: roomName === null ? null : cut(roomName, ROOM_NAME_MAX)
					})
				);
				if (held) log.info({ owner, roomId, eventId }, 'mention pending');
			}
		},
		// A public read receipt covers the thread of the event it names alone, up to that event:
		// Synapse pushes it without its thread, so the event is read, and the events its relations
		// name, only for a room where a mention waits for its owner. One on an event whose thread a
		// redaction hid settles nothing. A private one never reaches the harness.
		receipt: async ({ roomId, userId, eventId }) => {
			if (!config.chatMentions.enabled || isPlatformAccount(config, userId)) return;
			const owner = principalOfMatrixUser(config, userId);
			if (owner === null) return;
			if (!(await withPrincipal(db, { id: owner }, (tx) => hasMentionsIn(tx, owner, roomId)))) {
				return;
			}
			const receipted = await deps.roomEvent(roomId, eventId);
			const sentAt = sentAtOf(receipted);
			if (sentAt === null) return;
			const thread = await threadReadOf(receipted, (related) => deps.roomEvent(roomId, related));
			if (thread === null) return;
			await settle(owner, roomId, 'read', (tx) =>
				settleRead(tx, owner, roomId, { thread, sentAt })
			);
		}
	};
}
