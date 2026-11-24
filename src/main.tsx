import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

async function start() {
  if (new URLSearchParams(location.search).has("demo")) {
    // Loaded lazily so the fake league isn't in the main bundle.
    const { installDemo } = await import("./api/demo");
    installDemo();
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
start();
