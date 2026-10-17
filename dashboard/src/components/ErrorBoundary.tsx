import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    const { error } = this.state;

    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        background: 'var(--cr-bg-main)',
        color: 'var(--cr-text)',
        fontFamily: 'var(--cr-font-sans)',
        gap: '24px',
        padding: '40px',
      }}>
        <div style={{ fontSize: '32px', color: 'var(--cr-accent)' }}>⚠</div>

        <div style={{ textAlign: 'center', maxWidth: '480px' }}>
          <p style={{ fontSize: '18px', color: 'var(--cr-cream)', marginBottom: '8px' }}>
            Something went wrong
          </p>
          <p style={{ fontSize: '13px', color: 'var(--cr-sub)' }}>
            {error.message}
          </p>
        </div>

        <details style={{ maxWidth: '600px', width: '100%' }}>
          <summary style={{
            fontSize: '12px',
            color: 'var(--cr-muted-br)',
            cursor: 'pointer',
            marginBottom: '8px',
          }}>
            Stack trace
          </summary>
          <pre style={{
            fontSize: '11px',
            color: 'var(--cr-sub)',
            background: 'var(--cr-bg-elevated)',
            border: '1px solid var(--cr-border)',
            borderRadius: '6px',
            padding: '12px',
            overflowX: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}>
            {error.stack}
          </pre>
        </details>

        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '10px 24px',
            background: 'var(--cr-accent)',
            color: 'var(--cr-on-accent)',
            border: 'none',
            borderRadius: '6px',
            fontSize: '14px',
            cursor: 'pointer',
          }}
        >
          Reload dashboard
        </button>
      </div>
    );
  }
}
