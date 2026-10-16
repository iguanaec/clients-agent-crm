import type { ReactNode } from "react";

export function Card({ title, hint, children, className = "" }: { title: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      <h3>{title}</h3>
      {hint && <p className="muted small">{hint}</p>}
      {children}
    </section>
  );
}

export function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "warn" }) {
  return (
    <div className={`kpi ${tone ?? ""}`}>
      <small>{label}</small>
      <strong>{value}</strong>
      {sub && <span>{sub}</span>}
    </div>
  );
}

const H = 160, PAD = { l: 34, r: 8, t: 10, b: 22 };

/** Barras verticales; `hot` marca índices resaltados (por ejemplo las horas en que el agente está activo). */
export function Bars({ values, labels, hot, format = (n: number) => String(n), color = "var(--accent)", W = 520 }: {
  values: number[]; labels: string[]; hot?: (i: number) => boolean; format?: (n: number) => string; color?: string; W?: number;
}) {
  const max = Math.max(1, ...values);
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b, bw = iw / values.length;
  const every = Math.ceil(values.length / 12);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img">
      {[0, 0.5, 1].map((t) => (
        <g key={t}>
          <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + ih * (1 - t)} y2={PAD.t + ih * (1 - t)} stroke="var(--line)" />
          <text x={PAD.l - 6} y={PAD.t + ih * (1 - t) + 4} textAnchor="end" className="axis">{format(Math.round(max * t))}</text>
        </g>
      ))}
      {values.map((v, i) => (
        <g key={i}>
          <rect x={PAD.l + i * bw + bw * 0.15} y={PAD.t + ih * (1 - v / max)} width={bw * 0.7} height={ih * (v / max)} rx="2"
            fill={color} opacity={hot && !hot(i) ? 0.35 : 1}><title>{`${labels[i]}: ${format(v)}`}</title></rect>
          {i % every === 0 && <text x={PAD.l + i * bw + bw / 2} y={H - 6} textAnchor="middle" className="axis">{labels[i]}</text>}
        </g>
      ))}
    </svg>
  );
}

/** Línea simple con área suave. */
export function Line({ values, labels, color = "var(--accent)", W = 520 }: { values: number[]; labels: string[]; color?: string; W?: number }) {
  const max = Math.max(1, ...values);
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (values.length <= 1 ? iw / 2 : (i / (values.length - 1)) * iw);
  const y = (v: number) => PAD.t + ih * (1 - v / max);
  const path = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const every = Math.ceil(values.length / 8);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img">
      {[0, 0.5, 1].map((t) => (
        <g key={t}>
          <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + ih * (1 - t)} y2={PAD.t + ih * (1 - t)} stroke="var(--line)" />
          <text x={PAD.l - 6} y={PAD.t + ih * (1 - t) + 4} textAnchor="end" className="axis">{Math.round(max * t)}</text>
        </g>
      ))}
      <path d={`${path} L${x(values.length - 1)} ${PAD.t + ih} L${x(0)} ${PAD.t + ih} Z`} fill={color} opacity="0.12" />
      <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
      {values.map((v, i) => (
        <g key={i}>
          <circle cx={x(i)} cy={y(v)} r={values.length > 40 ? 0 : 2.5} fill={color}><title>{`${labels[i]}: ${v}`}</title></circle>
          {i % every === 0 && <text x={x(i)} y={H - 6} textAnchor="middle" className="axis">{labels[i]}</text>}
        </g>
      ))}
    </svg>
  );
}

/** Embudo: cada etapa es tan ancha como su cantidad frente a la primera. */
export function Funnel({ steps }: { steps: { label: string; value: number }[] }) {
  const top = Math.max(1, steps[0]?.value ?? 1);
  return (
    <div className="funnel">
      {steps.map((s, i) => (
        <div key={s.label} className="frow">
          <span className="flabel">{s.label}</span>
          <div className="fbar"><div style={{ width: `${Math.max(2, (s.value / top) * 100)}%` }} /></div>
          <span className="fnum">{s.value}{i > 0 && steps[i - 1].value > 0 && <small> {Math.round((s.value / steps[i - 1].value) * 100)}%</small>}</span>
        </div>
      ))}
    </div>
  );
}

/** Barra apilada con leyenda: quién respondió. */
export function Split({ parts }: { parts: { label: string; value: number; color: string }[] }) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return (
    <div>
      <div className="split">{parts.map((p) => p.value > 0 && <div key={p.label} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} title={`${p.label}: ${p.value}`} />)}</div>
      <ul className="legend">{parts.map((p) => <li key={p.label}><i style={{ background: p.color }} />{p.label}: <strong>{p.value}</strong></li>)}</ul>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted small empty">{children}</p>;
}
