import { NextRequest, NextResponse } from 'next/server';
import { validateToken } from '@/lib/qobuz-dl-server';
import { addToken, getMaskedTokens, removeToken } from '@/lib/token-store';
import { assertSameOrigin, ApiGuardError } from '@/lib/api-guard';
import z from 'zod';

export const dynamic = 'force-dynamic';

const ok = (data: unknown) => new NextResponse(JSON.stringify({ success: true, data }), { status: 200 });

function fail(error: any) {
    // ApiGuardError and validateToken errors carry an explicit HTTP status;
    // zod and other errors fall back to 400.
    const status = error instanceof ApiGuardError ? error.status : typeof error?.status === 'number' ? error.status : 400;
    const message = Array.isArray(error?.errors)
        ? error.errors.map((e: any) => e.message).join(', ')
        : error?.message || 'An error occurred.';
    return new NextResponse(JSON.stringify({ success: false, error: message }), { status });
}

// List the stored tokens (masked — full tokens never leave the server).
export async function GET(request: NextRequest) {
    try {
        assertSameOrigin(request);
        return ok(getMaskedTokens());
    } catch (error: any) {
        return fail(error);
    }
}

const addSchema = z.object({
    token: z.string().min(10, 'Token looks too short'),
    // Validate against Qobuz before saving (default true).
    validate: z.boolean().default(true)
});

// Add a pasted user auth token (paste-token fallback flow).
export async function POST(request: NextRequest) {
    try {
        assertSameOrigin(request);
        const { token, validate } = addSchema.parse(await request.json());
        if (validate) await validateToken(token);
        const masked = addToken({ token, label: 'pasted' });
        return ok({ saved: true, ...masked });
    } catch (error: any) {
        return fail(error);
    }
}

const deleteSchema = z.object({
    id: z.string().min(1, 'Token id is required')
});

// Remove a stored token by its hash id.
export async function DELETE(request: NextRequest) {
    try {
        assertSameOrigin(request);
        const { id } = deleteSchema.parse(await request.json());
        const removed = removeToken(id);
        return ok({ removed });
    } catch (error: any) {
        return fail(error);
    }
}
