import type { Config } from '../config.js';
import { labelOf, type DomainDescriptions } from '../contracts/domains.js';
import type { Locale, Messages } from '../i18n/messages.js';

// The applications an owner's assistant may listen to, by the names their consents give them, in
// the order a brief offers them: what one of them publishes for the owner wakes the assistant only
// while it listens there
export const SOURCES = ['calendar', 'tasks', 'mail', 'drive', 'chat'] as const;
export type Source = (typeof SOURCES)[number];

// The source the calendar producer gave the invitations it published, which the harness gives
// Calendar's notifications and keeps their wake-ups by
export const CALENDAR_SOURCE = 'twake://calendar';

// The source the harness gives the wake-ups of the mentions it hears in the Chat: its own, which
// no producer publishes
export const CHAT_SOURCE = 'twake://chat';

// What the harness knows of a source
export interface SourceEntry {
	readonly source: Source;
	// Whether its owner may have their assistant listen there or not
	readonly listenable: boolean;
	// Whether their assistant listens there until they choose otherwise
	readonly byDefault: boolean;
	// The application their assistant may read, at the read level, before it listens there, which
	// their yes to listening allows: none where listening reads nothing through a contract
	readonly reads: string | null;
	// What its producer publishes its activities under, which wake their assistant while it listens
	// there, and by none other: none where only their brief tells them what arrives
	readonly publishedAs: readonly string[];
	// Its source offer, the question a brief may ask its owner once, after it, of having their
	// assistant listen there, in their language, the application named as they read it and the
	// listener as the members of its rooms see it: none where no brief makes one
	readonly offer?: (messages: Messages, application: string, listener: string) => string;
}

// Every source, as a deployment has it, in the order of SOURCES
export type SourceRegistry = readonly SourceEntry[];

// Calendar and Tasks are listened to by default: the harness takes the activities their producers
// publish, Calendar's notifications under the source it names them by. Mail and Drive publish none it
// takes, so that listening there only has the brief read them: Mail waits for the owner's yes to the
// question of their first brief, and Drive for their asking. The Chat's are the mentions the harness
// hears there itself, under its own source, and its listening reads nothing through a contract: it
// waits for the owner's yes to the source offer of a brief, or for their asking, where the deployment
// opened it.
const ENTRIES: Readonly<Record<Source, Omit<SourceEntry, 'source'>>> = {
	calendar: {
		listenable: true,
		byDefault: true,
		reads: 'calendar',
		publishedAs: [CALENDAR_SOURCE]
	},
	tasks: { listenable: true, byDefault: true, reads: 'tasks', publishedAs: ['twake://tasks'] },
	mail: { listenable: true, byDefault: false, reads: 'mail', publishedAs: [] },
	drive: { listenable: true, byDefault: false, reads: 'drive', publishedAs: [] },
	chat: {
		listenable: true,
		byDefault: false,
		reads: null,
		publishedAs: [CHAT_SOURCE],
		offer: (messages, application, listener) =>
			messages.sources.chatSourceOffer(application, listener)
	}
};

// The sources as a deployment has them: the Chat cannot be listened to unless it opened it, with
// CHAT_MENTIONS_ENABLED
export function sourceRegistryOf(config: Pick<Config, 'chatMentions'>): SourceRegistry {
	return SOURCES.map((source) => ({
		source,
		...ENTRIES[source],
		...(source === 'chat' && !config.chatMentions.enabled ? { listenable: false } : {})
	}));
}

// The sources of a registry their owner may have their assistant listen to or not
export function listenableOf(registry: SourceRegistry): Source[] {
	return registry.filter((entry) => entry.listenable).map((entry) => entry.source);
}

// The listenable sources their assistant listens to unless they said otherwise
export const LISTENED_BY_DEFAULT: readonly Source[] = SOURCES.filter(
	(source) => ENTRIES[source].byDefault
);

export function isSource(value: string): value is Source {
	return (SOURCES as readonly string[]).includes(value);
}

export function isListenable(registry: SourceRegistry, value: string): value is Source {
	return (listenableOf(registry) as string[]).includes(value);
}

// The application a source's listening allows its assistant to read, if any
export function readDomainOf(source: Source): string | null {
	return ENTRIES[source].reads;
}

// The source of a registry an activity was published under, while it may be listened to, or null
// for one nobody listens to
export function sourceOfActivity(registry: SourceRegistry, published: string): Source | null {
	const entry = registry.find(
		({ listenable, publishedAs }) => listenable && publishedAs.includes(published)
	);
	return entry?.source ?? null;
}

// Whether what a source publishes for its owner wakes their assistant while it listens there
export function wakesAssistant(source: Source): boolean {
	return ENTRIES[source].publishedAs.length > 0;
}

// What the producers of the sources given publish their activities under
export function publishedUnder(sources: readonly Source[]): string[] {
	return SOURCES.filter((source) => sources.includes(source)).flatMap(
		(source) => ENTRIES[source].publishedAs
	);
}

// The names the harness gives the applications no contract of the catalog names, in every
// language: the Chat's, whose mentions it hears itself
const OWN_NAMES: Readonly<Partial<Record<Source, string>>> = { chat: 'Twake Chat' };

// An application named as its owner reads it, in their language: as the catalog names it, or else
// as the harness does
export function sourceName(
	domains: DomainDescriptions,
	source: Source,
	locale: Locale,
	fallback: Locale
): string {
	const own = OWN_NAMES[source];
	return own === undefined || domains.has(source)
		? labelOf(domains, source, 'read', locale, fallback).name
		: own;
}

// The harness's own words that confirm the owner's choice for a source, in their language, the
// application named as they read it: what reaches them in an application that wakes no
// assistant, such as Mail or Drive, only their brief tells them of; listening to the Chat says
// where their assistant hears the mentions of them, which includes the channels the listener, named
// as their members see it, is in, and its assistant reads nothing there once it stops
export function listeningSaid(
	messages: Messages,
	source: Source,
	application: string,
	listening: boolean,
	listener: string
): string {
	const { sources } = messages;
	if (source === 'chat') {
		return listening
			? sources.listeningToChat(application, listener)
			: sources.notListeningToChat(application);
	}
	if (wakesAssistant(source)) {
		return listening ? sources.listening(application) : sources.notListening(application);
	}
	return listening
		? sources.listeningForBrief(application)
		: sources.notListeningForBrief(application);
}
