import React, { Component, type ReactNode } from 'react';
import AudiobookApp from './AudiobookApp';

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[Auralis ErrorBoundary caught]:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#070b16] text-[#eef2ff] p-8 flex flex-col items-center justify-center text-center font-sans">
          <div className="max-w-md w-full bg-[#111728] border border-red-800/40 p-6 rounded-2xl shadow-2xl">
            <div className="w-12 h-12 rounded-xl bg-red-950/60 border border-red-700/50 flex items-center justify-center text-red-400 mx-auto mb-3">
              ⚠️
            </div>
            <h2 className="text-base font-bold text-white mb-1">Affichage temporairement indisponible</h2>
            <p className="text-xs text-[#9aa7c0] mb-4">
              {this.state.error?.message || 'Une exception a été interceptée.'}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition"
            >
              Recharger l'application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <AudiobookApp />
    </ErrorBoundary>
  );
}
