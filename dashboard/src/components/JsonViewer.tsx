import React, { useState } from 'react';
import { ChevronRight, ChevronDown, Copy, Check } from 'lucide-react';

interface JsonViewerProps {
    data: any;
    label?: string;
    isLast?: boolean;
    depth?: number;
}

const JsonNode: React.FC<JsonViewerProps> = ({ data, label, isLast, depth = 0 }) => {
    const [isExpanded, setIsExpanded] = useState(depth < 2);
    const isObject = typeof data === 'object' && data !== null;
    const isArray = Array.isArray(data);

    const renderValue = (val: any) => {
        if (typeof val === 'string') return <span style={{ color: 'var(--cr-green)' }}>"{val}"</span>;
        if (typeof val === 'number') return <span style={{ color: 'var(--cr-warn)' }}>{val}</span>;
        if (typeof val === 'boolean') return <span style={{ color: 'var(--cr-purple)' }}>{val.toString()}</span>;
        if (val === null) return <span style={{ color: 'var(--cr-blue)' }}>null</span>;
        return val.toString();
    };

    if (!isObject) {
        return (
            <div style={{ marginLeft: '20px', fontSize: '12.5px', lineHeight: '1.6', fontFamily: 'JetBrains Mono, monospace' }}>
                {label && <span style={{ color: 'var(--accent-cyan)', marginRight: '8px' }}>"{label}":</span>}
                {renderValue(data)}
                {!isLast && <span style={{ color: 'var(--cr-line-str)' }}>,</span>}
            </div>
        );
    }

    const keys = Object.keys(data);
    const bracketOpen = isArray ? '[' : '{';
    const bracketClose = isArray ? ']' : '}';

    return (
        <div style={{ fontSize: '12.5px', lineHeight: '1.6', fontFamily: 'JetBrains Mono, monospace' }}>
            <div 
                onClick={() => setIsExpanded(!isExpanded)} 
                style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', gap: '4px' }}
            >
                {keys.length > 0 ? (
                    isExpanded ? <ChevronDown size={14} color="var(--cr-muted-br)" /> : <ChevronRight size={14} color="var(--cr-muted-br)" />
                ) : <div style={{ width: '14px' }} />}
                
                {label && <span style={{ color: 'var(--accent-cyan)', marginRight: '8px' }}>"{label}":</span>}
                <span style={{ color: 'var(--cr-muted)' }}>{bracketOpen}</span>
                {!isExpanded && keys.length > 0 && <span style={{ color: 'var(--cr-line-str)', fontSize: '11px' }}> ... </span>}
                {!isExpanded && <span style={{ color: 'var(--cr-muted)' }}>{bracketClose}</span>}
                {!isExpanded && !isLast && <span style={{ color: 'var(--cr-line-str)' }}>,</span>}
                
                {!isExpanded && (
                    <span style={{ fontSize: '10px', color: 'var(--cr-line-str)', marginLeft: '8px' }}>
                        // {keys.length} {isArray ? 'items' : 'keys'}
                    </span>
                )}
            </div>

            {isExpanded && (
                <div style={{ borderLeft: '1px solid var(--cr-tint-4)', marginLeft: '6px', paddingLeft: '14px' }}>
                    {keys.map((key, index) => (
                        <JsonNode 
                            key={key} 
                            label={isArray ? undefined : key} 
                            data={data[key]} 
                            isLast={index === keys.length - 1}
                            depth={depth + 1}
                        />
                    ))}
                </div>
            )}

            {isExpanded && (
                <div style={{ marginLeft: '18px' }}>
                    <span style={{ color: 'var(--cr-muted)' }}>{bracketClose}</span>
                    {!isLast && <span style={{ color: 'var(--cr-line-str)' }}>,</span>}
                </div>
            )}
        </div>
    );
};

export const JsonViewer: React.FC<{ data: any }> = ({ data }) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = () => {
        navigator.clipboard.writeText(JSON.stringify(data, null, 2));
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div style={{ 
            background: 'var(--cr-well)', 
            borderRadius: '8px', 
            border: '1px solid var(--cr-tint-4)',
            padding: '16px',
            position: 'relative',
            minHeight: '100px'
        }}>
            <button
                onClick={handleCopy}
                style={{
                    position: 'absolute',
                    top: '12px',
                    right: '12px',
                    background: 'var(--cr-tint-3)',
                    border: '1px solid var(--cr-tint-5)',
                    borderRadius: '4px',
                    padding: '6px',
                    color: 'var(--cr-muted-br)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '11px',
                    transition: 'all 0.2s',
                    zIndex: 10
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--cr-tint-5)'; e.currentTarget.style.color = 'var(--cr-cream)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--cr-tint-3)'; e.currentTarget.style.color = 'var(--cr-muted-br)'; }}
            >
                {copied ? <Check size={14} color="var(--cr-green)" /> : <Copy size={14} />}
                {copied ? 'Copied' : 'Copy'}
            </button>

            <div style={{ overflowX: 'auto' }}>
                <JsonNode data={data} isLast={true} />
            </div>
        </div>
    );
};
