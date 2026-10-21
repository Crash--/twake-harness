import type { z } from 'zod';

import type { ToolOutcome } from './tools.js';

// The harness's question about the owner's permission for their assistant to act for them, which
// the platform's broker holds none of, or an expired one: its text, and the call it froze, which
// waits for their answer
export interface DelegationQuestion {
	readonly text: string;
	readonly pendingCallId: string;
}

// A read the harness makes of its own, for a brief or to check an answer, or why there is none: an
// application that needs a yes the owner did not give, here or on the platform, is not read, and
// nobody asks them for it. The day's read the platform's broker refused for want of their
// permission is the exception, while no brief waits for their answer about it: its call waits for
// them, under the harness's question.
export type Read<T> =
	| { readonly ok: true; readonly value: T }
	| {
			readonly ok: false;
			readonly reason: string;
			readonly status?: number;
			readonly question?: DelegationQuestion;
	  };

// The status a contract answered a call with, and its body, when it answered
function answerOf(result: unknown): { readonly status: number; readonly body: unknown } | null {
	if (typeof result !== 'object' || result === null) return null;
	const { status, body } = result as Record<string, unknown>;
	return typeof status === 'number' ? { status, body } : null;
}

// Why a call that would have waited for its owner was not made, as the contract tool tells a turn
// nobody attends
function notAskedReason(result: unknown): string | null {
	if (typeof result !== 'object' || result === null) return null;
	const { status, reasons } = result as Record<string, unknown>;
	return status === 'not_asked' && Array.isArray(reasons) ? reasons.join(',') : null;
}

// What a read of the harness's own came to, as the contract tool ran it: the body of a success that
// has the shape asked for, else why it is none
export function readOf<T>(
	{ result, final, pendingCallId }: ToolOutcome,
	schema: z.ZodType<T>
): Read<T> {
	if (final !== undefined && pendingCallId !== undefined) {
		return { ok: false, reason: 'delegation', question: { text: final, pendingCallId } };
	}
	const reason = notAskedReason(result);
	if (reason !== null) return { ok: false, reason };
	const answer = answerOf(result);
	if (answer === null || answer.status < 200 || answer.status >= 300) {
		return { ok: false, reason: 'failed', ...(answer === null ? {} : { status: answer.status }) };
	}
	const parsed = schema.safeParse(answer.body);
	if (!parsed.success) return { ok: false, reason: 'unreadable', status: answer.status };
	return { ok: true, value: parsed.data };
}
