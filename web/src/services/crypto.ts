export async function sha256Blob(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

export async function sha256File(file: File): Promise<string> {
  return sha256Blob(file);
}

export async function sha256Chunks(chunks: Uint8Array[]): Promise<string> {
  const validChunks = chunks.filter((c): c is Uint8Array => c instanceof Uint8Array);
  const totalSize = validChunks.reduce((acc, chunk) => acc + chunk.byteLength, 0);
  const combined = new Uint8Array(totalSize);
  
  let offset = 0;
  for (const chunk of validChunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  
  const hashBuffer = await crypto.subtle.digest('SHA-256', combined.buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
