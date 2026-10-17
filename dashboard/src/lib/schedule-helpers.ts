/**
 * Schedule parsing + preview helpers.
 *
 * Supports two value formats:
 *   - Interval shorthand: "5m" / "15m" / "1h" / "4h" / "24h" / "7d"
 *   - 5-field cron expression: "0 9 * * *"
 *   - Literal "manual" (means: never auto-fire)
 *
 * Returns a description + the next 5 fire times so the UI can preview
 * exactly when the schedule will run.
 *
 * Crons are UTC. The server pins the parser to UTC (agent-scheduler.ts calcNextRun), so
 * this computes fires in UTC too and leaves conversion to the display. It used to walk the
 * browser's local clock instead, which showed `0 9 * * *` as "9:00 AM" to someone in IST
 * while the server ran it at 2:30 PM their time.
 */

export interface SchedulePreview {
    description: string;
    nextFires: Date[];
    error: null;
}
export interface ScheduleError {
    error: string;
}
export type ScheduleParseResult = SchedulePreview | ScheduleError;

// ─── Cron field parsing ──────────────────────────────────────────────────────

const DAYS   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseField(field: string, min: number, max: number): number[] | null {
    const values = new Set<number>();
    for (const part of field.split(',')) {
        if (part === '*') {
            for (let i = min; i <= max; i++) values.add(i);
        } else if (part.startsWith('*/')) {
            const step = parseInt(part.slice(2));
            if (isNaN(step) || step < 1) return null;
            for (let i = min; i <= max; i += step) values.add(i);
        } else if (part.includes('/')) {
            const [range, stepStr] = part.split('/');
            const step = parseInt(stepStr);
            if (isNaN(step) || step < 1) return null;
            const [lo, hi] = range.includes('-') ? range.split('-').map(Number) : [parseInt(range), max];
            if (isNaN(lo) || isNaN(hi)) return null;
            for (let i = lo; i <= hi; i += step) values.add(i);
        } else if (part.includes('-')) {
            const [lo, hi] = part.split('-').map(Number);
            if (isNaN(lo) || isNaN(hi) || lo > hi) return null;
            for (let i = lo; i <= hi; i++) values.add(i);
        } else {
            const v = parseInt(part);
            if (isNaN(v)) return null;
            values.add(v);
        }
    }
    const arr = [...values].sort((a, b) => a - b);
    if (arr.some(v => v < min || v > max)) return null;
    return arr;
}

