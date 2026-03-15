import { LoginGate } from "@/components/login-gate";
import { router } from "@/router";
import { initTheme } from "@/lib/theme";
import { RouterProvider } from "@tanstack/react-router";
import "maplibre-gl/dist/maplibre-gl.css";
import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";

initTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <LoginGate>
      <RouterProvider router={router} />
    </LoginGate>
  </React.StrictMode>,
);
