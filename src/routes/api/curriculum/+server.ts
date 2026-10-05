import { json } from '@sveltejs/kit'
import { getView } from '$lib/server/curriculum'

export function GET() {
  return json(getView())
}
