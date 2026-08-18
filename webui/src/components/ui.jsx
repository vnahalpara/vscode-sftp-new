import React from 'react';

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
