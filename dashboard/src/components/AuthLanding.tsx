import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Link } from 'react-router-dom'

/**
 * Claude.ai-style entry page, themed as nanocrew. A split hero (auth card on the left,
 * product demo on the right) followed by pricing and an FAQ. LoginPage / SignupPage drop
 * their auth card in as children; everything around it is shared. Layout borrowed from
 * claude.ai/login; colours + type are nanocrew's own (warm-dark, orange accent, DM Serif).
 */

const ACCENT = 'var(--cr-accent)'
const ACCENT_WARM = 'var(--cr-accent-warm)'
const TEXT = 'var(--cr-text)'
const MUTED = 'var(--cr-muted-br)'
const SUB = 'var(--cr-sub)'
const CARD = 'var(--cr-bg-card)'
const ELEV = 'var(--cr-bg-elevated)'
const BG = 'var(--cr-bg-main)'
const BORDER = 'var(--cr-border)'
const BORDER_BR = 'var(--cr-border-bright)'
const ACCENT_LOW = 'var(--cr-accent-low)'
const SERIF = 'var(--cr-font-serif, "DM Serif Display", serif)'
const MONO = 'var(--cr-font-mono, monospace)'

function Logo() {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <img src="/nanocrew-logo.png" alt="nanocrew" style={{ width: 26, height: 26, objectFit: 'contain' }} />
            <span style={{ fontFamily: SERIF, fontSize: 22, color: TEXT }}>nanocrew</span>
        </div>
    )
}

const tiers = [
    { name: 'Standard', price: '15', highlight: false, blurb: 'For getting your first specialists working.', features: ['200 agent runs / month', 'Up to 5 agents', 'Dashboard + WhatsApp', 'Fast default models'] },
    { name: 'Pro', price: '30', highlight: true, blurb: 'For running real work across a team.', features: ['1,000 agent runs / month', 'Bring your own API key (any model)', 'Everything in Standard, plus more channels', 'Priority support'] },
    { name: 'Business', price: '100', highlight: false, blurb: 'For a business running a full crew.', features: ['5,000 runs / month + unlimited on your own key', 'Unlimited agents & projects', 'Everything in Pro', 'Priority support + onboarding call'] },
]

const faqs = [
    { q: 'What is nanocrew?', a: 'nanocrew is a team of AI specialists you hire — one for coding, one for content, one for research, or any role you describe. Each agent has its own skills, tools, and memory of your business, and works from your dashboard or WhatsApp.' },
    { q: 'How is this different from ChatGPT?', a: 'ChatGPT is one generalist that forgets each chat and waits for your prompt. nanocrew is a team of specialists that remember your business, collaborate on projects, and run on their own — on a schedule or on demand, even while you sleep.' },
    { q: 'Do I need to know how to code?', a: 'No. You hire a ready-made specialist in two clicks, or describe the agent you want in plain English and the Recruiter builds it with you.' },
    { q: 'Can agents really work on their own?', a: 'Yes. Agents run scheduled or on-demand jobs in the background, build their own tools when they need them, and report back to you when something matters.' },
    { q: 'Can I use my own AI model or API key?', a: 'On Pro and Business you can bring your own API key and run any model — Claude, GPT, or Gemini. Standard uses fast default models.' },
    { q: 'How do I get started?', a: 'We onboard you personally — we set your first specialists up with you and get them working on your own tasks, so you see real value before you pay.' },
]

function scrollToTop() {
    // The page scrolls inside its own container (#root is overflow:hidden), not the window.
    document.getElementById('auth-scroll')?.scrollTo({ top: 0, behavior: 'smooth' })
}

function FaqItem({ q, a }: { q: string; a: string }) {
    const [open, setOpen] = useState(false)
    return (
        <div style={{ borderBottom: `1px solid ${BORDER}` }}>
            <button onClick={() => setOpen(o => !o)} style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, background: 'none', border: 'none', cursor: 'pointer', padding: '22px 4px', textAlign: 'left' }}>
                <span style={{ fontFamily: SERIF, fontSize: 'clamp(17px,2.4vw,21px)', color: TEXT }}>{q}</span>
                <span style={{ fontSize: 22, color: ACCENT, flexShrink: 0, transform: open ? 'rotate(45deg)' : 'none', transition: 'transform .2s' }}>+</span>
            </button>
            {open && <p style={{ margin: '0 4px 22px', fontSize: 15, lineHeight: 1.6, color: MUTED, maxWidth: 720 }}>{a}</p>}
        </div>
    )
}

