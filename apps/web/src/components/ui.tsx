/** Small shared building blocks for the pages (dark theme, Tailwind) */

import { useEffect, useState, type ReactNode } from 'react';

export const inputCls = 'w-full px-3 py-2 bg-[#111] border border-[#333] rounded-lg text-white text-sm focus:outline-none focus:border-accent';
export const btnCls =
  'inline-flex items-center justify-center px-3 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
export const btnPrimary = `${btnCls} text-white bg-accent hover:bg-accent-hover`;
export const btnSecondary = `${btnCls} border border-[#333] text-gray-300 hover:bg-[#222]`;
export const btnDanger = `${btnCls} text-white bg-red-600 hover:bg-red-500`;
export const thCls = 'px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase whitespace-nowrap';
export const tdCls = 'px-3 py-2 text-sm text-gray-200 align-top';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-2xl font-bold text-white">{title}</h2>
        {subtitle && <p className="mt-1 text-sm text-gray-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`bg-surface border border-[#2a2a2a] rounded-xl ${className}`}>
      {(title || actions) && (
        <div className="px-4 sm:px-5 py-3 border-b border-[#2a2a2a] flex flex-wrap items-center justify-between gap-2">
          {title && <h3 className="text-base font-medium text-white">{title}</h3>}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

const TONES = {
  gray: 'bg-gray-500/10 text-gray-400 border-gray-500/20',
  green: 'bg-green-500/10 text-green-400 border-green-500/20',
  yellow: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  amber: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  red: 'bg-red-500/10 text-red-400 border-red-500/20',
  blue: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  purple: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  orange: 'bg-accent-muted text-accent border-accent/30',
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ tone = 'gray', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border whitespace-nowrap ${TONES[tone]}`}>
      {children}
    </span>
  );
}

const STAGE_TONES: Record<string, Tone> = { paper: 'amber', probation: 'blue', full: 'green', retired: 'gray' };

export function StageBadge({ stage }: { stage?: string | null }) {
  if (!stage) return null;
  return (
    <Badge tone={STAGE_TONES[stage] ?? 'gray'} title="Ramp stage (spec §4.5)">
      {stage}
    </Badge>
  );
}

const RIGHTS_TONES: Record<string, Tone> = { trading: 'green', shadow: 'gray', suspended: 'red', deprioritised: 'yellow' };
export function RightsBadge({ state, forced }: { state: string; forced?: boolean }) {
  return (
    <Badge tone={RIGHTS_TONES[state] ?? 'gray'} title={forced ? 'Forced by a human' : undefined}>
      {state}
      {forced ? ' (forced)' : ''}
    </Badge>
  );
}

/** Horizontal bar of `value` against `limit` (green < 70 %, yellow < 90 %, red beyond) */
export function LimitBar({
  label,
  value,
  limit,
  format,
  hint,
}: {
  label: ReactNode;
  value: number | null;
  limit: number | null;
  format: (n: number | null) => string;
  hint?: ReactNode;
}) {
  const ratio = value !== null && limit !== null && limit > 0 ? value / limit : value && value > 0 && limit === 0 ? 1 : 0;
  const width = Math.min(100, Math.max(0, ratio * 100));
  const color = ratio >= 0.9 ? 'bg-red-500' : ratio >= 0.7 ? 'bg-yellow-500' : 'bg-green-500';
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-gray-400">{label}</span>
        <span className="text-gray-200 tabular-nums">
          {format(value)} <span className="text-gray-500">/ {format(limit)}</span>
        </span>
      </div>
      <div className="mt-1.5 h-2 rounded-full bg-[#111] overflow-hidden" role="meter" aria-valuenow={value ?? undefined} aria-valuemax={limit ?? undefined}>
        <div className={`h-full ${color}`} style={{ width: `${width}%` }} />
      </div>
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

export function ErrorBox({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-sm text-red-300 whitespace-pre-wrap break-words">{children}</div>;
}

export function Notice({ tone = 'yellow', children }: { tone?: 'yellow' | 'red' | 'blue' | 'green'; children: ReactNode }) {
  const cls = {
    yellow: 'bg-yellow-500/10 border-yellow-500/20 text-yellow-200',
    red: 'bg-red-500/10 border-red-500/30 text-red-200',
    blue: 'bg-blue-500/10 border-blue-500/20 text-blue-200',
    green: 'bg-green-500/10 border-green-500/20 text-green-200',
  }[tone];
  return <div className={`border rounded-lg px-3 py-2 text-sm ${cls}`}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-gray-500 py-4 text-center">{children}</p>;
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className={`w-full ${wide ? 'sm:max-w-4xl' : 'sm:max-w-lg'} max-h-[92vh] flex flex-col bg-[#1a1a1a] border border-[#2a2a2a] rounded-t-xl sm:rounded-xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-[#2a2a2a]">
          <h3 className="text-base font-medium text-white min-w-0 break-words">{title}</h3>
          <button type="button" onClick={onClose} className="text-gray-500 hover:text-gray-200 text-xl leading-none" aria-label="Close">
            ×
          </button>
        </div>
        <div className="px-5 py-4 overflow-y-auto space-y-3">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-[#2a2a2a] flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Confirmation with an optional required reason. `onConfirm` may throw: its message is shown and the
 * dialog stays open (e.g. the re-auth dialog was cancelled).
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  reasonLabel,
  reasonRequired,
  onConfirm,
  onClose,
}: {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** Show a reason field */
  reasonLabel?: string;
  reasonRequired?: boolean;
  onConfirm: (reason: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = busy || (reasonRequired === true && reason.trim() === '');
  const submit = async () => {
    if (blocked) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btnSecondary} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={danger ? btnDanger : btnPrimary} disabled={blocked} onClick={submit}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      {body && <div className="text-sm text-gray-300 space-y-2">{body}</div>}
      {reasonLabel && (
        <label className="block">
          <span className="text-sm text-gray-400">
            {reasonLabel}
            {reasonRequired ? ' (required)' : ''}
          </span>
          <textarea className={`${inputCls} mt-1`} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </label>
      )}
      <ErrorBox>{error}</ErrorBox>
    </Modal>
  );
}

export function Tabs<T extends string>({ tabs, active, onChange }: { tabs: Array<{ id: T; label: ReactNode }>; active: T; onChange: (id: T) => void }) {
  return (
    <div className="flex gap-1 border-b border-[#2a2a2a] overflow-x-auto">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={`px-3 sm:px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
            active === t.id ? 'border-accent text-accent' : 'border-transparent text-gray-400 hover:text-gray-200'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Two-column definition list that stacks on phones */
export function Facts({ items }: { items: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
      {items.map(([k, v], i) => (
        <div key={i} className="min-w-0">
          <dt className="text-xs font-medium text-gray-500 uppercase">{k}</dt>
          <dd className="mt-0.5 text-sm text-gray-100 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
