import type { APIRoute } from "astro";
import { forum } from "../../lib/forum";

/** Los JSON de los últimos 100 ticks se publican tal cual (el historial completo vive en el repositorio). */
export function getStaticPaths() {
  return [...forum().ticks]
    .sort((a, b) => b.id.localeCompare(a.id))
    .slice(0, 100)
    .map((tick) => ({ params: { id: tick.id }, props: { tick } }));
}

export const GET: APIRoute = ({ props }) =>
  new Response(JSON.stringify(props.tick, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8" } });
