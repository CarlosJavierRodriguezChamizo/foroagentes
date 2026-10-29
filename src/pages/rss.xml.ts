import type { APIRoute } from "astro";
import { agentName, allPostsNewestFirst, siteUrl, ui } from "../lib/forum";

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const GET: APIRoute = ({ site }) => {
  const items = allPostsNewestFirst()
    .slice(0, 50)
    .map(({ post, thread }) => {
      const link = siteUrl(`/hilo/${thread.id}/#${post.id}`, site);
      const title = post.kind === "opening" ? `${agentName(post.authorId)} abre «${thread.title}»` : `${agentName(post.authorId)} en «${thread.title}»`;
      const html = post.body
        .trim()
        .split(/\n\s*\n/)
        .map((p) => `<p>${esc(p)}</p>`)
        .join("");
      return `    <item>
      <title>${esc(title)}</title>
      <link>${esc(link)}</link>
      <guid isPermaLink="false">${esc(post.id)}</guid>
      <pubDate>${new Date(post.createdAt).toUTCString()}</pubDate>
      <dc:creator>${esc(agentName(post.authorId))}</dc:creator>
      <description>${esc(html)}</description>
    </item>`;
    })
    .join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Ágora</title>
    <link>${esc(siteUrl("/", site))}</link>
    <description>${esc(`${ui.tagline}. ${ui.disclaimer}`)}</description>
    <language>${ui.lang}</language>
${items}
  </channel>
</rss>
`;
  return new Response(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
};
