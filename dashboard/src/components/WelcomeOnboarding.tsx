import { useState } from 'react'
import type { ReactNode } from 'react'
import { useAuthStore } from '../stores/authStore'

/**
 * First-run product overview. A full-screen, claude.ai-style welcome flow shown once
 * per user (gated in App.tsx on `user.onboarded_at`). Gives a new user the "what is
 * nanocrew / what can it really do" overview before they enter the dashboard — built to
 * spark curiosity, not lecture. Five quick steps, each with a small live visual:
 * crew → specialists → projects+pipelines+swarm → tools+jobs → build your first agent.
 * Skipping still counts as done, so it never nags. Completion is persisted server-side.
 */

const ACCENT = 'var(--cr-accent)'
const ACCENT_WARM = 'var(--cr-accent-warm)'
const TEXT = 'var(--cr-text)'
const MUTED = 'var(--cr-muted-br)'
const CARD = 'var(--cr-bg-card)'
const BORDER = 'var(--cr-border)'
const BORDER_BR = 'var(--cr-border-bright)'
const ACCENT_LOW = 'var(--cr-accent-low)'
const SERIF = 'var(--cr-font-serif, "DM Serif Display", serif)'
const MONO = 'var(--cr-font-mono, monospace)'

// ── small shared bits ─────────────────────────────────────────────────────────
function Tags({ items }: { items: string[] }) {
    return (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', marginTop: 22 }}>
            {items.map((t) => (
                <span key={t} style={{ fontFamily: MONO, fontSize: 11, letterSpacing: '.04em', color: ACCENT, background: ACCENT_LOW, border: `1px solid ${BORDER}`, borderRadius: 999, padding: '5px 12px' }}>{t}</span>
            ))}
        </div>
    )
}

function Avatar({ emoji, size = 44, ring = false, delay = 0 }: { emoji: string; size?: number; ring?: boolean; delay?: number }) {
    return (
        <div style={{
            width: size, height: size, borderRadius: '50%', flexShrink: 0,
            background: CARD, border: `1.5px solid ${ring ? ACCENT : BORDER}`,
            boxShadow: ring ? `0 0 0 3px ${ACCENT_LOW}` : 'none',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.46,
            animation: `ncwPop .5s cubic-bezier(.16,.8,.3,1) ${delay}ms both`,
        }}>{emoji}</div>
    )
}

// ── per-step visuals ──────────────────────────────────────────────────────────
function CrewAssembling() {
    const team = ['🧑‍💻', '🎨', '🔬', '📊', '🤖']
    return (
        <div style={{ display: 'flex', gap: 14, justifyContent: 'center', marginTop: 30 }}>
            {team.map((e, i) => <Avatar key={i} emoji={e} delay={i * 110} />)}
        </div>
    )
}

function Specialists() {
    const items = [
        { e: '🧑‍💻', n: 'Dev', t: 'ships features' },
        { e: '🎨', n: 'Content', t: 'creates in your voice' },
        { e: '🔬', n: 'Research', t: 'tracks topics' },
        { e: '✨', n: 'Any role', t: 'you describe it', custom: true },
    ]
    return (
        <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 10, marginTop: 26 }}>
                {items.map((c, i) => (
                    <div key={c.n} style={{ padding: '15px 14px', borderRadius: 12, background: CARD, border: c.custom ? `1px dashed ${BORDER_BR}` : `1px solid ${BORDER}`, display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left', animation: `ncwPop .5s cubic-bezier(.16,.8,.3,1) ${i * 80}ms both` }}>
                        <span style={{ fontSize: 24, flexShrink: 0 }}>{c.e}</span>
                        <div>
                            <div style={{ fontSize: 14, fontWeight: 700, color: c.custom ? ACCENT : TEXT }}>{c.n}</div>
                            <div style={{ fontSize: 11.5, color: MUTED, marginTop: 2 }}>{c.t}</div>
                        </div>
                    </div>
                ))}
            </div>
            <Tags items={['🧠 remembers your business', '💬 on WhatsApp']} />
        </>
    )
}

