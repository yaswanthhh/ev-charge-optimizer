import React from "react";

export class ErrorBoundary extends React.Component<
    { children: React.ReactNode },
    { hasError: boolean; message: string }
> {
    state = { hasError: false, message: "" };

    static getDerivedStateFromError(error: any) {
        return { hasError: true, message: String(error?.message ?? error) };
    }

    componentDidCatch(error: any) {
        console.error("UI crashed:", error);
    }

    render() {
        if (this.state.hasError) {
            return (
                <div style={{ padding: 16 }}>
                    <h2>UI error</h2>
                    <pre style={{ whiteSpace: "pre-wrap" }}>{this.state.message}</pre>
                    <button onClick={() => location.reload()}>Reload</button>
                </div>
            );
        }
        return this.props.children;
    }
}
