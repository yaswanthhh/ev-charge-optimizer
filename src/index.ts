import express from "express";
import { sendSetChargingProfile } from "./chargerStub.ts";
import { Pool } from "pg";
import http from "http";
import { WebSocketServer } from "ws";
import cors from "cors";


const app = express();
app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

const pool = new Pool({
    host: process.env.PGHOST ?? "localhost",
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? "ev",
    password: process.env.PGPASSWORD ?? "ev",
    database: process.env.PGDATABASE ?? "evopt",
});

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAck(chargerId: string, since: number, timeoutMs: number) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        const ack = lastAck.get(chargerId);
        if (ack && ack.at >= since) return ack;
        await sleep(50);
    }
    return null;
}


app.post("/dispatch", (req, res) => {
    const { chargerId, setChargingProfile } = req.body as {
        chargerId: string;
        setChargingProfile: unknown;
    };

    if (!chargerId || !setChargingProfile) {
        return res.status(400).json({ error: "chargerId and setChargingProfile required" });
    }

    const result = sendSetChargingProfile(chargerId, setChargingProfile);
    res.json(result);
});

app.get("/health", (_req, res) => res.json({ ok: true }));

type OptimizeRequest = {
    siteMaxKw: number;
    connectorMaxKw: number[];      // e.g. [11, 11, 22]
    gridLimitKw?: number[];        // optional, length = steps
    steps?: number;                // optional, default 8
};

app.post("/optimize", (req, res) => {
    const body = req.body as OptimizeRequest;

    const steps = body.steps ?? 8;
    const n = body.connectorMaxKw?.length ?? 0;

    if (!body.siteMaxKw || body.siteMaxKw <= 0 || n === 0) {
        return res.status(400).json({ error: "siteMaxKw > 0 and connectorMaxKw[] required" });
    }

    // cap_t = min(siteMaxKw, gridLimitKw[t] if provided)
    const siteCapKw: number[] = Array.from({ length: steps }, (_, t) => {
        const grid = body.gridLimitKw?.[t];
        return Math.min(body.siteMaxKw, grid ?? body.siteMaxKw);
    });

    // Split equally across connectors, clip by each connector max
    const perConnectorKw: number[][] = Array.from({ length: steps }, (_, t) => {
        const equalShare = siteCapKw[t] / n;
        return body.connectorMaxKw.map((mx) => {
            const kw = Math.max(0, Math.min(mx, equalShare));
            return Math.round(kw * 100) / 100; // 2 decimals
        });
    });

    // Actual site kW is the sum (after clipping)
    const siteKw = perConnectorKw.map((row) => row.reduce((a, b) => a + b, 0));

    res.json({ steps, perConnectorKw, siteKw });
});

type OcppProfileRequest = {
    connectorId: number;          // OCPP connectorId (1..n)
    perStepKw: number[];          // e.g. [10, 5, 10, 10, 10, 10, 10, 10]
    stepSeconds?: number;         // default 900 (15 min)
    profileId?: number;           // default 1
    stackLevel?: number;          // default 0
};

app.post("/ocpp/profile", (req, res) => {
    const body = req.body as OcppProfileRequest;

    const stepSeconds = body.stepSeconds ?? 900;
    const chargingProfileId = body.profileId ?? 1;
    const stackLevel = body.stackLevel ?? 0;

    if (!body.connectorId || body.connectorId < 0) {
        return res.status(400).json({ error: "connectorId required (>= 0)" });
    }
    if (!Array.isArray(body.perStepKw) || body.perStepKw.length === 0) {
        return res.status(400).json({ error: "perStepKw[] required" });
    }

    // OCPP schema uses chargingRateUnit "W" or "A". We'll send W (watts). [page:0]
    const chargingSchedulePeriod = body.perStepKw.map((kw, idx) => ({
        startPeriod: idx * stepSeconds,
        limit: Math.round(kw * 1000 * 10) / 10  // W, multiple of 0.1 (schema) [page:0]
    }));

    const ocppSetChargingProfileReq = {
        connectorId: body.connectorId,
        csChargingProfiles: {
            chargingProfileId,
            stackLevel,
            chargingProfilePurpose: "TxDefaultProfile",
            chargingProfileKind: "Absolute",
            chargingSchedule: {
                chargingRateUnit: "W",
                chargingSchedulePeriod
            }
        }
    };

    res.json(ocppSetChargingProfileReq);
});

app.get("/runs/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });

    const result = await pool.query(
        "select id, created_at, input, output from runs where id = $1",
        [id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "not found" });
    res.json(result.rows[0]);
});

app.post("/runs", async (req, res) => {
    const { input, output } = req.body as { input: unknown; output: unknown };

    if (!input || !output) {
        return res.status(400).json({ error: "input and output required" });
    }

    const result = await pool.query(
        "insert into runs(input, output) values($1::jsonb, $2::jsonb) returning id, created_at",
        [JSON.stringify(input), JSON.stringify(output)]
    );

    res.status(201).json(result.rows[0]);
});