function ProjectBoard() {
    return (
        <>
            <div style={{ marginTop: 28, padding: 18, borderRadius: 14, background: CARD, border: `1px solid ${BORDER}`, textAlign: 'left', position: 'relative', overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: TEXT }}>📂 Launch campaign</span>
                    <span style={{ fontFamily: MONO, fontSize: 10, color: ACCENT, border: `1px solid ${BORDER_BR}`, borderRadius: 999, padding: '3px 9px' }}>3 agents · 1 lead</span>
                </div>
                {/* agents in the project, with a handoff line between them */}
                <div style={{ position: 'relative', display: 'flex', gap: 26, justifyContent: 'center', alignItems: 'center', padding: '22px 0 8px' }}>
                    <div style={{ position: 'absolute', top: 38, left: '18%', right: '18%', height: 2, background: `linear-gradient(90deg, ${BORDER_BR}, ${ACCENT}, ${BORDER_BR})` }} />
                    <div style={{ position: 'absolute', top: 33, left: '18%', width: 10, height: 10, borderRadius: '50%', background: ACCENT, boxShadow: `0 0 8px ${ACCENT}`, animation: 'ncwHandoff 2.4s ease-in-out infinite' }} />
                    <div style={{ position: 'relative', textAlign: 'center', zIndex: 1 }}><Avatar emoji="🔬" size={38} ring delay={60} /><div style={{ fontSize: 9.5, color: ACCENT, marginTop: 4, fontFamily: MONO }}>LEAD</div></div>
                    <div style={{ position: 'relative', textAlign: 'center', zIndex: 1 }}><Avatar emoji="🎨" size={38} delay={160} /><div style={{ fontSize: 9.5, color: MUTED, marginTop: 4, fontFamily: MONO }}>·</div></div>
                    <div style={{ position: 'relative', textAlign: 'center', zIndex: 1 }}><Avatar emoji="🧑‍💻" size={38} delay={260} /><div style={{ fontSize: 9.5, color: MUTED, marginTop: 4, fontFamily: MONO }}>·</div></div>
                </div>
            </div>
            <Tags items={['Projects', 'Pipelines', 'Swarm']} />
        </>
    )
}

function BeyondChat() {
    return (
        <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 28 }}>
                {/* tool being built */}
                <div style={{ padding: 16, borderRadius: 12, background: CARD, border: `1px solid ${BORDER}`, textAlign: 'left' }}>
                    <div style={{ fontSize: 12, color: MUTED, fontFamily: MONO }}>🔧 building tool</div>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: TEXT, marginTop: 8 }}>pdf_extractor</div>
                    <div style={{ height: 5, borderRadius: 999, background: ACCENT_LOW, marginTop: 12, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: '60%', borderRadius: 999, background: `linear-gradient(90deg, ${ACCENT}, ${ACCENT_WARM})`, animation: 'ncwBuild 2.2s ease-in-out infinite' }} />
                    </div>
                </div>
                {/* scheduled job */}
                <div style={{ padding: 16, borderRadius: 12, background: CARD, border: `1px solid ${BORDER}`, textAlign: 'left' }}>
                    <div style={{ fontSize: 12, color: MUTED, fontFamily: MONO }}>⏱ scheduled job</div>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: TEXT, marginTop: 8 }}>Daily digest</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 12 }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--cr-green)', boxShadow: '0 0 8px var(--cr-green)', animation: 'ncwPulse 1.8s ease-in-out infinite' }} />
                        <span style={{ fontSize: 11.5, color: MUTED, fontFamily: MONO }}>runs 6:00 AM · daily</span>
                    </div>
                </div>
            </div>
            <Tags items={['Builds its own tools', 'Runs while you sleep']} />
        </>
    )
}

function RecruiterReady() {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center', marginTop: 28, padding: '14px 18px', borderRadius: 999, background: CARD, border: `1px solid ${BORDER_BR}`, width: 'fit-content', marginLeft: 'auto', marginRight: 'auto', animation: 'ncwPop .5s cubic-bezier(.16,.8,.3,1) both' }}>
            <Avatar emoji="🧭" size={34} ring />
            <span style={{ fontSize: 13.5, color: TEXT }}>Your <b>Recruiter</b> is ready to help you build.</span>
        </div>
    )
}

interface Step { eyebrow: string; title: string; body: string; visual?: () => ReactNode }

const STEPS: Step[] = [
    {
        eyebrow: 'welcome to nanocrew',
        title: 'One AI does one job.\nYou get a whole team.',
        body: 'Stop stretching one assistant across every task. nanocrew is a team of AI specialists — each built for one job, each remembering your business.',
        visual: CrewAssembling,
    },
    {
        eyebrow: 'your crew',
        title: 'A specialist for every job',
        body: 'Dev, content, research — or any role you describe. Each agent is a pro at one thing, with its own skills, tools, and memory, reachable from your dashboard or WhatsApp.',
        visual: Specialists,
    },
    {
        eyebrow: 'they work as a team',
        title: 'Give them a project,\nnot just a prompt',
        body: 'Drop your crew into a project and they split the work and hand off to each other, while a lead agent keeps everyone on track. Big job? Spin up a swarm for more hands.',
        visual: ProjectBoard,
    },
    {
        eyebrow: 'beyond chat',
        title: 'They build tools &\nwork while you sleep',
        body: "No tool for the job? They build one. Then schedule the work and it runs in the background — overnight, on repeat, without you lifting a finger.",
        visual: BeyondChat,
    },
    {
        eyebrow: "you're all set",
        title: 'Build your first agent',
        body: 'Hire a ready-made specialist in two clicks, or describe the agent you want and build it together — right from your dashboard.',
        visual: RecruiterReady,
    },
]

