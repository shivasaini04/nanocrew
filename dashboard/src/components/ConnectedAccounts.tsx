import { useCallback, useEffect, useState } from 'react';
import { CR } from '../lib/cr';

/**
 * Which sites the agent's browser is signed into (stage 52 Phase 3).
 *
 * Renders only inside the desktop app — a web page has no browser profile to report on,
 * so `window.nanocrewDesktop` missing means this component returns null and nothing about
 * the web dashboard changes. That is the rule for every desktop capability: additive,
 * feature-detected, never a forked screen.
 *
 * ## Why the tick means something
 *
 * The obvious check — "does the site render a logged-in page" — is wrong, and the stage 52
 * spike proved it wrong on live data: a real LinkedIn feed sat above a profile holding
 * only session-scoped cookies, and the login vanished when the browser closed.
 *
 * So the app tests the auth cookie's PERSISTENCE, and this screen shows three states
 * rather than two, because "signed in but fragile" is the one that silently fails at 3am
 * and the one a person can actually fix.
 */

interface SessionRow {
    site: string;
    label: string;
    ok: boolean;
    state?: 'connected' | 'fragile' | 'visited' | 'never';
    reason: string;
    hints?: string[];
    corroborating?: string[];
    expiresAt?: number | null;
}

interface DesktopSessions {
    list: () => Promise<SessionRow[]>;
    signIn: (site: string) => Promise<boolean>;
    signOut: (site: string) => Promise<boolean>;
}

function bridge(): DesktopSessions | null {
    const d = (window as unknown as { nanocrewDesktop?: { sessions?: DesktopSessions } }).nanocrewDesktop;
    return d?.sessions ?? null;
}

const DOT: Record<string, string> = {
    connected: 'var(--cr-green)',
    fragile: 'var(--cr-amber, #d98a2b)',
    visited: 'var(--cr-muted, #8b8b93)',
    never: 'var(--cr-muted, #8b8b93)',
};

export default function ConnectedAccounts() {
    const [rows, setRows] = useState<SessionRow[] | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        const api = bridge();
        if (!api) return;
        try {
            setRows(await api.list());
        } catch {
            // An older shell whose bridge predates this. Showing nothing is better than
            // showing an error about a feature the user never asked for.
            setRows(null);
        }
    }, []);

    useEffect(() => {
        void refresh();
        // Sessions change while the user is signing in *in the panel beside this*, so the
        // list has to notice on its own. Slow enough to be free, fast enough that a tick
        // appears while they are still looking at it.
        const t = setInterval(() => { void refresh(); }, 4000);
        return () => clearInterval(t);
    }, [refresh]);

    // Not in the desktop app: this screen has nothing to say.
    if (!bridge() || !rows) return null;

    const connect = async (site: string) => {
        setBusy(site);
        try {
            await bridge()?.signIn(site);
            setExpanded(site);      // the hints matter most right now
        } finally {
            setBusy(null);
        }
    };

    const disconnect = async (site: string) => {
        setBusy(site);
        try {
            await bridge()?.signOut(site);
            await refresh();
        } finally {
            setBusy(null);
        }
    };

    return (
        <div style={{ fontFamily: CR.sans }}>
            <div style={{ fontSize: 12.5, color: CR.sub, lineHeight: 1.6, marginBottom: 12 }}>
                Sites your agents can use in <strong>your</strong> browser. Sign in once here and the
                session is reused — nothing leaves this machine, and no password is stored by NanoCrew.
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {rows.map(r => (
                    <div key={r.site} style={{ border: `1px solid ${CR.border}`, borderRadius: 8, padding: '10px 12px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                            <span style={{
                                width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                                background: DOT[r.state ?? 'never'],
                            }} />
                            <span style={{ fontSize: 13, fontWeight: 600, color: CR.text, flexShrink: 0 }}>
                                {r.label}
                            </span>
                            <span style={{
                                fontSize: 11.5, color: r.state === 'fragile' ? 'var(--cr-amber, #d98a2b)' : CR.muted,
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                            }}>
                                {r.reason}
                            </span>

                            {r.ok ? (
                                <button
                                    onClick={() => disconnect(r.site)}
                                    disabled={busy === r.site}
                                    style={btn(false)}
                                >
                                    Disconnect
                                </button>
                            ) : (
                                <button
                                    onClick={() => connect(r.site)}
                                    disabled={busy === r.site}
                                    style={btn(true)}
                                >
                                    {r.state === 'fragile' ? 'Sign in again' : 'Sign in'}
                                </button>
                            )}
                        </div>

                        {/* The hints are what turn a failed sign-in into a successful one.
                            Every line was learned from a live spike run where a login
                            looked fine and produced nothing durable. */}
                        {expanded === r.site && (r.hints?.length ?? 0) > 0 && (
                            <ul style={{
                                margin: '10px 0 2px', paddingLeft: 18,
                                fontSize: 11.5, color: CR.muted, lineHeight: 1.6,
                            }}>
                                {r.hints!.map((h, i) => <li key={i}>{h}</li>)}
                            </ul>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}

function btn(primary: boolean): React.CSSProperties {
    return {
        flexShrink: 0,
        padding: '5px 12px',
        fontSize: 11.5,
        fontFamily: CR.sans,
        borderRadius: 6,
        cursor: 'pointer',
        border: primary ? 'none' : `1px solid ${CR.border}`,
        background: primary ? 'var(--cr-accent, #e8623c)' : 'transparent',
        color: primary ? '#fff' : CR.sub,
    };
}
