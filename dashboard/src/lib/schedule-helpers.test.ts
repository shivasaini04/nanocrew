/**
 * Found 2026-09-23 on Crawler: the Schedule tab walked crons on the browser's clock
 * while the server reads them in UTC, so `0 9 * * *` previewed as "9:00 AM" to someone
 * in IST and actually fired at 2:30 PM. The presets had the same flaw — "Daily 9 AM" was
 * a raw UTC cron. These pin both halves: previews are UTC, presets convert from local.
 */
import { describe, expect, it } from 'vitest';
import { parseCron, localTimeToUtcCron } from './schedule-helpers';

describe('parseCron', () => {
    it('computes fire times in UTC, whatever the viewer\'s zone', () => {
        const r = parseCron('0 9 * * *');
        if (!('nextFires' in r)) throw new Error(r.error);
        for (const d of r.nextFires) {
            expect(d.getUTCHours()).toBe(9);
            expect(d.getUTCMinutes()).toBe(0);
        }
    });

    it('describes the weekday entry the agent wrote, in UTC', () => {
        const r = parseCron('0 0,6,12,18 * * 1-5');
        if (!('description' in r)) throw new Error(r.error);
        expect(r.description).toBe('Every weekday (Mon–Fri) at 12:00 AM, 6:00 AM, 12:00 PM, 6:00 PM');
        for (const d of r.nextFires) expect([1, 2, 3, 4, 5]).toContain(d.getUTCDay());
    });
});

describe('localTimeToUtcCron', () => {
    it('produces a cron whose next fire lands on the requested local time', () => {
        const cron = localTimeToUtcCron(9, 0, null);
        const r = parseCron(cron);
        if (!('nextFires' in r)) throw new Error(r.error);
        for (const d of r.nextFires) {
            expect(d.getHours()).toBe(9);
            expect(d.getMinutes()).toBe(0);
        }
    });

    it('keeps the local weekday when the UTC day differs', () => {
        // 3 AM local is the previous UTC day for any zone east of UTC+3.
        const cron = localTimeToUtcCron(3, 0, [1]);
        const r = parseCron(cron);
        if (!('nextFires' in r)) throw new Error(r.error);
        for (const d of r.nextFires) {
            expect(d.getDay()).toBe(1);
            expect(d.getHours()).toBe(3);
        }
    });
});
