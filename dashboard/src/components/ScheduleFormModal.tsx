import { useState, useMemo } from 'react'
import { Calendar, X, AlertCircle, Loader2 } from 'lucide-react'
import { useTasksStore } from '../stores/tasksStore'

interface ScheduleFormModalProps {
    onClose: () => void;
    onSuccess: () => void;
}

// ── Cron parser ───────────────────────────────────────────────────────────────

const DAYS   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function parseField(field: string, min: number, max: number): number[] | null {
    const values = new Set<number>()
    for (const part of field.split(',')) {
        if (part === '*') {
            for (let i = min; i <= max; i++) values.add(i)
        } else if (part.startsWith('*/')) {
            const step = parseInt(part.slice(2))
            if (isNaN(step) || step < 1) return null
            for (let i = min; i <= max; i += step) values.add(i)
        } else if (part.includes('/')) {
            const [range, stepStr] = part.split('/')
            const step = parseInt(stepStr)
            if (isNaN(step) || step < 1) return null
            const [lo, hi] = range.includes('-') ? range.split('-').map(Number) : [parseInt(range), max]
            if (isNaN(lo) || isNaN(hi)) return null
            for (let i = lo; i <= hi; i += step) values.add(i)
        } else if (part.includes('-')) {
            const [lo, hi] = part.split('-').map(Number)
            if (isNaN(lo) || isNaN(hi) || lo > hi) return null
            for (let i = lo; i <= hi; i++) values.add(i)
        } else {
            const v = parseInt(part)
            if (isNaN(v)) return null
            values.add(v)
        }
    }
    const arr = [...values].sort((a, b) => a - b)
    if (arr.some(v => v < min || v > max)) return null
    return arr
}

interface CronPreview {
    description: string;
    nextFires: Date[];
    error: null;
}
interface CronError {
    error: string;
}

function parseCron(expr: string): CronPreview | CronError {
    const parts = expr.trim().split(/\s+/)
    if (parts.length !== 5) return { error: 'Expected 5 fields: minute hour day month weekday' }

    const [minF, hourF, domF, monF, dowF] = parts
    const minutes  = parseField(minF,  0, 59)
    const hours    = parseField(hourF, 0, 23)
    const doms     = parseField(domF,  1, 31)
    const months   = parseField(monF,  1, 12)
    const dows     = parseField(dowF,  0, 6)

    if (!minutes || !hours || !doms || !months || !dows)
        return { error: 'Invalid field value — check ranges and syntax' }

    // Human-readable description
    const description = describeCron(minF, hourF, domF, monF, dowF, minutes, hours, doms, months, dows)

    // Next 5 fire times — walk minute-by-minute from now (cap at 1 year of minutes)
    const nextFires: Date[] = []
    const domStar = domF === '*'
    const dowStar = dowF === '*'
    const now = new Date()
    const cursor = new Date(now)
    cursor.setSeconds(0, 0)
    cursor.setMinutes(cursor.getMinutes() + 1) // start 1 minute from now

    const limit = 60 * 24 * 366 // minutes in a year
    for (let i = 0; i < limit && nextFires.length < 5; i++) {
        const mo = cursor.getMonth() + 1
        const dom = cursor.getDate()
        const dow = cursor.getDay()
        const hr  = cursor.getHours()
        const mn  = cursor.getMinutes()

        const monthOk = months.includes(mo)
        // Standard cron: if both dom and dow are restricted, either match triggers
        const domOk = domStar ? true : doms.includes(dom)
        const dowOk = dowStar ? true : dows.includes(dow)
        const dayOk = (!domStar && !dowStar) ? (domOk || dowOk) : domOk && dowOk

        if (monthOk && dayOk && hours.includes(hr) && minutes.includes(mn)) {
            nextFires.push(new Date(cursor))
        }
        cursor.setMinutes(cursor.getMinutes() + 1)
    }

    return { description, nextFires, error: null }
}

