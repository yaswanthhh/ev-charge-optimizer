import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type RunResponse = any;

function calcEstimatedCostSek(out: any) {
  const n = Number(out?.steps ?? 0);
  const stepHours = 900 / 3600; // 15 min
  let sum = 0;

  for (let t = 0; t < n; t++) {
    const kw = Number(out?.siteKw?.[t] ?? 0);
    const sekPerKwh = Number(price[t] ?? 0);
    // kW * hours = kWh, then * SEK/kWh = SEK
    sum += kw * stepHours * sekPerKwh;
  }
  return sum;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function chipColor(status?: string) {
  if (status === "Accepted") return { bg: "#e9fbe9", bd: "#b7f7c2", fg: "#065f46" };
  if (status === "Sent") return { bg: "#fff7e6", bd: "#fde68a", fg: "#92400e" };
  if (status === "NotConnected") return { bg: "#fdecec", bd: "#fecaca", fg: "#991b1b" };
  return { bg: "#f3f4f6", bd: "#e5e7eb", fg: "#111827" };
}

export default function App() {
  const [siteMaxKw, setSiteMaxKw] = useState(20);
  const [steps, setSteps] = useState(8);
  const [alpha, setAlpha] = useState(0.7);
  const [chargerId, setChargerId] = useState("charger-001");

  const [price] = useState<number[]>([0.5, 0.5, 0.6, 0.7, 2.0, 2.2, 2.0, 1.8]);
  const [gridLimit] = useState<number[]>([20, 20, 20, 20, 20, 20, 20, 20]);
  const connectorMaxKw = useMemo(() => [11, 11], []);

  const [result, setResult] = useState<RunResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const anyNotConnected = useMemo(() => {
    return !!result?.dispatchResults?.some((d: any) => d?.result?.status === "NotConnected");
  }, [result]);

  const chartData = useMemo(() => {
    const out = result?.optimizeOutput;
    if (!out) return [];
    const n = Number(out.steps ?? 0);
    return Array.from({ length: n }, (_, t) => ({
      t,
      price: Number(price[t] ?? 0),
      siteKw: round2(Number(out.siteKw?.[t] ?? 0)),
      effectiveCapKw: round2(Number(out.effectiveCapKw?.[t] ?? 0)),
    }));
  }, [result, price]);

  async function run() {
    setLoading(true);
    setErr(null);
    setResult(null);

    const payload = {
      siteMaxKw,
      connectorMaxKw,
      gridLimitKw: gridLimit.slice(0, steps),
      priceSekPerKwh: price.slice(0, steps),
      alpha,
      steps,
      stepSeconds: 900,
      chargerId,
    };

    try {
      const res = await fetch("http://localhost:3000/run-and-dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);

      const data = text ? JSON.parse(text) : null;
      setResult(data);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  const backendCost = result?.optimizeOutput?.estimatedCostSek;
  const shownCost =
    Number.isFinite(Number(backendCost))
      ? Number(backendCost)
      : calcEstimatedCostSek(result?.optimizeOutput);

  return (
    <div style={{ padding: 16, maxWidth: 1120, margin: "0 auto", fontFamily: "system-ui" }}>
      <h1 style={{ margin: "0 0 6px 0" }}>EV Charging Control Room</h1>
      <div style={{ color: "#6b7280", marginBottom: 14 }}>
        Tune price sensitivity, run the optimizer, and dispatch connector limits.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 14, padding: 12 }}>
          <h2 style={{ marginTop: 0 }}>Controls</h2>

          <label style={{ display: "block", marginBottom: 10 }}>
            <div style={{ fontSize: 13, color: "#6b7280" }}>Charger ID</div>
            <input
              value={chargerId}
              onChange={(e) => setChargerId(e.target.value)}
              style={{ width: "100%", padding: 10, borderRadius: 10, border: "1px solid #e5e7eb" }}
            />
          </label>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label style={{ display: "block" }}>
              <div style={{ fontSize: 13, color: "#6b7280" }}>Site max (kW)</div>
              <input
                type="number"
                value={siteMaxKw}
                onChange={(e) => setSiteMaxKw(Number(e.target.value))}
                style={{ width: "100%", padding: 10, borderRadius: 10, border: "1px solid #e5e7eb" }}
              />
            </label>

            <label style={{ display: "block" }}>
              <div style={{ fontSize: 13, color: "#6b7280" }}>Steps (15 min each)</div>
              <input
                type="number"
                min={1}
                max={48}
                value={steps}
                onChange={(e) => setSteps(Number(e.target.value))}
                style={{ width: "100%", padding: 10, borderRadius: 10, border: "1px solid #e5e7eb" }}
              />
            </label>
          </div>

          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 6 }}>
              Price sensitivity (alpha): <b>{alpha.toFixed(2)}</b>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={alpha}
              onChange={(e) => setAlpha(Number(e.target.value))}
              style={{ width: "100%" }}
            />
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>
              0 = ignore price, 1 = strongly avoid expensive periods.
            </div>
          </div>

          <button
            onClick={run}
            disabled={loading}
            style={{
              marginTop: 12,
              width: "100%",
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid #111827",
              background: loading ? "#e5e7eb" : "#111827",
              color: loading ? "#111827" : "white",
              fontWeight: 700,
              cursor: loading ? "not-allowed" : "pointer",
            }}
          >
            {loading ? "Running..." : "Run & Dispatch"}
          </button>

          {err && <div style={{ marginTop: 10, color: "#b91c1c" }}>{err}</div>}
        </div>

        <div style={{ border: "1px solid #e5e7eb", borderRadius: 14, padding: 12 }}>
          <h2 style={{ marginTop: 0 }}>What happened</h2>

          {!result && <div style={{ color: "#6b7280" }}>Click “Run & Dispatch” to generate a new run.</div>}

          {result && (
            <>
              {anyNotConnected && (
                <div style={{ padding: 10, borderRadius: 12, background: "#fff1f2", border: "1px solid #fecdd3" }}>
                  <b>Dispatch blocked:</b> charger not connected (optimization still ran).
                </div>
              )}

              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 10 }}>
                <div><b>Run:</b> {result.runId ?? "—"}</div>
                <div>
                  <b>Cost:</b>{" "}
                  {shownCost === null ? "—" : shownCost.toFixed(2)} SEK
                </div>
              </div>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                {result.dispatchResults?.map((d: any) => {
                  const c = chipColor(d?.result?.status);
                  return (
                    <div
                      key={String(d.connectorId)}
                      style={{
                        padding: "6px 10px",
                        borderRadius: 999,
                        background: c.bg,
                        border: `1px solid ${c.bd}`,
                        color: c.fg,
                      }}
                    >
                      Connector {d.connectorId}: <b>{d?.result?.status ?? "—"}</b>
                    </div>
                  );
                })}
              </div>

              <div style={{ marginTop: 12, height: 280 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 8, right: 18, left: 6, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" />

                    <XAxis dataKey="t" />

                    {/* Left axis: kW */}
                    <YAxis
                      yAxisId="kw"
                      tickFormatter={(v) => `${Number(v).toFixed(0)} kW`}
                    />

                    {/* Right axis: SEK/kWh */}
                    <YAxis
                      yAxisId="price"
                      orientation="right"
                      tickFormatter={(v) => `${Number(v).toFixed(2)}`}
                    />

                    <Tooltip
                      formatter={(value: any, name: any) => {
                        const n = Number(value);
                        if (name === "SEK/kWh") return [n.toFixed(2), "SEK/kWh"];
                        if (name.includes("(kW)")) return [n.toFixed(2), name];
                        return [String(value), name];
                      }}
                      labelFormatter={(label) => `Step ${label} (15 min)`}
                    />

                    <Legend />

                    {/* Price uses right axis */}
                    <Line
                      yAxisId="price"
                      type="monotone"
                      dataKey="price"
                      name="SEK/kWh"
                      stroke="#7c3aed"
                      dot={false}
                      strokeWidth={2}
                    />

                    {/* Power uses left axis */}
                    <Line
                      yAxisId="kw"
                      type="monotone"
                      dataKey="effectiveCapKw"
                      name="Effective cap (kW)"
                      stroke="#0ea5e9"
                      dot={false}
                      strokeWidth={2}
                    />
                    <Line
                      yAxisId="kw"
                      type="monotone"
                      dataKey="siteKw"
                      name="Site power (kW)"
                      stroke="#22c55e"
                      dot={false}
                      strokeWidth={2}
                    />
                  </LineChart>
                </ResponsiveContainer>

              </div>

              <details style={{ marginTop: 10 }}>
                <summary style={{ cursor: "pointer" }}>Raw JSON (debug)</summary>
                <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(result, null, 2)}</pre>
              </details>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
