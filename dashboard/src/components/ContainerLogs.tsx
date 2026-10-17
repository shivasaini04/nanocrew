import { useEffect, useRef } from 'react';
import { useContainerStore } from '../stores/containerStore';

interface ContainerLogsProps {
    containerId: string;
}

export default function ContainerLogs({ containerId }: ContainerLogsProps) {
    const { logs, subscribeLogs, unsubscribeLogs } = useContainerStore();
    const containerLogs = logs[containerId] || [];
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        subscribeLogs(containerId);
        return () => {
            unsubscribeLogs(containerId);
        };
    }, [containerId, subscribeLogs, unsubscribeLogs]);

    // Auto-scroll to bottom
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [containerLogs]);

    return (
        <div className="bg-glass border border-white/5 rounded-xl overflow-hidden shadow-2xl backdrop-blur-md flex flex-col h-full h-[400px]">
            <div className="px-4 py-3 bg-black/40 border-b border-white/5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_var(--cr-green-line)] animate-pulse" />
                    <h3 className="text-sm font-medium text-white/90 font-mono tracking-tight">
                        Log Stream
                    </h3>
                </div>
                <div className="text-xs text-secondary font-mono">
                    {containerId.substring(0, 12)}
                </div>
            </div>
            <div
                ref={scrollRef}
                className="flex-1 p-4 overflow-y-auto font-mono text-xs text-gray-300 leading-relaxed bg-[#0a0a0a]/80"
            >
                {containerLogs.length === 0 ? (
                    <div className="text-secondary italic flex items-center h-full justify-center">
                        Waiting for logs...
                    </div>
                ) : (
                    containerLogs.map((log, index) => (
                        <div key={index} className="break-all hover:bg-white/5 px-2 py-0.5 rounded transition-colors break-words whitespace-pre-wrap">
                            {log}
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
