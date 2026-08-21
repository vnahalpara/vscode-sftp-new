import React, { useEffect, useState } from 'react';

export function Card({ title, sub, actions, children, className = '', ...rest }) {
  return (
    <div className={`card ${className}`} {...rest}>
      {(title || actions) && (
        <div className="row" style={{ marginBottom: sub ? 2 : 12 }}>
          <div>
            {title && <h3>{title}</h3>}
            {sub && <div className="sub" style={{ marginBottom: 0 }}>{sub}</div>}
          </div>
          <div className="spacer" />
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}

// Tones come from format.ts's toneForPct: 'ok' | 'warn' | 'bad' | ''.
function toneColor(tone) {
  if (tone === 'bad') return 'var(--critical)';
  if (tone === 'warn') return 'var(--warning)';
  if (tone === 'ok') return 'var(--good)';
  return 'var(--series-1)';
}

export function Stat({ label, value, unit, sub, pct, tone }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      {sub && <div className="sub">{sub}</div>}
      {pct != null && (
        <div className="meter">
          <div style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: toneColor(tone) }} />
        </div>
      )}
    </div>
  );
}

/** Status is never colour alone — every badge ships with its own text label. */
export function Badge({ tone = '', children }) {
  return (
    <span className={`badge ${tone}`}>
      <span className="dot" />
      {children}
    </span>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="empty">
      <div style={{ fontSize: 15, color: 'var(--text-secondary)', marginBottom: 6 }}>{title}</div>
      <div>{children}</div>
    </div>
  );
}

/** A labelled block used by the sidebar to group nav items under a heading. */
export function Section({ title, children }) {
  return (
    <div className="section">
      {title && <div className="section-title">{title}</div>}
      <div className="section-body">{children}</div>
    </div>
  );
}

// Every action -- including 'start' -- opens this before anything runs;
// originally Services.jsx's own, systemctl-shaped dialog. Generalised (Task
// 3, Cloudflare card) to also serve a non-systemctl confirmation:
// `title`/`message`/`confirmLabel`/`danger` let a caller override the
// default systemctl-shaped copy and button styling entirely, while every
// existing `unit`/`action` caller (Services.jsx keeps its OWN separate,
// systemctl-only copy of this component -- see that file's own comment --
// but WebServer.jsx's systemctl callers pass neither prop) is untouched:
// none of them pass the new props, so `title`/`message`/`confirmLabel`
// default back to exactly the strings this dialog always rendered, and
// `danger` defaults to the original `action === 'stop'` check. The
// submitting/no-double-submit behaviour (the whole reason a caller reuses
// this component instead of writing its own) is unchanged for everyone.
//
// Moved here from WebServer.jsx (Task 8) so a caller with no systemctl unit
// at all -- the Database tab's row-delete and mutating-SQL confirmations --
// can reuse it too, without a third hand-rolled copy.
export function ConfirmDialog({
  unit,
  action,
  onCancel,
  onConfirm,
  title,
  message,
  confirmLabel,
  danger,
  // True for every existing systemctl caller (none of them pass this), which
  // preserves their exact current behaviour: Escape/backdrop/Cancel all
  // close the dialog immediately, but that path is inert for them anyway --
  // runAction() calls setConfirm(null) as its first synchronous line, so the
  // dialog is already unmounted before any await begins and there is no
  // in-flight window to dismiss out of.
  //
  // CloudflareCard was the first caller that keeps this dialog mounted
  // across an await (see its own comment on why -- a purge is slow,
  // destructive, irreversible, and this card has no per-row banner to fall
  // back on). That inversion makes Escape/backdrop/Cancel live during a real
  // in-flight request for the first time: dismissing the dialog without this
  // flag would make the user believe they cancelled a purge that is, in
  // fact, still running server-side (apiPost has no abort). dismissible={false}
  // during that window is what keeps the dialog honestly modal instead of
  // just visually modal. Database.jsx's row-delete and mutating-SQL
  // confirmations follow the exact same pattern, for the exact same reason:
  // those requests run against a live database and are not abortable either.
  dismissible = true,
}) {
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const onKey = e => {
      if (e.key === 'Escape' && dismissible) {
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, dismissible]);

  function handleConfirm() {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    onConfirm();
  }

  function handleBackdropClick() {
    if (dismissible) {
      onCancel();
    }
  }

  function handleCancelClick() {
    if (!dismissible) {
      return;
    }
    onCancel();
  }

  const isDanger = danger != null ? danger : action === 'stop';
  const readyLabel = confirmLabel || `${action} ${unit}`;
  const busyLabel = confirmLabel ? `${confirmLabel}…` : `${action}…`;

  return (
    <div
      role="presentation"
      onClick={handleBackdropClick}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="card"
        style={{ maxWidth: 440, width: '90%' }}
        onClick={e => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>{title || 'Confirm action'}</h3>
        <p style={{ color: 'var(--text-secondary)' }}>
          {message || (
            <>
              Run <strong className="mono">systemctl {action}</strong> on{' '}
              <span className="mono">{unit}</span>? This runs on the live host over SSH.
            </>
          )}
        </p>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn" onClick={handleCancelClick} disabled={!dismissible}>
            Cancel
          </button>
          <button
            className={isDanger ? 'btn danger' : 'btn primary'}
            onClick={handleConfirm}
            disabled={submitting}
            autoFocus
          >
            {submitting ? busyLabel : readyLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
