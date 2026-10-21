import { isRecord } from './json.js';

// The thread of a room's main timeline, as read receipts name it
const MAIN_THREAD = 'main';

// A room event as the matrix role reads it
export interface RoomEvent {
	readonly type?: string;
	readonly sender?: string;
	readonly state_key?: string;
	readonly event_id?: string;
	// When its homeserver received it from its author, in milliseconds, by the homeserver's clock
	readonly origin_server_ts?: number;
	readonly content?: Record<string, unknown>;
}

// A message of a room the matrix role reads for someone, as it hands it to its subscribers: read
// once, whoever it is read for
export interface ReadMessage {
	readonly roomId: string;
	readonly eventId: string;
	// Who wrote it, by their Matrix id
	readonly sender: string;
	// The words of an m.text, null for a message without words, such as an image or a file
	readonly text: string | null;
	// Whom it mentions, by the Matrix ids its m.mentions names: never the whole room
	readonly mentions: readonly string[];
	// The root of its thread, or main for the room's main timeline, as read receipts name them. An
	// edit reads as main: its relation names the message it replaces, not a thread.
	readonly thread: string;
	// The message an edit replaces, null for a message that is no edit. Clients copy the mentions of
	// the message they edit into the edit's, so an edit's mentions are mostly the same again.
	readonly replaces: string | null;
	// When its homeserver received it from its author, by the homeserver's clock: what tells which of
	// two messages of a room came first, as a read receipt's message and a mention
	readonly sentAt: Date;
	// When the matrix role received it, by its own clock
	readonly receivedAt: Date;
}

// The words of a message: the body of an m.text alone
export function textOf(event: RoomEvent): string | null {
	const content = event.content ?? {};
	return content['msgtype'] === 'm.text' && typeof content['body'] === 'string'
		? content['body']
		: null;
}

// The Matrix ids a message's m.mentions names, each once
function mentionsOf(content: Record<string, unknown>): string[] {
	const mentions = content['m.mentions'];
	const userIds = isRecord(mentions) ? mentions['user_ids'] : undefined;
	if (!Array.isArray(userIds)) return [];
	return [...new Set(userIds.filter((userId): userId is string => typeof userId === 'string'))];
}

// The event a content's relation of this type names: the root of the thread it puts its message
// in, or the message it replaces; null when it has no relation of that type
function relatedBy(
	content: Record<string, unknown>,
	relType: 'm.thread' | 'm.replace'
): string | null {
	const relation = content['m.relates_to'];
	if (!isRecord(relation) || relation['rel_type'] !== relType) return null;
	const related = relation['event_id'];
	return typeof related === 'string' ? related : null;
}

// When its homeserver received an event from its author, by the homeserver's clock: null for an
// event that does not say
export function sentAtOf(event: RoomEvent): Date | null {
	return typeof event.origin_server_ts === 'number' ? new Date(event.origin_server_ts) : null;
}

// A message as the matrix role reads it once, from its content, as decrypted when it came
// encrypted: the encryption engine gives the decrypted event the relation the encrypted one left in
// the clear, when its content names none, and the time its homeserver gave it. Null for a message
// without an id, a sender or that time.
export function messageOf(roomId: string, event: RoomEvent, receivedAt: Date): ReadMessage | null {
	const { event_id: eventId, sender } = event;
	const sentAt = sentAtOf(event);
	if (eventId === undefined || sender === undefined || sentAt === null) return null;
	const content = event.content ?? {};
	return {
		roomId,
		eventId,
		sender,
		text: textOf(event),
		mentions: mentionsOf(content),
		thread: relatedBy(content, 'm.thread') ?? MAIN_THREAD,
		replaces: relatedBy(content, 'm.replace'),
		sentAt,
		receivedAt
	};
}
