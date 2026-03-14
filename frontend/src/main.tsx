import { router } from "@/router";
import { RouterProvider } from "@tanstack/react-router";
import "maplibre-gl/dist/maplibre-gl.css";
import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";

const root = document.documentElement;
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
const applySystemTheme = () => {
  root.classList.toggle("dark", prefersDark.matches);
};

applySystemTheme();
prefersDark.addEventListener("change", applySystemTheme);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
