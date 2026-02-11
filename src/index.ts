import express from "express";
import { sendSetChargingProfile } from "./chargerStub.ts";
import { Pool } from "pg";

const app = express();
app.use(express.json());

const pool = new Pool({
    host: process.env.PGHOST ?? "localhost",
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? "ev",
    password: process.env.PGPASSWORD ?? "ev",
    database: process.env.PGDATABASE ?? "evopt",
});

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
        return body.connectorMaxKw.map((mx) => Math.max(0, Math.min(mx, equalShare)));
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
        steps?: number;
        stepSeconds?: number;
        chargerId?: string;
    };

    const steps = body.steps ?? 8;
    const stepSeconds = body.stepSeconds ?? 900;
    const chargerId = body.chargerId ?? "charger-001";

    // 1) optimize (reuse the same logic as /optimize)
    const n = body.connectorMaxKw?.length ?? 0;
    if (!body.siteMaxKw || body.siteMaxKw <= 0 || n === 0) {
        return res.status(400).json({ error: "siteMaxKw > 0 and connectorMaxKw[] required" });
    }

    const siteCapKw: number[] = Array.from({ length: steps }, (_, t) => {
        const grid = body.gridLimitKw?.[t];
        return Math.min(body.siteMaxKw, grid ?? body.siteMaxKw);
    });

    const perConnectorKw: number[][] = Array.from({ length: steps }, (_, t) => {
        const equalShare = siteCapKw[t] / n;
        return body.connectorMaxKw.map((mx) => Math.max(0, Math.min(mx, equalShare)));
    });

    const optimizeOutput = {
        steps,
        perConnectorKw,
        siteKw: perConnectorKw.map((row) => row.reduce((a, b) => a + b, 0)),
    };

    // 2) build + dispatch one OCPP profile per connectorId (1..n)
    const dispatchResults = perConnectorKw[0].map((_ignored, idxConnector) => {
        const connectorId = idxConnector + 1;

        const perStepKw = perConnectorKw.map((row) => row[idxConnector]);

        const chargingSchedulePeriod = perStepKw.map((kw, idx) => ({
            startPeriod: idx * stepSeconds,
            limit: Math.round(kw * 1000 * 10) / 10,
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

        // your existing stub
        return {
            connectorId,
            result: { status: "Accepted" as const },
            setChargingProfile,
            chargerId,
        };
    });

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
app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
