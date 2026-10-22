-- The pending mentions of each owner (the harness's spec #306 on listening to the applications,
-- #310): one row per owner and message of an unencrypted room the listener is in that names them
-- in its m.mentions, while they listen to the Chat. The worker role's minute pass wakes them for a
-- room's once the oldest is ten minutes old, out of their quiet hours, and deletes each one it
-- settles, text included, in the transaction that settles it. They go with their /delete.

create table pending_mentions (
	owner text not null,
	room_id text not null,
	event_id text not null,
	-- The root of the message's thread, or main for the room's main timeline, as read receipts name
	-- them
	thread text not null,
	-- Who wrote it, by their Matrix id
	sender text not null,
	-- When the matrix role received it, by its own clock
	received_at timestamptz not null,
	-- What people wrote, cut, which the model is shown as data: the message's words, none for a
	-- message without words, and the room's name, none for a room without one
	text text,
	room_name text,
	primary key (owner, room_id, event_id)
);

-- The minute pass looks for each owner's oldest
create index pending_mentions_received_idx on pending_mentions (owner, received_at);

-- Readable and writable by its owner alone, as their journal is
alter table pending_mentions enable row level security;
alter table pending_mentions force row level security;
create policy pending_mentions_owner on pending_mentions
	using (owner = current_setting('app.principal', true))
	with check (owner = current_setting('app.principal', true));
