'use client';

import { useEffect, useRef, useState } from 'react';

interface Placement {
  text: string;
  left: number;
  top: number;
}

const WIDTH = 256;
const MARGIN = 8;

/**
 * The single tooltip panel for the whole app.
 *
 * Mounted once in the layout. It listens for pointer and focus events on any
 * element carrying `data-hint`, then positions one shared panel clamped to the
 * viewport — so a tooltip near any edge flips instead of being cut off.
 *
 * Uses `position: fixed`, which escapes any ancestor with `overflow: hidden`
 * (tables scroll horizontally, and an absolutely positioned panel would be
 * clipped by them).
 */
export function HintLayer() {
  const [placement, setPlacement] = useState<Placement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function show(target: HTMLElement) {
      const text = target.getAttribute('data-hint');
      if (!text) return;
      const r = target.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;

      // Centre on the trigger, then clamp into the viewport.
      let left = r.left + r.width / 2 - WIDTH / 2;
      left = Math.max(MARGIN, Math.min(left, vw - WIDTH - MARGIN));

      // Prefer below; flip above when there is not enough room.
      const estimatedHeight = 96;
      const top = r.bottom + estimatedHeight + MARGIN > vh ? r.top - estimatedHeight - 6 : r.bottom + 6;

      setPlacement({ text, left, top: Math.max(MARGIN, top) });
    }

    function hide() {
      setPlacement(null);
    }

    function onOver(e: Event) {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-hint]');
      if (el) show(el);
      else hide();
    }

    function onFocus(e: Event) {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-hint]');
      if (el) show(el);
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') hide();
    }

    document.addEventListener('pointerover', onOver);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', hide);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', hide, true);
    return () => {
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', hide, true);
    };
  }, []);

  if (!placement) return null;

  return (
    <div
      ref={panelRef}
      role="tooltip"
      style={{ left: placement.left, top: placement.top, width: WIDTH }}
      className="pointer-events-none fixed z-[100] rounded border border-line-strong bg-bg-raised px-2.5 py-2 text-2xs font-normal normal-case leading-relaxed tracking-normal text-ink-muted shadow-lg"
    >
      {placement.text}
    </div>
  );
}
