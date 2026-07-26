// Hono fixture — basePath prefix propagation (statement order).
import { Hono } from 'hono'

const app = new Hono()

app.basePath('/api')

app.get('/users', listUsers)
app.post('/users', createUser)
app.get('/users/:id', getUser)

function listUsers(c: any) { return c.json([]) }
function createUser(c: any) { return c.json({ id: 'new' }) }
function getUser(c: any) { return c.json({ id: 'one' }) }
