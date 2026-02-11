export function sendSetChargingProfile(_chargerId: string, payload: unknown) {
    // In real life: send via OCPP WebSocket.
    // For now: pretend the charger accepted it.
    return {
        status: "Accepted",
        echoedRequest: payload
    };
}
