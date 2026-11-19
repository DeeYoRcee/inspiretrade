declare module "lzma-native" {
  export function decompress(input: Buffer, cb: (result: Buffer | string) => void): void;
  export function compress(input: Buffer, cb: (result: Buffer | string) => void, mode?: number): void;
}
