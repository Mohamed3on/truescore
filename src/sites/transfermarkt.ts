// ============================================================
// Constants & Utilities
// ============================================================
const CACHE_TTL = 3 * 24 * 60 * 60 * 1000; // 3 days
const CACHE_PREFIX = 'tmSorter_v5_';
let isSorting = false;

const createEl = (tag: string, className?: string, text?: string | number) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = String(text);
  return el;
};

const parseValue = (text: string): any => {
  const cleaned = text.trim();

  // Market value (€1.40bn, €56.04m, €928k)
  if (cleaned.includes('€')) {
    const val = cleaned.replace(/[€\s]/g, '');
    const multipliers: Record<string, number> = { bn: 1e9, m: 1e6, k: 1e3, 'Th.': 1e3 };
    for (const [suffix, mult] of Object.entries(multipliers)) {
      if (val.endsWith(suffix)) {
        const num = parseFloat(val.slice(0, -suffix.length));
        return isNaN(num) ? 0 : num * mult;
      }
    }
    return parseFloat(val) || 0;
  }

  // Percentage
  if (cleaned.includes('%')) {
    return parseFloat(cleaned.replace('%', '')) || 0;
  }

  // Number
  const num = parseFloat(cleaned.replace(/,/g, ''));
  if (!isNaN(num)) return num;

  return cleaned.toLowerCase();
};

const getColumnValue = (cell: Element): any => {
  const text = cell.textContent!.trim();

  const hauptlink = cell.querySelector('.hauptlink a');
  if (hauptlink) {
    const linkText = hauptlink.textContent!.trim();
    return linkText.includes('€') ? parseValue(linkText) : linkText.toLowerCase();
  }

  const link = cell.querySelector('a');
  if (link && !cell.querySelector('img')) {
    return link.textContent!.trim().toLowerCase();
  }

  return parseValue(text);
};

const extractVereinId = (element: Element) => {
  const img = element.querySelector('img[src*="/verein/"]');
  const link = element.querySelector('a[href*="/verein/"]');
  const src = (img as HTMLImageElement)?.src || (link as HTMLAnchorElement)?.href || '';
  return src.match(/\/verein\/(\d+)\//)?.[1] || null;
};

const isMarketValueTable = (table: Element) => {
  const headerText = table.querySelector('thead tr')?.textContent?.toLowerCase() || '';
  return headerText.includes('market value') || headerText.includes('marktwert');
};

const isAverageMarketValueTable = (table: Element) => {
  const headerText = table.querySelector('thead tr')?.textContent || '';
  return headerText.includes('ø');
};

const isPaginatedTable = () => !!document.querySelector('.tm-pagination, .pager, [class*="pagination"]');

// ============================================================
// Cache
// ============================================================
const cache = {
  getKey(url: string) {
    const urlObj = new URL(url);
    const params = new URLSearchParams(urlObj.search);
    params.delete('page');
    params.delete('ajax');
    params.sort();
    return CACHE_PREFIX + urlObj.pathname + '?' + params.toString();
  },

  get(key: string) {
    try {
      const data = localStorage.getItem(key);
      if (!data) return null;
      const parsed = JSON.parse(data);
      return Date.now() - parsed.fetchedAt < CACHE_TTL ? parsed.rows : null;
    } catch { return null; }
  },

  set(key: string, rows: any[]) {
    try {
      localStorage.setItem(key, JSON.stringify({ rows, fetchedAt: Date.now() }));
    } catch (e) {
      console.warn('[TM Sorter] Cache failed:', e);
    }
  }
};

// ============================================================
// Page Fetching
// ============================================================
const buildPageUrl = (baseUrl: string, pageNum: number) => {
  const url = new URL(baseUrl);
  url.searchParams.set('page', String(pageNum));
  url.searchParams.set('ajax', 'yw1');
  return url.toString();
};

const parseRowsFromHtml = (html: string) => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return Array.from(doc.querySelectorAll('tr.even, tr.odd')).map((row) => ({
    cells: Array.from(row.children)
      .filter(child => child.tagName === 'TD')
      .map(cell => ({ html: cell.innerHTML, value: getColumnValue(cell) })) // eslint-disable-line no-unsanitized/property
  }));
};

