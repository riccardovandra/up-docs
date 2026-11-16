import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { isEmbedded, startEmbedBridge } from "./embedBridge.ts";
import { startOpenTabs } from "./OpenTabsStrip.tsx";
import "./styles.css";
import { startTheme } from "./theme.ts";
import { isPublicToken } from "../shared/publicLinks.ts";

const PublicDocPage = lazy(() =>
  import("./pages/PublicDocPage.tsx").then((module) => ({ default: module.PublicDocPage })),
);

/** The token of a public link's page (`/p/<token>`), or null for every other page. */
function publicToken(pathname: string): string | null {
  const match = /^\/p\/([^/]+)\/?$/.exec(pathname);
  return match && isPublicToken(match[1]!) ? match[1]! : null;
}

startTheme({ embedded: isEmbedded() });
startEmbedBridge();
// A public link's page stands apart from the app: no sign-in check, no
// library, no account. It never calls the signed-in API.
const token = publicToken(window.location.pathname);

// Open-doc tabs are a T3 Code feature; the standalone site keeps one doc per browser tab.
if (isEmbedded() && token === null) startOpenTabs();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {token !== null ? (
      <Suspense fallback={null}>
        <PublicDocPage token={token} />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
