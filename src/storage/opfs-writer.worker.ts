/**
 * OPFS writer for engines without `FileSystemFileHandle.createWritable()`
 * (WKWebView before Safari 26, i.e. most supported macOS versions). Sync
 * access handles exist there, but only inside a dedicated worker.
 */
interface WriteRequest {
  id: number;
  /** Path below the OPFS root; the last segment is the file name. */
  path: string[];
  data: Blob;
}

interface SyncAccessHandle {
  truncate(size: number): void;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  flush(): void;
  close(): void;
}

self.onmessage = async (event: MessageEvent<WriteRequest>) => {
  const { id, path, data } = event.data;
  try {
    let dir = await navigator.storage.getDirectory();
    for (const segment of path.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }
    const file = await dir.getFileHandle(path[path.length - 1]!, { create: true });
    const handle = await (
      file as unknown as { createSyncAccessHandle(): Promise<SyncAccessHandle> }
    ).createSyncAccessHandle();
    try {
      const bytes = new Uint8Array(await data.arrayBuffer());
      handle.truncate(0);
      let written = 0;
      while (written < bytes.byteLength) {
        written += handle.write(bytes.subarray(written), { at: written });
      }
      handle.flush();
    } finally {
      handle.close();
    }
    self.postMessage({ id, ok: true });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
