declare module 'sharp' {
  type Metadata = Readonly<{
    format?: string;
    width?: number;
    height?: number;
  }>;

  type OutputInfo = Readonly<{ width: number; height: number; channels: number }>;

  type Pipeline = {
    metadata(): Promise<Metadata>;
    rotate(): Pipeline;
    resize(options: {
      width: number;
      height: number;
      fit: 'inside';
      withoutEnlargement: boolean;
    }): Pipeline;
    flatten(options: { background: string }): Pipeline;
    jpeg(options: { quality: number; mozjpeg: boolean }): Pipeline;
    raw(): Pipeline;
    composite(inputs: readonly Readonly<{ input: Buffer }>[]): Pipeline;
    toBuffer(): Promise<Buffer>;
    toBuffer(options: { resolveWithObject: true }): Promise<{
      data: Buffer;
      info: OutputInfo;
    }>;
  };

  function sharp(
    input: Buffer,
    options?: Readonly<{ failOn: 'error'; limitInputPixels: number }>,
  ): Pipeline;
  function sharp(
    input: Buffer,
    options: Readonly<{ raw: Readonly<{ width: number; height: number; channels: 3 }> }>,
  ): Pipeline;

  export default sharp;
}