function fmt12(h: number, m: number): string {
    const ampm = h < 12 ? 'AM' : 'PM';
    const h12  = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

/** " at 12:00 AM, 6:00 AM, 12:00 PM UTC" — for a handful of fixed times at one minute. */
function hourList(hours: number[], minutes: number[]): string {
    if (minutes.length !== 1 || hours.length > 6) return '';
    return ` at ${hours.map(h => fmt12(h, minutes[0])).join(', ')}`;
}

function describeCron(
    minF: string, hourF: string, domF: string, monF: string, dowF: string,
    minutes: number[], hours: number[], doms: number[], _months: number[], dows: number[],
): string {
    if (minF === '*' && hourF === '*' && domF === '*' && monF === '*' && dowF === '*') return 'Every minute';
    if (minF.startsWith('*/') && hourF === '*' && domF === '*' && monF === '*' && dowF === '*') {
        const n = parseInt(minF.slice(2));
        return n === 1 ? 'Every minute' : `Every ${n} minutes`;
    }
    if (hourF === '*' && domF === '*' && monF === '*' && dowF === '*' && minutes.length === 1) {
        return `Every hour at :${String(minutes[0]).padStart(2, '0')}`;
    }
    const singleHour = hours.length === 1;
    const singleMin  = minutes.length === 1;
    const timePart   = (singleHour && singleMin) ? ` at ${fmt12(hours[0], minutes[0])}` : '';
    if (domF === '*' && monF === '*' && dowF === '*' && singleHour && singleMin) return `Every day${timePart}`;
    if (dowF === '1-5' && domF === '*' && monF === '*') return `Every weekday (Mon–Fri)${timePart || hourList(hours, minutes)}`;
    if (dowF === '0,6' && domF === '*' && monF === '*') return `Every weekend${timePart || hourList(hours, minutes)}`;
    if (domF === '*' && monF === '*' && dowF === '*' && singleMin && hours.length > 1 && hours.length <= 6) {
        return `Every day${hourList(hours, minutes)}`;
    }
    if (domF === '*' && monF === '*' && dowF !== '*') {
        const dayNames = dows.map(d => DAYS[d]).join(', ');
        const every = dows.length === 7 ? 'Every day' : `Every ${dayNames}`;
        return `${every}${timePart}`;
    }
    if (domF !== '*' && monF === '*' && dowF === '*' && singleHour && singleMin) {
        return `Monthly on day ${doms.join(', ')}${timePart}`;
    }
    const parts = [
        minF  === '*' ? 'every min'  : `min ${minF}`,
        hourF === '*' ? 'every hour' : `hour ${hourF}`,
        domF  === '*' ? ''           : `dom ${domF}`,
        monF  === '*' ? ''           : `month ${MONTHS[parseInt(monF) - 1] ?? monF}`,
        dowF  === '*' ? ''           : `${DAYS[parseInt(dowF)] ?? dowF}`,
    ].filter(Boolean);
    return parts.join(', ');
}

// ─── Public: parse any schedule string ───────────────────────────────────────

/**
 * Detect whether a schedule value is interval-shorthand, a cron expression, or "manual".
 */
export function classifySchedule(value: string): 'manual' | 'interval' | 'cron' {
    const v = value.trim().toLowerCase();
    if (!v || v === 'manual') return 'manual';
    // Cron expressions have exactly 5 whitespace-separated fields
    if (v.split(/\s+/).length === 5) return 'cron';
    return 'interval';
}

/**
 * Parse an interval shorthand string like "5m", "1h", "24h", "7d" → minutes.
 * Returns null if invalid.
 */
export function parseIntervalToMinutes(value: string): number | null {
    // Same forms the server accepts: "1h", "1 hour", "every 30 minutes", "2 days".
    const m = value.trim().toLowerCase().replace(/^every\s+/, '').match(/^(\d+)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)?$/);
    if (!m) return null;
    const n = parseInt(m[1]);
    if (isNaN(n) || n < 1) return null;
    const unit = m[2] ?? 'm';
    if (unit.startsWith('m')) return n;
    if (unit.startsWith('h')) return n * 60;
    if (unit.startsWith('d')) return n * 60 * 24;
    return n;
}

export function parseCron(expr: string): ScheduleParseResult {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return { error: 'Expected 5 fields: minute hour day month weekday' };
    const [minF, hourF, domF, monF, dowF] = parts;
    const minutes  = parseField(minF,  0, 59);
    const hours    = parseField(hourF, 0, 23);
    const doms     = parseField(domF,  1, 31);
    const months   = parseField(monF,  1, 12);
    const dows     = parseField(dowF,  0, 6);
    if (!minutes || !hours || !doms || !months || !dows) {
        return { error: 'Invalid field value — check ranges and syntax' };
    }
    const description = describeCron(minF, hourF, domF, monF, dowF, minutes, hours, doms, months, dows);
    const nextFires: Date[] = [];
    const domStar = domF === '*';
    const dowStar = dowF === '*';
    const cursor = new Date();
    cursor.setUTCSeconds(0, 0);
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    const limit = 60 * 24 * 366;
    for (let i = 0; i < limit && nextFires.length < 5; i++) {
        const mo = cursor.getUTCMonth() + 1, dom = cursor.getUTCDate(), dow = cursor.getUTCDay();
        const hr = cursor.getUTCHours(), mn = cursor.getUTCMinutes();
        const monthOk = months.includes(mo);
        const domOk = domStar ? true : doms.includes(dom);
        const dowOk = dowStar ? true : dows.includes(dow);
        const dayOk = (!domStar && !dowStar) ? (domOk || dowOk) : domOk && dowOk;
        if (monthOk && dayOk && hours.includes(hr) && minutes.includes(mn)) {
            nextFires.push(new Date(cursor));
        }
        cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    }
    return { description, nextFires, error: null };
}

