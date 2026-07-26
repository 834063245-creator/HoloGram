// SvelteKit fixture — API endpoint with two exported handlers.
export async function GET() {
    return Response.json({ users: [] });
}

export const POST = async ({ request }: { request: Request }) => {
    const body = await request.json();
    return Response.json({ created: body });
};
