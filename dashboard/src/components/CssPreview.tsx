/**
 * CssPreview — renders user CSS applied to a sample HTML scaffold in a sandboxed iframe.
 * Agents frequently generate theme files, component stylesheets, or design tokens.
 * This gives a live visual preview without needing a real page context.
 */

interface CssPreviewProps {
    content: string; // raw CSS text
}

function buildPreviewHtml(css: string): string {
    // Escape </style> in user CSS to prevent breaking the style tag
    const safeCSS = css.replace(/<\/style>/gi, '<\\/style>');
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
/* ── Reset ── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, sans-serif; padding: 24px; line-height: 1.6; }

/* ── User CSS ── */
${safeCSS}
</style>
</head>
<body>

<h1>Heading 1</h1>
<h2>Heading 2</h2>
<h3>Heading 3</h3>
<p>A paragraph of body text. The quick brown fox jumps over the lazy dog. <a href="#">A link</a> and <strong>bold text</strong> and <em>italic text</em>.</p>

<hr style="margin: 16px 0;">

<div class="container" style="margin: 12px 0;">
  <div class="card">
    <h4>Card Title</h4>
    <p>Card body content goes here.</p>
  </div>
</div>

<div style="display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0;">
  <button class="btn btn-primary">Primary</button>
  <button class="btn btn-secondary">Secondary</button>
  <button class="btn" disabled>Disabled</button>
</div>

<div style="margin: 12px 0; display: flex; flex-direction: column; gap: 8px;">
  <input type="text" placeholder="Text input" class="input" style="max-width: 320px;">
  <input type="email" placeholder="Email input" class="input" style="max-width: 320px;">
  <select class="input" style="max-width: 320px;">
    <option>Option 1</option>
    <option>Option 2</option>
    <option>Option 3</option>
  </select>
  <textarea class="input" rows="3" placeholder="Textarea" style="max-width: 320px; resize: vertical;"></textarea>
</div>

<ul style="margin: 12px 0 12px 20px;">
  <li>List item one</li>
  <li>List item two</li>
  <li>List item three</li>
</ul>

<table style="margin: 12px 0; width: 100%; border-collapse: collapse;">
  <thead>
    <tr>
      <th>Name</th><th>Role</th><th>Status</th>
    </tr>
  </thead>
  <tbody>
    <tr><td>Alice</td><td>Engineer</td><td>Active</td></tr>
    <tr><td>Bob</td><td>Designer</td><td>Active</td></tr>
    <tr><td>Carol</td><td>PM</td><td>Away</td></tr>
  </tbody>
</table>

<div class="alert" style="margin: 12px 0;">This is an alert message.</div>

<div style="margin: 12px 0; display: flex; gap: 6px; flex-wrap: wrap;">
  <span class="badge">Default</span>
  <span class="badge badge-success">Success</span>
  <span class="badge badge-warning">Warning</span>
  <span class="badge badge-error">Error</span>
</div>

<blockquote style="margin: 12px 0;">
  "A blockquote for quoted content or callouts."
</blockquote>

<pre style="margin: 12px 0;"><code>.example { color: red; }</code></pre>

</body>
</html>`;
}

export default function CssPreview({ content }: CssPreviewProps) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
            <iframe
                sandbox="allow-scripts"
                srcDoc={buildPreviewHtml(content)}
                // The iframe renders the user's own CSS, which assumes a browser
                // default white canvas. Theming this would change what they see.
                style={{
                    flex: 1,
                    width: '100%',
                    border: 'none',
                    background: '#fff',
                    display: 'block',
                }}
                title="CSS Preview"
            />
        </div>
    );
}