app.post("/run-and-dispatch", async (req, res) => {
    const body = req.body as {
        siteMaxKw: number;
        connectorMaxKw: number[];
        gridLimitKw?: number[];
        priceSekPerKwh?: number[];
        alpha?: number;
        steps?: number;
        stepSeconds?: number;
        chargerId?: string;
    };

    const steps = body.steps ?? 8;
    const stepSeconds = body.stepSeconds ?? 900;
    const chargerId = body.chargerId ?? "charger-001";

    // 1) optimize (constraints + grid + price throttle)
    const n = body.connectorMaxKw?.length ?? 0;
    if (!body.siteMaxKw || body.siteMaxKw <= 0 || n === 0) {
        return res.status(400).json({ error: "siteMaxKw > 0 and connectorMaxKw[] required" });
    }

    const siteCapKw: number[] = Array.from({ length: steps }, (_, t) => {
        const grid = body.gridLimitKw?.[t];
        return Math.min(body.siteMaxKw, grid ?? body.siteMaxKw);
    });

    const price = body.priceSekPerKwh;
    const alpha = body.alpha ?? 0.7;

    // Normalize prices to 0..1 (0 cheapest, 1 most expensive)
    const priceNorm: number[] | undefined =
        price && price.length >= steps
            ? (() => {
                const slice = price.slice(0, steps);
                const minP = Math.min(...slice);
                const maxP = Math.max(...slice);
                const denom = maxP - minP;
                return slice.map((p) => (denom === 0 ? 0 : (p - minP) / denom));
            })()
            : undefined;

    // Apply price-based throttle to cap
    const effectiveCapKw = siteCapKw.map((cap, t) => {
        if (!priceNorm) return cap;
        const mult = 1 - alpha * priceNorm[t]; // expensive => lower
        return Math.max(0, cap * mult);
    });

    const perConnectorKw: number[][] = Array.from({ length: steps }, (_, t) => {
        const equalShare = effectiveCapKw[t] / n;
        return body.connectorMaxKw.map((mx) => Math.max(0, Math.min(mx, equalShare)));
    });

    const siteKw = perConnectorKw.map((row) => row.reduce((a, b) => a + b, 0));

    // SEK = (kW * hours) * (SEK/kWh)
    const hoursPerStep = stepSeconds / 3600;
    const estimatedCostSek =
        price && price.length >= steps
            ? siteKw.reduce((acc, kw, t) => acc + kw * hoursPerStep * price[t], 0)
            : null;

    const optimizeOutput = {
        steps,
        perConnectorKw,
        siteKw,
        effectiveCapKw,
        estimatedCostSek,
    };

    // 2) build + dispatch one OCPP profile per connectorId (1..n)
    const sentAt = Date.now();

    const dispatchResults = await Promise.all(
        perConnectorKw[0].map(async (_ignored, idxConnector) => {
            const connectorId = idxConnector + 1;

            const perStepKw = perConnectorKw.map((row) => row[idxConnector]);

            const chargingSchedulePeriod = perStepKw.map((kw, idx) => ({
                startPeriod: idx * stepSeconds,
                limit: Math.round(kw * 1000 * 10) / 10, // W
            }));

            const setChargingProfile = {
                connectorId,
                csChargingProfiles: {
                    chargingProfileId: 1,
                    stackLevel: 0,
                    chargingProfilePurpose: "TxDefaultProfile",
                    chargingProfileKind: "Absolute",
                    chargingSchedule: {
                        chargingRateUnit: "W",
                        chargingSchedulePeriod,
                    },
                },
            };

            const ws = chargers.get(chargerId);
            if (!ws) {
                return {
                    connectorId,
                    result: { status: "NotConnected" as const },
                    setChargingProfile,
                    chargerId,
                };
            }

            ws.send(JSON.stringify(setChargingProfile));

            const ack = await waitForAck(chargerId, sentAt, 2000);

            return {
                connectorId,
                result: { status: ack ? ("Accepted" as const) : ("NoAckYet" as const) },
                ack: ack?.msg ?? null,
                setChargingProfile,
                chargerId,
            };
        })
    );


    // 3) store run in DB
    const dbRow = await pool.query(
        "insert into runs(input, output) values($1::jsonb, $2::jsonb) returning id, created_at",
        [JSON.stringify(body), JSON.stringify({ optimizeOutput, dispatchResults })]
    );

    res.status(201).json({
        runId: dbRow.rows[0].id,
        createdAt: dbRow.rows[0].created_at,
        optimizeOutput,
        dispatchResults,
    });
});


const port = Number(process.env.PORT ?? 3000);

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// In-memory map: chargerId -> ws connection
const chargers = new Map<string, import("ws").WebSocket>();
const lastAck = new Map<string, { at: number; msg: any }>();

wss.on("connection", (ws, req) => {
    const url = req.url ?? "/";
    // Expect ws://host:3000/ocpp/CHARGER_ID
    const parts = url.split("/").filter(Boolean);
    if (parts[0] !== "ocpp" || !parts[1]) {
        ws.close();
        return;
    }
    const chargerId = parts[1];
    chargers.set(chargerId, ws);

    ws.on("close", () => chargers.delete(chargerId));
    ws.on("message", (data) => {
        // for now just log; later we’ll parse OCPP messages
        console.log("WS message from", chargerId, data.toString());
    });

    ws.send("connected");
});

server.listen(port, () => {
    console.log(`API listening on http://localhost:${port}`);
    console.log(`OCPP WS listening on ws://localhost:${port}/ocpp/{chargerId}`);
});