function fmt12(h: number, m: number): string {
    const ampm = h < 12 ? 'AM' : 'PM'
    const h12  = h === 0 ? 12 : h > 12 ? h - 12 : h
    return `${h12}:${String(m).padStart(2, '0')} ${ampm}`
}

function describeCron(
    minF: string, hourF: string, domF: string, monF: string, dowF: string,
    minutes: number[], hours: number[], _doms: number[], _months: number[], dows: number[]
): string {
    // Every minute
    if (minF === '*' && hourF === '*' && domF === '*' && monF === '*' && dowF === '*')
        return 'Every minute'

    // Every N minutes: */N * * * *
    if (minF.startsWith('*/') && hourF === '*' && domF === '*' && monF === '*' && dowF === '*') {
        const n = parseInt(minF.slice(2))
        return n === 1 ? 'Every minute' : `Every ${n} minutes`
    }

    // Every hour at :MM  →  M * * * *
    if (hourF === '*' && domF === '*' && monF === '*' && dowF === '*' && minutes.length === 1)
        return `Every hour at :${String(minutes[0]).padStart(2, '0')}`

    const singleHour = hours.length === 1
    const singleMin  = minutes.length === 1
    const timePart   = (singleHour && singleMin) ? ` at ${fmt12(hours[0], minutes[0])}` : ''

    // Every day at H:MM  →  M H * * *
    if (domF === '*' && monF === '*' && dowF === '*' && singleHour && singleMin)
        return `Every day${timePart}`

    // Specific weekday(s)  →  M H * * D
    if (domF === '*' && monF === '*' && dowF !== '*') {
        const dayNames = dows.map(d => DAYS[d]).join(', ')
        const every = dows.length === 7 ? 'Every day' : `Every ${dayNames}`
        return `${every}${timePart}`
    }

    // Monthly on day D  →  M H D * *
    if (domF !== '*' && monF === '*' && dowF === '*' && singleHour && singleMin)
        return `Monthly on day ${_doms.join(', ')}${timePart}`

    // Weekday shortcuts
    if (dowF === '1-5' && domF === '*' && monF === '*' && singleHour && singleMin)
        return `Every weekday (Mon–Fri)${timePart}`
    if (dowF === '0,6' && domF === '*' && monF === '*' && singleHour && singleMin)
        return `Every weekend${timePart}`

    // Fallback: field breakdown
    const parts = [
        minF  === '*' ? 'every min'    : `min ${minF}`,
        hourF === '*' ? 'every hour'   : `hour ${hourF}`,
        domF  === '*' ? ''             : `dom ${domF}`,
        monF  === '*' ? ''             : `month ${MONTHS[parseInt(monF) - 1] ?? monF}`,
        dowF  === '*' ? ''             : `${DAYS[parseInt(dowF)] ?? dowF}`,
    ].filter(Boolean)
    return parts.join(', ')
}

