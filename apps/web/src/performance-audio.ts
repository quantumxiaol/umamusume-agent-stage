import type { PerformanceScript } from "@uma-stage/contracts";

export interface PerformanceAudioPlayback {
  durationMs: number;
  completion: Promise<void>;
}

export function performanceAudioPaths(script: PerformanceScript): string[] {
  return [
    ...new Set(
      script.scenes.flatMap((scene) =>
        scene.beats.flatMap((beat) =>
          beat.cues.flatMap((cue) =>
            (cue.type === "dialogue.say" || cue.type === "narration.say") && cue.audio_path
              ? [cue.audio_path]
              : [],
          ),
        ),
      ),
    ),
  ];
}

export function audioDurationMs(durationSeconds: number): number {
  return Math.max(1, Math.ceil(durationSeconds * 1000));
}

export class PerformanceAudioPlayer {
  readonly #urlForPath: (path: string) => string;
  readonly #buffers = new Map<string, Promise<AudioBuffer>>();
  readonly #sources = new Set<AudioBufferSourceNode>();
  #context: AudioContext | null = null;

  constructor(urlForPath: (path: string) => string) {
    this.#urlForPath = urlForPath;
  }

  async unlock(): Promise<void> {
    const context = this.context();
    if (context.state === "suspended") await context.resume();
  }

  async preload(paths: Iterable<string>): Promise<void> {
    await Promise.all([...new Set(paths)].map((path) => this.load(path)));
  }

  async play(path: string): Promise<PerformanceAudioPlayback> {
    const [buffer] = await Promise.all([this.load(path), this.unlock()]);
    const context = this.context();
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    this.#sources.add(source);

    const completion = new Promise<void>((resolve) => {
      source.addEventListener("ended", () => {
        source.disconnect();
        this.#sources.delete(source);
        resolve();
      }, { once: true });
    });
    source.start();
    return { durationMs: audioDurationMs(buffer.duration), completion };
  }

  stopAll(): void {
    for (const source of this.#sources) {
      try {
        source.stop();
      } catch {
        source.disconnect();
      }
    }
    this.#sources.clear();
  }

  async dispose(): Promise<void> {
    this.stopAll();
    const context = this.#context;
    this.#context = null;
    this.#buffers.clear();
    if (context && context.state !== "closed") await context.close();
  }

  private context(): AudioContext {
    if (this.#context) return this.#context;
    const AudioContextConstructor = window.AudioContext;
    if (!AudioContextConstructor) throw new Error("当前浏览器不支持 Web Audio API");
    this.#context = new AudioContextConstructor();
    return this.#context;
  }

  private load(path: string): Promise<AudioBuffer> {
    const cached = this.#buffers.get(path);
    if (cached) return cached;
    const loading = this.fetchAndDecode(path).catch((error: unknown) => {
      this.#buffers.delete(path);
      throw error;
    });
    this.#buffers.set(path, loading);
    return loading;
  }

  private async fetchAndDecode(path: string): Promise<AudioBuffer> {
    const url = this.#urlForPath(path);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`无法读取剧本音频 ${path} (${response.status})`);
    try {
      return await this.context().decodeAudioData(await response.arrayBuffer());
    } catch (error) {
      throw new Error(`无法解码剧本音频 ${path}: ${errorMessage(error)}`);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
