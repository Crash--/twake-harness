import type { Config } from '../config.js';
import { listenerUserId } from '../suggestions/listener.js';
import { COMMANDS_EVENT_TYPE } from './commands.js';
import type { RoomEvent } from './messages.js';
import { isAssistantUserId } from './registration.js';

// What Twake Chat takes for a bot: an id that says so, or a member announcing its commands in the
// room (MSC4332, under its unstable and stable names)
const BOT_ID_PATTERN = /^@(bot_|hermes_)/;
const BOT_COMMANDS_TYPES = [COMMANDS_EVENT_TYPE, 'm.bot.commands'];

// The bots of a room, asked no yes: the ids that say so on our homeserver only (anyone chooses
// their own localpart on another), and the members announcing their commands, each keyed by
// itself, which the homeserver enforces
export function botsOf(state: readonly RoomEvent[], serverName: string): Set<string> {
	const bots = new Set<string>();
	for (const event of state) {
		const id = event.state_key ?? '';
		if (BOT_COMMANDS_TYPES.includes(event.type ?? '') && id === event.sender) bots.add(id);
		else if (
			event.type === 'm.room.member' &&
			BOT_ID_PATTERN.test(id) &&
			id.endsWith(`:${serverName}`)
		)
			bots.add(id);
	}
	return bots;
}

// An assistant or the listener, the harness's own accounts: neither is asked for a yes, whatever it
// does in a room
export function isPlatformAccount(config: Config, userId: string): boolean {
	return isAssistantUserId(config, userId) || userId === listenerUserId(config);
}
