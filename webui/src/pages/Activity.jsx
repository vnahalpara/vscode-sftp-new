import React from 'react';
import { Card, Empty } from '../components/ui.jsx';
import { fmtAgo } from '../format';

/**
 * A table over the session's privileged-command log (`ActivityEntry`: at,
 * label, command, code, ms — see src/modules/serverManager/activity.ts).
 * Empty in every session today (nothing in this milestone runs a privileged
 * command yet), so the empty state is the one path this page will actually
 * be seen in until a later milestone starts pushing entries.
 */
export default function Activity({ activity }) {
  const entries = activity || [];
  const now = Date.now();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Activity</h1>
          <p>Privileged commands run against this host in this session.</p>
        </div>
      </div>

      <Card>
        {entries.length ? (
          <table className="tbl">
            <thead>
              <tr>
                <th>At</th>
                <th>Label</th>
                <th>Command</th>
                <th className="num">Code</th>
                <th className="num">Duration</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={`${e.at}-${i}`}>
                  <td className="muted">{fmtAgo(e.at, now)}</td>
                  <td>{e.label}</td>
                  <td className="mono">{e.command}</td>
                  <td className="num">{e.code}</td>
                  <td className="num">{typeof e.ms === 'number' ? `${e.ms} ms` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="Nothing here yet">No privileged commands have run in this session.</Empty>
        )}
      </Card>
    </>
  );
}
