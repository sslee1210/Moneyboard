import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";
import "./flow-alerts.css";
import "./right-panel-compact.css";
import "./right-panel-trading.css";
import "./right-panel-decision.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