export default function WelcomeOnboarding() {
    const completeOnboarding = useAuthStore((s) => s.completeOnboarding)
    const [step, setStep] = useState(0)
    const [finishing, setFinishing] = useState(false)

    const isLast = step === STEPS.length - 1
    const s = STEPS[step]

    const finish = async (openHire = false) => {
        // Finishing via the final CTA hands off to the hire picker on the dashboard, so
        // onboarding flows straight into hiring the first agent (the old FirstRunCard's job).
        if (openHire) sessionStorage.setItem('nc_open_hire', '1')
        setFinishing(true)
        try { await completeOnboarding() } finally { setFinishing(false) }
        // On success the store sets onboarded_at and App.tsx swaps in the dashboard.
    }
    const next = () => { if (isLast) finish(true); else setStep((n) => n + 1) }
    const back = () => setStep((n) => Math.max(0, n - 1))

    return (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--cr-bg-main)', color: TEXT, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
            <style>{`
                @keyframes ncwFade { from { opacity: 0; transform: translateY(14px) } to { opacity: 1; transform: none } }
                @keyframes ncwPop { from { opacity: 0; transform: scale(.85) translateY(8px) } to { opacity: 1; transform: none } }
                @keyframes ncwHandoff { 0% { left: 18%; opacity: 0 } 15% { opacity: 1 } 85% { opacity: 1 } 100% { left: 78%; opacity: 0 } }
                @keyframes ncwBuild { 0%,100% { width: 35% } 50% { width: 88% } }
                @keyframes ncwPulse { 0%,100% { opacity: 1; transform: scale(1) } 50% { opacity: .4; transform: scale(.8) } }
            `}</style>

            {/* ambient glow */}
            <div style={{ position: 'absolute', top: '-15%', left: '50%', transform: 'translateX(-50%)', width: 620, height: 420, background: `radial-gradient(ellipse at center, ${ACCENT_LOW}, transparent 70%)`, pointerEvents: 'none' }} />

            {/* top bar: logo + skip */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '22px clamp(20px,5vw,40px)', position: 'relative', zIndex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <img src="/nanocrew-logo.png" alt="nanocrew" style={{ width: 24, height: 24, objectFit: 'contain' }} />
                    <span style={{ fontFamily: SERIF, fontSize: 21 }}>nanocrew</span>
                </div>
                <button onClick={() => finish(false)} disabled={finishing} style={{ background: 'none', border: 'none', color: MUTED, cursor: finishing ? 'default' : 'pointer', fontSize: 13.5 }}>Skip</button>
            </div>

            {/* center content */}
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px clamp(20px,5vw,40px)', position: 'relative', zIndex: 1 }}>
                <div key={step} style={{ maxWidth: 560, width: '100%', textAlign: 'center', animation: 'ncwFade .45s cubic-bezier(.16,.8,.3,1)' }}>
                    <div style={{ fontFamily: MONO, fontSize: 12, letterSpacing: '.18em', textTransform: 'uppercase', color: ACCENT, marginBottom: 16 }}>{s.eyebrow}</div>
                    <h1 style={{ fontFamily: SERIF, fontSize: 'clamp(28px,5vw,44px)', lineHeight: 1.08, fontWeight: 400, margin: 0, whiteSpace: 'pre-line' }}>{s.title}</h1>
                    {s.body && <p style={{ fontSize: 16, color: MUTED, lineHeight: 1.6, margin: '18px auto 0', maxWidth: 460 }}>{s.body}</p>}
                    {s.visual?.()}
                </div>
            </div>

            {/* footer: dots + nav */}
            <div style={{ padding: '18px clamp(20px,5vw,40px) 30px', maxWidth: 620, margin: '0 auto', width: '100%', position: 'relative', zIndex: 1 }}>
                <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 20 }}>
                    {STEPS.map((_, i) => (
                        <button key={i} onClick={() => setStep(i)} aria-label={`Step ${i + 1}`} style={{ width: i === step ? 22 : 7, height: 7, padding: 0, border: 'none', borderRadius: 999, background: i === step ? ACCENT : BORDER_BR, cursor: 'pointer', transition: 'all .3s ease' }} />
                    ))}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <button onClick={back} disabled={step === 0} style={{ background: 'none', border: 'none', color: step === 0 ? 'transparent' : MUTED, cursor: step === 0 ? 'default' : 'pointer', fontSize: 14, padding: '8px 4px' }}>← Back</button>
                    <button onClick={next} disabled={finishing} style={{ padding: '12px 30px', borderRadius: 999, background: `linear-gradient(135deg, ${ACCENT}, ${ACCENT_WARM})`, color: 'var(--cr-on-accent)', border: 'none', cursor: finishing ? 'default' : 'pointer', fontSize: 14.5, fontWeight: 600, opacity: finishing ? 0.7 : 1, boxShadow: `0 4px 18px ${ACCENT_LOW}`, transition: 'opacity .2s' }}>
                        {finishing ? 'Setting up…' : isLast ? 'Get started →' : 'Next →'}
                    </button>
                </div>
            </div>
        </div>
    )
}
