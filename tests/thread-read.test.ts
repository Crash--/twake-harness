import { describe, expect, it } from 'vitest';

import { threadReadOf, type RoomEvent } from '../src/matrix/messages.js';

const ROOT = '$root';

const event = (eventId: string, relation?: Record<string, unknown>): RoomEvent => ({
	type: 'm.room.message',
	event_id: eventId,
	content: {
		msgtype: 'm.text',
		body: 'Hello',
		...(relation === undefined ? {} : { 'm.relates_to': relation })
	}
});
const inThread = (eventId: string) =>
	event(eventId, { rel_type: 'm.thread', event_id: ROOT, is_falling_back: true });
const relatedTo = (eventId: string, related: string, relType = 'm.annotation') =>
	event(eventId, { rel_type: relType, event_id: related, key: '👍' });
// An event as a homeserver gives it once redacted: its content, its relation included, is gone
const redacted = (eventId: string): RoomEvent => ({
	type: 'm.room.message',
	event_id: eventId,
	content: {},
	unsigned: { redacted_because: { type: 'm.room.redaction', redacts: eventId } }
});

// The events of a room the receipt's thread is looked for in, each read counted
function roomOf(...events: RoomEvent[]) {
	const reads: string[] = [];
	return {
		reads,
		eventOf: async (eventId: string): Promise<RoomEvent> => {
			reads.push(eventId);
			const found = events.find((candidate) => candidate.event_id === eventId);
			if (found === undefined) throw new Error(`no event ${eventId}`);
			return found;
		}
	};
}

describe('the thread a read receipt on an event covers', () => {
	it('is the thread of a message in one, and the main timeline for one outside any, a root included', async () => {
		const room = roomOf();
		expect(await threadReadOf(inThread('$in'), room.eventOf)).toBe(ROOT);
		expect(await threadReadOf(event(ROOT), room.eventOf)).toBe('main');
		expect(room.reads).toEqual([]);
	});

	it('is the thread of the message a reaction or an edit relates to, and the main timeline for one to a root', async () => {
		const room = roomOf(inThread('$in'), event(ROOT));
		expect(await threadReadOf(relatedTo('$reaction', '$in'), room.eventOf)).toBe(ROOT);
		expect(await threadReadOf(relatedTo('$edit', '$in', 'm.replace'), room.eventOf)).toBe(ROOT);
		expect(await threadReadOf(relatedTo('$on-root', ROOT), room.eventOf)).toBe('main');
	});

	it('follows three relations at most, past which it takes the main timeline', async () => {
		const deep = roomOf(relatedTo('$1', '$2'), relatedTo('$2', '$3'), inThread('$3'));
		expect(await threadReadOf(relatedTo('$0', '$1'), deep.eventOf)).toBe(ROOT);
		const deeper = roomOf(
			relatedTo('$1', '$2'),
			relatedTo('$2', '$3'),
			relatedTo('$3', '$4'),
			inThread('$4')
		);
		expect(await threadReadOf(relatedTo('$0', '$1'), deeper.eventOf)).toBe('main');
		expect(deeper.reads).toEqual(['$1', '$2', '$3']);
	});

	it('is none for a redacted event, or one that relates to it, whose thread nobody can tell', async () => {
		const room = roomOf(redacted('$gone'));
		expect(await threadReadOf(redacted('$gone'), room.eventOf)).toBeNull();
		expect(await threadReadOf(relatedTo('$reaction', '$gone'), room.eventOf)).toBeNull();
	});
});
