# EV Charge Optimisation (EV Charge Optimizer)

A small full‑stack demo that **optimizes EV charging power over time** based on site/grid limits and electricity price, then tries to **dispatch** the planned limits to charger connectors.

## What the app does

1. **Frontend (React + Vite)**
   - Lets you set: charger ID, site max power, number of time steps, and a price sensitivity slider.
   - Sends one request to the backend: “run optimizer + dispatch”.
   - Shows: chart, cost estimate, dispatch status per connector, and raw JSON output.

2. **Backend (Node API on port 3000)**
   - Receives the optimization inputs.
   - Produces an optimized power schedule per time step.
   - Builds per‑connector charging profiles (limits in W).
   - Attempts to dispatch those profiles to a charger connection.

## Key concepts (easy terms)

### Time steps
The plan is computed in discrete steps:
- `stepSeconds = 900` means each step is **15 minutes**.
- `steps = 8` means you plan for **2 hours**.

### Price sensitivity (alpha)
`alpha` controls how much you avoid expensive electricity:
- `alpha = 0` → mostly ignore price.
- `alpha = 1` → strongly reduce charging during expensive periods (while still respecting constraints).

### Constraints (why power is capped)
Charging is limited by:
- `siteMaxKw` (overall site limit)
- `gridLimitKw[t]` (time‑varying limit)
- `connectorMaxKw` (per connector maximum power)

## How to run (development)

### Backend
Start the backend so it listens on:
- `http://localhost:3000`

(The exact command depends on your backend setup, e.g. `npm run dev` / `npm start`.)

### Frontend
From the `frontend/` folder:

```bash
npm install
npm run dev
```
Frontend runs on a Vite dev URL (commonly http://localhost:5173).

## API used by the frontend

### POST (/run-and-dispatch)
The frontend send:
- siteMaxkW (number)
- connectorMaxKw (array of numbers)
- gridLimitKw (array of numbers)
- priceSekPerKwh (array of numbers)
- alpha (number)
- steps (number)
- stepSeconds (number)
- chargerId (string)

### Response
The backend returns:
- optimizeOutput (object)
- dispatchResults (array)
- runId (string)
- createdAt (string)

## Understanding the chart
The chart asnwers: "What did we plan, and why?"
- Price line (SEK/kWh) shows when power is cheap or expensive.
- Power lines (kW) show:
  - Site max (kW): the overall site limit.
  - Effective cap (kW): the actual limit after considering grid and connector constraints.
With two Y-axes, price and power can be compared on the same chart.

## Cost
if estimatedCostSek is present in the backend response, the UI displays it.
If it’s missing, the UI can compute a fallback estimate:
For each step:
- energy (kWh) = effectiveCapKw * stepSeconds / 3600
- cost (SEK) = energy * priceSekPerKwh
Sum these up to get the total estimated cost.

## Dispatch results
- Accepted: The connector was successfully started with the planned limit.
- NotConnected: The connector could not be started (e.g. cable not plugged in).
- Error: An unexpected error occurred during dispatch.

## Troubleshooting
### Blank Page/"Unexpected Token"
Frontend compile error (usually broken JSX or missing braces). Check the Vite terminal output and fix the reported line.
### "Cannot read properties of null (reading 'useContext')"
Usually a React runtime issue (mismatched versions or duplicate React copies). Ensure a single React + ReactDOM version and dedupe React in the bundler config.
### Cost shows "-" when steps > your arrays
If steps is larger than the provided price/gridLimit arrays, later steps have missing data. Make sure those arrays are at least steps long (or auto-expand them).

## Typical Strcuture
```
ev-charge-optimizer/
  frontend/    # React + Vite UI
  backend/     # Node API (port 3000)
```