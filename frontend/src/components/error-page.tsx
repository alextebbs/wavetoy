import { WavetoyLogo } from "@/components/wavetoy-logo";

interface ErrorPageProps {
  code: string;
}

export function ErrorPage({ code }: ErrorPageProps) {
  return (
    <div
      className="relative flex min-h-screen flex-col items-center px-8"
      style={{ backgroundColor: "#000" }}
    >
      <div
        className="pointer-events-none absolute inset-0 z-10"
        style={{
          background: "red",
          mixBlendMode: "hue",
          opacity: 1,
        }}
      />
      <div className="flex flex-1 items-center justify-center">
        <p className="text-2xl font-light tracking-widest text-primary/70">
          {code}
        </p>
      </div>
      <div className="shrink-0 pb-6">
        <WavetoyLogo className="text-3xl" noise />
      </div>
    </div>
  );
}
