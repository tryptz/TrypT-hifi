import { NextRequest, NextResponse } from 'next/server';
import { ACCESS_COOKIE, accessDigest, accessPassword, sameDigest } from '@/lib/access';

// The password page for this site's own pages, when ACCESS_PASSWORD is set.
// A plain form and a cookie: no client code, and none of the app's providers,
// which would call API routes the password still guards.

// Only a path on this site, so the form cannot be used to send someone elsewhere.
function safeNext(next: string | null): string {
    return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/unlock') ? next : '/';
}

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// Relative, so it holds behind the tunnel whatever host the request names.
function goTo(next: string): NextResponse {
    return new NextResponse(null, { status: 303, headers: { Location: next } });
}

function page(next: string, wrong: boolean, status = 200): NextResponse {
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>TrypT-hifi</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #0b0b0c; color: #f2f2f2; }
  @media (prefers-color-scheme: light) { body { background: #f6f6f7; color: #111; } input { background: #fff; color: #111; } }
  form { width: min(320px, calc(100vw - 32px)); display: grid; gap: 12px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  input { font: inherit; padding: 12px; border-radius: 10px; border: 1px solid #8884; background: #18181b; color: inherit; }
  button { font: inherit; font-weight: 600; padding: 12px; border-radius: 10px; border: 0; background: #f2f2f2; color: #111; cursor: pointer; }
  p { margin: 0; color: #e5484d; font-size: 14px; }
</style>
</head>
<body>
<form method="post" action="/unlock">
  <h1>TrypT-hifi</h1>
  <input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  ${wrong ? '<p>That password is not right.</p>' : ''}
  <button type="submit">Unlock</button>
</form>
</body>
</html>`;
    return new NextResponse(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export async function GET(request: NextRequest) {
    const next = safeNext(request.nextUrl.searchParams.get('next'));
    if (!accessPassword()) return goTo(next);
    return page(next, false);
}

export async function POST(request: NextRequest) {
    const password = accessPassword();
    const form = await request.formData();
    const next = safeNext(form.get('next')?.toString() ?? null);
    if (!password) return goTo(next);

    const expected = await accessDigest(password);
    const given = form.get('password')?.toString() ?? '';
    if (!sameDigest(await accessDigest(given), expected)) {
        // A second per wrong guess slows a script down; a person barely notices.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return page(next, true, 401);
    }
    const response = goTo(next);
    const https = request.nextUrl.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
    response.cookies.set(ACCESS_COOKIE, expected, {
        httpOnly: true,
        secure: https,
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 365,
    });
    return response;
}
