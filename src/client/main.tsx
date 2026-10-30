import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { isEmbedded, startEmbedBridge } from "./embedBridge.ts";
import { startOpenTabs } from "./OpenTabsStrip.tsx";
import "./styles.css";
import { startTheme } from "./theme.ts";

startTheme();
startEmbedBridge();
// Open-doc tabs are a T3 Code feature; the standalone site keeps one doc per browser tab.
if (isEmbedded()) startOpenTabs();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
