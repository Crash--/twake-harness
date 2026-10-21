import { isoIn } from '../agent/clock.js';
import type { Config } from '../config.js';
import { withPrincipal } from '../db/client.js';
import { principalOfMatrixUser } from '../principals/identity.js';
import { isQuietAt, quietHoursOf } from '../quiet/hours.js';
import { findOwnerSettings } from '../settings/repository.js';
import { CHAT_SOURCE } from '../sources/sources.js';
import { UNREAD_MENTION_EVENT_TYPE } from '../wakeups/event-types.js';
import {
	wakeFor,
	type Carried,
	type WakeDeps,
	type WakeOutcome,
	type Wakeup
} from '../wakeups/wake.js';
import {
	hasDueMentions,
	listDueRooms,
	lockRoomMentions,
	settleMentions,
	type PendingMention
} from './repository.js';

// How long a mention waits unread before it wakes its owner's assistant, from its receipt by the
// matrix role, by its clock, to the worker role's pass, by its own
const UNREAD_MINUTES = 10;
// The mentions of a room one wake-up tells, the first received: the others are counted
const MAX_TOLD = 10;

// The link that opens a message in Twake Chat, at the message
function linkOf(config: Config, roomId: string, eventId: string): string {
	return `https://matrix.to/#/${encodeURIComponent(roomId)}/${encodeURIComponent(eventId)}?via=${config.matrix.serverName}`;
}

// Why the line of a mention says it was settled: what came of its wake-up, a mention whose owner
// has no assistant left, or no longer listens to the Chat, being abandoned
function settledAs(outcome: WakeOutcome): string {
	return outcome === 'no_assistant' || outcome === 'unlistened' ? 'abandoned' : outcome;
}

// The wake-up of the mentions of an owner waiting in a room, the first received first, as many as
// there are: its id is the first's. What the code computed, the room, the link to each message, the
// time it was received in the owner's zone and its author's address, is shown apart from what people
// wrote, the room's name as it last read, the words of each message, and the Matrix id of an author
// of another homeserver, who has no address. The owner's journal keeps the room and the authors,
// never the words.
function wakeupOf(
	config: Config,
	mentions: readonly [PendingMention, ...PendingMention[]],
	timeZone: string
): Wakeup {
	const [first] = mentions;
	const { owner, roomId } = first;
	const told = mentions.slice(0, MAX_TOLD);
	const more = mentions.length - told.length;
	const roomName = mentions.at(-1)?.roomName ?? null;
	const authors = told.map(({ sender }) => principalOfMatrixUser(config, sender));
	const foreign = told.flatMap(({ sender }, index) => (authors[index] === null ? [sender] : []));
	const addresses = authors.filter((author): author is string => author !== null);
	return {
		source: CHAT_SOURCE,
		id: first.eventId,
		type: UNREAD_MENTION_EVENT_TYPE,
		recipient: { email: owner, uuid: null, reason: 'mentioned' },
		actor: { email: null, uuid: null },
		shown: {
			computed: {
				type: UNREAD_MENTION_EVENT_TYPE,
				source: CHAT_SOURCE,
				id: first.eventId,
				room: roomId,
				mentions: told.map((mention, index) => ({
					number: index + 1,
					author: authors[index] ?? null,
					received_at: isoIn(mention.receivedAt, timeZone),
					link: linkOf(config, roomId, mention.eventId)
				})),
				...(more > 0 ? { more } : {})
			},
			untrusted: {
				...(roomName === null ? {} : { room_name: roomName }),
				messages: told.map((mention, index) => ({
					number: index + 1,
					...(authors[index] === null ? { author: mention.sender } : {}),
					...(mention.text === null ? {} : { text: mention.text })
				}))
			}
		},
		noted: {
			ids: { computed: { room: roomId }, untrusted: {} },
			names: {
				computed: { authors: [...new Set(addresses)] },
				untrusted: {
					...(roomName === null ? {} : { room_name: roomName }),
					...(foreign.length === 0 ? {} : { authors: [...new Set(foreign)] })
				}
			}
		}
	};
}

// Wakes an owner's assistant for the mentions of them that waited unread ten minutes, once for
// each room, out of their quiet hours, during which they wait for their end where they are. Each
// wake-up goes as any other does, within their hourly cap, kept from going twice and noted in their
// journal, and settles the mentions it carries, their words erased, whatever came of it. Gives how
// many it woke.
export async function wakeForMentions(deps: WakeDeps, owner: string): Promise<number> {
	const { config, db, clock, log } = deps;
	const due = new Date(clock.now().getTime() - UNREAD_MINUTES * 60_000);
	if (!(await withPrincipal(db, { id: owner }, (tx) => hasDueMentions(tx, owner, due)))) return 0;
	const rooms: { readonly roomId: string; readonly eventIds: readonly string[] }[] = [];
	const outcomes = await wakeFor(deps, owner, async (tx) => {
		const settings = await findOwnerSettings(tx, owner);
		const timeZone = settings.timeZone ?? config.timeZone;
		if (isQuietAt(quietHoursOf(settings.quiet, config.quietHours), timeZone, clock.now())) {
			return [];
		}
		const carried: Carried[] = [];
		for (const roomId of await listDueRooms(tx, owner, due)) {
			const [first, ...others] = await lockRoomMentions(tx, owner, roomId);
			if (first === undefined) continue;
			const eventIds = [first, ...others].map(({ eventId }) => eventId);
			rooms.push({ roomId, eventIds });
			carried.push({
				wakeup: wakeupOf(config, [first, ...others], timeZone),
				settle: (settling) => settleMentions(settling, owner, roomId, eventIds)
			});
		}
		return carried;
	});
	rooms.forEach(({ roomId, eventIds }, index) => {
		const outcome = outcomes[index];
		if (outcome === undefined) return;
		for (const eventId of eventIds) {
			log.info({ owner, roomId, eventId, reason: settledAs(outcome) }, 'mention settled');
		}
	});
	return outcomes.filter((outcome) => outcome === 'woken').length;
}
