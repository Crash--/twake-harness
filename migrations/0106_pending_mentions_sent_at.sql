-- When the homeserver received each pending mention from its author, by its clock (the harness's
-- spec #306 on listening to the applications, #311): a public read receipt of the owner settles the
-- mentions of its message's thread sent no later than that message, and a message of theirs in the
-- room those sent before it, both times read from the homeserver. A row kept before takes the time
-- the matrix role received it.
--
-- Pending mentions are rows under forced row-level security. The table owner lifts the force for the
-- one statement that times them, inside the migration's transaction whose lock on the table keeps
-- every other session out, and puts it back.
alter table pending_mentions add column sent_at timestamptz;

alter table pending_mentions no force row level security;

update pending_mentions set sent_at = received_at;

alter table pending_mentions force row level security;

alter table pending_mentions alter column sent_at set not null;
