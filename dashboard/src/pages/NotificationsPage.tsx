import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotificationsStore, type Notification, type NotificationType } from '../stores/notificationsStore';
import { CheckCheck, Trash2, X, ExternalLink } from 'lucide-react';

// ─── Type config ──────────────────────────────────────────────────────────────

const TYPE_CONFIG: Record<NotificationType, { icon: string; color: string; bg: string }> = {
    cycle_completed: { icon: '✓',  color: 'var(--cr-green)', bg: 'var(--cr-green-low)' },
    cycle_failed:    { icon: '✗',  color: 'var(--cr-error)', bg: 'var(--cr-error-low)' },
    pipeline_fired:  { icon: '⚡', color: 'var(--cr-purple)', bg: 'var(--cr-purple-low)' },
    agent_error:     { icon: '!',  color: 'var(--cr-error)', bg: 'var(--cr-error-low)'  },
    budget_warning:  { icon: '$',  color: 'var(--cr-orange)', bg: 'var(--cr-accent-15)'  },
    webhook_received:{ icon: '↓',  color: 'var(--cr-cyan)', bg: 'var(--cr-cyan-low)'  },
    subagent_done:   { icon: '↩',  color: 'var(--cr-purple)', bg: 'var(--cr-purple-low)' },
    message_received:{ icon: '✉',  color: 'var(--cr-orange)', bg: 'var(--cr-accent-15)'  },
};

function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const s = Math.floor(diff / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}

function NotifRow({ n, onMarkRead, onRemove, onNavigate }: {
    n: Notification;
    onMarkRead: () => void;
    onRemove: () => void;
    onNavigate: () => void;
}) {
    const cfg = TYPE_CONFIG[n.type] ?? { icon: '•', color: 'var(--cr-muted)', bg: 'transparent' };

    return (
        <div
            style={{
                display: 'flex',
                gap: '14px',
                padding: '14px 20px',
                borderBottom: '1px solid var(--cr-border-sub)',
                background: n.read ? 'transparent' : 'var(--cr-tint-1)',
                transition: 'background 0.2s',
                alignItems: 'flex-start',
            }}
            onMouseEnter={e => { if (n.read) e.currentTarget.style.background = 'var(--cr-tint-1)'; }}
            onMouseLeave={e => { if (n.read) e.currentTarget.style.background = 'transparent'; }}
        >
            {/* Unread dot */}
            <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: n.read ? 'transparent' : cfg.color, flexShrink: 0, marginTop: '6px', boxShadow: n.read ? 'none' : `0 0 6px ${cfg.color}` }} />

            {/* Icon */}
            <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: cfg.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: '14px', color: cfg.color, fontWeight: 700 }}>
                {cfg.icon}
            </div>

            {/* Content */}
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '3px' }}>
                    <span style={{ fontFamily: 'var(--cr-font-sans)', fontSize: '14px', color: n.read ? 'var(--cr-sub)' : 'var(--cr-cream)', fontWeight: n.read ? 400 : 500 }}>
                        {n.title}
                    </span>
                    <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '10px', color: 'var(--cr-muted)', flexShrink: 0 }}>{timeAgo(n.created_at)}</span>
                </div>
                <p style={{ fontFamily: 'var(--cr-font-sans)', fontSize: '13px', color: 'var(--cr-muted-br)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {n.body}
                </p>
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                {n.agent_id && (
                    <button onClick={onNavigate} title="Go to agent" style={{ padding: '4px 6px', borderRadius: '5px', border: '1px solid var(--cr-border)', background: 'transparent', color: 'var(--cr-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                        <ExternalLink size={12} />
                    </button>
                )}
                {!n.read && (
                    <button onClick={onMarkRead} title="Mark as read" style={{ padding: '4px 6px', borderRadius: '5px', border: '1px solid var(--cr-border)', background: 'transparent', color: 'var(--cr-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                        <CheckCheck size={12} />
                    </button>
                )}
                <button onClick={onRemove} title="Dismiss" style={{ padding: '4px 6px', borderRadius: '5px', border: '1px solid var(--cr-border)', background: 'transparent', color: 'var(--cr-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                    <X size={12} />
                </button>
            </div>
        </div>
    );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function NotificationsPage() {
    const navigate = useNavigate();
    const { notifications, unreadCount, loading, fetchNotifications, markRead, markAllRead, remove, clearAll } = useNotificationsStore();

    useEffect(() => { fetchNotifications(); }, []);

    const byDate: Record<string, Notification[]> = {};
    for (const n of notifications) {
        const day = new Date(n.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        (byDate[day] ??= []).push(n);
    }

    return (
        <div style={{ maxWidth: '720px', margin: '0 auto', padding: '28px 24px' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '28px' }}>
                <div>
                    <h1 style={{ fontFamily: 'var(--cr-font-serif)', fontSize: '26px', color: 'var(--cr-cream)', margin: '0 0 6px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                        Notifications
                        {unreadCount > 0 && (
                            <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '12px', padding: '2px 10px', borderRadius: '100px', background: 'var(--cr-accent)', color: 'var(--cr-on-accent)' }}>{unreadCount}</span>
                        )}
                    </h1>
                    <p style={{ fontFamily: 'var(--cr-font-sans)', fontSize: '14px', color: 'var(--cr-muted)', margin: 0 }}>
                        Alerts from across your crew
                    </p>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                    {unreadCount > 0 && (
                        <button onClick={markAllRead} style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '7px 14px', borderRadius: '7px', border: '1px solid var(--cr-border)', background: 'transparent', color: 'var(--cr-sub)', fontFamily: 'var(--cr-font-sans)', fontSize: '12px', cursor: 'pointer' }}>
                            <CheckCheck size={13} /> Mark all read
                        </button>
                    )}
                    {notifications.length > 0 && (
                        <button onClick={() => { if (confirm('Clear all notifications?')) clearAll(); }} style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '7px 14px', borderRadius: '7px', border: '1px solid var(--cr-border)', background: 'transparent', color: 'var(--cr-muted)', fontFamily: 'var(--cr-font-sans)', fontSize: '12px', cursor: 'pointer' }}>
                            <Trash2 size={13} /> Clear all
                        </button>
                    )}
                </div>
            </div>

            {loading ? (
                <div style={{ textAlign: 'center', padding: '60px', fontFamily: 'var(--cr-font-mono)', fontSize: '13px', color: 'var(--cr-muted)' }}>Loading...</div>
            ) : notifications.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '80px 0' }}>
                    <div style={{ fontSize: '44px', marginBottom: '16px', opacity: 0.25 }}>🔔</div>
                    <p style={{ fontFamily: 'var(--cr-font-sans)', fontSize: '15px', color: 'var(--cr-muted)' }}>All clear — no notifications yet.</p>
                </div>
            ) : (
                <div style={{ background: 'var(--cr-bg-card)', border: '1px solid var(--cr-border)', borderRadius: '12px', overflow: 'hidden' }}>
                    {Object.entries(byDate).map(([day, notifs]) => (
                        <div key={day}>
                            <div style={{ padding: '8px 20px', background: 'var(--cr-tint-1)', borderBottom: '1px solid var(--cr-border-sub)', fontFamily: 'var(--cr-font-mono)', fontSize: '10px', color: 'var(--cr-muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                                {day}
                            </div>
                            {notifs.map(n => (
                                <NotifRow
                                    key={n.id}
                                    n={n}
                                    onMarkRead={() => markRead(n.id)}
                                    onRemove={() => remove(n.id)}
                                    onNavigate={() => n.agent_id && navigate(`/agents/${n.agent_id}`)}
                                />
                            ))}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
