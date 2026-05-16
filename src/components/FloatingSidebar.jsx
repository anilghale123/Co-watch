// src/components/FloatingSidebar.jsx
'use client';

import { useState } from 'react';
import PropTypes from 'prop-types';
import { cn } from '@/lib/utils';
import Button from '@/components/ui/Button';

/**
 * Collapsible side panel that hosts the chat + presence. On wide screens it
 * sits beside the theater; collapsing it gives the video full width. On small
 * screens it overlays. Semantic <aside>, keyboard-operable toggle.
 */
export default function FloatingSidebar({ title, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <aside
      aria-label={title}
      className={cn(
        'relative flex h-full shrink-0 flex-col transition-all duration-200',
        open ? 'w-full sm:w-[340px]' : 'w-full sm:w-[44px]',
      )}
    >
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        {open ? (
          <span className="text-sm font-semibold text-white/90">{title}</span>
        ) : null}
        <Button
          size="icon"
          variant="ghost"
          aria-expanded={open}
          aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
          onClick={() => setOpen((v) => !v)}
          className="ml-auto"
        >
          <span aria-hidden="true">{open ? '⟩' : '⟨'}</span>
        </Button>
      </div>
      <div className={cn('flex-1 overflow-hidden', open ? 'block' : 'hidden')}>
        {children}
      </div>
    </aside>
  );
}

FloatingSidebar.propTypes = {
  title: PropTypes.string.isRequired,
  children: PropTypes.node,
  defaultOpen: PropTypes.bool,
};
