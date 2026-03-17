export const addCommas = (x: number | string): string =>
  String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export const npsColor = (nps: number): string => {
  const hue = Math.min(120, Math.max(0, (nps - 50) * 3));
  return `hsl(${hue}, 70%, 35%)`;
};
