export const getDecathlonSite = () => {
  const m = location.hostname.match(/\bdecathlon\.([a-z.]+)$/);
  if (!m) return null;
  const locale = document.documentElement.lang || 'en-US';
  return { tld: m[1], locale };
};
