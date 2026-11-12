import type { LocationQuery } from 'vue-router';

/** Query parameter holding the graph camera (`x,y,zoom`). */
export const VIEW_PARAM = 'view';

/** Query parameters that only describe the current view, not the content. */
const VIEW_PARAMS = [VIEW_PARAM];

/** The query of a link to share, with or without the view parameters. */
export function shareQuery(
  query: LocationQuery,
  includeView: boolean
): LocationQuery {
  if (includeView) {
    return { ...query };
  }

  const result: LocationQuery = {};
  for (const [key, value] of Object.entries(query)) {
    if (!VIEW_PARAMS.includes(key)) {
      result[key] = value;
    }
  }

  return result;
}
