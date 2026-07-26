// Next.js App Router fixture — catch-all page ([...slug] -> *).
export default function Docs({ params }: { params: { slug: string[] } }) {
    return <main>{params.slug.join('/')}</main>;
}
