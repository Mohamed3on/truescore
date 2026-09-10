// Maps' scrolling place pane, found from inside it: the rating histogram
// (.jANrlb) or a review card. Cards alone miss a Reviews tab whose list hasn't
// loaded — Maps loads it only once it scrolls into view, so a list pushed below
// the fold (e.g. by a removal notice) has no card yet.
export const findReviewsScroll = (): HTMLElement | null => {
  let el = document.querySelector<HTMLElement>('.jftiEf[data-review-id], .jANrlb')?.parentElement ?? null;
  while (el) {
    const s = getComputedStyle(el);
    if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return el;
    el = el.parentElement;
  }
  return null;
};