export default function AuthLanding({ mode, children }: { mode: 'login' | 'signup'; children: ReactNode }) {
    return (
        <div id="auth-scroll" style={{ height: '100vh', overflowY: 'auto', overflowX: 'hidden', width: '100%', background: BG, color: TEXT, fontFamily: 'var(--cr-font-sans, system-ui, sans-serif)' }}>
            {/* nav */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px clamp(20px,5vw,48px)', maxWidth: 1280, margin: '0 auto' }}>
                <Logo />
                <div style={{ display: 'flex', alignItems: 'center', gap: 18, fontSize: 14 }}>
                    <a href="#pricing" style={{ color: MUTED, textDecoration: 'none' }}>Pricing</a>
                    <a href="#faq" style={{ color: MUTED, textDecoration: 'none' }}>FAQ</a>
                    {mode === 'login'
                        ? <Link to="/signup" style={{ color: TEXT, textDecoration: 'none', fontWeight: 600 }}>Sign up</Link>
                        : <Link to="/" style={{ color: TEXT, textDecoration: 'none', fontWeight: 600 }}>Sign in</Link>}
                </div>
            </div>

            {/* HERO: auth card (left) + demo (right) */}
            <section style={{ position: 'relative', maxWidth: 1280, margin: '0 auto', padding: 'clamp(20px,4vw,40px) clamp(20px,5vw,48px) 64px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 'clamp(36px,5vw,56px)', alignItems: 'center', minHeight: 'calc(100vh - 76px)' }} className="auth-hero">
                {/* ambient warm glow behind the hero */}
                <div style={{ position: 'absolute', top: '-10%', left: '-5%', width: 560, height: 460, background: `radial-gradient(ellipse at center, ${ACCENT_LOW}, transparent 70%)`, pointerEvents: 'none' }} />

                {/* left */}
                <div style={{ position: 'relative' }}>
                    <h1 style={{ fontFamily: SERIF, fontSize: 'clamp(36px,4.2vw,54px)', lineHeight: 1.06, letterSpacing: '-.015em', fontWeight: 400, margin: 0 }}>
                        One AI does one job.<br />Get a <span style={{ color: ACCENT_WARM }}>whole team.</span>
                    </h1>
                    <p style={{ fontSize: 'clamp(15px,1.6vw,18px)', color: SUB, lineHeight: 1.6, margin: '20px 0 30px', maxWidth: 430 }}>
                        Hire a crew of AI specialists that remember your business, work together, and run while you sleep.
                    </p>
                    {children}
                </div>

                {/* right — product preview, autoplaying muted loop */}
                <div style={{ position: 'relative', borderRadius: 18, overflow: 'hidden', border: `1px solid var(--cr-tint-5)`, background: ELEV, minHeight: 'clamp(400px, 62vh, 580px)', boxShadow: '0 40px 100px -40px var(--cr-shade-4)', display: 'flex', flexDirection: 'column' }} className="auth-demo">
                    {/* faux window top bar */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '13px 16px', borderBottom: `1px solid var(--cr-tint-4)` }}>
                        {/* Faux traffic lights on the demo's window chrome — decorative, and
                            recognisable only as red/amber/green, so they aren't themed. */}
                        {['#e0603e', '#caa84a', 'var(--cr-green)'].map(c => <span key={c} style={{ width: 10, height: 10, borderRadius: '50%', background: c, opacity: 0.85 }} />)}
                        <span style={{ marginLeft: 8, fontFamily: MONO, fontSize: 11, color: SUB }}>nanocrew · your crew</span>
                    </div>
                    {/* TODO: product demo goes here */}
                </div>
            </section>

            {/* PRICING */}
            <section id="pricing" style={{ maxWidth: 1100, margin: '0 auto', padding: '60px clamp(20px,5vw,48px)' }}>
                <h2 style={{ fontFamily: SERIF, fontSize: 'clamp(32px,4.5vw,52px)', fontWeight: 400, textAlign: 'center', margin: '0 0 8px' }}>Less than one employee</h2>
                <p style={{ textAlign: 'center', color: MUTED, fontSize: 15, margin: '0 0 44px' }}>Bring your own API key on Pro &amp; Business to run any model — Claude, GPT, or Gemini.</p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 18, alignItems: 'stretch' }}>
                    {tiers.map(t => (
                        <div key={t.name} style={{ display: 'flex', flexDirection: 'column', background: t.highlight ? ELEV : CARD, border: `1px solid ${t.highlight ? BORDER_BR : BORDER}`, borderRadius: 18, padding: 28 }}>
                            {t.highlight && <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: '.15em', textTransform: 'uppercase', color: ACCENT, marginBottom: 8 }}>Most popular</div>}
                            <div style={{ fontFamily: SERIF, fontSize: 26, color: TEXT }}>{t.name}</div>
                            <div style={{ marginTop: 6 }}><span style={{ fontFamily: SERIF, fontSize: 44, color: TEXT }}>${t.price}</span><span style={{ fontSize: 14, color: MUTED }}>/mo</span></div>
                            <p style={{ fontSize: 13.5, color: MUTED, marginTop: 4, marginBottom: 18 }}>{t.blurb}</p>
                            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
                                {t.features.map(f => <li key={f} style={{ display: 'flex', gap: 8, fontSize: 13.5, color: TEXT, lineHeight: 1.4 }}><span style={{ color: ACCENT }}>✓</span>{f}</li>)}
                            </ul>
                            <button onClick={scrollToTop} style={{ marginTop: 22, padding: 11, borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600, color: 'var(--cr-on-accent)', background: t.highlight ? `linear-gradient(135deg, ${ACCENT}, ${ACCENT_WARM})` : ACCENT }}>Get started</button>
                        </div>
                    ))}
                </div>
            </section>

            {/* FAQ */}
            <section id="faq" style={{ maxWidth: 820, margin: '0 auto', padding: '40px clamp(20px,5vw,48px) 70px' }}>
                <h2 style={{ fontFamily: SERIF, fontSize: 'clamp(34px,5vw,56px)', fontWeight: 400, textAlign: 'center', margin: '0 0 30px' }}>FAQ</h2>
                <div style={{ borderTop: `1px solid ${BORDER}` }}>
                    {faqs.map(f => <FaqItem key={f.q} q={f.q} a={f.a} />)}
                </div>
            </section>

            {/* footer */}
            <footer style={{ borderTop: `1px solid ${BORDER}`, padding: '28px clamp(20px,5vw,48px)', maxWidth: 1280, margin: '0 auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                <Logo />
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 12, fontFamily: MONO, color: MUTED }}>
                    <a href="https://axoncrew.com" target="_blank" rel="noopener noreferrer" style={{ color: MUTED, textDecoration: 'none' }}>nanocrew by axoncrew.com</a>
                    <span>© 2026</span>
                </div>
            </footer>

            <style>{`
                #auth-scroll input:focus { border-color: var(--cr-accent) !important; background: var(--cr-well-str) !important; }
                #auth-scroll input::placeholder { color: var(--cr-muted-br); }
                @media (max-width: 860px){ .auth-hero{ grid-template-columns: 1fr !important; } }
            `}</style>
        </div>
    )
}

