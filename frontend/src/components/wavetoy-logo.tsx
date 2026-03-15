import { useEffect, useRef } from "react";

interface WavetoyLogoProps {
  className?: string;
  noise?: boolean;
  onKeystroke?: never;
}

export function WavetoyLogo({ className, noise = false }: WavetoyLogoProps) {
  const pathRef = useRef<SVGPathElement>(null);
  const raf = useRef<number>(0);
  const t = useRef(0);
  const noiseAmount = useRef(0);

  const noiseTarget = useRef(0);

  useEffect(() => {
    noiseTarget.current = noise ? 1 : 0;
  }, [noise]);

  useEffect(() => {
    const draw = () => {
      const path = pathRef.current;
      if (!path) {
        raf.current = requestAnimationFrame(draw);
        return;
      }

      t.current += 0.02;

      const target = noiseTarget.current;
      if (noiseAmount.current < target) {
        noiseAmount.current += (target - noiseAmount.current) * 0.2;
      } else {
        noiseAmount.current *= 0.94;
        if (noiseAmount.current < 0.001) noiseAmount.current = 0;
      }


      const w = 180;
      const h = 72;
      const mid = h / 2;
      const baseAmp = 10;
      const noiseMix = noiseAmount.current;
      const amp = baseAmp + noiseMix * 20;
      const segments = 80;
      const points: string[] = [];
      const time = t.current;

      for (let i = 0; i <= segments; i++) {
        const x = (i / segments) * w;
        const phase = (x / w) * Math.PI * 4 + time;
        const sine = Math.sin(phase);

        const noiseVal = (Math.random() * 2 - 1) * 0.5;

        const sample = sine * (1 - noiseMix) + noiseVal * noiseMix;
        const y = mid - sample * amp;

        points.push(i === 0 ? `M${x} ${y}` : `L${x} ${y}`);
      }

      path.setAttribute("d", points.join(" "));
      raf.current = requestAnimationFrame(draw);
    };

    raf.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf.current);
  }, []);

  return (
    <span
      className={`font-xanh-mono lowercase text-primary/80 ${className ?? ""}`}
      style={{ letterSpacing: "-0.03em" }}
    >
      wave
      <svg
        className="inline-block"
        style={{ width: "3.6em", height: "2em", margin: "0 0.15em" }}
        viewBox="0 0 180 72"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          ref={pathRef}
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
      toy
    </span>
  );
}