const fetchPage = async (baseUrl: string, pageNum: number) => {
  const response = await fetch(buildPageUrl(baseUrl, pageNum), {
    headers: { 'X-Requested-With': 'XMLHttpRequest' }
  });
  return parseRowsFromHtml(await response.text());
};

const fetchAllPages = async (baseUrl: string, totalPages: number, onProgress?: (current: number, total: number) => void) => {
  const cacheKey = cache.getKey(baseUrl);
  const cached = cache.get(cacheKey);
  if (cached) {
    console.log('[TM Sorter] Using cache:', cached.length, 'rows');
    return cached;
  }

  console.log('[TM Sorter] Fetching', totalPages, 'pages');
  let completed = 0;

  const results = await Promise.all(
    Array.from({ length: totalPages }, (_, i) => i + 1).map(async (page) => {
      const rows = await fetchPage(baseUrl, page);
      onProgress?.(++completed, totalPages);
      return { page, rows };
    })
  );

  const allRows = results.sort((a, b) => a.page - b.page).flatMap(r => r.rows);
  console.log('[TM Sorter] Fetched:', allRows.length, 'rows');
  cache.set(cacheKey, allRows);
  return allRows;
};

const detectPaginationInfo = () => {
  const pageNums = [...document.querySelectorAll('a[href*="page="]')]
    .map(a => a.getAttribute('href')?.match(/page=(\d+)/)?.[1])
    .filter(Boolean)
    .map(Number);

  return {
    totalPages: Math.max(1, ...pageNums),
    baseUrl: window.location.href
  };
};

// ============================================================
// League Table Data
// ============================================================
const getLeagueTableData = () => {
  for (const table of document.querySelectorAll('table.items')) {
    const headerText = table.querySelector('thead tr')?.textContent || '';
    if (!headerText.includes('Pts') || isMarketValueTable(table)) continue;

    const leagueData = new Map<string, { position: number; points: number }>();
    table.querySelectorAll('tbody tr').forEach((row, index) => {
      const vereinId = extractVereinId(row);
      if (!vereinId) return;

      const cells = Array.from(row.querySelectorAll('td'))
        .filter(c => !c.classList.contains('tm-pts-diff-cell'));
      const points = parseInt(cells[cells.length - 1]?.textContent!.trim(), 10);

      if (!isNaN(points)) {
        leagueData.set(vereinId, { position: index + 1, points });
      }
    });

    if (leagueData.size > 0) return leagueData;
  }
  return null;
};

// ============================================================
// Ranking Column
// ============================================================
const addRankingColumn = (table: HTMLTableElement) => {
  if (table.hasAttribute('data-has-ranking')) return;

  const thead = table.querySelector('thead tr');
  const tbody = table.querySelector('tbody');
  if (!thead || !tbody) return;

  const th = createEl('th', 'zentriert', '#');
  (th as HTMLElement).style.cursor = 'default';
  thead.insertBefore(th, thead.firstChild);

  tbody.querySelectorAll('tr.even, tr.odd').forEach((row, i) => {
    row.insertBefore(createEl('td', 'zentriert tm-rank-cell', i + 1), row.firstChild);
  });

  const tfoot = table.querySelector('tfoot tr');
  if (tfoot) tfoot.insertBefore(createEl('td', '', '\u00A0'), tfoot.firstChild);

  table.setAttribute('data-has-ranking', 'true');
};

const updateRankings = (table: HTMLTableElement) => {
  if (!table.hasAttribute('data-has-ranking')) return;
  table.querySelectorAll('tbody tr.even, tbody tr.odd').forEach((row, i) => {
    const cell = row.querySelector('.tm-rank-cell');
    if (cell) cell.textContent = String(i + 1);
  });
};

