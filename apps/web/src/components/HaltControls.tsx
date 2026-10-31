import { useState } from 'react';
import { riskApi } from '../lib/api';
import { useInvalidateRisk } from '../hooks/useRisk';
import { ConfirmDialog, btnDanger, btnSecondary } from './ui';
import { dateTime } from '../lib/format';

/** Global halt: cancel every open order and stop every bot (spec §4.3). Anyone may press it. */
export function KillSwitchButton({ className = '' }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const invalidate = useInvalidateRisk();
  return (
    <>
      <button type="button" className={`${btnDanger} ${className}`} onClick={() => setOpen(true)}>
        Kill switch
      </button>
      {open && (
        <ConfirmDialog
          title="Activate the kill switch?"
          danger
          confirmLabel="Halt everything"
          reasonLabel="Reason"
          body={
            <>
              <p>This sets the global halt, cancels every open order and stops every bot (paper bots too). Positions are not sold.</p>
              <p>Only a human can clear the halt afterwards (password required).</p>
            </>
          }
          onConfirm={async (reason) => {
            await riskApi.killSwitch(reason || 'manual kill switch (UI)');
            invalidate();
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** Clear a global or bot halt: human only, reason required, may ask for the password again (re-auth). */
export function ClearHaltButton({ scope, label, className = '' }: { scope: string; label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const invalidate = useInvalidateRisk();
  return (
    <>
      <button type="button" className={`${btnSecondary} ${className}`} onClick={() => setOpen(true)}>
        {label ?? 'Clear halt'}
      </button>
      {open && (
        <ConfirmDialog
          title={scope === 'global' ? 'Clear the global halt?' : 'Clear this bot’s halt?'}
          confirmLabel="Clear halt"
          reasonLabel="Why is it safe to resume?"
          reasonRequired
          body={
            <>
              <p>Bots are not restarted automatically; start them yourself afterwards.</p>
              <p>For the rest of today the daily loss limit counts from the P&L at this moment.</p>
            </>
          }
          onConfirm={async (reason) => {
            await riskApi.clearHalt(scope, reason);
            invalidate();
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** Red banner for the global halt and halted bots */
export function HaltBanner({
  global,
  bots,
}: {
  global: { halted: boolean; reason: string | null; haltedAt: string | null } | null | undefined;
  bots: Array<{ botId: string; name: string; reason: string | null; haltedAt: string | null }>;
}) {
  if (!global?.halted && bots.length === 0) return null;
  return (
    <div className="bg-red-500/10 border border-red-500/40 rounded-xl p-4 space-y-3">
      {global?.halted && (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-red-300">Trading is halted (global)</p>
            <p className="text-sm text-red-200/80 break-words">
              {global.reason ?? 'no reason recorded'} · since {dateTime(global.haltedAt)}
            </p>
          </div>
          <ClearHaltButton scope="global" />
        </div>
      )}
      {bots.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-semibold text-red-300">Halted bots</p>
          {bots.map((b) => (
            <div key={b.botId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="min-w-0 break-words text-red-200/90">
                <a href={`#/bots/${b.botId}`} className="underline">
                  {b.name}
                </a>
                : {b.reason ?? 'no reason'} · {dateTime(b.haltedAt)}
              </span>
              <ClearHaltButton scope={b.botId} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
