import { useEffect, useState } from 'react'
import { Container, Play, Square, RotateCw, TerminalSquare, AlertCircle } from 'lucide-react'
import { useContainerStore } from '../stores/containerStore'
import ContainerLogs from '../components/ContainerLogs'

export default function ContainersPage() {
    const { containers, stats, loading, error, fetchContainers, actionContainer } = useContainerStore()
    const [selectedContainer, setSelectedContainer] = useState<string | null>(null)

    useEffect(() => {
        fetchContainers()
    }, [fetchContainers])

    return (
        <div className="crew-page-container">
            <div className="hero-gradient" style={{ padding: '0 0 40px', marginBottom: '40px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '12px' }}>
                        <div style={{ 
                            width: '40px', 
                            height: '40px', 
                            borderRadius: '12px', 
                            background: 'var(--cr-bg-surf)', 
                            border: '1px solid var(--cr-border-bright)',
                            display: 'flex', 
                            alignItems: 'center', 
                            justifyContent: 'center' 
                        }}>
                            <Container size={22} color="var(--cr-accent)" />
                        </div>
                        <h1 className="font-serif" style={{ fontSize: '32px', color: 'var(--cr-cream)', margin: 0 }}>
                            Infrastructure
                        </h1>
                    </div>
                    <p style={{ color: 'var(--cr-sub)', fontSize: '15px', maxWidth: '600px', lineHeight: 1.6 }}>
                        Real-time container monitoring and lifecycle management for your agent swarm.
                    </p>
                </div>
                <button
                    onClick={() => fetchContainers()}
                    style={{ 
                        padding: '10px 20px', 
                        borderRadius: '8px', 
                        background: 'var(--cr-bg-card)', 
                        border: '1px solid var(--cr-border)', 
                        color: 'var(--cr-cream)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        fontSize: '13px',
                        fontFamily: 'var(--cr-font-sans)',
                        boxShadow: '0 2px 8px var(--cr-shade-1)'
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--cr-bg-card-hov)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'var(--cr-bg-card)'}
                >
                    <RotateCw size={16} style={{ animation: loading ? 'crewPulse 1s linear infinite' : 'none' }} />
                    Refresh Swarm
                </button>
            </div>

            {error && (
                <div style={{ 
                    padding: '16px', 
                    background: 'var(--cr-error-low)', 
                    border: '1px solid var(--cr-error-line)', 
                    borderRadius: '10px', 
                    color: 'var(--cr-error-str)', 
                    marginBottom: '24px', 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '10px',
                    fontSize: '14px'
                }}>
                    <AlertCircle size={18} />
                    {error}
                </div>
            )}

            <div style={{ display: 'flex', gap: '32px', flex: 1, minHeight: 0 }}>
                {/* Containers List */}
                <div style={{ flex: 1, overflowY: 'auto', paddingRight: '8px' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '16px' }}>
                        {loading && containers.length === 0 ? (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '60px', gap: '16px' }}>
                                <RotateCw className="animate-spin" size={24} color="var(--cr-muted)" />
                                <span style={{ color: 'var(--cr-muted)', fontSize: '12px', fontFamily: 'var(--cr-font-mono)' }}>SCANNING NETWORK...</span>
                            </div>
                        ) : containers.length === 0 ? (
                            <div className="premium-card" style={{ padding: '60px', textAlign: 'center', color: 'var(--cr-muted-br)', borderRadius: '16px' }}>
                                No active swarm containers detected.
                            </div>
                        ) : (
                            containers.map(container => {
                                const normalizedName = container.name.replace(/^\//, '')
                                const stat = stats[normalizedName] || stats[container.status]
                                const isRunning = container.status.toLowerCase().includes('up')

                                return (
                                    <div key={container.name} className="premium-card" style={{ padding: '24px', borderRadius: '16px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                            <div style={{ display: 'flex', gap: '16px' }}>
                                                <div style={{ 
                                                    width: '42px', 
                                                    height: '42px', 
                                                    borderRadius: '10px', 
                                                    background: 'var(--cr-tint-1)', 
                                                    border: '1px solid var(--cr-border)',
                                                    display: 'flex', 
                                                    alignItems: 'center', 
                                                    justifyContent: 'center',
                                                    fontSize: '20px'
                                                }}>🐳</div>
                                                <div>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
                                                        <h3 className="font-mono" style={{ fontSize: '15px', color: 'var(--cr-cream)', fontWeight: 600 }}>
                                                            {normalizedName}
                                                        </h3>
                                                        <span style={{ 
                                                            fontSize: '9px', 
                                                            background: isRunning ? 'var(--cr-green-low)' : 'var(--cr-error-low)', 
                                                            color: isRunning ? 'var(--cr-green)' : 'var(--cr-error-str)',
                                                            padding: '2px 8px',
                                                            borderRadius: '100px',
                                                            fontFamily: 'var(--cr-font-mono)',
                                                            textTransform: 'uppercase',
                                                            fontWeight: 700,
                                                            border: `1px solid ${isRunning ? 'var(--cr-green-low)' : 'var(--cr-error-low)'}`
                                                        }}>
                                                            {isRunning ? 'Online' : 'Offline'}
                                                        </span>
                                                    </div>
                                                    <div style={{ fontSize: '11px', color: 'var(--cr-muted-br)', fontFamily: 'var(--cr-font-mono)' }}>
                                                        {container.status}
                                                    </div>
                                                </div>
                                            </div>

                                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                {isRunning ? (
                                                    <button onClick={() => actionContainer(normalizedName, 'stop')} style={{ color: 'var(--cr-error-str)', padding: '8px', borderRadius: '6px', background: 'var(--cr-error-low)', border: '1px solid var(--cr-error-low)' }} title="Stop Instance">
                                                        <Square size={14} fill="currentColor" />
                                                    </button>
                                                ) : (
                                                    <button onClick={() => actionContainer(normalizedName, 'start')} style={{ color: 'var(--cr-green)', padding: '8px', borderRadius: '6px', background: 'var(--cr-green-low)', border: '1px solid var(--cr-green-low)' }} title="Start Instance">
                                                        <Play size={14} fill="currentColor" />
                                                    </button>
                                                )}
                                                <button onClick={() => actionContainer(normalizedName, 'restart')} style={{ color: 'var(--cr-amber)', padding: '8px', borderRadius: '6px', background: 'var(--cr-amber-low)', border: '1px solid var(--cr-amber-low)' }} title="Restart Instance">
                                                    <RotateCw size={14} />
                                                </button>
                                                <button
                                                    onClick={() => setSelectedContainer(selectedContainer === normalizedName ? null : normalizedName)}
                                                    style={{
                                                        marginLeft: '8px',
                                                        padding: '8px 14px',
                                                        borderRadius: '6px',
                                                        fontSize: '11px',
                                                        fontFamily: 'var(--cr-font-sans)',
                                                        fontWeight: 600,
                                                        background: selectedContainer === normalizedName ? 'var(--cr-accent)' : 'var(--cr-bg-card)',
                                                        border: selectedContainer === normalizedName ? '1px solid var(--cr-accent)' : '1px solid var(--cr-border)',
                                                        color: selectedContainer === normalizedName ? 'white' : 'var(--cr-sub)',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        gap: '6px'
                                                    }}
                                                >
                                                    <TerminalSquare size={14} />
                                                    Logs
                                                </button>
                                            </div>
                                        </div>

                                        {isRunning && stat && (
                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '32px', background: 'var(--cr-well)', padding: '16px', borderRadius: '12px', border: '1px solid var(--cr-border-sub)' }}>
                                                <div>
                                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', marginBottom: '8px', fontFamily: 'var(--cr-font-mono)' }}>
                                                        <span style={{ color: 'var(--cr-sub)' }}>CPU ENGINE</span>
                                                        <span style={{ color: 'var(--cr-cream)' }}>{stat.cpu_percent || '0.00%'}</span>
                                                    </div>
                                                    <div style={{ height: '4px', width: '100%', background: 'var(--cr-tint-2)', borderRadius: '100px', overflow: 'hidden' }}>
                                                        <div style={{ height: '100%', background: 'var(--cr-accent)', width: stat.cpu_percent || '0%', boxShadow: '0 0 8px var(--cr-accent)' }} />
                                                    </div>
                                                </div>
                                                <div>
                                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', marginBottom: '8px', fontFamily: 'var(--cr-font-mono)' }}>
                                                        <span style={{ color: 'var(--cr-sub)' }}>MEMORY SWARM</span>
                                                        <span style={{ color: 'var(--cr-cream)' }}>{stat.memory_usage || '0B'}</span>
                                                    </div>
                                                    <div style={{ height: '4px', width: '100%', background: 'var(--cr-tint-2)', borderRadius: '100px', overflow: 'hidden' }}>
                                                        <div style={{ height: '100%', background: 'var(--cr-blue)', width: stat.memory_percent || '0%', boxShadow: '0 0 8px var(--cr-blue)' }} />
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )
                            })
                        )}
                    </div>
                </div>

                {/* Log Stream Panel */}
                {selectedContainer && (
                    <div style={{ width: '500px', display: 'flex', flexDirection: 'column', animation: 'crewFadeIn 0.3s ease-out' }}>
                        <div className="premium-card" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRadius: '16px', background: 'var(--cr-bg-card)' }}>
                            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--cr-border)', background: 'var(--cr-tint-1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                    <TerminalSquare size={16} color="var(--cr-accent)" />
                                    <h3 className="font-mono" style={{ fontSize: '13px', color: 'var(--cr-cream)', fontWeight: 600 }}>
                                        {selectedContainer}.log
                                    </h3>
                                </div>
                                <button onClick={() => setSelectedContainer(null)} style={{ color: 'var(--cr-muted)', fontSize: '18px' }}>&times;</button>
                            </div>
                            <div style={{ flex: 1, minHeight: 0 }}>
                                <ContainerLogs containerId={selectedContainer} />
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
