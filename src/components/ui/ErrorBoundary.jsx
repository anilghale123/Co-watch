// src/components/ui/ErrorBoundary.jsx
'use client';

import React from 'react';
import PropTypes from 'prop-types';

/**
 * Class-based error boundary (spec §4). React requires a class for
 * `componentDidCatch` / `getDerivedStateFromError` — there is no hook
 * equivalent. Wrapping the room subtree means a render-time crash in the
 * player or chat shows a recoverable fallback instead of a white screen.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, message: '' };
    this.handleReset = this.handleReset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, message: error && error.message ? error.message : 'Unexpected error' };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info);
  }

  handleReset() {
    this.setState({ hasError: false, message: '' });
    if (this.props.onReset) this.props.onReset();
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div
          role="alert"
          className="flex h-full min-h-[200px] flex-col items-center justify-center gap-3 p-6 text-center"
        >
          <p className="text-lg font-semibold text-white">Something broke in this panel.</p>
          <p className="max-w-sm text-sm text-white/60">{this.state.message}</p>
          <button
            type="button"
            onClick={this.handleReset}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ErrorBoundary.propTypes = {
  children: PropTypes.node,
  fallback: PropTypes.node,
  onReset: PropTypes.func,
};
