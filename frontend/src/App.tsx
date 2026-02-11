import { useState } from "react";

type RunResponse = any;

export default function App() {
  const [result, setResult] = useState<RunResponse | null>(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true);
    setResult(null);

    const payload = {
      siteMaxKw: 20,
      connectorMaxKw: [11, 11],
      gridLimitKw: [20, 20, 20, 20, 20, 20, 20, 20],
      priceSekPerKwh: [0.5, 0.5, 0.6, 0.7, 2.0, 2.2, 2.0, 1.8],
      alpha: 0.7,
      steps: 8,
      stepSeconds: 900,
      chargerId: "charger-001",
    };

    const res = await fetch("http://localhost:3000/run-and-dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    setResult(data);
    setLoading(false);
  }

  return (
    <div style={{ fontFamily: "system-ui", padding: 16 }}>
      <h1>EV Charging Optimization Demo</h1>

      <button onClick={run} disabled={loading}>
        {loading ? "Running..." : "Run & Dispatch"}
      </button>

      {result && (
        <>
          <h2>Run</h2>
          <pre>{JSON.stringify({ runId: result.runId, createdAt: result.createdAt }, null, 2)}</pre>

          <h2>Optimize output</h2>
          <pre>{JSON.stringify(result.optimizeOutput, null, 2)}</pre>

          <h2>Dispatch results</h2>
          <pre>{JSON.stringify(result.dispatchResults, null, 2)}</pre>
        </>
      )}
    </div>
  );
}
