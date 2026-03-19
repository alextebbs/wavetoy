import { clearToken } from "@/lib/auth";
import { ErrorPage } from "@/components/error-page";
import { StreamPlayerPage } from "@/routes/stream-player-page";
import { StreamsPage } from "@/routes/streams-page";
import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

function RootLayout() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <main>
        <Outlet />
      </main>
    </div>
  );
}

function GlobalErrorBoundary() {
  return <ErrorPage code="500" />;
}

function NotFoundPage() {
  return <ErrorPage code="404" />;
}

const rootRoute = createRootRoute({
  component: RootLayout,
  errorComponent: GlobalErrorBoundary,
  notFoundComponent: NotFoundPage,
});

const streamsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: StreamsPage,
});

const streamPlayerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/streams/$streamId",
  validateSearch: (search: Record<string, unknown>): { scrollback?: number } => {
    const s = search?.scrollback;
    if (typeof s === "number" && s > 0) return { scrollback: s };
    if (typeof s === "string") {
      const n = parseInt(s, 10);
      if (!Number.isNaN(n) && n > 0) return { scrollback: n };
    }
    return {};
  },
  component: StreamPlayerPage,
});

const logoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/logout",
  component: () => {
    clearToken();
    window.location.href = "/";
    return null;
  },
});

const routeTree = rootRoute.addChildren([streamsRoute, streamPlayerRoute, logoutRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
