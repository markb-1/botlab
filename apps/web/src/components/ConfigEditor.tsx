import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import YAML from 'yaml';
import { configApi, type ConfigFile } from '../lib/api';
import type { ConfigPreview, ConfigVersion } from '../types';
import { useConfig, useConfigSchemas } from '../hooks/useRisk';
import { SchemaForm } from './SchemaForm';
import { DiffView } from './DiffView';
import { Badge, Card, ErrorBox, Modal, Notice, btnPrimary, btnSecondary, inputCls } from './ui';
import { dateTime, errorMessage } from '../lib/format';

const SECRET_PATHS: Partial<Record<ConfigFile, string[]>> = { server: ['notify.telegram.bot_token'] };

function fmtValue(v: unknown): string {
  if (v === undefined) return '(unset)';
  return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
}

/**
 * Editor for one config file (spec §3): a form generated from the zod schema or the YAML text, "Review"
 * runs the server-side validation and risk classification (dry run), saving sends the file hash loaded
 * with the config so a concurrent hand edit is not overwritten. Raising risk needs an explicit tick.
 */
export function ConfigEditor({
  file,
  intro,
  defaultMode = 'form',
  pick,
}: {
  file: ConfigFile;
  intro?: React.ReactNode;
  defaultMode?: 'form' | 'yaml';
  pick?: string[];
}) {
  const qc = useQueryClient();
  const { data: cfg, error: cfgError, refetch } = useConfig();
  const { data: schemas } = useConfigSchemas();
  const loaded = (cfg?.config?.[file] ?? null) as Record<string, unknown> | null;
  const hash = cfg?.hashes?.[file];

  const [draft, setDraft] = useState<unknown>(null);
  const [baseHash, setBaseHash] = useState<string | undefined>(undefined);
  /** The value the edit started from (dirty = draft differs from it) */
  const [base, setBase] = useState<unknown>(null);
  const [mode, setMode] = useState<'form' | 'yaml'>(defaultMode);
  const [yamlText, setYamlText] = useState('');
  const [yamlError, setYamlError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formKey, setFormKey] = useState(0);
  const [preview, setPreview] = useState<ConfigPreview | null>(null);
  const [ackRaise, setAckRaise] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(base);
  const adopt = (value: Record<string, unknown> | null, h: string | undefined) => {
    setDraft(value);
    setBase(value);
    setBaseHash(h);
    setYamlText(YAML.stringify(value ?? {}));
    setYamlError(null);
    setFieldErrors({});
    setFormKey((k) => k + 1);
    setPreview(null);
  };
  // First load, or the file changed on the server while nothing was edited here
  useEffect(() => {
    if (loaded && (!dirty || baseHash === undefined) && hash !== baseHash) adopt(loaded, hash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, loaded === null]);

  const changedOnServer = baseHash !== undefined && hash !== undefined && hash !== baseHash;
  const hasFieldErrors = Object.keys(fieldErrors).length > 0;

  const schema = useMemo(() => {
    const s = schemas?.[file];
    if (!s || !pick) return s;
    return { ...s, properties: Object.fromEntries(Object.entries(s.properties ?? {}).filter(([k]) => pick.includes(k))) };
  }, [schemas, file, pick]);

  const currentValue = (): unknown => {
    if (mode === 'yaml') {
      const parsed = YAML.parse(yamlText) as unknown;
      return parsed ?? {};
    }
    return draft;
  };

  const switchMode = (next: 'form' | 'yaml') => {
    if (next === mode) return;
    if (next === 'yaml') {
      // Fields with a typing error kept their last valid value, which is what the YAML shows
      setYamlText(YAML.stringify(draft ?? {}));
      setYamlError(null);
      setFieldErrors({});
      setFormKey((k) => k + 1);
    } else {
      try {
        setDraft(YAML.parse(yamlText) ?? {});
        setFormKey((k) => k + 1);
        setFieldErrors({});
      } catch (err) {
        setYamlError(errorMessage(err));
        return;
      }
    }
    setPreview(null);
    setMode(next);
  };

  const reset = () => {
    adopt(loaded, hash);
    setError(null);
  };

  const review = async () => {
    setError(null);
    setSaved(null);
    setAckRaise(false);
    let value: unknown;
    try {
      value = currentValue();
    } catch (err) {
      setYamlError(errorMessage(err));
      return;
    }
    setBusy(true);
    try {
      setPreview((await configApi.preview(file, value)) as ConfigPreview);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!baseHash) {
      setError('The file hash is unknown (the config did not reload): reload the page before saving.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const value = currentValue();
      const res = (await configApi.write(file, value, baseHash)) as { changes: unknown[]; raises: string[] };
      setSaved(
        `Saved ${file}.yaml: ${res.changes.length} change(s)${res.raises.length ? `, ${res.raises.length} raising risk (Telegram confirmation sent if enabled)` : ''}.`
      );
      setPreview(null);
      const fresh = await refetch();
      const freshHash = fresh.data?.hashes?.[file];
      if (fresh.error || !freshHash || !fresh.data?.config?.[file]) {
        // Saved, but the new state could not be loaded: block further saves until a reload succeeds
        setBaseHash(undefined);
        setError('Saved, but reloading the config failed. Reload the page before editing again.');
      } else {
        adopt(fresh.data.config[file] as Record<string, unknown>, freshHash);
      }
      qc.invalidateQueries({ queryKey: ['configHistory', file] });
      qc.invalidateQueries({ queryKey: ['overview'] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (cfgError) return <ErrorBox>{errorMessage(cfgError)}</ErrorBox>;
  if (!cfg) return <p className="text-sm text-gray-500">Loading…</p>;

  return (
    <div className="space-y-4">
      {cfg.error && (
        <Notice tone="red">
          The config on disk is invalid, so edits cannot be checked until it is fixed by hand: <span className="whitespace-pre-wrap">{cfg.error}</span>
        </Notice>
      )}
      <Card
        title={
          <span>
            {file}.yaml {dirty && <Badge tone="yellow">unsaved changes</Badge>}
          </span>
        }
        actions={
          <div className="inline-flex rounded-lg border border-[#333] overflow-hidden text-xs">
            {(['form', 'yaml'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => switchMode(m)}
                className={`px-3 py-1.5 ${mode === m ? 'bg-accent text-white' : 'text-gray-400 hover:text-gray-200'}`}
              >
                {m === 'form' ? 'Form' : 'YAML'}
              </button>
            ))}
          </div>
        }
      >
        <div className="space-y-4">
          {intro && <div className="text-sm text-gray-400 space-y-1">{intro}</div>}
          {changedOnServer && (
            <Notice tone="yellow">
              {file}.yaml changed on the server since you started editing.{' '}
              <button type="button" className="underline" onClick={reset}>
                Reload it
              </button>{' '}
              (your edits here are discarded) — saving now would be refused.
            </Notice>
          )}
          {mode === 'form' ? (
            schema && draft !== null ? (
              <SchemaForm
                key={formKey}
                schema={schema}
                value={draft}
                secretPaths={SECRET_PATHS[file]}
                onChange={(v) => {
                  setDraft(v);
                  setPreview(null);
                }}
                onFieldError={(p, err) =>
                  setFieldErrors((prev) => {
                    if (!err && !(p in prev)) return prev;
                    const next = { ...prev };
                    if (err) next[p] = err;
                    else delete next[p];
                    return next;
                  })
                }
              />
            ) : (
              <p className="text-sm text-gray-500">Loading form…</p>
            )
          ) : (
            <div>
              <textarea
                className={`${inputCls} font-mono text-xs`}
                rows={22}
                spellCheck={false}
                value={yamlText}
                onChange={(e) => {
                  setYamlText(e.target.value);
                  setYamlError(null);
                  setPreview(null);
                }}
              />
              <p className="mt-1 text-xs text-gray-500">
                Edit the values as YAML. The server merges them into the file and keeps its comments; secrets show as <code>***</code> (leave them to keep the
                stored value).
              </p>
            </div>
          )}
          {yamlError && <ErrorBox>YAML: {yamlError}</ErrorBox>}
          <ErrorBox>{error}</ErrorBox>
          {saved && <Notice tone="green">{saved}</Notice>}

          <div className="sticky bottom-0 -mx-4 sm:-mx-5 px-4 sm:px-5 py-3 bg-surface border-t border-[#2a2a2a] flex flex-wrap gap-2 justify-end">
            <button type="button" className={btnSecondary} onClick={reset} disabled={busy}>
              Discard
            </button>
            <button type="button" className={btnPrimary} onClick={review} disabled={busy || hasFieldErrors || !!yamlError}>
              {busy && !preview ? 'Checking…' : 'Review changes'}
            </button>
          </div>
          {preview && (
            <Modal
              title={`Review ${file}.yaml`}
              onClose={() => setPreview(null)}
              wide
              footer={
                <>
                  <button type="button" className={btnSecondary} onClick={() => setPreview(null)}>
                    {preview.valid ? 'Back to editing' : 'Close'}
                  </button>
                  {preview.valid && (
                    <button
                      type="button"
                      className={btnPrimary}
                      onClick={save}
                      disabled={busy || preview.changes.length === 0 || (preview.raises && !ackRaise) || changedOnServer}
                    >
                      {busy ? 'Saving…' : preview.raises ? 'Save (raises risk)' : 'Save'}
                    </button>
                  )}
                </>
              }
            >
              <PreviewPanel preview={preview} ackRaise={ackRaise} setAckRaise={setAckRaise} />
              {changedOnServer && <Notice tone="yellow">{file}.yaml changed on the server meanwhile: reload it before saving.</Notice>}
              <ErrorBox>{error}</ErrorBox>
            </Modal>
          )}
        </div>
      </Card>
      <ConfigHistory file={file} />
    </div>
  );
}

function PreviewPanel({ preview, ackRaise, setAckRaise }: { preview: ConfigPreview; ackRaise: boolean; setAckRaise: (v: boolean) => void }) {
  if (!preview.valid) {
    return (
      <ErrorBox>
        <p className="font-medium">The server would reject this:</p>
        <ul className="list-disc pl-5">
          {preview.issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      </ErrorBox>
    );
  }
  if (preview.changes.length === 0) return <Notice tone="blue">No changes to save.</Notice>;
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border border-[#2a2a2a]">
        <table className="min-w-full text-sm">
          <thead className="bg-[#111]">
            <tr>
              <th className="px-3 py-2 text-left text-xs text-gray-500 uppercase">Key</th>
              <th className="px-3 py-2 text-left text-xs text-gray-500 uppercase">Before</th>
              <th className="px-3 py-2 text-left text-xs text-gray-500 uppercase">After</th>
              <th className="px-3 py-2 text-left text-xs text-gray-500 uppercase">Effect</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#2a2a2a]">
            {preview.changes.map((c) => (
              <tr key={c.path}>
                <td className="px-3 py-2 font-mono text-xs text-gray-300 break-all">{c.path}</td>
                <td className="px-3 py-2 font-mono text-xs text-gray-400 break-all">{fmtValue(c.old)}</td>
                <td className="px-3 py-2 font-mono text-xs text-gray-100 break-all">{fmtValue(c.new)}</td>
                <td className="px-3 py-2">
                  <Badge tone={c.effect === 'raises' ? 'red' : c.effect === 'lowers' ? 'green' : 'gray'}>{c.effect}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {preview.raises && (
        <Notice tone="red">
          <p className="font-medium">This change raises risk.</p>
          <p>It takes effect immediately when saved and a Telegram confirmation is sent (if Telegram is enabled).</p>
          <label className="mt-2 flex items-center gap-2">
            <input type="checkbox" checked={ackRaise} onChange={(e) => setAckRaise(e.target.checked)} />
            <span>I understand and want to raise risk.</span>
          </label>
        </Notice>
      )}
    </div>
  );
}

/** Version list with a diff against the previous version and restore (human, recent password) */
export function ConfigHistory({ file }: { file: ConfigFile }) {
  const qc = useQueryClient();
  const { data: versions = [], error } = useQuery({
    queryKey: ['configHistory', file],
    queryFn: async () => (await configApi.history(file)) as ConfigVersion[],
  });
  const [diffOf, setDiffOf] = useState<{ v: ConfigVersion; prev: ConfigVersion | null } | null>(null);
  const [restoreOf, setRestoreOf] = useState<ConfigVersion | null>(null);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? versions : versions.slice(0, 8);
  return (
    <Card title={`History of ${file}.yaml`}>
      <ErrorBox>{error ? errorMessage(error) : null}</ErrorBox>
      {versions.length === 0 ? (
        <p className="text-sm text-gray-500">No versions recorded yet.</p>
      ) : (
        <ul className="divide-y divide-[#2a2a2a]">
          {shown.map((v, i) => (
            <li key={v.versionId} className="py-2 flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="min-w-0">
                <span className="text-gray-200">{dateTime(v.at)}</span>{' '}
                <span className="text-gray-500">
                  · {v.actor} · {v.source}
                </span>
                {i === 0 && (
                  <span className="ml-2">
                    <Badge tone="green">current</Badge>
                  </span>
                )}
              </span>
              <span className="flex gap-2">
                <button type="button" className="text-accent hover:text-accent-hover text-sm" onClick={() => setDiffOf({ v, prev: versions[i + 1] ?? null })}>
                  Diff
                </button>
                {i > 0 && (
                  <button type="button" className="text-gray-300 hover:text-white text-sm" onClick={() => setRestoreOf(v)}>
                    Restore
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {versions.length > 8 && (
        <button type="button" className="mt-2 text-sm text-accent" onClick={() => setShowAll((s) => !s)}>
          {showAll ? 'Show fewer' : `Show all ${versions.length}`}
        </button>
      )}
      {diffOf && <VersionDiff file={file} v={diffOf.v} prev={diffOf.prev} onClose={() => setDiffOf(null)} />}
      {restoreOf && (
        <RestoreReview
          file={file}
          version={restoreOf}
          onDone={() => {
            for (const k of ['config', 'configHistory', 'overview']) qc.invalidateQueries({ queryKey: [k] });
          }}
          onClose={() => setRestoreOf(null)}
        />
      )}
    </Card>
  );
}

/**
 * Restore goes through the same review as an edit: the server classifies the version against the current
 * file (an older, looser version raises risk), raises need the tick, and the restore carries the hash of
 * the file as reviewed so a concurrent edit is not overwritten.
 */
function RestoreReview({ file, version, onDone, onClose }: { file: ConfigFile; version: ConfigVersion; onDone: () => void; onClose: () => void }) {
  const { data: cfg } = useConfig();
  const [hash] = useState<string | undefined>(cfg?.hashes?.[file]);
  const { data: preview, error: previewError } = useQuery({
    queryKey: ['configRestorePreview', file, version.versionId],
    queryFn: async () => (await configApi.previewRestore(file, version.versionId)) as ConfigPreview,
    gcTime: 0,
  });
  const [ackRaise, setAckRaise] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restore = async () => {
    if (!hash) {
      setError('The current file hash is unknown; reload the page before restoring.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await configApi.restore(file, version.versionId, hash);
      onDone();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Restore ${file}.yaml to ${dateTime(version.at)}?`}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className={btnSecondary} onClick={onClose}>
            Cancel
          </button>
          {preview?.valid && (
            <button
              type="button"
              className={btnPrimary}
              onClick={restore}
              disabled={busy || !hash || preview.changes.length === 0 || (preview.raises && !ackRaise)}
            >
              {busy ? 'Restoring…' : preview.raises ? 'Restore (raises risk)' : 'Restore'}
            </button>
          )}
        </>
      }
    >
      <p className="text-sm text-gray-400">The old text replaces the file (comments included) after the same validation as any edit.</p>
      <ErrorBox>{previewError ? errorMessage(previewError) : null}</ErrorBox>
      {preview ? (
        <PreviewPanel preview={preview} ackRaise={ackRaise} setAckRaise={setAckRaise} />
      ) : (
        !previewError && <p className="text-sm text-gray-500">Checking…</p>
      )}
      <ErrorBox>{error}</ErrorBox>
    </Modal>
  );
}

function VersionDiff({ file, v, prev, onClose }: { file: ConfigFile; v: ConfigVersion; prev: ConfigVersion | null; onClose: () => void }) {
  const { data, error } = useQuery({
    queryKey: ['configVersionDiff', file, v.versionId, prev?.versionId ?? null],
    queryFn: async () => {
      const after = (await configApi.versionText(file, v.versionId)) as { text: string };
      const before = prev ? ((await configApi.versionText(file, prev.versionId)) as { text: string }) : { text: '' };
      return { before: before.text, after: after.text };
    },
  });
  return (
    <Modal title={`${file}.yaml — ${dateTime(v.at)}`} onClose={onClose} wide>
      <ErrorBox>{error ? errorMessage(error) : null}</ErrorBox>
      {data ? (
        <DiffView before={data.before} after={data.after} beforeLabel={prev ? dateTime(prev.at) : '(nothing)'} afterLabel={dateTime(v.at)} />
      ) : (
        <p className="text-sm text-gray-500">Loading…</p>
      )}
    </Modal>
  );
}