export function previewInterval(value: string): ScheduleParseResult {
    const mins = parseIntervalToMinutes(value);
    if (mins === null) return { error: 'Enter a duration like 5m, 15m, 1h, 24h, or 7d' };
    const description = mins === 1 ? 'Every minute'
        : mins < 60     ? `Every ${mins} minutes`
        : mins === 60   ? 'Every hour'
        : mins % 1440 === 0 ? (mins === 1440 ? 'Every day' : `Every ${mins / 1440} days`)
        : mins % 60 === 0 ? `Every ${mins / 60} hours`
        : `Every ${mins} minutes (${(mins / 60).toFixed(1)} hours)`;
    // Illustrative only: the server counts an interval from the entry's last completed
    // run, not from now, so a saved entry's real next run comes from the schedule API.
    const now = new Date();
    const nextFires = Array.from({ length: 5 }, (_, i) => {
        const d = new Date(now);
        d.setSeconds(0, 0);
        d.setMinutes(d.getMinutes() + mins * (i + 1));
        return d;
    });
    return { description, nextFires, error: null };
}

/**
 * Universal: classify the value, parse with the right parser, return preview.
 */
export function previewSchedule(value: string, enabled: boolean): ScheduleParseResult {
    if (!enabled) return { description: 'Disabled — won\'t fire automatically', nextFires: [], error: null };
    const kind = classifySchedule(value);
    if (kind === 'manual') return { description: 'Manual only — never auto-fires', nextFires: [], error: null };
    if (kind === 'cron')   return parseCron(value);
    return previewInterval(value);
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

export function fmtFireDate(d: Date): string {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const tmrw = new Date(now); tmrw.setDate(now.getDate() + 1);
    const isTomorrow = d.toDateString() === tmrw.toDateString();
    const time = fmt12(d.getHours(), d.getMinutes());
    if (sameDay)    return `Today ${time}`;
    if (isTomorrow) return `Tomorrow ${time}`;
    return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()}, ${time}`;
}

// ─── Presets ──────────────────────────────────────────────────────────────────

export const INTERVAL_PRESETS = [
    { label: '5 min',   value: '5m'  },
    { label: '15 min',  value: '15m' },
    { label: '30 min',  value: '30m' },
    { label: '1 hour',  value: '1h'  },
    { label: '4 hours', value: '4h'  },
    { label: '6 hours', value: '6h'  },
    { label: '24 hours',value: '24h' },
    { label: '7 days',  value: '7d'  },
];

// ─── Local time ↔ UTC ─────────────────────────────────────────────────────────

/** The viewer's zone as a short label, e.g. "IST" or "GMT+5:30". */
export function localZoneLabel(): string {
    try {
        const part = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
            .formatToParts(new Date()).find(p => p.type === 'timeZoneName');
        if (part?.value) return part.value;
    } catch { /* fall through */ }
    const off = -new Date().getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const a = Math.abs(off);
    return `GMT${sign}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, '0')}` : ''}`;
}

/** True when the viewer is on UTC, so showing both would just repeat the same time. */
export function viewerIsUtc(): boolean {
    return new Date().getTimezoneOffset() === 0;
}

/**
 * A cron, in UTC, that fires at hour:minute of the VIEWER's clock on the given weekdays
 * (0 = Sunday; null = every day).
 *
 * The day list moves with the clock: 3 AM Monday in IST is 9:30 PM Sunday UTC, so a
 * "Mondays" preset has to say Sunday in UTC terms or it fires a day late.
 */
