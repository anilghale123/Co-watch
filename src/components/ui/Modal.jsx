// src/components/ui/Modal.jsx
'use client';

import { useEffect, useRef } from 'react';
import PropTypes from 'prop-types';
import { cn } from '@/lib/utils';

/**
 * Accessible modal dialog: focus-trapped-ish (focuses panel on open),
 * Escape-to-close, backdrop click, ARIA dialog role.
 */
export default function Modal({ open, onClose, title, children, dismissable = true }) {
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissable && onClose) onClose();
    };
    window.addEventListener('keydown', onKey);
    if (panelRef.current) panelRef.current.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, dismissable, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && dismissable && onClose) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title || 'Dialog'}
        tabIndex={-1}
        className={cn(
          'w-full max-w-md rounded-2xl border border-edge bg-panel p-6',
          'shadow-2xl outline-none',
        )}
      >
        {title ? (
          <h2 className="mb-4 text-lg font-semibold text-white">{title}</h2>
        ) : null}
        {children}
      </div>
    </div>
  );
}

Modal.propTypes = {
  open: PropTypes.bool.isRequired,
  onClose: PropTypes.func,
  title: PropTypes.string,
  children: PropTypes.node,
  dismissable: PropTypes.bool,
};
