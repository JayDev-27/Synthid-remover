declare module 'omggif' {
  export interface GifFrameInfo {
    x: number;
    y: number;
    width: number;
    height: number;
    has_local_palette: boolean;
    palette_offset: number;
    palette_size: number;
    data_offset: number;
    data_length: number;
    transparent_index: number | null;
    interlaced: boolean;
    delay: number;
    disposal: number;
  }

  export class GifReader {
    width: number;
    height: number;
    constructor(buf: Uint8Array | ArrayLike<number>);
    numFrames(): number;
    loopCount(): number | null;
    frameInfo(frameNum: number): GifFrameInfo;
    decodeAndBlitFrameBGRA(frameNum: number, pixels: Uint8Array | Uint8ClampedArray): void;
    decodeAndBlitFrameRGBA(frameNum: number, pixels: Uint8Array | Uint8ClampedArray): void;
  }

  export interface GifWriterGlobalOptions {
    loop?: number | null;
    palette?: number[] | null;
    background?: number;
  }

  export interface GifWriterFrameOptions {
    palette?: number[];
    delay?: number;
    disposal?: number;
    transparent?: number;
  }

  export class GifWriter {
    constructor(
      buf: Uint8Array | Buffer | number[],
      width: number,
      height: number,
      gopts?: GifWriterGlobalOptions
    );
    addFrame(
      x: number,
      y: number,
      w: number,
      h: number,
      indexedPixels: Uint8Array | number[],
      opts?: GifWriterFrameOptions
    ): number;
    end(): number;
  }
}
