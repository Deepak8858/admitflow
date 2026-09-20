/** Shared API/repository/UI bounds: callers must refine filters beyond this window. */
export const MAX_LEAD_PAGE = 1000;
export const MAX_LEAD_PAGE_SIZE = 100;
export function leadPageCount(total: number, pageSize: number) { return Math.min(MAX_LEAD_PAGE, Math.max(1, Math.ceil(total / pageSize))); }
export function hasMoreLeadPages(total: number, page: number, pageSize: number) { return page < MAX_LEAD_PAGE && page * pageSize < total; }
