export type PlaceRef = { featureId: string; name: string; resolvedUrl: string };

export async function resolvePlace(input: string): Promise<PlaceRef> {
  let url = input.trim();
  if (!url.startsWith('http')) throw new Error('paste a Google Maps URL');

  const wasShortLink = url.includes('maps.app.goo.gl') || url.includes('goo.gl/maps');
  const hops: { status: number; loc: string | null }[] = [];

  // Follow short-link redirects via headers only (avoid downloading the full page).
  // Strip query first — the path alone identifies the link, and iOS Shortcut share
  // appends ?g_st=com.apple.shortcuts.Run-Workflow.(null) which otherwise rides the
  // redirect into our cached resolvedUrl.
  if (wasShortLink) {
    try {
      const u = new URL(url);
      u.search = '';
      url = u.toString();
    } catch {}
    for (let hop = 0; hop < 5; hop++) {
      const resp = await fetch(url, { redirect: 'manual', method: 'HEAD' });
      const loc = resp.headers.get('location');
      hops.push({ status: resp.status, loc });
      if (!loc) break;
      url = loc.startsWith('http') ? loc : new URL(loc, url).toString();
      if (!url.includes('goo.gl')) break;
    }
  }
  const resolvedUrl = url;

  // featureId can appear as ftid=0x...:0x... or !1s0x...:0x... in the URL
  const ftid = url.match(/[?&]ftid=(0x[a-f0-9]+(?:%3A|:)0x[a-f0-9]+)/i)?.[1];
  const dataId = [...url.matchAll(/!3m\d+!1s(0x[a-f0-9]+(?:%3A|:)0x[a-f0-9]+)/gi)].pop()?.[1];
  const placeId = [...url.matchAll(/!4m\d+(?:!\d+\w\d+)*!1s(0x[a-f0-9]+(?:%3A|:)0x[a-f0-9]+)/gi)].pop()?.[1];
  const featureRaw = ftid || dataId || placeId;
  if (!featureRaw) {
    const hopTrace = hops.length
      ? hops.map((h, i) => `[${i}] ${h.status} → ${h.loc ?? '(no location)'}`).join(' | ')
      : '(no redirects)';
    console.error(
      `[resolvePlace] no place id in URL — input=${input} resolved=${resolvedUrl} shortLink=${wasShortLink} hops=${hopTrace}`,
    );
    throw new Error('no place id in URL');
  }
  const featureId = decodeURIComponent(featureRaw);

  // Name from /place/<NAME>/ or ?q=<NAME>,
  let name = '';
  const placeMatch = url.match(/\/place\/([^/@?]+)/);
  if (placeMatch?.[1]) name = decodeURIComponent(placeMatch[1].replace(/\+/g, ' '));
  if (!name) {
    const qMatch = url.match(/[?&]q=([^&]+)/);
    if (qMatch?.[1]) name = decodeURIComponent(qMatch[1].split(',')[0]!.replace(/\+/g, ' '));
  }
  return { featureId, name, resolvedUrl };
}