// ============================================================
// Point Diff Column
// ============================================================
const getMarketValueColumnIndex = (table: HTMLTableElement) => {
  const headers = Array.from(table.querySelectorAll('thead th'));
  return headers.findIndex(th => th.textContent!.includes('ø') && th.textContent!.toLowerCase().includes('market'));
};

const addPointDiffColumn = (table: HTMLTableElement, leagueData: Map<string, { position: number; points: number }>) => {
  if (table.hasAttribute('data-has-pts-diff') || !isAverageMarketValueTable(table)) return;

  const thead = table.querySelector('thead tr');
  const tbody = table.querySelector('tbody');
  if (!thead || !tbody) return;

  const pointsByPosition: number[] = [];
  leagueData.forEach(data => { pointsByPosition[data.position] = data.points; });

  // Sort rows by market value to determine each team's market value rank
  const rows = Array.from(tbody.querySelectorAll('tr.even, tr.odd'));
  const mvColIndex = getMarketValueColumnIndex(table);
  const hasRanking = table.hasAttribute('data-has-ranking');
  const cellIndex = hasRanking ? mvColIndex + 1 : mvColIndex + 1;

  const rowsWithMV = rows.map(row => {
    const cell = row.querySelector(`td:nth-child(${cellIndex})`);
    return { row, value: cell ? getColumnValue(cell) : 0, vereinId: extractVereinId(row) };
  });

  // Sort by market value descending to get ranks
  const sorted = [...rowsWithMV].sort((a, b) => ((b.value as number) - (a.value as number)));
  const mvRankByVereinId = new Map<string, number>();
  sorted.forEach((item, i) => {
    if (item.vereinId) mvRankByVereinId.set(item.vereinId, i + 1);
  });

  const th = createEl('th', 'zentriert', 'Δ Pts');
  (th as HTMLElement).title = 'Points difference vs expected position based on market value';
  thead.appendChild(th);

  rows.forEach(row => {
    const td = createEl('td', 'zentriert tm-pts-diff-cell');
    const vereinId = extractVereinId(row);
    const teamData = vereinId && leagueData.get(vereinId);
    const mvRank = vereinId && mvRankByVereinId.get(vereinId);
    const expectedPoints = mvRank && pointsByPosition[mvRank];

    if (teamData && expectedPoints !== undefined) {
      const diff = teamData.points - expectedPoints;
      td.textContent = diff > 0 ? `+${diff}` : String(diff);
      (td as HTMLElement).style.color = diff > 0 ? '#2e7d32' : diff < 0 ? '#c62828' : '#666';
      (td as HTMLElement).style.fontWeight = 'bold';
    } else {
      td.textContent = '-';
      (td as HTMLElement).style.color = '#999';
    }
    row.appendChild(td);
  });

  const tfoot = table.querySelector('tfoot tr');
  if (tfoot) tfoot.appendChild(createEl('td', '', '\u00A0'));

  table.setAttribute('data-has-pts-diff', 'true');
};

// ============================================================
// Styles & UI
// ============================================================
const injectStyles = () => {
  if (document.getElementById('tm-sorter-styles')) return;

  const style = document.createElement('style');
  style.id = 'tm-sorter-styles';
  style.textContent = `
    .tm-rank-cell { font-weight: bold; color: #666; }
    .tm-pts-diff-cell { font-weight: bold; min-width: 45px; }
    .global-sort-loading {
      position: absolute; inset: 0;
      background: rgba(255,255,255,0.9);
      display: flex; align-items: center; justify-content: center; gap: 10px;
      z-index: 100; font-family: Arial, sans-serif;
    }
    .loading-spinner {
      width: 24px; height: 24px;
      border: 3px solid #ccc; border-top-color: #1a73e8;
      border-radius: 50%; animation: tm-spin 1s linear infinite;
    }
    @keyframes tm-spin { to { transform: rotate(360deg); } }
    .global-sort-badge {
      background: #1a73e8; color: white;
      padding: 8px 12px; border-radius: 4px;
      font-size: 12px; margin-bottom: 8px; font-family: Arial, sans-serif;
    }
    th.sorted-asc::after { content: ' ▲'; font-size: 10px; }
    th.sorted-desc::after { content: ' ▼'; font-size: 10px; }
  `;
  document.head.appendChild(style);
};

