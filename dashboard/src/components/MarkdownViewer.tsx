import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownViewerProps {
    content: string;
    className?: string;
    /** File-content context this markdown was loaded from (e.g. 'agent', 'project', 'job') — required to resolve relative image paths. */
    context?: string;
    contextId?: string;
    /** Directory containing the markdown file, relative to the context's workspace root — relative image srcs resolve against this. */
    basePath?: string;
}

/** Joins a base directory with a relative path and collapses '.'/'..' segments (no leading slash — workspace-relative). */
function resolveRelativePath(basePath: string, relSrc: string): string {
    const parts = [...basePath.split('/'), ...relSrc.split('/')].filter(p => p !== '' && p !== '.');
    const resolved: string[] = [];
    for (const part of parts) {
        if (part === '..') resolved.pop();
        else resolved.push(part);
    }
    return resolved.join('/');
}

function isAbsoluteUrl(src: string): boolean {
    return /^([a-z]+:)?\/\//i.test(src) || src.startsWith('data:') || src.startsWith('/');
}

/**
 * MarkdownViewer Component
 * Renders markdown content using react-markdown and remark-gfm.
 * Uses the .prose class from index.css for consistent dashboard styling.
 *
 * Image srcs in the markdown are almost always relative paths written by an agent
 * (e.g. `figures/plot.png`, relative to the .md file's own directory) — plain
 * react-markdown renders those as literal <img src="figures/plot.png">, which
 * resolves against the dashboard's own page URL and 404s. When context/contextId/
 * basePath are supplied, relative srcs are rewritten to the workspace file-content
 * API instead.
 */
export default function MarkdownViewer({ content, className = '', context, contextId, basePath }: MarkdownViewerProps) {
    return (
        <div className={`prose ${className}`} style={{ width: '100%' }}>
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={context && contextId ? {
                    img: ({ src, alt }) => {
                        const resolvedSrc = src && !isAbsoluteUrl(src)
                            ? `/api/files/content?context=${encodeURIComponent(context)}&contextId=${encodeURIComponent(contextId)}&path=${encodeURIComponent(resolveRelativePath(basePath ?? '', src))}`
                            : src;
                        return <img src={resolvedSrc} alt={alt ?? ''} style={{ maxWidth: '100%', borderRadius: '8px' }} />;
                    },
                } : undefined}
            >
                {content}
            </ReactMarkdown>
        </div>
    );
}
