import type { Tx } from '../db/client.js';

// A mention of an owner the matrix role read in a channel the listener is in, which waits for the
// worker role's pass to wake their assistant for it: what its turn will need, the words people wrote
// included, which go with it once it is settled
export interface PendingMention {
	readonly owner: string;
	readonly roomId: string;
	readonly eventId: string;
	// The root of its thread, or main for the room's main timeline, as read receipts name them
	readonly thread: string;
	// Who wrote it, by their Matrix id
	readonly sender: string;
	// When the matrix role received it, by its own clock
	readonly receivedAt: Date;
	// What people wrote, cut: the message's words, null for a message without words, and the room's
	// name, null for a room without one
	readonly text: string | null;
	readonly roomName: string | null;
}

interface PendingMentionRow {
	owner: string;
	room_id: string;
	event_id: string;
	thread: string;
	sender: string;
	received_at: Date;
	text: string | null;
	room_name: string | null;
}

// Keeps a mention for its owner, in the transaction given under their principal, unless it waits
// already, as a message the homeserver hands again does: gives whether it waits from now
export async function holdMention(tx: Tx, mention: PendingMention): Promise<boolean> {
	const rows = await tx.sql`
		insert into pending_mentions
			(owner, room_id, event_id, thread, sender, received_at, text, room_name)
		values (
			${mention.owner}, ${mention.roomId}, ${mention.eventId}, ${mention.thread},
			${mention.sender}, ${mention.receivedAt}, ${mention.text}, ${mention.roomName}
		)
		on conflict do nothing
		returning 1`;
	return rows.length > 0;
}

// Whether a mention of the owner has waited since an instant, the one thing most passes ask
export async function hasDueMentions(tx: Tx, owner: string, before: Date): Promise<boolean> {
	const rows = await tx.sql`
		select 1 from pending_mentions where owner = ${owner} and received_at <= ${before} limit 1`;
	return rows.length > 0;
}

// The rooms where a mention of the owner has waited since an instant, the room of the one that
// waited longest first
export async function listDueRooms(tx: Tx, owner: string, before: Date): Promise<string[]> {
	const rows = await tx.sql<{ room_id: string }[]>`
		select room_id from pending_mentions
		where owner = ${owner}
		group by room_id
		having min(received_at) <= ${before}
		order by min(received_at), room_id`;
	return rows.map((row) => row.room_id);
}

// The mentions of the owner waiting in a room, the first received first
export async function listRoomMentions(
	tx: Tx,
	owner: string,
	roomId: string
): Promise<PendingMention[]> {
	const rows = await tx.sql<PendingMentionRow[]>`
		select owner, room_id, event_id, thread, sender, received_at, text, room_name
		from pending_mentions
		where owner = ${owner} and room_id = ${roomId}
		order by received_at, event_id`;
	return rows.map((row) => ({
		owner: row.owner,
		roomId: row.room_id,
		eventId: row.event_id,
		thread: row.thread,
		sender: row.sender,
		receivedAt: row.received_at,
		text: row.text,
		roomName: row.room_name
	}));
}

// Erases the mentions of the owner a room settled, their words included
export async function settleMentions(
	tx: Tx,
	owner: string,
	roomId: string,
	eventIds: readonly string[]
): Promise<void> {
	for (const eventId of eventIds) {
		await tx.sql`
			delete from pending_mentions
			where owner = ${owner} and room_id = ${roomId} and event_id = ${eventId}`;
	}
}