const showLoading = (table: HTMLTableElement, current?: number, total?: number) => {
  let overlay = table.querySelector('.global-sort-loading') as HTMLElement | null;
  if (!overlay) {
    overlay = createEl('div', 'global-sort-loading') as HTMLElement;
    overlay.appendChild(createEl('div', 'loading-spinner'));
    overlay.appendChild(createEl('span'));
    table.style.position = 'relative';
    table.appendChild(overlay);
  }
  overlay.style.display = 'flex';
  overlay.querySelector('span')!.textContent = total
    ? `Loading page ${current} of ${total}...`
    : 'Loading all pages...';
};

const hideLoading = (table: HTMLTableElement) => {
  const overlay = table.querySelector('.global-sort-loading') as HTMLElement | null;
  if (overlay) overlay.style.display = 'none';
};

const showGlobalBadge = (table: HTMLTableElement, count: number) => {
  const parent = table.parentNode as Element;
  let badge = parent.querySelector('.global-sort-badge') as HTMLElement | null;
  if (!badge) {
    badge = createEl('div', 'global-sort-badge') as HTMLElement;
    parent.insertBefore(badge, table);
  }
  badge.textContent = `Global Sort Active - Showing all ${count} players (Shift+Click to re-sort)`;
  badge.style.display = 'block';
};

const hideGlobalBadge = (table: HTMLTableElement) => {
  const badge = (table.parentNode as Element)?.querySelector('.global-sort-badge') as HTMLElement | null;
  if (badge) badge.style.display = 'none';
};

// ============================================================
// Sorting
// ============================================================
const compareValues = (a: any, b: any, dir: number) => {
  if (typeof a === 'number' && typeof b === 'number') return (a - b) * dir;
  return String(a ?? '').localeCompare(String(b ?? '')) * dir;
};

const updateSortHeaders = (table: HTMLTableElement, columnIndex: number, ascending: boolean) => {
  table.querySelectorAll('th').forEach(th => th.classList.remove('sorted-asc', 'sorted-desc'));
  if (columnIndex === -1) return;

  const hasRanking = table.hasAttribute('data-has-ranking');
  const headerIndex = hasRanking ? columnIndex + 2 : columnIndex + 1;
  const header = table.querySelector(`th:nth-child(${headerIndex})`);
  if (header) {
    header.classList.add(ascending ? 'sorted-asc' : 'sorted-desc');
    header.setAttribute('data-sort-direction', ascending ? 'desc' : 'asc');
  }
};

const sortTableByColumn = (table: HTMLTableElement, columnIndex: number, ascending: boolean) => {
  isSorting = true;
  const tbody = table.querySelector('tbody');
  if (!tbody) { isSorting = false; return; }

  const hasRanking = table.hasAttribute('data-has-ranking');
  const cellIndex = hasRanking ? columnIndex + 2 : columnIndex + 1;
  const dir = ascending ? 1 : -1;
  const rows = Array.from(table.querySelectorAll('tr.even, tr.odd'));

  rows.sort((a, b) => {
    const aCol = a.querySelector(`td:nth-child(${cellIndex})`);
    const bCol = b.querySelector(`td:nth-child(${cellIndex})`);
    return aCol && bCol ? compareValues(getColumnValue(aCol), getColumnValue(bCol), dir) : 0;
  });

  tbody.querySelectorAll('tr.even, tr.odd').forEach(row => row.remove());
  rows.forEach(row => tbody.appendChild(row));
  updateSortHeaders(table, columnIndex, ascending);
  isSorting = false;
};

