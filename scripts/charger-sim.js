const WebSocket = require("ws");

const chargerId = process.argv[2] ?? "charger-001";
const ws = new WebSocket(`ws://localhost:3000/ocpp/${chargerId}`);

ws.on("open", () => console.log("charger connected as", chargerId));

ws.on("message", (data) => {
    const text = data.toString();
    console.log("WS message from", chargerId, text);

    try {
        const msg = JSON.parse(text);
        if (msg && msg.type === "Ack") {
            lastAck.set(chargerId, { at: Date.now(), msg });
        }
    } catch {
        // ignore non-JSON messages
    }
});


ws.on("close", () => console.log("charger disconnected"));
ws.on("error", (err) => console.error("ws error", err));
