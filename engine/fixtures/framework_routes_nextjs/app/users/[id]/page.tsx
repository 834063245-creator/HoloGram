// Next.js App Router fixture — dynamic segment page ([id] -> :id).
export default function UserDetail({ params }: { params: { id: string } }) {
    return <main>{params.id}</main>;
}
