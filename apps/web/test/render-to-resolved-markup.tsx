import type { ReactNode } from 'react';
import { renderToReadableStream } from 'react-dom/server';

export async function renderToResolvedMarkup(node: ReactNode): Promise<string> {
  const stream = await renderToReadableStream(node);
  await stream.allReady;
  return new Response(stream).text();
}
