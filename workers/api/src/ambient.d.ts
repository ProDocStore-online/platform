declare module "tweetnacl-sealedbox-js" {
  const sealedbox: {
    seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array;
  };
  export default sealedbox;
}
