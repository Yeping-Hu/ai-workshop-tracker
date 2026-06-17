// Emitted as a static /version.json at build time. A back/forward-cache page
// restored after a deploy fetches this; if the id differs from the one stamped
// into that page, it forces a single fresh load so stale code/markup can't
// linger (see the pageshow handler in Base.astro).
export async function GET() {
  return new Response(JSON.stringify({ build: import.meta.env.PUBLIC_BUILD_ID }), {
    headers: {
      'Content-Type': 'application/json',
      // Must not be cached, or the staleness check itself goes stale.
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
