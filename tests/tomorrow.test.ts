import { describe, expect, it } from 'vitest';

import { describeTomorrow } from '../src/agent/clock.js';

const at = (iso: string): Date => new Date(iso);

describe("tomorrow, as the owner's wall clock gives it", () => {
	it('is the Sunday of a Saturday, in words in the owner’s language and as ISO 8601 writes it', () => {
		// Saturday 10 October 2026, 06:43 in Paris
		const now = at('2026-10-10T04:43:00Z');
		expect(describeTomorrow(now, 'Europe/Paris', 'fr')).toEqual({
			words: 'dimanche 11 octobre 2026',
			iso: '2026-10-11'
		});
		expect(describeTomorrow(now, 'Europe/Paris', 'en')).toEqual({
			words: 'Sunday, October 11, 2026',
			iso: '2026-10-11'
		});
	});

	it('is the first day of the next month at the end of a month, and of the next year at the end of a year', () => {
		expect(describeTomorrow(at('2026-09-30T16:05:00Z'), 'Europe/Paris', 'fr')).toEqual({
			words: 'jeudi 1 octobre 2026',
			iso: '2026-10-01'
		});
		expect(describeTomorrow(at('2026-12-31T22:00:00Z'), 'UTC', 'en')).toEqual({
			words: 'Friday, January 1, 2027',
			iso: '2027-01-01'
		});
	});

	it('follows the day of the zone, which UTC may not have reached or may have passed', () => {
		// 23:30 UTC on Tuesday 6 October 2026: Wednesday already in Paris and Tokyo, Tuesday still in
		// New York
		const evening = at('2026-10-06T23:30:00Z');
		expect(describeTomorrow(evening, 'Europe/Paris', 'en').iso).toBe('2026-10-08');
		expect(describeTomorrow(evening, 'Asia/Tokyo', 'en').iso).toBe('2026-10-08');
		expect(describeTomorrow(evening, 'America/New_York', 'en').iso).toBe('2026-10-07');
		// 02:00 UTC on Wednesday 7 October: still Tuesday evening in New York
		expect(describeTomorrow(at('2026-10-07T02:00:00Z'), 'America/New_York', 'en')).toEqual({
			words: 'Wednesday, October 7, 2026',
			iso: '2026-10-07'
		});
	});

	it('is right on both sides of midnight in Los Angeles, which UTC passes seven hours before it', () => {
		// 23:30 on Tuesday 13 October there is already the 14th in UTC
		expect(describeTomorrow(at('2026-10-14T06:30:00Z'), 'America/Los_Angeles', 'en')).toEqual({
			words: 'Wednesday, October 14, 2026',
			iso: '2026-10-14'
		});
		// 00:30 on Wednesday 14 October there, an hour later, is the 14th in UTC as well
		expect(describeTomorrow(at('2026-10-14T07:30:00Z'), 'America/Los_Angeles', 'en')).toEqual({
			words: 'Thursday, October 15, 2026',
			iso: '2026-10-15'
		});
	});

	it('is right on both sides of midnight in Auckland, and gives the words of the day, not of its noon in UTC', () => {
		// 23:30 on Tuesday 13 October there is still the 13th in UTC, and so is 00:30 on the 14th, an
		// hour later. The noon of tomorrow in UTC is already the day after in Auckland, 13 hours ahead,
		// so words read in its zone would name the wrong day
		expect(describeTomorrow(at('2026-10-13T10:30:00Z'), 'Pacific/Auckland', 'en')).toEqual({
			words: 'Wednesday, October 14, 2026',
			iso: '2026-10-14'
		});
		expect(describeTomorrow(at('2026-10-13T11:30:00Z'), 'Pacific/Auckland', 'en')).toEqual({
			words: 'Thursday, October 15, 2026',
			iso: '2026-10-15'
		});
	});

	it('is the next day of the calendar when the clocks change, on days of 23 and of 25 hours', () => {
		// 23:30 on Saturday 28 March 2026 in Paris, the day before the clocks go forward: 24 hours later
		// is already the Monday
		expect(describeTomorrow(at('2026-03-28T22:30:00Z'), 'Europe/Paris', 'en')).toEqual({
			words: 'Sunday, March 29, 2026',
			iso: '2026-03-29'
		});
		// 00:30 on Sunday 25 October 2026 in Paris, the day the clocks go back: 24 hours later is still
		// that Sunday
		expect(describeTomorrow(at('2026-10-24T22:30:00Z'), 'Europe/Paris', 'en')).toEqual({
			words: 'Monday, October 26, 2026',
			iso: '2026-10-26'
		});
	});
});
