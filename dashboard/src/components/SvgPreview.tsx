/**
 * SvgPreview — renders an SVG file inline in a centred, scrollable container.
 *
 * Renders inline (dangerouslySetInnerHTML) so the SVG scales responsively
 * and viewBox / width / height attributes are respected. Agent-generated SVGs
 * are considered trusted content (same source as all other workspace files).
 */

interface SvgPreviewProps {
    content: string;
}

export default function SvgPreview({ content }: SvgPreviewProps) {
    // Inject max-width / max-height so the SVG never overflows the panel
    const wrapped = content.replace(
        /<svg/i,
        '<svg style="max-width:100%;max-height:100%;display:block;margin:auto;"'
    );

    return (
        <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '24px', overflowY: 'auto',
            background: 'var(--cr-tint-2)',
        }}>
            <div dangerouslySetInnerHTML={{ __html: wrapped }} />
        </div>
    );
}
