import { createApp } from "vue";
import App from "./App.vue";
import { reportBrowserError, startBrowserTelemetry } from "./shared/telemetry.ts";
import "./shared/styles/calm.css";
import "./features/auth-entry/auth-entry.css";
import "./shared/styles/interaction-feedback.css";

startBrowserTelemetry();
const app = createApp(App);
app.config.errorHandler = (error) => reportBrowserError("vue_error", error);
app.mount("#app");