function fmtDate(d: Date): string {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()}, ${fmt12(d.getHours(), d.getMinutes())}`
}

// ── Schedule preview component ────────────────────────────────────────────────

function CronPreviewBox({ expr }: { expr: string }) {
    const result = useMemo(() => parseCron(expr), [expr])

    if (!('description' in result)) {
        return (
            <div style={{ padding: '10px 14px', borderRadius: '8px', background: 'var(--cr-error-low)', border: '1px solid var(--cr-error-line)', fontSize: '12px', color: 'var(--cr-error)' }}>
                ⚠ {result.error}
            </div>
        )
    }

    return (
        <div style={{ padding: '12px 14px', borderRadius: '8px', background: 'var(--cr-tint-3)', border: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ fontSize: '12px', color: 'var(--accent-cyan)', fontWeight: 600 }}>
                {result.description}
            </div>
            {result.nextFires.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '2px' }}>Next fires</div>
                    {result.nextFires.map((d: Date, i: number) => (
                        <div key={i} style={{ fontSize: '11px', color: 'var(--text-secondary)', fontFamily: 'monospace', display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ color: 'var(--text-muted)', minWidth: '14px' }}>{i + 1}.</span>
                            {fmtDate(d)}
                        </div>
                    ))}
                </div>
            )}
            {result.nextFires.length === 0 && (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>No upcoming fires found within the next year</div>
            )}
        </div>
    )
}

function IntervalPreviewBox({ value }: { value: string }) {
    const mins = parseInt(value)
    if (isNaN(mins) || mins < 1) {
        return (
            <div style={{ padding: '10px 14px', borderRadius: '8px', background: 'var(--cr-error-low)', border: '1px solid var(--cr-error-line)', fontSize: '12px', color: 'var(--cr-error)' }}>
                ⚠ Enter a positive number of minutes
            </div>
        )
    }

    const description = mins === 1 ? 'Every minute' :
        mins < 60  ? `Every ${mins} minutes` :
        mins === 60 ? 'Every hour' :
        mins % 60 === 0 ? `Every ${mins / 60} hours` :
        `Every ${mins} minutes (${(mins / 60).toFixed(1)} hours)`

    const now = new Date()
    const nextFires = Array.from({ length: 5 }, (_, i) => {
        const d = new Date(now)
        d.setSeconds(0, 0)
        d.setMinutes(d.getMinutes() + mins * (i + 1))
        return d
    })

    return (
        <div style={{ padding: '12px 14px', borderRadius: '8px', background: 'var(--cr-tint-3)', border: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ fontSize: '12px', color: 'var(--accent-cyan)', fontWeight: 600 }}>{description}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '2px' }}>Next fires</div>
                {nextFires.map((d, i) => (
                    <div key={i} style={{ fontSize: '11px', color: 'var(--text-secondary)', fontFamily: 'monospace', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ color: 'var(--text-muted)', minWidth: '14px' }}>{i + 1}.</span>
                        {fmtDate(d)}
                    </div>
                ))}
            </div>
        </div>
    )
}

// ── Quick-pick presets ────────────────────────────────────────────────────────

const PRESETS = [
    { label: 'Every 15 min', value: '*/15 * * * *' },
    { label: 'Every hour',   value: '0 * * * *' },
    { label: 'Daily 9 AM',   value: '0 9 * * *' },
    { label: 'Daily 8 PM',   value: '0 20 * * *' },
    { label: 'Weekdays 9 AM',value: '0 9 * * 1-5' },
    { label: 'Mon 9 AM',     value: '0 9 * * 1' },
    { label: 'Weekly Sun',   value: '0 9 * * 0' },
    { label: 'Monthly 1st',  value: '0 9 1 * *' },
]

// ── Main modal ────────────────────────────────────────────────────────────────

export default function ScheduleFormModal({ onClose, onSuccess }: ScheduleFormModalProps) {
    const { addTask } = useTasksStore()
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const [formData, setFormData] = useState({
        prompt: '',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        context_mode: 'isolated'
    })

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setLoading(true)
        setError(null)
        try {
            await addTask(formData as any)
            onSuccess()
        } catch (err: any) {
            setError(err.message || 'Failed to create schedule')
            setLoading(false)
        }
    }

    return (
        <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--cr-scrim)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(8px)' }}>
            <div className="glass-card" style={{ width: '100%', maxWidth: '520px', padding: 0, overflow: 'hidden', border: '1px solid var(--accent-cyan)', maxHeight: '90vh', overflowY: 'auto' }}>
                <div style={{ padding: '16px 24px', background: 'var(--cr-well-str)', borderBottom: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'sticky', top: 0, zIndex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: 'var(--accent-cyan)' }}>
                        <Calendar size={20} />
                        <h2 style={{ fontSize: '18px', fontWeight: 600, margin: 0 }}>Create New Schedule</h2>
                    </div>
                    <button onClick={onClose} style={{ color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}><X size={24} /></button>
                </div>

                <form onSubmit={handleSubmit} style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
                    {error && (
                        <div className="error-banner" style={{ margin: 0 }}>
                            <AlertCircle size={18} />
                            {error}
                        </div>
                    )}

                    {/* Prompt */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>Agent Instruction (Goal)</label>
                        <textarea
                            required
                            value={formData.prompt}
                            onChange={(e) => setFormData({ ...formData, prompt: e.target.value })}
                            placeholder="e.g. Write a summary of world news and send it to me over WhatsApp."
                            style={{ width: '100%', minHeight: '100px', padding: '12px', borderRadius: '8px', background: 'var(--cr-tint-4)', border: '1px solid var(--border-subtle)', color: 'white', outline: 'none', resize: 'vertical', fontSize: '14px', lineHeight: '1.5' }}
                        />
                    </div>

                    {/* Schedule type + value */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>Schedule Type</label>
                            <select
                                value={formData.schedule_type}
                                onChange={(e) => setFormData({ ...formData, schedule_type: e.target.value, schedule_value: e.target.value === 'cron' ? '0 9 * * *' : '60' })}
                                style={{ padding: '10px', borderRadius: '8px', background: 'var(--cr-tint-4)', border: '1px solid var(--border-subtle)', color: 'white', outline: 'none' }}
                            >
                                <option value="cron">Cron Expression</option>
                                <option value="interval">Interval (Minutes)</option>
                            </select>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>Value</label>
                            <input
                                required
                                value={formData.schedule_value}
                                onChange={(e) => setFormData({ ...formData, schedule_value: e.target.value })}
                                placeholder={formData.schedule_type === 'cron' ? '0 9 * * *' : '60'}
                                style={{ padding: '10px', borderRadius: '8px', background: 'var(--cr-tint-4)', border: '1px solid var(--border-subtle)', color: 'white', outline: 'none', fontFamily: formData.schedule_type === 'cron' ? 'monospace' : 'inherit' }}
                            />
                        </div>
                    </div>

                    {/* Quick presets — cron only */}
                    {formData.schedule_type === 'cron' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Quick presets</div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                {PRESETS.map(p => (
                                    <button
                                        key={p.value}
                                        type="button"
                                        onClick={() => setFormData({ ...formData, schedule_value: p.value })}
                                        style={{
                                            padding: '4px 10px', borderRadius: '6px', fontSize: '11px', cursor: 'pointer',
                                            border: `1px solid ${formData.schedule_value === p.value ? 'var(--accent-cyan)' : 'var(--border-subtle)'}`,
                                            background: formData.schedule_value === p.value ? 'var(--cr-cyan-low)' : 'var(--cr-tint-3)',
                                            color: formData.schedule_value === p.value ? 'var(--accent-cyan)' : 'var(--text-secondary)',
                                            transition: 'all 0.15s',
                                        }}
                                    >{p.label}</button>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Live preview */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Preview</div>
                        {formData.schedule_type === 'cron'
                            ? <CronPreviewBox expr={formData.schedule_value} />
                            : <IntervalPreviewBox value={formData.schedule_value} />
                        }
                    </div>

                    {/* Context isolation */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>Context Isolation</label>
                        <select
                            value={formData.context_mode}
                            onChange={(e) => setFormData({ ...formData, context_mode: e.target.value })}
                            style={{ padding: '10px', borderRadius: '8px', background: 'var(--cr-tint-4)', border: '1px solid var(--border-subtle)', color: 'white', outline: 'none' }}
                        >
                            <option value="isolated">Isolated (Fresh Session Each Time)</option>
                            <option value="persistent">Persistent (Shared History)</option>
                        </select>
                    </div>

                    <div style={{ marginTop: '4px', display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
                        <button
                            type="button"
                            onClick={onClose}
                            style={{ padding: '10px 20px', borderRadius: '8px', background: 'transparent', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', fontWeight: 500, cursor: 'pointer' }}
                        >Cancel</button>
                        <button
                            type="submit"
                            disabled={loading}
                            style={{ padding: '10px 24px', borderRadius: '8px', background: 'var(--accent-cyan)', border: 'none', color: 'black', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px', opacity: loading ? 0.7 : 1, cursor: loading ? 'default' : 'pointer' }}
                        >{loading ? <Loader2 size={18} className="animate-spin" /> : 'Create Routine'}</button>
                    </div>
                </form>
            </div>
        </div>
    )
}