const globalSortTableByColumn = async (table: HTMLTableElement, columnIndex: number, ascending: boolean) => {
  const { baseUrl, totalPages } = detectPaginationInfo();
  showLoading(table);

  try {
    const allRows = await fetchAllPages(baseUrl, totalPages, (cur, tot) => showLoading(table, cur, tot));
    const dir = ascending ? 1 : -1;
    const sorted = [...allRows].sort((a: any, b: any) =>
      compareValues(a.cells[columnIndex]?.value, b.cells[columnIndex]?.value, dir)
    );

    renderGlobalResults(table, sorted);
    updateSortHeaders(table, columnIndex, ascending);
    updateRankings(table);
    showGlobalBadge(table, sorted.length);
    table.setAttribute('data-global-sorted', 'true');
  } catch (error) {
    console.error('[TM Sorter] Global sort failed:', error);
    sortTableByColumn(table, columnIndex, ascending);
  } finally {
    hideLoading(table);
  }
};

const renderGlobalResults = (table: HTMLTableElement, sortedRows: any[]) => {
  isSorting = true;

  const tbody = table.querySelector('tbody');
  if (!tbody) { isSorting = false; return; }

  const hasRanking = table.hasAttribute('data-has-ranking');
  tbody.querySelectorAll('tr.even, tr.odd').forEach(row => row.remove());

  sortedRows.forEach((rowData, index) => {
    const row = createEl('tr', index % 2 === 0 ? 'odd' : 'even');

    if (hasRanking) {
      row.appendChild(createEl('td', 'zentriert tm-rank-cell', index + 1));
    }

    rowData.cells.forEach((cell: any) => {
      const td = document.createElement('td');
      td.innerHTML = cell.html; // eslint-disable-line no-unsanitized/property
      row.appendChild(td);
    });

    tbody.appendChild(row);
  });

  isSorting = false;
};

// ============================================================
// Table Initialization
// ============================================================
const makeTableSortable = (table: HTMLTableElement) => {
  if (table.hasAttribute('data-sortable')) return;

  injectStyles();

  // Add ranking and point diff columns to average market value tables only
  if (table.classList.contains('items') && isAverageMarketValueTable(table)) {
    addRankingColumn(table);
    const leagueData = getLeagueTableData();
    if (leagueData) addPointDiffColumn(table, leagueData);
  }

  table.querySelectorAll('th').forEach((header, index) => {
    const text = header.textContent!.trim();
    if (text === '#') return; // Skip non-sortable columns

    header.style.cursor = 'pointer';
    header.addEventListener('click', async (event) => {
      const currentDir = header.getAttribute('data-sort-direction') || 'desc';
      const ascending = currentDir === 'asc';
      const hasRanking = table.hasAttribute('data-has-ranking');
      const colIndex = hasRanking ? index - 1 : index;

      if (event.shiftKey && isPaginatedTable()) {
        await globalSortTableByColumn(table, colIndex, ascending);
      } else {
        if (table.hasAttribute('data-global-sorted')) {
          hideGlobalBadge(table);
          table.removeAttribute('data-global-sorted');
        }
        sortTableByColumn(table, colIndex, ascending);
      }

      updateRankings(table);
    });
  });

  table.setAttribute('data-sortable', 'true');
};

const initializeSortableTables = () => {
  document.querySelectorAll('table').forEach(table => makeTableSortable(table as HTMLTableElement));

  new MutationObserver(mutations => {
    if (isSorting) return;

    for (const { addedNodes } of mutations) {
      addedNodes.forEach(node => {
        if (node.nodeName === 'TABLE') makeTableSortable(node as HTMLTableElement);
        (node as Element).querySelectorAll?.('table').forEach(t => makeTableSortable(t as HTMLTableElement));
      });
    }
  }).observe(document.body, { childList: true, subtree: true });
};

// Initialize
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeSortableTables);
} else {
  initializeSortableTables();
}
