import type { StageEnvironment } from "@uma-stage/contracts";

export interface EnvironmentVisual {
  shadeColor: number;
  shadeAlpha: number;
  particleColor: number;
  particleAlpha: number;
  particleCount: number;
}

export function resolveEnvironmentVisual(environment: StageEnvironment): EnvironmentVisual {
  const timeVisual = {
    day: { color: 0xffffff, alpha: 0 },
    evening: { color: 0xd47b4b, alpha: 0.18 },
    night: { color: 0x142a49, alpha: 0.46 },
  }[environment.time_of_day];
  const intensity = environment.weather === "clear" ? 0 : environment.intensity;

  if (environment.weather === "rain") {
    return {
      shadeColor: mixColor(timeVisual.color, 0x435b70, 0.55 * intensity),
      shadeAlpha: Math.min(0.58, timeVisual.alpha + 0.12 * intensity),
      particleColor: 0xa9d5ec,
      particleAlpha: 0.38 + 0.42 * intensity,
      particleCount: Math.round(24 + 84 * intensity),
    };
  }
  if (environment.weather === "snow") {
    return {
      shadeColor: mixColor(timeVisual.color, 0xdceaf2, 0.35 * intensity),
      shadeAlpha: Math.min(0.53, timeVisual.alpha + 0.07 * intensity),
      particleColor: 0xf5fbff,
      particleAlpha: 0.55 + 0.4 * intensity,
      particleCount: Math.round(16 + 58 * intensity),
    };
  }
  return {
    shadeColor: timeVisual.color,
    shadeAlpha: timeVisual.alpha,
    particleColor: 0xffffff,
    particleAlpha: 0,
    particleCount: 0,
  };
}

export function interpolateEnvironmentVisual(
  from: EnvironmentVisual,
  to: EnvironmentVisual,
  progress: number,
): EnvironmentVisual {
  const ratio = Math.max(0, Math.min(1, progress));
  return {
    shadeColor: mixColor(from.shadeColor, to.shadeColor, ratio),
    shadeAlpha: lerp(from.shadeAlpha, to.shadeAlpha, ratio),
    particleColor: to.particleColor,
    particleAlpha: to.particleAlpha,
    particleCount: to.particleCount,
  };
}

function mixColor(from: number, to: number, ratio: number): number {
  const amount = Math.max(0, Math.min(1, ratio));
  const fromRed = (from >> 16) & 0xff;
  const fromGreen = (from >> 8) & 0xff;
  const fromBlue = from & 0xff;
  const toRed = (to >> 16) & 0xff;
  const toGreen = (to >> 8) & 0xff;
  const toBlue = to & 0xff;
  return (
    Math.round(lerp(fromRed, toRed, amount)) << 16 |
    Math.round(lerp(fromGreen, toGreen, amount)) << 8 |
    Math.round(lerp(fromBlue, toBlue, amount))
  );
}

function lerp(from: number, to: number, ratio: number): number {
  return from + (to - from) * ratio;
}
