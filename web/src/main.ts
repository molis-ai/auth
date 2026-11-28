import { createApp } from "vue";
import App from "./App.vue";
import { startBrowserTelemetry } from "./shared/telemetry.ts";
import "./shared/styles/calm.css";
import "./features/auth-entry/auth-entry.css";
import "./shared/styles/interaction-feedback.css";

startBrowserTelemetry();
createApp(App).mount("#app");