export function localTimeToUtcCron(hour: number, minute: number, localDays: number[] | null, now: Date = new Date()): string {
    const local = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
    const localDayIndex = Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()) / 86_400_000;
    const utcDayIndex = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) / 86_400_000;
    const shift = utcDayIndex - localDayIndex; // -1, 0 or +1
    const days = localDays === null ? '*'
        : [...new Set(localDays.map(d => (d + shift + 7) % 7))].sort((a, b) => a - b).join(',');
    return `${local.getUTCMinutes()} ${local.getUTCHours()} * * ${days}`;
}

/** A fire time in the viewer's zone, with UTC alongside unless they are the same. */
export function fmtFireBoth(d: Date): string {
    const local = `${fmtFireDate(d)} ${localZoneLabel()}`;
    if (viewerIsUtc()) return local;
    return `${local}  ·  ${fmt12(d.getUTCHours(), d.getUTCMinutes())} UTC`;
}

/**
 * Presets phrased in the viewer's own time, converted to UTC when picked.
 *
 * The old presets were raw UTC crons labelled "Daily 9 AM", which is 2:30 PM for someone
 * in IST. The label was only true for someone sitting on UTC.
 */
export function cronPresets(now: Date = new Date()): { label: string; value: string }[] {
    return [
        { label: 'Every hour',    value: '0 * * * *' },
        { label: 'Every 6 hours', value: '0 */6 * * *' },
        { label: 'Daily 9 AM',    value: localTimeToUtcCron(9, 0, null, now) },
        { label: 'Daily 8 PM',    value: localTimeToUtcCron(20, 0, null, now) },
        { label: 'Weekdays 9 AM', value: localTimeToUtcCron(9, 0, [1, 2, 3, 4, 5], now) },
        { label: 'Mondays 9 AM',  value: localTimeToUtcCron(9, 0, [1], now) },
    ];
}

/** The viewer's own IANA zone, e.g. "Asia/Kolkata" — the default for a new timer. */
export function browserTimeZone(): string {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** Zones offered in the timer picker. The timer's current zone is always added if missing. */
export const TIMEZONE_CHOICES = [
    'UTC', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney',
    'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles',
];

/** "Thu 24 Sep, 09:00" on the given zone's clock. */
export function fmtInZone(d: Date, timeZone: string): string {
    try {
        return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    } catch {
        return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    }
}

/** Presets for a timer that carries its own zone — plain crons, read on that zone's clock. */
export const ZONED_CRON_PRESETS = [
    { label: 'Every hour',     value: '0 * * * *' },
    { label: 'Every 6 hours',  value: '0 */6 * * *' },
    { label: 'Daily 9 AM',     value: '0 9 * * *' },
    { label: 'Daily 8 PM',     value: '0 20 * * *' },
    { label: 'Weekdays 9 AM',  value: '0 9 * * 1-5' },
    { label: 'Weekends 10 AM', value: '0 10 * * 0,6' },
    { label: 'Mondays 9 AM',   value: '0 9 * * 1' },
];

/** What each cycle type does, in plain words rather than the enum. */
export const CYCLE_TYPE_INFO: Record<string, { label: string; desc: string }> = {
    work:          { label: 'Work',          desc: 'Its main job, driven by its goals' },
    lead_search:   { label: 'Lead search',   desc: 'Sweep lead sources for new candidates' },
    send_outreach: { label: 'Send outreach', desc: 'Draft and send outreach' },
    followup:      { label: 'Follow-up',     desc: 'Follow up on earlier outreach' },
    checkin:       { label: 'Check-in',      desc: 'Report back to you' },
    self_improve:  { label: 'Self-improve',  desc: 'Tidy memory and learn from recent runs' },
    custom:        { label: 'Custom',        desc: 'A general-purpose run' },
};

/** The types an entry can have: the same list the server accepts from an agent. */
export const SCHEDULABLE_TYPES = Object.keys(CYCLE_TYPE_INFO);

