// Next.js App Router fixture — API route with two exported handlers.
export async function GET() {
    return Response.json({ users: [] });
}

export async function POST(request: Request) {
    const body = await request.json();
    return Response.json({ created: body });
}
