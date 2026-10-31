import { Card, PageHeader } from '../components/ui';
import { useOverview } from '../hooks/useRisk';

/** Approvals (spec §12): empty unless approvals are enabled; there is no approvals table yet */
export function Approvals() {
  const { data } = useOverview();
  const enabled = data?.approvalsNewTemplateLive === true;
  return (
    <div className="space-y-6">
      <PageHeader title="Approvals" subtitle="Human approval of new templates going live" />
      <Card>
        <div className="py-8 text-center space-y-2">
          <p className="text-gray-300">No approvals.</p>
          {enabled ? (
            <p className="text-sm text-gray-500 max-w-xl mx-auto">
              <code>approvals.new_template_live</code> is on: bots on a new template stay in paper instead of moving to probation (the ramp logs{' '}
              <code>bot.stage_blocked</code>). Approval records are not implemented yet, so there is nothing to approve here; turn the setting off on the Risk
              page to let the ramp promote them.
            </p>
          ) : (
            <p className="text-sm text-gray-500 max-w-xl mx-auto">
              Approvals are disabled (<code>limits.yaml approvals.new_template_live: false</code>): bots on new templates move from paper to probation
              automatically when the ramp rules are met.
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
