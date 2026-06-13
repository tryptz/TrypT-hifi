import { NextRequest, NextResponse } from 'next/server';
import { qobuzLogin } from '@/lib/qobuz-dl-server';
import { addToken } from '@/lib/token-store';
import { assertSameOrigin, ApiGuardError } from '@/lib/api-guard';
import z from 'zod';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
    email: z.string().email('A valid email is required'),
    password: z.string().min(1, 'Password is required')
});

export async function POST(request: NextRequest) {
    try {
        assertSameOrigin(request);
        const { email, password } = bodySchema.parse(await request.json());

        // The full token is always stored server-side and never returned to the
        // client — only the masked form leaves the server.
        const { token } = await qobuzLogin(email, password);
        const masked = addToken({ token, label: email });
        return new NextResponse(JSON.stringify({ success: true, data: { saved: true, ...masked } }), { status: 200 });
    } catch (error: any) {
        // qobuzLogin / ApiGuardError carry an explicit HTTP status; zod and other
        // errors fall back to 400. error?.errors holds zod issues (stringified).
        const status = error instanceof ApiGuardError ? error.status : typeof error?.status === 'number' ? error.status : 400;
        const message = Array.isArray(error?.errors)
            ? error.errors.map((e: any) => e.message).join(', ')
            : error?.message || 'An error occurred during login.';
        return new NextResponse(JSON.stringify({ success: false, error: message }), { status });
    }
}
