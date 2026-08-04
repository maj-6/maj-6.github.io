import React from "react";
import { createRoot } from "react-dom/client";
import "@blueprintjs/core/lib/css/blueprint.css";
import "@blueprintjs/icons/lib/css/blueprint-icons.css";
import App from "./App.jsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Editor root element is missing.");

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
