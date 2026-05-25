
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
    return NextResponse.json({ status: 'success' });
}

export async function OPTIONS() {
    return new NextResponse(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-witty-api-key, baggage, traceparent, tracestate',
        }
    });
}
