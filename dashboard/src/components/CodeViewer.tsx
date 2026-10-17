import { Light as SyntaxHighlighter } from 'react-syntax-highlighter';
import { atomOneDark } from 'react-syntax-highlighter/dist/esm/styles/hljs';

// Register only the languages we're likely to encounter
import python from 'react-syntax-highlighter/dist/esm/languages/hljs/python';
import javascript from 'react-syntax-highlighter/dist/esm/languages/hljs/javascript';
import typescript from 'react-syntax-highlighter/dist/esm/languages/hljs/typescript';
import bash from 'react-syntax-highlighter/dist/esm/languages/hljs/bash';
import sql from 'react-syntax-highlighter/dist/esm/languages/hljs/sql';
import json from 'react-syntax-highlighter/dist/esm/languages/hljs/json';
import yaml from 'react-syntax-highlighter/dist/esm/languages/hljs/yaml';
import xml from 'react-syntax-highlighter/dist/esm/languages/hljs/xml';

SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('javascript', javascript);
SyntaxHighlighter.registerLanguage('typescript', typescript);
SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('shell', bash);
SyntaxHighlighter.registerLanguage('sql', sql);
SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('yaml', yaml);
SyntaxHighlighter.registerLanguage('xml', xml);

const EXT_TO_LANG: Record<string, string> = {
    py: 'python',
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    sql: 'sql',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    html: 'xml',
    htm: 'xml',
    toml: 'yaml',
};

export function isCodeFile(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    return ext in EXT_TO_LANG;
}

export function isPythonFile(filename: string): boolean {
    return filename.split('.').pop()?.toLowerCase() === 'py';
}

export function isHtmlFile(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    return ext === 'html' || ext === 'htm';
}

export function isJsOrTsFile(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    return ext === 'js' || ext === 'ts' || ext === 'jsx' || ext === 'tsx';
}

export function isSqlFile(filename: string): boolean {
    return filename.split('.').pop()?.toLowerCase() === 'sql';
}

export function isSvgFile(filename: string): boolean {
    return filename.split('.').pop()?.toLowerCase() === 'svg';
}

export function isCssFile(filename: string): boolean {
    return filename.split('.').pop()?.toLowerCase() === 'css';
}

export function isShellFile(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    return ext === 'sh' || ext === 'bash' || ext === 'zsh';
}

interface CodeViewerProps {
    filename: string;
    code: string;
}

export default function CodeViewer({ filename, code }: CodeViewerProps) {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    const language = EXT_TO_LANG[ext] ?? 'plaintext';

    return (
        <SyntaxHighlighter
            language={language}
            style={atomOneDark}
            showLineNumbers
            wrapLongLines={false}
            customStyle={{
                margin: 0,
                padding: '16px',
                background: 'transparent',
                fontSize: '12px',
                lineHeight: '1.65',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
            lineNumberStyle={{
                minWidth: '2.5em',
                paddingRight: '1em',
                color: 'var(--cr-muted)',
                userSelect: 'none',
            }}
        >
            {code}
        </SyntaxHighlighter>
    );
}
