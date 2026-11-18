declare module 'gifenc' {
  type Palette = number[][];
  type Fmt = 'rgb565' | 'rgb444' | 'rgba4444';
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: { format?: Fmt; oneBitAlpha?: boolean | number; clearAlpha?: boolean },
  ): Palette;
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: Fmt): Uint8Array;
  export function GIFEncoder(opts?: { auto?: boolean }): {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: { palette?: Palette; transparent?: boolean; transparentIndex?: number; delay?: number; repeat?: number },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  };
}

declare module 'utif' {
  export interface IFD {
    width: number;
    height: number;
    subIFD?: IFD[];
    [tag: string]: unknown;
  }
  export function decode(buffer: ArrayBuffer): IFD[];
  export function decodeImage(buffer: ArrayBuffer, ifd: IFD, ifds?: IFD[]): void;
  export function toRGBA8(ifd: IFD): Uint8Array;
  export function encodeImage(rgba: ArrayBuffer | Uint8Array, w: number, h: number, metadata?: Record<string, unknown>): ArrayBuffer;
}