// ── shared auth-card styles (used by LoginPage + SignupPage) ───────────────────
export const authCard: CSSProperties = { width: '100%', maxWidth: 410, background: 'linear-gradient(180deg, var(--cr-tint-4), var(--cr-tint-1))', border: '1px solid var(--cr-tint-6)', borderRadius: 16, padding: 24, display: 'flex', flexDirection: 'column', gap: 13, boxShadow: '0 26px 64px -30px var(--cr-shade-4)' }
export const authField: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 }
/** Claude-style "Continue with email" — the light primary that reveals the email form. */
export const authEmailBtn: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '11px', borderRadius: 10, border: 'none', background: 'var(--cr-cream)', color: 'var(--cr-bg-main)', fontSize: 14, fontWeight: 700, cursor: 'pointer', width: '100%' }
export const authBack: CSSProperties = { background: 'none', border: 'none', color: SUB, fontSize: 13, cursor: 'pointer', padding: 0, alignSelf: 'flex-start' }
export const authLabel: CSSProperties = { fontSize: 11.5, color: SUB, fontWeight: 600, letterSpacing: '.02em' }
export const authInput: CSSProperties = { padding: '9px 12px', borderRadius: 10, border: '1px solid var(--cr-tint-6)', background: 'var(--cr-well-str)', color: TEXT, fontSize: 14, outline: 'none', width: '100%', boxSizing: 'border-box' }
export const authErr: CSSProperties = { fontSize: 12.5, color: 'var(--cr-error)', background: 'var(--cr-accent-15)', border: `1px solid var(--cr-accent-40)`, borderRadius: 9, padding: '9px 12px' }
export const authLink: CSSProperties = { background: 'none', border: 'none', color: ACCENT, fontSize: 13, cursor: 'pointer', padding: 0, textDecoration: 'none' }
export const authMutedLink: CSSProperties = { fontSize: 13, color: MUTED, textDecoration: 'none' }
export const authRowBetween: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between' }
export const authNotice: CSSProperties = { fontSize: 13, color: MUTED, background: ACCENT_LOW, border: `1px solid ${BORDER}`, borderRadius: 10, padding: '12px 14px', lineHeight: 1.5, textAlign: 'center' }
export const authFormCol: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 11 }
export function authPrimaryBtn(busy: boolean): CSSProperties {
    return { marginTop: 2, padding: 10, borderRadius: 999, border: 'none', background: busy ? 'var(--cr-accent-60)' : `linear-gradient(135deg, ${ACCENT}, ${ACCENT_WARM})`, color: 'var(--cr-on-accent)', fontSize: 14, fontWeight: 600, cursor: busy ? 'default' : 'pointer' }
}
