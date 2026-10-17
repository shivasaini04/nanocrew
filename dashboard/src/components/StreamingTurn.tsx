import React from 'react';
import { CR, withAlpha } from '../lib/cr';
import { CycleTimeline, type TimelineStep } from './CycleTimeline';

/**
 * StreamingTurn — the live "agent is working" turn, used by BOTH the agent chat
 * and the project chat. A thin wrapper (avatar + name) around the shared
 * CycleTimeline rendered in active mode.
 */

export interface StreamingTurnTool extends TimelineStep {
    id: string;
    name: string;
    args: string;
    result?: string;
}

interface StreamingTurnProps {
    agentName?: string;
    agentEmoji?: string;
    agentColor?: string;
    liveTools?: StreamingTurnTool[];
    /** Live cumulative token count (Claude-style "· N tokens"); omit when unavailable. */
    tokenCount?: number;
}

export const StreamingTurn: React.FC<StreamingTurnProps> = ({
    agentName = 'Agent', agentEmoji = '🤖', agentColor = CR.accent, liveTools = [], tokenCount,
}) => {
    return (
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div style={{
                width: 34, height: 34, borderRadius: 10, flexShrink: 0,
                background: `${withAlpha(agentColor, 8)}`, border: `1px solid ${withAlpha(agentColor, 19)}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16,
                animation: 'crewPulse 2s infinite',
            }}>{agentEmoji}</div>
            <div style={{ maxWidth: '76%' }}>
                <div style={{ fontFamily: CR.sans, fontSize: 11, fontWeight: 600, color: agentColor, paddingLeft: 4, marginBottom: 4 }}>
                    {agentName}
                </div>
                <div style={{ paddingLeft: 4 }}>
                    <CycleTimeline steps={liveTools} agentColor={agentColor} isActive tokenCount={tokenCount} />
                </div>
            </div>
        </div>
    );
};

