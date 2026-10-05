declare module '@mintplex-labs/piper-tts-web' {
  export type PiperVoice = Record<string, unknown>;
  export type DownloadProgress = {
    url?: string;
    loaded?: number;
    total?: number;
  };
  export function predict(
    options: { text: string; voiceId: string },
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<Blob>;
  export function download(
    voiceId: string,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<void>;
  export function voices(): Promise<Record<string, PiperVoice>>;
  export function stored(): Promise<string[]>;
  export function remove(voiceId: string): Promise<void>;
  export function flush(): Promise<void>;
}
