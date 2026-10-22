import type { Tx } from '../db/client.js';
import {
	isSource,
	listenableOf,
	LISTENED_BY_DEFAULT,
	SOURCES,
	type Source,
	type SourceRegistry
} from './sources.js';

// What the owner chose for a source: to have their assistant listen there, to stop it listening
// there, or nothing yet, their assistant then listening there by default or not
export type ListeningChoice = 'listening' | 'stopped' | 'none';

// Whether the owner's assistant listens to a source of the deployment's registry: as they last
// chose, or by its default
export async function isListening(
	tx: Tx,
	owner: string,
	source: Source,
	registry: SourceRegistry
): Promise<boolean> {
	return (await listListened(tx, owner, registry)).includes(source);
}

// Keeps the owner's choice for a source, in place of the one before
export async function saveListening(
	tx: Tx,
	owner: string,
	source: Source,
	listening: boolean
): Promise<void> {
	await tx.sql`
		insert into listened_sources (owner, source, listening)
		values (${owner}, ${source}, ${listening})
		on conflict (owner, source) do update set listening = excluded.listening`;
}

// Has the owner's assistant listen to a source, unless they chose for it already
export async function listenUnlessChosen(tx: Tx, owner: string, source: Source): Promise<void> {
	await tx.sql`
		insert into listened_sources (owner, source, listening)
		values (${owner}, ${source}, true)
		on conflict (owner, source) do nothing`;
}

// What the owner chose for each source, as they last chose
export async function findChoices(
	tx: Tx,
	owner: string
): Promise<Readonly<Record<Source, ListeningChoice>>> {
	const rows = await tx.sql<{ source: string; listening: boolean }[]>`
		select source, listening from listened_sources where owner = ${owner}`;
	const choices = Object.fromEntries(SOURCES.map((source) => [source, 'none'])) as Record<
		Source,
		ListeningChoice
	>;
	for (const { source, listening } of rows) {
		if (isSource(source)) choices[source] = listening ? 'listening' : 'stopped';
	}
	return choices;
}

// The sources of the deployment's registry the owner's assistant listens to, of those it may listen
// to: those they chose to, and those they never chose for that it listens to by default. A choice
// kept for a source the deployment closed since counts for nothing while it stays closed.
export async function listListened(
	tx: Tx,
	owner: string,
	registry: SourceRegistry
): Promise<Source[]> {
	const choices = await findChoices(tx, owner);
	return listenableOf(registry).filter(
		(source) =>
			choices[source] === 'listening' ||
			(choices[source] === 'none' && LISTENED_BY_DEFAULT.includes(source))
	);
}
