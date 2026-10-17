import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, X, CheckCheck, ExternalLink } from 'lucide-react';
import { useNotificationsStore, type Notification, type NotificationType } from '../stores/notificationsStore';
import { useIsMobile } from '../hooks/useIsMobile';
import { withAlpha } from '../lib/cr'

const TYPE_ICONS: Record<NotificationType, string> = {
    cycle_completed:  '✓',
    cycle_failed:     '✗',
    pipeline_fired:   '⚡',
    agent_error:      '!',
    budget_warning:   '$',
    webhook_received: '↓',
    subagent_done:    '↩',
    message_received: '✉',
};

const TYPE_COLORS: Record<NotificationType, string> = {
    cycle_completed:  'var(--cr-green)',
    cycle_failed:     'var(--cr-error)',
    pipeline_fired:   'var(--cr-purple)',
    agent_error:      'var(--cr-error)',
    budget_warning:   'var(--cr-orange)',
    webhook_received: 'var(--cr-cyan)',
    subagent_done:    'var(--cr-purple)',
    message_received: 'var(--cr-orange)',
};

function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
}

export default function NotificationBell({ placement = 'topbar' }: { placement?: 'topbar' | 'sidebar' } = {}) {
    const navigate = useNavigate();
    const isMobile = useIsMobile();
    const { notifications, unreadCount, fetchNotifications, markRead, markAllRead, remove } = useNotificationsStore();
    const [open, setOpen] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);

    useEffect(() => { fetchNotifications(); }, []);

    // Close on outside click
    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    // Defensive: never let a bad/empty API response crash the whole dashboard.
    const recent = (notifications ?? []).slice(0, 12);

    // In the sidebar the bell just navigates to the full Notifications page instead of
    // opening a popover — a 360px dropdown never fit well inside a 240px column (it either
    // dwarfed the sidebar or got clipped), and "View all notifications" already went to the
    // same page anyway, so the popover was a detour, not a shortcut.
    const goToPage = placement === 'sidebar';

    return (
        <div ref={panelRef} style={{ position: 'relative' }}>
            {/* Bell button */}
            <button
                onClick={() => goToPage ? navigate('/notifications') : setOpen(o => !o)}
                aria-label="Notifications"
                title={goToPage ? 'Notifications' : undefined}
                style={{
                    position: 'relative',
                    width: '34px',
                    height: '34px',
                    borderRadius: '8px',
                    border: '1px solid',
                    borderColor: open ? 'var(--cr-border-bright)' : 'var(--cr-border)',
                    background: open ? 'var(--cr-accent-low)' : 'transparent',
                    color: open ? 'var(--cr-accent)' : 'var(--cr-muted)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'all 0.15s',
                }}
            >
                <Bell size={15} />
                {unreadCount > 0 && (
                    <div style={{
                        position: 'absolute',
                        top: '-4px',
                        right: '-4px',
                        minWidth: '16px',
                        height: '16px',
                        borderRadius: '8px',
                        background: 'var(--cr-accent)',
                        border: '2px solid var(--cr-bg-sidebar)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontFamily: 'var(--cr-font-mono)',
                        fontSize: '9px',
                        fontWeight: 700,
                        color: 'var(--cr-on-accent)',
                        padding: '0 3px',
                    }}>
                        {unreadCount > 99 ? '99+' : unreadCount}
                    </div>
                )}
            </button>

            {/* Dropdown panel — on mobile the bell isn't at the viewport's right edge (the
                hamburger/log-out buttons sit around it), so anchoring a 360px panel to the
                bell's own right:0 pushes it off the left edge of the screen. Anchor to the
                viewport instead via position:fixed + left/right margins.
                In the sidebar footer the bell sits near the bottom-left of the screen, so the
                panel opens upward (bottom, not top) and rightward (left, not right) — the
                topbar's down/right anchor would run off the bottom and left edges instead. */}
            {open && (
                <div style={isMobile ? {
                    position: 'fixed',
                    top: '56px',
                    left: '12px',
                    right: '12px',
                    maxHeight: 'calc(100dvh - 72px)',
                    background: 'var(--cr-bg-card)',
                    border: '1px solid var(--cr-border)',
                    borderRadius: '12px',
                    boxShadow: '0 16px 48px var(--cr-shade-3)',
                    zIndex: 200,
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                } : {
                    position: 'absolute',
                    ...(placement === 'sidebar' ? { bottom: 'calc(100% + 8px)', left: 0 } : { top: 'calc(100% + 8px)', right: 0 }),
                    width: '360px',
                    maxHeight: '480px',
                    background: 'var(--cr-bg-card)',
                    border: '1px solid var(--cr-border)',
                    borderRadius: '12px',
                    boxShadow: '0 16px 48px var(--cr-shade-3)',
                    zIndex: 200,
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                }}>
                    {/* Panel header */}
                    <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--cr-border-sub)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                        <span style={{ fontFamily: 'var(--cr-font-serif)', fontSize: '15px', color: 'var(--cr-cream)' }}>
                            Notifications {unreadCount > 0 && <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '11px', color: 'var(--cr-accent)', marginLeft: '6px' }}>{unreadCount} new</span>}
                        </span>
                        <div style={{ display: 'flex', gap: '6px' }}>
                            {unreadCount > 0 && (
                                <button onClick={markAllRead} title="Mark all read" style={{ padding: '3px 8px', borderRadius: '5px', border: '1px solid var(--cr-border)', background: 'transparent', color: 'var(--cr-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', fontFamily: 'var(--cr-font-mono)', fontSize: '10px' }}>
                                    <CheckCheck size={11} /> All read
                                </button>
                            )}
                        </div>
                    </div>

                    {/* List */}
                    <div style={{ overflowY: 'auto', flex: 1 }}>
                        {recent.length === 0 ? (
                            <div style={{ padding: '40px', textAlign: 'center', fontFamily: 'var(--cr-font-sans)', fontSize: '13px', color: 'var(--cr-muted)' }}>
                                No notifications yet
                            </div>
                        ) : recent.map((n: Notification) => {
                            const color = TYPE_COLORS[n.type] ?? 'var(--cr-muted)';
                            const icon = TYPE_ICONS[n.type] ?? '•';
                            return (
                                <div key={n.id} style={{
                                    display: 'flex',
                                    gap: '10px',
                                    padding: '10px 14px',
                                    borderBottom: '1px solid var(--cr-border-sub)',
                                    background: n.read ? 'transparent' : 'var(--cr-tint-1)',
                                    alignItems: 'flex-start',
                                }}>
                                    {/* Dot */}
                                    <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: n.read ? 'transparent' : color, flexShrink: 0, marginTop: '7px' }} />

                                    {/* Icon */}
                                    <div style={{ width: '26px', height: '26px', borderRadius: '6px', background: `${withAlpha(color, 8)}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: '12px', color, fontWeight: 700 }}>
                                        {icon}
                                    </div>

                                    {/* Text */}
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontFamily: 'var(--cr-font-sans)', fontSize: '12px', color: n.read ? 'var(--cr-sub)' : 'var(--cr-cream)', fontWeight: n.read ? 400 : 500, marginBottom: '2px', display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.title}</span>
                                            <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: '9px', color: 'var(--cr-muted)', flexShrink: 0 }}>{timeAgo(n.created_at)}</span>
                                        </div>
                                        <div style={{ fontFamily: 'var(--cr-font-sans)', fontSize: '11px', color: 'var(--cr-muted-br)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {n.body}
                                        </div>
                                    </div>

                                    {/* Actions */}
                                    <div style={{ display: 'flex', gap: '2px', flexShrink: 0 }}>
                                        {n.agent_id && (
                                            <button onClick={() => { navigate(`/agents/${n.agent_id}`); setOpen(false); }} style={{ padding: '3px 5px', borderRadius: '4px', border: 'none', background: 'transparent', color: 'var(--cr-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                                                <ExternalLink size={10} />
                                            </button>
                                        )}
                                        {!n.read && (
                                            <button onClick={() => markRead(n.id)} style={{ padding: '3px 5px', borderRadius: '4px', border: 'none', background: 'transparent', color: 'var(--cr-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                                                <CheckCheck size={10} />
                                            </button>
                                        )}
                                        <button onClick={() => remove(n.id)} style={{ padding: '3px 5px', borderRadius: '4px', border: 'none', background: 'transparent', color: 'var(--cr-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                                            <X size={10} />
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {/* Footer */}
                    {notifications.length > 0 && (
                        <div style={{ padding: '10px 14px', borderTop: '1px solid var(--cr-border-sub)', flexShrink: 0 }}>
                            <button onClick={() => { navigate('/notifications'); setOpen(false); }} style={{ width: '100%', padding: '7px', borderRadius: '7px', border: '1px solid var(--cr-border)', background: 'transparent', color: 'var(--cr-sub)', fontFamily: 'var(--cr-font-sans)', fontSize: '12px', cursor: 'pointer', textAlign: 'center' }}>
                                View all notifications
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
