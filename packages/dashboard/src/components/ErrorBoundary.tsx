import { Component, type ReactNode, type ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });
    console.error('[Hawkeye ErrorBoundary]', error.message, '\n', errorInfo.componentStack);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="p-8 rounded-lg border border-hawk-red/30 bg-hawk-red/5 m-4">
          <h2 className="font-display text-lg font-semibold text-hawk-red mb-2">Something went wrong</h2>
          <pre className="font-mono text-xs text-hawk-text2 whitespace-pre-wrap break-all max-h-60 overflow-auto bg-hawk-surface rounded p-3 border border-hawk-border">
            {this.state.error?.message}
          </pre>
          {this.state.errorInfo?.componentStack && (
            <details className="mt-3">
              <summary className="font-mono text-xs text-hawk-text3 cursor-pointer">Component Stack</summary>
              <pre className="mt-2 font-mono text-[10px] text-hawk-text3 whitespace-pre-wrap max-h-40 overflow-auto">
                {this.state.errorInfo.componentStack}
              </pre>
            </details>
          )}
          <button
            onClick={() => this.setState({ hasError: false, error: null, errorInfo: null })}
            className="mt-4 rounded bg-hawk-orange/20 px-3 py-1.5 font-mono text-xs text-hawk-orange hover:bg-hawk-orange/30 transition-colors"
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
