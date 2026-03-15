import { clearToken } from "@/lib/auth";
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

const rootRoute = createRootRoute({
  component: RootLayout,
});

const streamsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: StreamsPage,
});

const streamPlayerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/streams/$streamId",
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
