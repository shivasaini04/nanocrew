/**
 * HtmlPreview — renders an HTML file in a sandboxed iframe.
 *
 * Given the agent and file it came from, the page also remembers what its viewer does on
 * it (see ArtifactFrame). Without them it renders as a plain preview.
 */
import ArtifactFrame from './ArtifactFrame';

interface HtmlPreviewProps {
    content: string;
    agentId?: string;
    filePath?: string;
}

export default function HtmlPreview({ content, agentId, filePath }: HtmlPreviewProps) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
            <ArtifactFrame html={content} agentId={agentId} filePath={filePath} title="HTML Preview" />
        </div>
    );
}
