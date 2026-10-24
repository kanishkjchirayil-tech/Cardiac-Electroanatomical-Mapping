/** Save data as a file in the browser. */
export function download(name: string, data: string | Uint8Array | object, type = 'application/octet-stream'): void {
  const body = typeof data === 'string' || data instanceof Uint8Array ? data : JSON.stringify(data);
  const blob = new Blob([body as BlobPart], { type: typeof data === 'object' && !(data instanceof Uint8Array) ? 'application/json' : type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
